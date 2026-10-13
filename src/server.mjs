/**
 * HTTP 门与 A2A 端点（契约 §5，两扇门，ADR-0004）：
 *   GET  /.well-known/agent-card.json   聚合 Agent Card（能力声明公开）
 *   POST /a2a                           JSON-RPC 2.0：message/send、tasks/get、tasks/cancel
 *   POST /api/trigger                   人类客户端门（iOS 快捷指令 / 企微 bot / Web 面板）
 *   POST /api/artifacts                 artifact 上传（agent token 鉴权，内联上限 5MB）
 *   GET  /api/artifacts/:name           artifact 下载
 *   GET  /api/status                    联邦状态（Bearer 鉴权）
 *   GET  /api/tasks                     任务列表（Bearer 鉴权）
 *   GET  /api/events                    审计流水（Bearer 鉴权）
 *   POST /api/bootstrap                 首访设口令（仅未设置时）
 *   POST /api/session                   口令校验（dashboard 登录）
 *   GET  /                              dashboard 页面
 *
 * 鉴权（契约 §8 分池）：agentTokens 给隧道；clientKeys 给 A2A 客户端（试点：With 一把）；
 * dashboardToken 给面板。三者均 Bearer。
 */
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readBody, readJson, sendJson, parseBearer } from "./http-helpers.mjs";
import { renderDashboard } from "./dashboard.mjs";

const JSONRPC_ERRORS = {
  TASK_NOT_FOUND: { code: -32001, message: "Task not found" },
  NOT_CANCELABLE: { code: -32002, message: "Task not cancelable" },
  UNSUPPORTED: { code: -32004, message: "Operation not supported" },
  ILLEGAL: { code: -32000, message: "非法请求" },
};

export function startServer({
  port,
  host = "0.0.0.0",
  registry,
  queue,
  audit,
  secrets,
  artifacts,
  validate,
  delegate, // async ({ task, vars, cancel }) => { ok, reason } —— 隧道下发钩子（tunnel.mjs 提供）
  notify,   // async ({ event }) => void —— 通知扇出钩子（通知扇出最小版挂 M1 后段）
  log = console,
}) {
  const safeEq = (a, b) => {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  };

  function authorizeClient(req) {
    const token = parseBearer(req.headers.authorization);
    if (!token) return null;
    if (safeEq(token, secrets.get("dashboardToken"))) return "dashboard";
    for (const key of secrets.get("clientKeys")) {
      if (safeEq(token, key)) return `client:${key.slice(0, 6)}`;
    }
    return null;
  }

  function auditLine(partial, actor, lane) {
    try {
      audit.append({ actor, lane, ...partial }, validate?.auditEvent);
    } catch (error) {
      log.error?.(`审计落盘失败：${error.message}`);
    }
  }

  /** 人类门触发：查表 → 入队 → 202 受理 → 异步下发（fire-and-forget，契约 §5.1）。 */
  async function handleTrigger(req, res) {
    const actor = authorizeClient(req) ?? "human";
    let payload;
    try {
      payload = await readJson(req);
    } catch {
      sendJson(res, 400, { error: "bad json" });
      return;
    }
    const target = String(payload?.target ?? "").trim();
    const memberHint = String(payload?.member ?? "").trim();
    const vars = plainVars(payload?.vars);
    if (!target) {
      sendJson(res, 400, { error: "缺少 target" });
      return;
    }

    const owner = memberHint ? resolveWithMember(target, memberHint) : registry.resolve(target);
    if (!owner) {
      if (registry.knows(target)) {
        // skill 存在但成员离线：按 target offline 策略分流（契约 §5.1 / §1.1，M2）
        const placed = placeOfflineTask({ target, memberHint, actor, vars, lane: "a2a" });
        sendJson(res, 202, placed.body);
        return;
      }
      // 查无此 skill（含 expose: local：本地注册表有、聚合 card 无，查表自然 miss）
      auditLine({ target, outcome: "rejected", detail: { reason: "no-such-skill" } }, actor, "a2a");
      sendJson(res, 404, { error: "target not remotely triggerable" });
      return;
    }

    const task = queue.submit({ skillId: target, target, member: owner.agentId, vars, actor, lane: "a2a" });
    auditLine({ target, taskId: task.id, outcome: "submitted" }, actor, "a2a");
    sendJson(res, 202, { taskId: task.id, state: "submitted" });
    delegate?.({ task, vars }).catch((error) => {
      log.error?.(`下发失败 ${task.id}：${error.message}`);
    });
  }

  /**
   * 离线策略分流（M2，契约 §1.1）：查 card 的 x-novoard-offline 扩展。
   * reject（默认/未标注）：不入队，rejected + 审计 + 通知（PRD-3 US4 离线拒绝）。
   * queue：submit 后 markQueuedOffline，expiresAt 按 offlineTtl（默认 30m）；
   *        成员上线（tunnel hello 钩子）自动补下发，TTL 到期 sweeper 转 failed。
   * 返回 202 响应体（两扇门共用）。
   */
  function placeOfflineTask({ target, memberHint = "", actor, vars = {}, lane = "a2a", contextId = "" }) {
    const owned = registry.ownerOf(target);
    const policy = owned?.skill?.["x-novoard-offline"]?.policy ?? "reject";
    if (policy !== "queue") {
      auditLine({ target, outcome: "rejected", detail: { reason: "member-offline" } }, actor, lane);
      notify?.({ event: { kind: "offline-reject", target, reason: "member-offline" } });
      return { body: { state: "rejected", reason: "member-offline" } };
    }
    const ttlMs = parseDuration(owned?.skill?.["x-novoard-offline"]?.ttl ?? "30m") ?? 30 * 60_000;
    const task = queue.submit({ skillId: target, target, member: owned.agentId, vars, actor, lane, contextId });
    queue.markQueuedOffline(task.id, Date.now() + ttlMs);
    auditLine({ target, taskId: task.id, outcome: "submitted", detail: { reason: "member-offline-queued", ttl: owned?.skill?.["x-novoard-offline"]?.ttl ?? "30m" } }, actor, lane);
    return { body: { taskId: task.id, state: "queued-offline", reason: "member-offline", expiresAt: queue.get(task.id).expiresAt } };
  }

  function parseDuration(literal) {
    const m = String(literal ?? "").trim().match(/^(\d+)(s|m|h|d)$/);
    if (!m) return null;
    const n = Number(m[1]);
    return { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]] * n;
  }

  /** A2A 门：JSON-RPC 2.0 三方法（message/stream M4，试点期明确 UNSUPPORTED）。 */
  async function handleA2A(req, res) {
    const actor = authorizeClient(req);
    if (!actor) {
      sendJson(res, 401, { error: "client key required" });
      return;
    }
    let rpc;
    try {
      rpc = await readJson(req);
    } catch {
      sendJson(res, 400, { error: "bad json" });
      return;
    }
    if (rpc?.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
      sendJson(res, 400, { error: "jsonrpc 2.0 required" });
      return;
    }

    if (rpc.method === "tasks/get") {
      const id = String(rpc.params?.id ?? "");
      const task = queue.toA2A(id);
      if (!task) {
        rpcError(res, rpc.id, JSONRPC_ERRORS.TASK_NOT_FOUND);
        return;
      }
      rpcResult(res, rpc.id, task);
      return;
    }

    if (rpc.method === "tasks/cancel") {
      const id = String(rpc.params?.id ?? "");
      const raw = queue.get(id);
      if (!raw) {
        rpcError(res, rpc.id, JSONRPC_ERRORS.TASK_NOT_FOUND);
        return;
      }
      if (queue.isTerminal(raw.state)) {
        rpcError(res, rpc.id, JSONRPC_ERRORS.NOT_CANCELABLE);
        return;
      }
      queue.transition(id, "canceled", { message: "canceled by client" });
      auditLine({ target: raw.target, taskId: id, outcome: "canceled" }, actor, "a2a");
      rpcResult(res, rpc.id, queue.toA2A(id));
      delegate?.({ task: queue.get(id), vars: raw.vars, cancel: true }).catch(() => {});
      return;
    }

    if (rpc.method === "message/send") {
      const message = rpc.params?.message ?? {};
      const target = parseTarget(firstText(message.parts));
      if (!target) {
        rpcError(res, rpc.id, JSONRPC_ERRORS.UNSUPPORTED, "无法从消息解析 target，请在 card skills 中查看可触发能力");
        return;
      }
      const [skillId, memberHint] = target;
      const owner = memberHint ? resolveWithMember(skillId, memberHint) : registry.resolve(skillId);
      if (!owner) {
        if (registry.knows(skillId)) {
          // 成员离线：按 target offline 策略分流（契约 §5.1，M2）——queue 则入队返回 task，reject 则报错
          const placed = placeOfflineTask({ target: skillId, memberHint, actor, vars: {}, lane: "a2a", contextId: typeof message.contextId === "string" ? message.contextId : "" });
          if (placed.body.state === "queued-offline") {
            rpcResult(res, rpc.id, queue.toA2A(placed.body.taskId));
          } else {
            rpcError(res, rpc.id, JSONRPC_ERRORS.UNSUPPORTED, "成员离线，已拒绝（target offline: reject）");
          }
          return;
        }
        auditLine({ target: skillId, outcome: "rejected", detail: { reason: "no-such-skill" } }, actor, "a2a");
        rpcError(res, rpc.id, JSONRPC_ERRORS.UNSUPPORTED, "target expose=local, no remote capability");
        return;
      }
      const task = queue.submit({
        skillId,
        target: skillId,
        member: owner.agentId,
        vars: {},
        actor,
        lane: "a2a",
        contextId: typeof message.contextId === "string" ? message.contextId : "",
      });
      auditLine({ target: skillId, taskId: task.id, outcome: "submitted" }, actor, "a2a");
      rpcResult(res, rpc.id, queue.toA2A(task.id));
      delegate?.({ task, vars: {} }).catch((error) => {
        log.error?.(`下发失败 ${task.id}：${error.message}`);
      });
      return;
    }

    if (rpc.method === "message/stream") {
      rpcError(res, rpc.id, JSONRPC_ERRORS.UNSUPPORTED, "message/stream M4 完备化，试点期以轮询 + 通知顶替");
      return;
    }

    rpcError(res, rpc.id, JSONRPC_ERRORS.UNSUPPORTED, `未知方法：${rpc.method}`);
  }

  function resolveWithMember(skillId, memberHint) {
    const member = registry.status().find((s) => s.agentId === memberHint || s.name === memberHint);
    if (!member) return null;
    const owner = registry.resolve(skillId);
    if (!owner || owner.agentId !== member.agentId) return null;
    return owner;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;
    try {
      if (req.method === "GET" && pathname === "/.well-known/agent-card.json") {
        sendJson(res, 200, registry.aggregateCard());
        return;
      }

      if (req.method === "POST" && pathname === "/a2a") {
        await handleA2A(req, res);
        return;
      }

      if (req.method === "POST" && pathname === "/api/trigger") {
        await handleTrigger(req, res);
        return;
      }

      if (req.method === "POST" && pathname === "/api/artifacts") {
        const token = parseBearer(req.headers.authorization);
        if (!token || !secrets.get("agentTokens").includes(token)) {
          sendJson(res, 401, { error: "agent token required" });
          return;
        }
        const raw = await readBody(req, 5 * 1024 * 1024); // 契约 §7：内联上限 5MB
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: "bad json" });
          return;
        }
        const name = String(payload?.name ?? "artifact.bin");
        if (!payload?.data) {
          sendJson(res, 400, { error: "缺少 data" });
          return;
        }
        const saved = artifacts.save(name, Buffer.from(String(payload.data), "utf8"));
        sendJson(res, 200, { artifactUrl: saved.artifactUrl });
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/api/artifacts/")) {
        const name = decodeURIComponent(pathname.slice("/api/artifacts/".length));
        const buffer = artifacts.read(name);
        if (!buffer) {
          sendJson(res, 404, { error: "artifact not found" });
          return;
        }
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(buffer);
        return;
      }

      if (req.method === "POST" && pathname === "/api/bootstrap") {
        if (secrets.has("dashboardToken")) {
          sendJson(res, 409, { error: "管理口令已设置" });
          return;
        }
        const { token } = await readJson(req);
        if (typeof token !== "string" || token.trim().length < 8) {
          sendJson(res, 400, { error: "口令至少 8 位" });
          return;
        }
        secrets.set({ dashboardToken: token.trim() });
        auditLine({ target: "hub", outcome: "completed", detail: { reason: "dashboard 口令已设置" } }, "human", "ops");
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "POST" && pathname === "/api/session") {
        if (!authorizeClient(req)) {
          sendJson(res, 401, { error: "管理口令错误" });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && pathname === "/api/status") {
        if (!authorizeClient(req)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        const tasks = queue.list();
        sendJson(res, 200, {
          version: process.env.NOVOARD_VERSION ?? "dev",
          startedAt: server.startedAt ?? null,
          members: registry.status(),
          tasks: {
            total: tasks.length,
            active: tasks.filter((t) => !queue.isTerminal(t.state)).length,
          },
          secrets: secrets.view(),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/tasks") {
        if (!authorizeClient(req)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        sendJson(res, 200, { tasks: queue.list() });
        return;
      }

      if (req.method === "GET" && pathname === "/api/events") {
        if (!authorizeClient(req)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        sendJson(res, 200, { events: audit.list() });
        return;
      }

      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderDashboard());
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      log.error?.(`HTTP 处理异常：${error.message}`);
      sendJson(res, 500, { error: String(error?.message ?? error) });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      server.startedAt = new Date().toISOString();
      resolve(server);
    });
  });
}

function plainVars(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") out[k] = val;
  }
  return out;
}

function firstText(parts = []) {
  const part = (Array.isArray(parts) ? parts : []).find((p) => p?.kind === "text" && typeof p.text === "string");
  return part?.text ?? "";
}

function parseTarget(text) {
  const match = String(text).trim().match(/^([a-z0-9][a-z0-9-]*)(?:@([a-z0-9][a-z0-9-]*))?$/);
  if (!match) return null;
  return [match[1], match[2] ?? ""];
}

function rpcResult(res, id, result) {
  sendJson(res, 200, { jsonrpc: "2.0", id, result });
}

function rpcError(res, id, error, extra) {
  sendJson(res, 200, {
    jsonrpc: "2.0",
    id,
    error: { code: error.code, message: extra ? `${error.message}：${extra}` : error.message },
  });
}
