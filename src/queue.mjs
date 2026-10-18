/**
 * 任务队列（契约 §4.4 / ADR-0006 定稿）：append-only JSONL 文件队列。
 * 入队即追加一行；重启扫文件重放——未终态任务回到内存索引，等 agent 重连或拒绝通知。
 * 内存索引承担全部运行期查询（tasks/get、面板翻页）；文件只负责"重启不丢"（PRD-2 NFR）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { parseDuration } from "./duration.mjs";

const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "rejected"]);
const TASK_STATES = new Set([
  "submitted",
  "queued-offline",
  "working",
  "input-required",
  ...TERMINAL_STATES,
]);
const ALLOWED_TRANSITIONS = new Map([
  ["submitted", new Set(["queued-offline", "working", "input-required", ...TERMINAL_STATES])],
  ["queued-offline", new Set(["working", "canceled", "failed", "rejected"])],
  ["working", new Set(["working", "input-required", ...TERMINAL_STATES])],
  ["input-required", new Set(["working", "completed", "failed", "canceled", "rejected"])],
]);

let seq = 0;

const TRACE_TYPES = new Set(["run/start", "step/start", "step/end", "run/end", "run/truncated"]);

/** 运行记录的最后一条，给 agent-lost 和任务列表用。不参与恢复执行。 */
export function traceSummary(task) {
  const events = Array.isArray(task?.trace) ? task.trace : [];
  const last = events[events.length - 1];
  if (!last) return "";
  const event = last.type === "run/truncated" && last.last?.type ? last.last : last;
  if (event.type === "step/start" || event.type === "step/end") return `${event.type} ${event.index ?? ""}`.trim();
  return String(event.type ?? "");
}

export function lostMessage(task) {
  const summary = traceSummary(task);
  return summary ? `agent-lost：${summary}` : "agent-lost";
}

export function createTaskQueue({ dir, now = Date.now } = {}) {
  if (!dir) throw new Error("TaskQueue 需要 dir");
  const file = join(dir, "queue.jsonl");
  /** taskId → task 快照（全量含终态，供 tasks/get 与历史查询） */
  const index = new Map();
  /** msgId → true（信封幂等去重窗口，契约 §4.4 第 3 条；窗口随重启清零，重放由 agent 侧负责） */
  const dedupWindow = new Map();

  /** 状态变更订阅（M4 message/stream SSE 数据源）：taskId → Set<fn>，"*" 通配全部任务。 */
  const listeners = new Map(); // taskId | "*" → Set<(task) => void>
  function subscribe(taskId, fn) {
    const key = taskId || "*";
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
    return () => listeners.get(key)?.delete(fn);
  }
  function emit(task) {
    for (const fn of listeners.get(task.id) ?? []) {
      try { fn(snapshot(task)); } catch {}
    }
    for (const fn of listeners.get("*") ?? []) {
      try { fn(snapshot(task)); } catch {}
    }
  }


  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8").trim();
    if (raw) {
      for (const line of raw.split("\n")) {
        try {
          const task = JSON.parse(line);
          if (task?.id) {
            task.authorization = normalizeAuthorization(task.authorization);
            index.set(task.id, task);
            // seq 续号：按当日已存最大序号恢复，防止重启后 taskId 撞号（审计对账依赖 id 唯一）
            const m = String(task.id).match(/^task-(\d{4})(\d{2})(\d{2})-(\d+)$/);
            if (m) {
              const day = `${m[1]}-${m[2]}-${m[3]}`;
              const n = Number(m[4]);
              const today = new Date(now()).toISOString().slice(0, 10);
              if (day === today && n > seq) seq = n;
            }
          }
        } catch {
          // 损坏行跳过，不阻断启动
        }
      }
    }
  }

  function persist(task) {
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, JSON.stringify(task) + "\n");
  }

  function snapshot(task) {
    const { id, contextId, skillId, target, member, caller, vars, actor, lane, state, createdAt, updatedAt, status, artifacts, history, requiresApproval, ruleTrace, expiresAt, queuedOfflineAt, authorization, trace, limits, approvalDeadline } = task;
    return {
      id, contextId, skillId, target, member, caller: caller || "", vars, actor, lane, state, createdAt, updatedAt, status, artifacts, history, requiresApproval, ruleTrace, expiresAt, queuedOfflineAt, authorization,
      trace: Array.isArray(trace) ? trace : [],
      limits: limits ?? null,
      approvalDeadline: approvalDeadline ?? "",
    };
  }

  return {
    /** 状态变更订阅（M4 SSE 数据源）。 */
    subscribe,

    /** 触发入队：生成 task id、建 task 对象、落盘、入索引。 */
    submit({ skillId, target, member = "", caller = "", vars = {}, actor = "human", lane = "a2a", contextId = "", requiresApproval = false, ruleTrace = [], expiresAt = "", authorization = null }) {
      const id = `task-${new Date(now()).toISOString().slice(0, 10).replace(/-/g, "")}-${String(++seq).padStart(3, "0")}`;
      const ts = new Date(now()).toISOString();
      const task = {
        id,
        contextId,
        skillId,
        target,
        member,
        caller,
        vars,
        actor,
        lane,
        state: "submitted",
        createdAt: ts,
        updatedAt: ts,
        requiresApproval,
        ruleTrace,
        authorization: normalizeAuthorization(authorization),
        expiresAt,
        queuedOfflineAt: expiresAt ? ts : "",
        status: { state: "submitted", timestamp: ts },
        artifacts: [],
        history: [
          { role: "user", parts: [{ kind: "text", text: `trigger ${target}${member ? ` @${member}` : ""}` }], ts },
        ],
      };
      index.set(id, task);
      persist(snapshot(task));
      return task;
    },

    /**
     * 状态翻转并报告是否实际变更。相同终态重放是幂等；不同终态是冲突，
     * 必须在调用方产生审计、通知或规则副作用前失败。
     */
    transitionChecked(taskId, state, extra = {}) {
      const task = index.get(taskId);
      if (!task) return { task: null, changed: false };
      if (!TASK_STATES.has(state)) {
        throw taskStateError("invalid-task-state", `非法任务状态：${state}`);
      }
      if (TERMINAL_STATES.has(task.state)) {
        if (task.state === state) return { task, changed: false };
        throw taskStateError("invalid-task-transition", `非法任务状态转换：${task.state} → ${state}`);
      }
      if (task.state === state && state !== "working") return { task, changed: false };
      if (!ALLOWED_TRANSITIONS.get(task.state)?.has(state)) {
        throw taskStateError("invalid-task-transition", `非法任务状态转换：${task.state} → ${state}`);
      }
      const ts = new Date(now()).toISOString();
      task.state = state;
      task.updatedAt = ts;
      task.status = { ...extra, state, timestamp: ts };
      if (state === "input-required") {
        const ttlMs = parseDuration(task.limits?.approvalTtl);
        if (ttlMs) task.approvalDeadline = new Date(now() + ttlMs).toISOString();
      }
      if (TERMINAL_STATES.has(state) || state === "working") {
        task.expiresAt = "";
        task.queuedOfflineAt = "";
      }
      persist(snapshot(task));
      emit(task);
      return { task, changed: true };
    },

    /** 兼容既有调用方：只返回任务快照。 */
    transition(taskId, state, extra = {}) {
      return this.transitionChecked(taskId, state, extra).task;
    },

    /** 离线入队快照（M2）：queued-offline 状态 + expiresAt 留存（pendingOffline / sweeper 依赖）。 */
    markQueuedOffline(taskId, expiresAtTs) {
      const task = index.get(taskId);
      if (!task) return null;
      if (task.state !== "submitted") {
        throw taskStateError("invalid-task-transition", `非法任务状态转换：${task.state} → queued-offline`);
      }
      const ts = new Date(now()).toISOString();
      task.state = "queued-offline";
      task.updatedAt = ts;
      task.expiresAt = new Date(expiresAtTs).toISOString();
      task.status = { state: "queued-offline", timestamp: ts, message: "member-offline, queued with ttl" };
      persist(snapshot(task));
      return task;
    },

    /** 离线等待中任务清单（sweeper 周期扫描 + 成员上线补下发用）。 */
    pendingOffline() {
      return [...index.values()].filter((t) => t.state === "queued-offline");
    },

    /** TTL 到期判定（sweeper 用）：queued-offline 且 expiresAt 已过。 */
    isExpired(task, at = Date.now()) {
      if (task.state !== "queued-offline" || !task.expiresAt) return false;
      return Date.parse(task.expiresAt) <= at;
    },

    /** 进入 working 时抄下 Target 时长。已有值不覆盖，之后改配置不影响这一单。 */
    stampLimits(taskId, limits) {
      const task = index.get(taskId);
      if (!task || task.limits) return task;
      task.limits = {
        timeout: limits?.timeout || "10m",
        lostTtl: limits?.lostTtl || "10m",
        approvalTtl: limits?.approvalTtl || "",
      };
      persist(snapshot(task));
      return task;
    },

    /**
     * 追加运行记录。不改变任务状态。相同 seq + type 幂等。
     * 终态之后仍可追加，用来补上进程消失前没送出的尾巴。
     */
    appendTrace(taskId, event) {
      const task = index.get(taskId);
      if (!task) return { ok: false, reason: "task-not-found" };
      const seq = Number(event?.seq);
      const type = String(event?.type ?? "");
      if (!Number.isInteger(seq) || seq < 1 || !TRACE_TYPES.has(type)) {
        return { ok: false, reason: "invalid-trace" };
      }
      if (!Array.isArray(task.trace)) task.trace = [];
      if (task.trace.some((item) => item.seq === seq && item.type === type)) {
        return { ok: true, dedup: true, task };
      }
      const stored = { seq, type, ts: String(event.ts ?? new Date(now()).toISOString()), taskId: String(event.taskId ?? taskId) };
      for (const key of ["target", "bootId", "timeout", "index", "command", "exit", "state", "last"]) {
        if (event[key] !== undefined) stored[key] = event[key];
      }
      task.trace.push(stored);
      task.trace.sort((left, right) => left.seq - right.seq || String(left.type).localeCompare(String(right.type)));
      const summary = traceSummary(task);
      if (type === "run/truncated" && summary && String(task.status?.message ?? "").startsWith("agent-lost")) {
        task.status = { ...task.status, message: `agent-lost：${summary}` };
      }
      persist(snapshot(task));
      emit(task);
      return { ok: true, dedup: false, task };
    },

    /** 追加 artifact（契约 §7：A2A 车道产物）。 */
    addArtifact(taskId, artifact) {
      const task = index.get(taskId);
      if (!task) return null;
      task.artifacts.push(artifact);
      const ts = new Date(now()).toISOString();
      task.updatedAt = ts;
      persist(snapshot(task));
      return task;
    },

    /** A2A task 对象形状（契约 §5.2 / task.json）。 */
    toA2A(taskId) {
      const task = index.get(taskId);
      if (!task) return null;
      return {
        id: task.id,
        contextId: task.contextId || undefined,
        kind: "task",
        status: task.status,
        artifacts: task.artifacts.length ? task.artifacts : undefined,
        history: task.history.length ? task.history : undefined,
        trace: task.trace?.length ? task.trace : undefined,
      };
    },

    /** HTTP 列表可见形状：剥离仅供 hub 内部规则续链使用的授权上下文。 */
    toPublic(taskOrId) {
      const task = typeof taskOrId === "string" ? index.get(taskOrId) : taskOrId;
      if (!task) return null;
      const { authorization: _authorization, ...visible } = snapshot(task);
      return visible;
    },

    get(taskId) {
      return index.get(taskId) ?? null;
    },

    list({ state, member } = {}) {
      let tasks = [...index.values()];
      if (state) tasks = tasks.filter((t) => t.state === state);
      if (member) tasks = tasks.filter((t) => t.member === member);
      return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    /** 信封幂等：见过的 msgId 返回 true（调用方回 dedup ack）。 */
    seenMsg(msgId) {
      return dedupWindow.has(msgId);
    },
    markMsg(msgId) {
      dedupWindow.set(msgId, true);
    },

    /** 终态判定（取消门与规则引擎触发条件用）。 */
    isTerminal(state) {
      return TERMINAL_STATES.has(state);
    },

    /** 重启重放后未终态任务清单（运维诊断用）。 */
    pendingAfterReboot() {
      return [...index.values()].filter((t) => !TERMINAL_STATES.has(t.state));
    },
  };
}

function taskStateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeAuthorization(value) {
  if (!value || value.kind !== "pat"
    || !/^[a-f0-9-]{36}$/i.test(String(value.userId))
    || !/^[a-f0-9]{16}$/.test(String(value.patId))) {
    return null;
  }
  return { kind: "pat", userId: String(value.userId), patId: String(value.patId) };
}
