/**
 * 任务队列（契约 §4.4 / ADR-0006 定稿）：append-only JSONL 文件队列。
 * 入队即追加一行；重启扫文件重放——未终态任务回到内存索引，等 agent 重连或拒绝通知。
 * 内存索引承担全部运行期查询（tasks/get、面板翻页）；文件只负责"重启不丢"（PRD-2 NFR）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const TERMINAL_STATES = new Set(["completed", "failed", "canceled", "rejected"]);

let seq = 0;

export function createTaskQueue({ dir, now = Date.now } = {}) {
  if (!dir) throw new Error("TaskQueue 需要 dir");
  const file = join(dir, "queue.jsonl");
  /** taskId → task 快照（全量含终态，供 tasks/get 与历史查询） */
  const index = new Map();
  /** msgId → true（信封幂等去重窗口，契约 §4.4 第 3 条；窗口随重启清零，重放由 agent 侧负责） */
  const dedupWindow = new Map();

  // ---- 启动重放：扫文件恢复任务（重启不丢的机制本体） ----
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8").trim();
    if (raw) {
      for (const line of raw.split("\n")) {
        try {
          const task = JSON.parse(line);
          if (task?.id) {
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
    const { id, contextId, skillId, target, member, vars, actor, lane, state, createdAt, updatedAt, status, artifacts, history, requiresApproval, ruleTrace, expiresAt, queuedOfflineAt } = task;
    return { id, contextId, skillId, target, member, vars, actor, lane, state, createdAt, updatedAt, status, artifacts, history, requiresApproval, ruleTrace, expiresAt, queuedOfflineAt };
  }

  return {
    /** 触发入队：生成 task id、建 task 对象、落盘、入索引。 */
    submit({ skillId, target, member = "", vars = {}, actor = "human", lane = "a2a", contextId = "", requiresApproval = false, ruleTrace = [], expiresAt = "" }) {
      const id = `task-${new Date(now()).toISOString().slice(0, 10).replace(/-/g, "")}-${String(++seq).padStart(3, "0")}`;
      const ts = new Date(now()).toISOString();
      const task = {
        id,
        contextId,
        skillId,
        target,
        member,
        vars,
        actor,
        lane,
        state: "submitted",
        createdAt: ts,
        updatedAt: ts,
        requiresApproval,
        ruleTrace,
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

    /** 状态翻转（working/input-required/终态），终态只允许一次（幂等）。 */
    transition(taskId, state, extra = {}) {
      const task = index.get(taskId);
      if (!task) return null;
      if (TERMINAL_STATES.has(task.state)) return task;
      const ts = new Date(now()).toISOString();
      task.state = state;
      task.updatedAt = ts;
      task.status = { state, timestamp: ts, ...extra };
      if (TERMINAL_STATES.has(state) || state === "working") {
        task.expiresAt = "";
        task.queuedOfflineAt = "";
      }
      persist(snapshot(task));
      return task;
    },

    /** 离线入队快照（M2）：queued-offline 状态 + expiresAt 留存（pendingOffline / sweeper 依赖）。 */
    markQueuedOffline(taskId, expiresAtTs) {
      const task = index.get(taskId);
      if (!task) return null;
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
      };
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
