/**
 * HTTP 门与 A2A 端点（契约 §5，两扇门，ADR-0004）：
 *   GET  /.well-known/agent-card.json   按调用主体 target 范围过滤的聚合 Agent Card
 *   POST /a2a                           JSON-RPC 2.0：message/send、tasks/get、tasks/cancel
 *   POST /api/trigger                   人类客户端门（iOS 快捷指令 / 企微 bot / Web 面板）
 *   POST /api/artifacts                 artifact 上传（agent token 鉴权，内联上限 5MB）
 *   GET  /api/artifacts/:artifactId     artifact 下载
 *   GET  /api/status                    联邦状态（Bearer 鉴权）
 *   GET  /api/tasks                     任务列表（Bearer 鉴权）
 *   GET  /api/events                    审计流水（Bearer 鉴权）
 *   GET/POST /api/setup                 首访初始化
 *   POST /api/session                   用户名/口令登录
 *   GET  /                              dashboard 页面
 *
 * 鉴权：浏览器使用 HttpOnly 会话 + CSRF；机器客户端使用具名 PAT；
 * agent token 只给隧道/artifact 上传。
 */
import { createServer } from "node:http";
import { readBody, readJson, sendJson, parseBearer } from "./http-helpers.mjs";
import { createStaticSite } from "./static-site.mjs";
import { PRODUCT_VERSION } from "./version.mjs";
import { CONTRACT_VERSION } from "./contract/version.mjs";
import {
  hashAgentToken,
  normalizeAgentId,
} from "./agent-auth.mjs";
import { listMemberViews } from "./members.mjs";

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
  identity,
  auth,
  artifacts,
  members, // 成员目录（members.mjs）：成员身份与接入凭据的持久化 SSOT
  validate,
  delegate, // async ({ task, vars, cancel }) => { ok, reason } —— 隧道下发钩子（tunnel.mjs 提供）
  resumeTask, // ({ task, actor }) => boolean —— 审批门恢复钩子（M4 F3：input-required → 继续执行）
  notify,   // async ({ event }) => void —— 通知扇出钩子（通知扇出最小版挂 M1 后段）
  ingestWebhook, // async ({ source, body }) => void —— 外部事件入口（M3 F4：落流水 + 规则消费）
  wecomBot,
  webDir,
  log = console,
}) {
  if (!identity || !auth) throw new Error("HTTP server 需要 identity/auth");
  const staticSite = createStaticSite({ dir: webDir, log });

  async function requirePrincipal(req, res, permission, {
    session = true,
    pat = true,
    mutation = false,
    allowForcedPasswordChange = false,
  } = {}) {
    const authn = await auth.authenticate(req, { session, pat });
    if (!authn) {
      sendJson(res, 401, { error: "unauthorized" });
      return null;
    }
    if (authn.principal.user.forcePasswordChange && !allowForcedPasswordChange) {
      sendJson(res, 403, { error: "password_change_required" });
      return null;
    }
    if (mutation && !auth.requireCsrf(req, authn)) {
      sendJson(res, 403, { error: "csrf_failed" });
      return null;
    }
    if (permission && !identity.hasPermission(authn.principal, permission)) {
      sendJson(res, 403, { error: "forbidden", permission });
      return null;
    }
    return authn;
  }

  function auditLine(partial, actor, lane) {
    try {
      audit.append({ actor, lane, ...partial }, validate?.auditEvent);
    } catch (error) {
      log.error?.(`审计落盘失败：${error.message}`);
    }
  }

  /** 成员被移除后同步清理在场状态：断开连接并从注册表摘除，避免僵尸成员继续出现在聚合 card 里。 */
  function evictMember(agentId) {
    const member = registry.connected?.(agentId);
    if (member?.conn) {
      try { member.conn.close(1008, "member-removed"); } catch { /* noop */ }
    }
    registry.remove?.(agentId);
  }

  function actorForRequest(req, principal) {
    if (principal?.kind !== "pat" || principal?.pat?.kind !== "service"
      || principal?.user?.accountType !== "service" || principal?.user?.username !== "wecom-bot") {
      return principal?.actor ?? "anonymous";
    }
    const sender = String(req.headers["x-novoard-wecom-sender"] ?? "").trim().slice(0, 128);
    return sender ? `wecom:${sender}` : principal.actor;
  }

  const WECOM_SERVICE_SCOPES = Object.freeze([
    "targets.read",
    "targets.execute",
    "tasks.read",
    "tasks.approve",
  ]);
  let wecomRotationActive = false;

  async function wecomConfigView() {
    const serviceUser = (await identity.listUsers()).find((user) => user.username === "wecom-bot" && user.accountType === "service");
    return {
      botId: secrets.get("wecomBotId"),
      botSecretConfigured: secrets.has("wecomBotSecret"),
      allowedUserIds: secrets.get("wecomAllowedUserIds"),
      allowedChatIds: secrets.get("wecomAllowedChatIds"),
      notifyChatId: secrets.get("wecomNotifyChatId"),
      servicePatConfigured: secrets.has("wecomServicePat"),
      servicePatId: secrets.get("wecomServicePatId") || null,
      serviceAccount: serviceUser ?? null,
    };
  }

  async function rotateWecomServicePat(actor) {
    if (wecomRotationActive) throw identityErrorLike("rotation-in-progress", "企微服务 PAT 正在轮换");
    wecomRotationActive = true;
    let issued;
    try {
      const serviceUser = await identity.ensureWecomServiceAccount(actor);
      const previousPatId = secrets.get("wecomServicePatId");
      const previousPat = secrets.get("wecomServicePat");
      issued = await identity.createPat(actor, {
        userId: serviceUser.id,
        name: `wecom-bot-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`,
        kind: "service",
        scopes: WECOM_SERVICE_SCOPES,
        targetAllow: ["*"],
      });
      const verified = await identity.authenticatePat(issued.token);
      if (!verified || verified.user.id !== serviceUser.id
        || WECOM_SERVICE_SCOPES.some((scope) => !verified.permissions.includes(scope))) {
        throw identityErrorLike("service-pat-verification-failed", "新企微服务 PAT 验证失败");
      }
      try {
        secrets.set({ wecomServicePat: issued.token, wecomServicePatId: issued.pat.id });
      } catch (error) {
        await identity.revokePat(actor, issued.pat.id).catch(() => {});
        throw error;
      }
      let previousRevoked = !previousPatId;
      if (previousPatId && previousPatId !== issued.pat.id) {
        try {
          await identity.revokePat(actor, previousPatId);
          previousRevoked = true;
        } catch (error) {
          secrets.set({ wecomServicePat: previousPat, wecomServicePatId: previousPatId });
          await identity.revokePat(actor, issued.pat.id).catch(() => {});
          throw error;
        }
      }
      return { pat: issued.pat, serviceAccount: serviceUser, previousPatId: previousPatId || null, previousRevoked };
    } catch (error) {
      if (issued && secrets.get("wecomServicePatId") !== issued.pat.id) {
        await identity.revokePat(actor, issued.pat.id).catch(() => {});
      }
      throw error;
    } finally {
      wecomRotationActive = false;
    }
  }

  /** 人类门触发：查表 → 入队 → 202 受理 → 异步下发（fire-and-forget，契约 §5.1）。 */
  async function handleTrigger(req, res) {
    const authn = await requirePrincipal(req, res, "targets.execute", { mutation: true });
    if (!authn) return;
    const actor = actorForRequest(req, authn.principal);
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
    const knownOwner = owner ?? registry.ownerOf(target);
    if (knownOwner && !identity.targetAllowed(authn.principal, knownOwner.agentId, target)) {
      auditLine({ target, outcome: "rejected", detail: { reason: "target-scope-denied" } }, actor, "a2a");
      sendJson(res, 404, { error: "target not remotely triggerable" });
      return;
    }
    if (!owner) {
      if (registry.knows(target)) {
        // skill 存在但成员离线：按 target offline 策略分流（契约 §5.1 / §1.1，M2）
        const placed = placeOfflineTask({
          target,
          memberHint,
          actor,
          vars,
          lane: "a2a",
          authorization: identity.authorizationContext(authn.principal),
        });
        sendJson(res, 202, placed.body);
        return;
      }
      // 查无此 skill（含 expose: local：本地注册表有、聚合 card 无，查表自然 miss）
      auditLine({ target, outcome: "rejected", detail: { reason: "no-such-skill" } }, actor, "a2a");
      sendJson(res, 404, { error: "target not remotely triggerable" });
      return;
    }

    const task = queue.submit({
      skillId: target,
      target,
      member: owner.agentId,
      vars,
      actor,
      lane: "a2a",
      authorization: identity.authorizationContext(authn.principal),
    });
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
  function placeOfflineTask({ target, memberHint = "", actor, vars = {}, lane = "a2a", contextId = "", authorization = null }) {
    const owned = registry.ownerOf(target);
    const policy = owned?.skill?.["x-novoard-offline"]?.policy ?? "reject";
    if (policy !== "queue") {
      auditLine({ target, outcome: "rejected", detail: { reason: "member-offline" } }, actor, lane);
      notify?.({ event: { kind: "offline-reject", target, reason: "member-offline" } });
      return { body: { state: "rejected", reason: "member-offline" } };
    }
    const ttlMs = parseDuration(owned?.skill?.["x-novoard-offline"]?.ttl ?? "30m") ?? 30 * 60_000;
    const task = queue.submit({ skillId: target, target, member: owned.agentId, vars, actor, lane, contextId, authorization });
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
    const authn = await auth.authenticate(req, { session: true, pat: true });
    if (!authn) {
      sendJson(res, 401, { error: "PAT or session required" });
      return;
    }
    if (authn.principal.user.forcePasswordChange) {
      sendJson(res, 403, { error: "password_change_required" });
      return;
    }
    const actor = actorForRequest(req, authn.principal);
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
    const mutationMethods = new Set(["message/send", "tasks/cancel", "tasks/approve"]);
    if (mutationMethods.has(rpc.method) && !auth.requireCsrf(req, authn)) {
      rpcError(res, rpc.id, JSONRPC_ERRORS.ILLEGAL, "CSRF 校验失败");
      return;
    }

    if (rpc.method === "tasks/get") {
      const id = String(rpc.params?.id ?? "");
      const raw = queue.get(id);
      if (!raw || !identity.hasPermission(authn.principal, "tasks.read")
        || !identity.targetAllowed(authn.principal, raw.member, raw.target)) {
        rpcError(res, rpc.id, JSONRPC_ERRORS.TASK_NOT_FOUND);
        return;
      }
      rpcResult(res, rpc.id, queue.toA2A(id));
      return;
    }

    if (rpc.method === "tasks/cancel") {
      const id = String(rpc.params?.id ?? "");
      const raw = queue.get(id);
      if (!raw || !identity.hasPermission(authn.principal, "tasks.cancel")
        || !identity.targetAllowed(authn.principal, raw.member, raw.target)) {
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
      if (!identity.hasPermission(authn.principal, "targets.execute")) {
        rpcError(res, rpc.id, JSONRPC_ERRORS.UNSUPPORTED, "缺少 targets.execute 权限");
        return;
      }
      const message = rpc.params?.message ?? {};
      const target = parseTarget(firstText(message.parts));
      if (!target) {
        rpcError(res, rpc.id, JSONRPC_ERRORS.UNSUPPORTED, "无法从消息解析 target，请在 card skills 中查看可触发能力");
        return;
      }
      const [skillId, memberHint] = target;
      const owner = memberHint ? resolveWithMember(skillId, memberHint) : registry.resolve(skillId);
      const knownOwner = owner ?? registry.ownerOf(skillId);
      const member = knownOwner?.agentId ?? memberHint ?? "";
      if (knownOwner && !identity.targetAllowed(authn.principal, member, skillId)) {
        auditLine({ target: skillId, outcome: "rejected", detail: { reason: "target-scope-denied" } }, actor, "a2a");
        rpcError(res, rpc.id, JSONRPC_ERRORS.UNSUPPORTED, "target not remotely triggerable");
        return;
      }
      if (!owner) {
        if (registry.knows(skillId)) {
          // 成员离线：按 target offline 策略分流（契约 §5.1，M2）——queue 则入队返回 task，reject 则报错
          const placed = placeOfflineTask({
            target: skillId,
            memberHint,
            actor,
            vars: {},
            lane: "a2a",
            contextId: typeof message.contextId === "string" ? message.contextId : "",
            authorization: identity.authorizationContext(authn.principal),
          });
          if (placed.body.state === "queued-offline") {
            rpcResult(res, rpc.id, queue.toA2A(placed.body.taskId));
          } else {
            rpcError(res, rpc.id, JSONRPC_ERRORS.UNSUPPORTED, "成员离线，已拒绝（target offline: reject）");
          }
          return;
        }
        auditLine({ target: skillId, outcome: "rejected", detail: { reason: "no-such-skill" } }, actor, "a2a");
        rpcError(res, rpc.id, JSONRPC_ERRORS.UNSUPPORTED, "target not remotely triggerable");
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
        authorization: identity.authorizationContext(authn.principal),
      });
      auditLine({ target: skillId, taskId: task.id, outcome: "submitted" }, actor, "a2a");
      rpcResult(res, rpc.id, queue.toA2A(task.id));
      delegate?.({ task, vars: {} }).catch((error) => {
        log.error?.(`下发失败 ${task.id}：${error.message}`);
      });
      return;
    }

    if (rpc.method === "message/stream") {
      // M4 F2：SSE 步骤级进度——订阅 task 状态变更，帧形状对齐 A2A spec（result: TaskStatusUpdateEvent / TaskArtifactUpdateEvent）
      const id = String(rpc.params?.id ?? rpc.params?.taskId ?? "");
      const task = queue.get(id);
      if (!task || !identity.hasPermission(authn.principal, "tasks.read")
        || !identity.targetAllowed(authn.principal, task.member, task.target)) {
        rpcError(res, rpc.id, JSONRPC_ERRORS.TASK_NOT_FOUND);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
      heartbeat.unref?.();
      const off = queue.subscribe(id, (t) => {
        if (t.state === "queued-offline" || t.state === "working" || t.state === "input-required") {
          sse({ jsonrpc: "2.0", id: rpc.id, result: { kind: "status-update", taskId: t.id, status: t.status, final: false } });
        }
        if (queue.isTerminal(t.state)) {
          sse({ jsonrpc: "2.0", id: rpc.id, result: { kind: "status-update", taskId: t.id, status: t.status, final: true } });
          if (t.artifacts?.length) {
            for (const a of t.artifacts) sse({ jsonrpc: "2.0", id: rpc.id, result: { kind: "artifact-update", taskId: t.id, artifact: a } });
          }
          cleanup();
        }
      });
      function cleanup() {
        clearInterval(heartbeat);
        off();
        res.end();
      }
      req.on("close", cleanup);
      // 订阅前状态已变化（如已终态）：补发当前快照
      const cur = queue.get(id);
      if (cur && queue.isTerminal(cur.state)) {
        sse({ jsonrpc: "2.0", id: rpc.id, result: { kind: "status-update", taskId: cur.id, status: cur.status, final: true } });
        cleanup();
      } else if (cur) {
        sse({ jsonrpc: "2.0", id: rpc.id, result: { kind: "status-update", taskId: cur.id, status: cur.status, final: false } });
      }
      return;
    }

    if (rpc.method === "tasks/approve") {
      // M4 F3：审批门恢复端点（IM AI / 面板 / 磁贴三入口共用同一份状态）
      const id = String(rpc.params?.id ?? "");
      const decision = rpc.params?.decision;
      if (!["approve", "reject"].includes(decision)) {
        rpcError(res, rpc.id, JSONRPC_ERRORS.ILLEGAL, "decision 必须是 approve 或 reject");
        return;
      }
      const raw = queue.get(id);
      if (!raw || !identity.hasPermission(authn.principal, "tasks.approve")) {
        rpcError(res, rpc.id, JSONRPC_ERRORS.TASK_NOT_FOUND);
        return;
      }
      if (raw.caller) {
        rpcError(res, rpc.id, JSONRPC_ERRORS.UNSUPPORTED, "这是成员对话，下一条同 contextId 的 message/send 续上，不用审批恢复");
        return;
      }
      if (!identity.targetAllowed(authn.principal, raw.member, raw.target)) {
        rpcError(res, rpc.id, JSONRPC_ERRORS.TASK_NOT_FOUND);
        return;
      }
      if (raw.state !== "input-required") {
        rpcError(res, rpc.id, JSONRPC_ERRORS.UNSUPPORTED, `task 状态为 ${raw.state}，非 input-required，无需恢复`);
        return;
      }
      if (decision === "reject") {
        queue.transition(id, "canceled", { message: `审批拒绝：${actor}` });
        auditLine({ target: raw.target, taskId: id, outcome: "canceled", detail: { reason: `approval-rejected by ${actor}` } }, actor, "a2a");
        notify?.({
          event: {
            kind: "terminal",
            taskId: id,
            target: raw.target,
            state: "canceled",
            reason: "approval-rejected",
            actor: raw.actor,
            authorization: raw.authorization,
          },
        });
        try {
          await delegate?.({ task: queue.get(id), vars: raw.vars, cancel: true });
        } catch (error) {
          log.error?.(`审批拒绝取消下发失败 ${id}：${error.message}`);
        }
        rpcResult(res, rpc.id, queue.toA2A(id));
        return;
      }
      // approve：下发恢复帧（agent 侧 input-required → working，继续执行）
      const resumed = await resumeTask?.({ task: raw, actor });
      if (!resumed) {
        rpcError(res, rpc.id, JSONRPC_ERRORS.UNSUPPORTED, "恢复失败：member-offline 或 hub 无恢复通道");
        return;
      }
      auditLine({ target: raw.target, taskId: id, outcome: "working", detail: { reason: `approval-resumed by ${actor}` } }, actor, "a2a");
      rpcResult(res, rpc.id, queue.toA2A(id));
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
      if (req.method === "GET" && pathname === "/api/setup/status") {
        const status = await identity.setupStatus();
        sendJson(res, 200, { required: status.required });
        return;
      }

      if (req.method === "POST" && pathname === "/api/setup") {
        const status = await identity.setupStatus();
        if (!status.required) {
          sendJson(res, 410, { error: "setup_closed" });
          return;
        }
        if (!auth.requireOrigin(req)) {
          sendJson(res, 403, { error: "origin_failed" });
          return;
        }
        if (!isJsonRequest(req)) {
          sendJson(res, 415, { error: "json_required" });
          return;
        }
        let payload;
        try {
          payload = await readJson(req);
        } catch {
          sendJson(res, 400, { error: "bad_json" });
          return;
        }
        if (!auth.allowCredentialAttempt(req, payload?.username)) {
          sendJson(res, 429, { error: "too_many_attempts" });
          return;
        }
        try {
          const created = await identity.setup(payload);
          auth.setSessionCookie(res, created.token, created.expiresAt);
          auth.resetCredentialAttempts(req, payload?.username);
          auditLine({
            target: "hub",
            outcome: "completed",
            detail: { reason: "first-superadmin-created", username: created.user.username },
          }, `user:${created.user.username}`, "ops");
          sendJson(res, 201, { user: created.user, csrfToken: created.csrfToken });
        } catch (error) {
          sendIdentityError(res, error);
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/session") {
        if (!auth.requireOrigin(req)) {
          sendJson(res, 403, { error: "origin_failed" });
          return;
        }
        if (!isJsonRequest(req)) {
          sendJson(res, 415, { error: "json_required" });
          return;
        }
        let payload;
        try {
          payload = await readJson(req);
        } catch {
          sendJson(res, 400, { error: "bad_json" });
          return;
        }
        if (!auth.allowCredentialAttempt(req, payload?.username)) {
          sendJson(res, 429, { error: "too_many_attempts" });
          return;
        }
        const loggedIn = await identity.login(payload);
        if (!loggedIn) {
          auditLine({
            target: "hub",
            outcome: "rejected",
            detail: { reason: "login-failed", username: String(payload?.username ?? "").slice(0, 64) },
          }, "anonymous", "ops");
          sendJson(res, 401, { error: "invalid_credentials" });
          return;
        }
        auth.resetCredentialAttempts(req, payload?.username);
        auth.setSessionCookie(res, loggedIn.token, loggedIn.expiresAt);
        auditLine({ target: "hub", outcome: "completed", detail: { reason: "login-succeeded" } }, `user:${loggedIn.user.username}`, "ops");
        sendJson(res, 200, { user: loggedIn.user, csrfToken: loggedIn.csrfToken });
        return;
      }

      if (req.method === "POST" && pathname === "/api/logout") {
        const authn = await requirePrincipal(req, res, null, {
          session: true,
          pat: false,
          mutation: true,
          allowForcedPasswordChange: true,
        });
        if (!authn) return;
        await identity.logout(authn.token);
        auth.clearSessionCookie(res);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && pathname === "/api/me") {
        const authn = await requirePrincipal(req, res, null, {
          session: true,
          pat: false,
          allowForcedPasswordChange: true,
        });
        if (!authn) return;
        sendJson(res, 200, {
          user: authn.principal.user,
          role: authn.principal.role,
          permissions: authn.principal.permissions,
          csrfToken: authn.principal.csrfToken,
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/me/password") {
        const authn = await requirePrincipal(req, res, null, {
          session: true,
          pat: false,
          mutation: true,
          allowForcedPasswordChange: true,
        });
        if (!authn) return;
        try {
          const payload = await readJson(req);
          const user = await identity.changeOwnPassword(authn.principal, payload?.currentPassword, payload?.newPassword);
          auth.clearSessionCookie(res);
          auditLine({ target: "hub", outcome: "completed", detail: { reason: "password-changed" } }, authn.principal.actor, "ops");
          sendJson(res, 200, { ok: true, user, reloginRequired: true });
        } catch (error) {
          sendIdentityError(res, error);
        }
        return;
      }

      const setup = await identity.setupStatus();
      if (setup.required && isRuntimePath(pathname)) {
        sendJson(res, 503, { error: "setup_required" });
        return;
      }

      if (req.method === "GET" && pathname === "/.well-known/agent-card.json") {
        const authn = await requirePrincipal(req, res, "targets.read");
        if (!authn) return;
        sendJson(res, 200, registry.aggregateCard({
          skillAllowed: (agentId, skill) =>
            identity.targetAllowed(authn.principal, agentId, skill.id),
        }));
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

      if (req.method === "GET" && pathname === "/api/members") {
        const authn = await requirePrincipal(req, res, "targets.read");
        if (!authn) return;
        // 凭据视图与签发/吊销保持同一道门（superadmin）；admin 能管人但不能碰 agent 凭据。
        const seesCredentials = authn.principal.role.id === "superadmin";
        const seesAllTargets = identity.hasGlobalTargetAccess(authn.principal);
        sendJson(res, 200, {
          members: listMemberViews({
            directory: members,
            registry,
            includeCredentials: seesCredentials,
            skillAllowed: seesAllTargets
              ? null
              : (agentId, skillId) => identity.targetAllowed(authn.principal, agentId, skillId),
          }),
        });
        return;
      }

      const memberRoute = pathname.match(/^\/api\/members\/([^/]+)$/);
      if ((req.method === "POST" || req.method === "DELETE") && memberRoute) {
        const authn = await requirePrincipal(req, res, "users.manage", { session: true, pat: false, mutation: true });
        if (!authn) return;
        if (authn.principal.role.id !== "superadmin") {
          sendJson(res, 403, { error: "forbidden" });
          return;
        }
        try {
          const agentId = normalizeAgentId(decodeURIComponent(memberRoute[1]));
          if (req.method === "DELETE") {
            const existed = members.remove(agentId);
            if (existed) evictMember(agentId);
            auditLine({
              target: "hub",
              outcome: "completed",
              detail: { reason: "agent-token-revoked", agentId, existed },
            }, authn.principal.actor, "ops");
            sendJson(res, 200, { ok: true, agentId, removed: existed });
            return;
          }
          const issued = members.issue(agentId);
          auditLine({
            target: "hub",
            outcome: "completed",
            detail: { reason: "agent-token-issued", agentId, rotated: issued.rotated },
          }, authn.principal.actor, "ops");
          sendJson(res, issued.rotated ? 200 : 201, {
            agentId,
            token: issued.token,
            rotated: issued.rotated,
            tokenLastFour: issued.member.tokenLastFour,
          });
        } catch (error) {
          sendIdentityError(res, error);
        }
        return;
      }

      if (req.method === "GET" && pathname === "/api/cards") {
        const token = parseBearer(req.headers.authorization);
        const agentId = token ? members.authenticate(token) : null;
        if (!agentId) {
          sendJson(res, 401, { error: "agent token required" });
          return;
        }
        sendJson(res, 200, { cards: registry.cards() });
        return;
      }

      if (req.method === "POST" && pathname === "/api/artifacts") {
        const token = parseBearer(req.headers.authorization);
        const agentId = token ? members.authenticate(token) : null;
        if (!agentId) {
          sendJson(res, 401, { error: "agent token required" });
          return;
        }
        const raw = await readBody(req, 7 * 1024 * 1024);
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: "bad json" });
          return;
        }
        const taskId = String(payload?.taskId ?? "");
        const task = queue.get(taskId);
        if (!task || task.member !== agentId) {
          auditLine({
            target: task?.target ?? "hub",
            ...(task?.id ? { taskId: task.id } : {}),
            outcome: "rejected",
            detail: { reason: "artifact-task-owner-mismatch", agentId, requestedTaskId: taskId },
          }, `agent:${agentId}`, "ops");
          sendJson(res, 404, { error: "task not found" });
          return;
        }
        if (payload?.encoding !== "base64" || typeof payload?.content !== "string" || !payload?.digest) {
          sendJson(res, 400, { error: "taskId/name/content(base64)/digest required" });
          return;
        }
        let buffer;
        try {
          buffer = Buffer.from(payload.content, "base64");
          if (buffer.toString("base64").replace(/=+$/, "") !== payload.content.replace(/=+$/, "")) {
            throw new Error("invalid base64");
          }
        } catch {
          sendJson(res, 400, { error: "invalid artifact content" });
          return;
        }
        if (buffer.length > 5 * 1024 * 1024) {
          sendJson(res, 413, { error: "artifact exceeds 5MB" });
          return;
        }
        try {
          const saved = artifacts.save({
            taskId,
            member: task.member,
            target: task.target,
            name: payload.name,
            digest: String(payload.digest),
            buffer,
          });
          const artifact = {
            name: saved.name,
            parts: [{ kind: "file", uri: saved.artifactUrl }],
            metadata: {
              artifactId: saved.artifactId,
              taskId,
              member: saved.member,
              target: saved.target,
              digest: saved.digest,
              size: saved.size,
            },
          };
          queue.addArtifact(taskId, artifact);
          auditLine({
            target: task.target,
            taskId,
            outcome: task.state,
            detail: { reason: "artifact-uploaded", artifactId: saved.artifactId, digest: saved.digest, size: saved.size },
          }, `agent:${agentId}`, "a2a");
          sendJson(res, 201, { artifact });
        } catch (error) {
          sendJson(res, error.code === "digest-mismatch" ? 422 : 400, { error: error.code ?? "invalid-artifact", message: error.message });
        }
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/api/artifacts/")) {
        const authn = await requirePrincipal(req, res, "artifacts.read");
        if (!authn) return;
        const artifactId = decodeURIComponent(pathname.slice("/api/artifacts/".length));
        const metadata = artifacts.metadata(artifactId);
        if (!metadata || !identity.targetAllowed(authn.principal, metadata.member, metadata.target)) {
          sendJson(res, 404, { error: "artifact not found" });
          return;
        }
        const stored = artifacts.read(artifactId);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": stored.buffer.length,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(metadata.name)}`,
          "X-Content-Type-Options": "nosniff",
        });
        res.end(stored.buffer);
        return;
      }

      if (req.method === "GET" && pathname === "/api/users") {
        const authn = await requirePrincipal(req, res, "users.manage", { session: true, pat: false });
        if (!authn) return;
        sendJson(res, 200, { users: await identity.listUsers() });
        return;
      }

      if (req.method === "POST" && pathname === "/api/users") {
        const authn = await requirePrincipal(req, res, "users.manage", { session: true, pat: false, mutation: true });
        if (!authn) return;
        try {
          const user = await identity.createUser(authn.principal, await readJson(req));
          auditLine({ target: "hub", outcome: "completed", detail: { reason: "user-created", username: user.username, roleId: user.roleId } }, authn.principal.actor, "ops");
          sendJson(res, 201, { user });
        } catch (error) {
          sendIdentityError(res, error);
        }
        return;
      }

      const userResetMatch = pathname.match(/^\/api\/users\/([^/]+)\/reset-password$/);
      if (req.method === "POST" && userResetMatch) {
        const authn = await requirePrincipal(req, res, "users.manage", { session: true, pat: false, mutation: true });
        if (!authn) return;
        try {
          const payload = await readJson(req);
          const user = await identity.resetPassword(authn.principal, decodeURIComponent(userResetMatch[1]), payload?.password);
          auditLine({ target: "hub", outcome: "completed", detail: { reason: "user-password-reset", username: user.username } }, authn.principal.actor, "ops");
          sendJson(res, 200, { user });
        } catch (error) {
          sendIdentityError(res, error);
        }
        return;
      }

      const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
      if (req.method === "PATCH" && userMatch) {
        const authn = await requirePrincipal(req, res, "users.manage", { session: true, pat: false, mutation: true });
        if (!authn) return;
        try {
          const user = await identity.updateUser(authn.principal, decodeURIComponent(userMatch[1]), await readJson(req));
          auditLine({ target: "hub", outcome: "completed", detail: { reason: "user-updated", username: user.username, roleId: user.roleId, disabled: user.disabled } }, authn.principal.actor, "ops");
          sendJson(res, 200, { user });
        } catch (error) {
          sendIdentityError(res, error);
        }
        return;
      }

      if (req.method === "GET" && pathname === "/api/roles") {
        const authn = await requirePrincipal(req, res, "system.read", { session: true, pat: false });
        if (!authn) return;
        sendJson(res, 200, { roles: await identity.listRoles() });
        return;
      }

      if (req.method === "POST" && pathname === "/api/roles") {
        const authn = await requirePrincipal(req, res, "roles.manage", { session: true, pat: false, mutation: true });
        if (!authn) return;
        try {
          const role = await identity.createRole(authn.principal, await readJson(req));
          auditLine({ target: "hub", outcome: "completed", detail: { reason: "role-created", roleId: role.id } }, authn.principal.actor, "ops");
          sendJson(res, 201, { role });
        } catch (error) {
          sendIdentityError(res, error);
        }
        return;
      }

      const roleMatch = pathname.match(/^\/api\/roles\/([^/]+)$/);
      if ((req.method === "PATCH" || req.method === "DELETE") && roleMatch) {
        const authn = await requirePrincipal(req, res, "roles.manage", { session: true, pat: false, mutation: true });
        if (!authn) return;
        const roleId = decodeURIComponent(roleMatch[1]);
        try {
          if (req.method === "DELETE") {
            await identity.deleteRole(authn.principal, roleId);
            auditLine({ target: "hub", outcome: "completed", detail: { reason: "role-deleted", roleId } }, authn.principal.actor, "ops");
            sendJson(res, 200, { ok: true });
          } else {
            const role = await identity.updateRole(authn.principal, roleId, await readJson(req));
            auditLine({ target: "hub", outcome: "completed", detail: { reason: "role-updated", roleId } }, authn.principal.actor, "ops");
            sendJson(res, 200, { role });
          }
        } catch (error) {
          sendIdentityError(res, error);
        }
        return;
      }

      if (req.method === "GET" && pathname === "/api/pats") {
        const authn = await requirePrincipal(req, res, "pats.self.manage", { session: true, pat: false });
        if (!authn) return;
        sendJson(res, 200, { pats: await identity.listPats(authn.principal) });
        return;
      }

      if (req.method === "POST" && pathname === "/api/pats") {
        const authn = await requirePrincipal(req, res, "pats.self.manage", { session: true, pat: false, mutation: true });
        if (!authn) return;
        try {
          const payload = await readJson(req);
          const issued = await identity.createPat(authn.principal, {
            name: payload?.name,
            scopes: payload?.scopes,
            targetAllow: payload?.targetAllow,
            targetDeny: payload?.targetDeny,
            expiresAt: payload?.expiresAt,
          });
          auditLine({ target: "hub", outcome: "completed", detail: { reason: "pat-created", patId: issued.pat.id, name: issued.pat.name } }, authn.principal.actor, "ops");
          sendJson(res, 201, issued);
        } catch (error) {
          sendIdentityError(res, error);
        }
        return;
      }

      const patMatch = pathname.match(/^\/api\/pats\/([^/]+)$/);
      if (req.method === "DELETE" && patMatch) {
        const authn = await requirePrincipal(req, res, "pats.self.manage", { session: true, pat: false, mutation: true });
        if (!authn) return;
        try {
          const patId = decodeURIComponent(patMatch[1]);
          await identity.revokePat(authn.principal, patId);
          auditLine({ target: "hub", outcome: "completed", detail: { reason: "pat-revoked", patId } }, authn.principal.actor, "ops");
          sendJson(res, 200, { ok: true });
        } catch (error) {
          sendIdentityError(res, error);
        }
        return;
      }

      if (req.method === "GET" && pathname === "/api/wecom/config") {
        const authn = await requirePrincipal(req, res, "wecom.manage", { session: true, pat: false });
        if (!authn) return;
        sendJson(res, 200, { config: await wecomConfigView() });
        return;
      }

      if (req.method === "PATCH" && pathname === "/api/wecom/config") {
        const authn = await requirePrincipal(req, res, "wecom.manage", { session: true, pat: false, mutation: true });
        if (!authn) return;
        try {
          const payload = await readJson(req);
          const input = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
          const values = {};
          if (Object.hasOwn(input, "botId")) values.wecomBotId = normalizeSecretString(input.botId, "botId");
          if (Object.hasOwn(input, "botSecret")) values.wecomBotSecret = normalizeSecretString(input.botSecret, "botSecret");
          if (Object.hasOwn(input, "notifyChatId")) values.wecomNotifyChatId = normalizeConfigId(input.notifyChatId, "notifyChatId", { allowEmpty: true });
          if (Object.hasOwn(input, "allowedUserIds")) values.wecomAllowedUserIds = normalizeConfigIds(input.allowedUserIds, "allowedUserIds");
          if (Object.hasOwn(input, "allowedChatIds")) values.wecomAllowedChatIds = normalizeConfigIds(input.allowedChatIds, "allowedChatIds");
          secrets.set(values);
          await wecomBot?.start();
          auditLine({
            target: "wecom",
            outcome: "completed",
            detail: {
              reason: "wecom-config-updated",
              fields: Object.keys(values).map((field) => field === "wecomBotSecret" ? "botSecret" : field.replace(/^wecom/, "")),
            },
          }, authn.principal.actor, "ops");
          sendJson(res, 200, { config: await wecomConfigView() });
        } catch (error) {
          sendIdentityError(res, error);
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/wecom/service-pat/rotate") {
        const authn = await requirePrincipal(req, res, "wecom.manage", { session: true, pat: false, mutation: true });
        if (!authn) return;
        try {
          const rotated = await rotateWecomServicePat(authn.principal);
          auditLine({
            target: "wecom",
            outcome: "completed",
            detail: {
              reason: "wecom-service-pat-rotated",
              patId: rotated.pat.id,
              previousPatId: rotated.previousPatId,
              previousRevoked: rotated.previousRevoked,
            },
          }, authn.principal.actor, "ops");
          sendJson(res, 201, {
            pat: rotated.pat,
            serviceAccount: rotated.serviceAccount,
            previousRevoked: rotated.previousRevoked,
          });
        } catch (error) {
          sendIdentityError(res, error);
        }
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/webhook/")) {
        const authn = await requirePrincipal(req, res, "webhooks.invoke", { session: false, pat: true });
        if (!authn) return;
        const actor = authn.principal.actor;
        const source = pathname.slice("/api/webhook/".length).replace(/[^a-zA-Z0-9._-]/g, "") || "default";
        let body;
        try {
          body = await readJson(req);
        } catch {
          body = {};
        }
        await ingestWebhook?.({ source, body, actor, principal: authn.principal });
        sendJson(res, 202, { accepted: true, source, actor });
        return;
      }

      if (req.method === "GET" && pathname === "/api/status") {
        const authn = await requirePrincipal(req, res, "system.read");
        if (!authn) return;
        const seesAllTargets = identity.hasGlobalTargetAccess(authn.principal);
        const views = listMemberViews({
          directory: members,
          registry,
          skillAllowed: seesAllTargets
            ? null
            : (agentId, skillId) => identity.targetAllowed(authn.principal, agentId, skillId),
        });
        const tasks = queue.list().filter((task) => identity.targetAllowed(authn.principal, task.member, task.target));
        const body = {
          version: PRODUCT_VERSION,
          // 契约版本随状态一并返回：排查"某 agent 连不上/字段被忽略"时，先比对这里的值与 agent 日志里的 contractVersion
          contractVersion: CONTRACT_VERSION,
          startedAt: server.startedAt ?? null,
          members: views.map((member) => ({
            agentId: member.agentId,
            name: member.name,
            online: member.online,
            registered: member.registered,
            skillCount: member.skillCount,
          })),
          tasks: {
            total: tasks.length,
            active: tasks.filter((t) => !queue.isTerminal(t.state)).length,
          },
        };
        if (identity.hasPermission(authn.principal, "wecom.manage")) body.secrets = secrets.view();
        sendJson(res, 200, body);
        return;
      }

      if (req.method === "GET" && pathname === "/api/targets") {
        const authn = await requirePrincipal(req, res, "targets.read");
        if (!authn) return;
        // 兼容视图：结构与 /api/members 同源（成员目录 + 在场层），仅裁剪成本端点历史字段名。
        // 保留它是为了不让既有调用方（快捷操作页、外部脚本）因 SSOT 收口而断裂。
        const seesAllTargets = identity.hasGlobalTargetAccess(authn.principal);
        const views = listMemberViews({
          directory: members,
          registry,
          skillAllowed: seesAllTargets
            ? null
            : (agentId, skillId) => identity.targetAllowed(authn.principal, agentId, skillId),
        });
        sendJson(res, 200, {
          catalog: views
            .filter((member) => member.skills.length > 0)
            .map((member) => ({
              agentId: member.agentId,
              name: member.name,
              online: member.online,
              skills: member.skills,
            })),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/tasks") {
        const authn = await requirePrincipal(req, res, "tasks.read");
        if (!authn) return;
        sendJson(res, 200, {
          tasks: queue.list()
            .filter((task) => identity.targetAllowed(authn.principal, task.member, task.target))
            .map((task) => queue.toPublic(task)),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/events") {
        const authn = await requirePrincipal(req, res, "audit.read");
        if (!authn) return;
        sendJson(res, 200, {
          events: audit.list().filter((event) => {
            if (!event.target || event.target === "hub" || event.target === "-" || event.target === "wecom") {
              return identity.hasGlobalTargetAccess(authn.principal);
            }
            const task = event.taskId ? queue.get(event.taskId) : null;
            const member = event.member ?? task?.member;
            if (!member) return identity.hasPermission(authn.principal, "users.manage");
            return identity.targetAllowed(authn.principal, member, event.target);
          }),
        });
        return;
      }

      if (isRuntimePath(pathname)) {
        sendJson(res, 404, { error: "not found" });
        return;
      }

      if (setup.required && req.method === "GET" && String(req.headers.accept ?? "").includes("text/html")
        && !["/", "/index.html", "/setup"].includes(pathname)) {
        res.writeHead(302, { Location: "/setup", "Cache-Control": "no-store" });
        res.end();
        return;
      }
      if (staticSite.serve(req, res, pathname)) return;
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

function sendIdentityError(res, error) {
  const code = String(error?.code ?? "identity_error");
  const status = code === "already-initialized" || code.endsWith("-conflict") || code === "role-in-use" || code === "rotation-in-progress"
    ? 409
    : code === "user-not-found" || code === "role-not-found" || code === "pat-not-found"
      ? 404
      : code === "forbidden" || code === "last-superadmin" || code === "scope-exceeds-role" || code === "reserved-permission"
        ? 403
        : 400;
  sendJson(res, status, { error: code, message: String(error?.message ?? "identity error") });
}

function identityErrorLike(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeSecretString(value, field) {
  const text = String(value ?? "").trim();
  if (text.length > 512 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw identityErrorLike("invalid-wecom-config", `${field} 格式无效`);
  }
  return text;
}

function normalizeConfigId(value, field, { allowEmpty = false } = {}) {
  const text = String(value ?? "").trim();
  if ((!allowEmpty && !text) || text.length > 128 || /[\s\u0000-\u001f\u007f]/.test(text)) {
    throw identityErrorLike("invalid-wecom-config", `${field} 格式无效`);
  }
  return text;
}

function normalizeConfigIds(value, field) {
  if (!Array.isArray(value) || value.length > 500) {
    throw identityErrorLike("invalid-wecom-config", `${field} 必须是最多 500 项的数组`);
  }
  return [...new Set(value.map((item) => normalizeConfigId(item, field)))];
}

function isRuntimePath(pathname) {
  return pathname === "/api"
    || pathname.startsWith("/api/")
    || pathname === "/a2a"
    || pathname.startsWith("/a2a/")
    || pathname === "/tunnel"
    || pathname.startsWith("/tunnel/")
    || pathname.startsWith("/.well-known/");
}

function plainVars(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") out[k] = val;
  }
  return out;
}

function isJsonRequest(req) {
  return /^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] ?? "").trim());
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
