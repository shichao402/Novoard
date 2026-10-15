/**
 * hub 入口：装配全部模块（依赖注入风格，测试可替换任意件）。
 * 目录约定：NOVOARD_STATE_DIR（默认 .state/）下 secrets.json、audit/、queue/、artifacts/。
 * 装配时序：先建 tunnel 的 delegate（下发/取消走隧道），再传给 HTTP server —— server 是同步
 * startServer 返回 listen Promise，delegate 以 getter 注入避免 Promise 时序问题。
 */
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createFrameValidator } from "./frames.mjs";
import { createAuditLog } from "./audit.mjs";
import { createTaskQueue } from "./queue.mjs";
import { createRegistry } from "./registry.mjs";
import { createSecrets } from "./secrets.mjs";
import { createIdentityStore } from "./identity.mjs";
import { createAuth } from "./auth.mjs";
import { createArtifacts } from "./artifacts.mjs";
import { createNotify } from "./notify.mjs";
import { createWecomBot } from "./wecom-bot.mjs";
import { createRules } from "./rules.mjs";
import { startServer } from "./server.mjs";
import { attachTunnel } from "./tunnel.mjs";

export async function createHub({
  stateDir = join(process.cwd(), ".state"),
  port = Number(process.env.NOVOARD_PORT ?? 38666),
  host = process.env.NOVOARD_HOST ?? "0.0.0.0",
  rulesPath = process.env.NOVOARD_RULES,
  webDir = process.env.NOVOARD_WEB_DIR ?? join(process.cwd(), "web", "dist"),
  offlineSweepMs = 30_000,
  approvalTtlMs = 10 * 60_000,
  publicOrigin = process.env.NOVOARD_PUBLIC_ORIGIN ?? "https://novoard.firoyang.com",
  secureCookies = process.env.NOVOARD_SECURE_COOKIES !== "0",
  log = console,
} = {}) {
  mkdirSync(stateDir, { recursive: true });
  const auditDir = join(stateDir, "audit");
  const queueDir = join(stateDir, "queue");
  const artifactsDir = join(stateDir, "artifacts");

  const validate = createFrameValidator();
  const identity = await createIdentityStore({ stateDir });
  const auth = createAuth({ identity, publicOrigin, secureCookies });
  const secrets = createSecrets({ dir: stateDir });
  const audit = createAuditLog({ dir: auditDir });
  const queue = createTaskQueue({ dir: queueDir });
  const registry = createRegistry({ validate, log });
  const artifacts = createArtifacts({ dir: artifactsDir });
  const wecomBot = createWecomBot({
    secrets,
    log,
    auditCommand({ senderUserId, chatId, chatType, command, authorized, reason }) {
      audit.append({
        actor: `wecom:${senderUserId || "unknown"}`,
        lane: "ops",
        target: "wecom",
        outcome: authorized ? "accepted" : "rejected",
        detail: { reason, senderUserId, chatId, chatType, command },
      }, validate.auditEvent);
    },
  });
  const notify = createNotify({ secrets, bot: wecomBot, log });
  const rules = createRules({ rulesPath, log });

  let tunnelDelegate = async () => ({ ok: false, reason: "tunnel not ready" });
  const delegate = (args) => tunnelDelegate(args);

  // ---- M2 离线队列：TTL sweeper + 成员上线补下发 ----
  /** 成员上线（或离线任务 owner 恢复在线）后补下发其 queued-offline 任务（契约 §1.1 offline: queue）。 */
  async function flushOfflineTasks(agentId) {
    const pending = queue.pendingOffline().filter((t) => t.member === agentId);
    for (const task of pending) {
      const result = await delegate({ task, vars: task.vars });
      audit.append({ actor: "hub", lane: "a2a", target: task.target, taskId: task.id, outcome: "working", detail: { reason: `member-online flush：${agentId} 上线补下发` } }, validate.auditEvent);
      log.info?.(`[offline-queue] ${agentId} 上线，补下发 ${task.id}（${result.ok ? "ok" : result.reason}）`);
    }
  }

  /** TTL sweeper：queued-offline 到期转 failed + 审计 + 通知（offline-ttl-expired）。 */
  function sweepOfflineQueue() {
    for (const task of queue.pendingOffline()) {
      if (!queue.isExpired(task)) continue;
      queue.transition(task.id, "failed", { message: "offline-ttl-expired" });
      audit.append({ actor: "hub", lane: "a2a", target: task.target, taskId: task.id, outcome: "failed", detail: { reason: "offline-ttl-expired", expiresAt: task.expiresAt } }, validate.auditEvent);
      notify.emit({ event: { kind: "terminal", taskId: task.id, target: task.target, state: "failed", reason: "offline-ttl-expired" } }).catch(() => {});
      log.info?.(`[offline-queue] ${task.id} TTL 到期转 failed（offline-ttl-expired）`);
    }
  }

  // per-target notify 策略查表（F2，契约 §1）：定义在 targets.yaml，经 card skill x-novoard-notify 透传
  function policyOf(target) {
    const owned = registry.ownerOf(target);
    return owned?.skill?.["x-novoard-notify"] ?? "always";
  }

  // 规则引擎接终态事件：动作不旁路，走 submit → delegate 全链路；有来源主体时保留 actor 与授权边界。
  const notifyAndRules = async ({ event, principal = null }) => {
    const { authorization: _authorization, ...notificationEvent } = event;
    await notify.emit({ event: notificationEvent, policy: event.kind === "terminal" ? policyOf(event.target) : "always" });
    if (rules.count === 0) return;
    // 事件源统一进规则引擎（F3 首批三源）：task 终态 / member 上线离线 / webhook 外部事件
    let ruleEvent = null;
    if (event.kind === "terminal") ruleEvent = { event: "task-terminal", target: event.target, state: event.state, taskId: event.taskId };
    else if (event.kind === "member-event") ruleEvent = { event: `member-${event.state}`, target: event.target, state: event.state };
    else if (event.kind === "webhook") ruleEvent = { event: `webhook-${event.source}`, target: "", state: event.body?.action ?? "", vars: event.body ?? {} };
    if (!ruleEvent) return;

    const ruleTrace = ruleEvent.taskId ? queue.get(ruleEvent.taskId)?.ruleTrace ?? [] : [];
    const authorization = event.authorization ?? identity.authorizationContext(principal);
    const effectivePrincipal = principal
      ?? (authorization ? await identity.principalFromAuthorization(authorization) : null);
    const authorizationInvalid = !!authorization && !effectivePrincipal;
    const actions = rules.evaluate({ ...ruleEvent, ruleTrace });
    for (const action of actions) {
      const actionActor = event.actor ?? "rule-engine";
      const knownOwner = registry.ownerOf(action.target);
      if (authorizationInvalid) {
        audit.append({
          actor: actionActor,
          lane: "a2a",
          target: action.target,
          outcome: "rejected",
          detail: { reason: "rule-authorization-invalid", viaRule: action.viaRule },
        }, validate.auditEvent);
        continue;
      }
      if (effectivePrincipal && knownOwner
        && !identity.targetAllowed(effectivePrincipal, knownOwner.agentId, action.target)) {
        audit.append({
          actor: actionActor,
          lane: "a2a",
          target: action.target,
          outcome: "rejected",
          detail: { reason: "rule-target-scope-denied", viaRule: action.viaRule },
        }, validate.auditEvent);
        continue;
      }
      const owner = action.member
        ? registry.status().find((s) => s.agentId === action.member) && registry.resolve(action.target)?.agentId === action.member
          ? registry.resolve(action.target)
          : null
        : registry.resolve(action.target);
      if (!owner) {
        audit.append({ actor: actionActor, lane: "a2a", target: action.target, outcome: "rejected", detail: { reason: registry.knows(action.target) ? "member-offline" : "no-such-skill", viaRule: action.viaRule } }, validate.auditEvent);
        continue;
      }
      const task = queue.submit({
        skillId: action.target,
        target: action.target,
        member: owner.agentId,
        vars: action.vars ?? {},
        actor: actionActor,
        lane: "a2a",
        ruleTrace: action.ruleTrace,
        authorization,
      });
      audit.append({ actor: actionActor, lane: "a2a", target: action.target, taskId: task.id, outcome: "submitted", detail: { reason: `规则触发：${ruleEvent.event}${ruleEvent.state ? " " + ruleEvent.state : ""}${ruleEvent.taskId ? " ← " + ruleEvent.taskId : ""}`, viaRule: action.viaRule } }, validate.auditEvent);
      delegate({ task, vars: action.vars ?? {} }).catch((error) => log.error?.(`规则任务下发失败 ${task.id}：${error.message}`));
    }
  };

  // 审批门恢复钩子（M4 F3）：input-required → 下发 resume 帧 → hub 侧转 working
  function resumeTask({ task }) {
    const result = delegate({ task, vars: task.vars, resume: true });
    if (result && typeof result.then === "function") {
      return result.then((r) => {
        if (r?.ok) queue.transition(task.id, "working", { message: "approval-resumed" });
        return r?.ok ?? false;
      });
    }
    if (result?.ok) queue.transition(task.id, "working", { message: "approval-resumed" });
    return result?.ok ?? false;
  }

  // 审批门 TTL（M4 F3）：input-required 超时（默认 10 分钟）自动 rejected + 通知
  function sweepApprovalGate() {
    for (const task of queue.list({ state: "input-required" })) {
      const age = Date.now() - Date.parse(task.updatedAt);
      if (age > approvalTtlMs) {
        queue.transition(task.id, "canceled", { message: "approval-ttl-expired" });
        audit.append({ actor: "hub", lane: "a2a", target: task.target, taskId: task.id, outcome: "canceled", detail: { reason: "approval-ttl-expired" } }, validate.auditEvent);
        notify.emit({ event: { kind: "terminal", taskId: task.id, target: task.target, state: "canceled", reason: "approval-ttl-expired" } }).catch(() => {});
        delegate({ task: queue.get(task.id), vars: task.vars, cancel: true })
          .catch((error) => log.error?.(`[approval-gate] ${task.id} 取消下发失败：${error.message}`));
        log.info?.(`[approval-gate] ${task.id} 审批超时转 canceled（approval-ttl-expired）`);
      }
    }
  }

  /** 外部事件入口（F4）：webhook 落流水 + 规则消费 + 通知面（member-event 类同理给面板）。 */
  const ingestWebhook = async ({ source, body, actor = `webhook:${source}`, principal = null }) => {
    const serializedBody = JSON.stringify(body ?? {});
    audit.append({
      actor,
      lane: "a2a",
      target: "-",
      outcome: "accepted",
      detail: {
        reason: `外部事件：${source}`,
        source,
        bodySha256: createHash("sha256").update(serializedBody).digest("hex"),
        bodyBytes: Buffer.byteLength(serializedBody),
        bodyKeys: body && typeof body === "object" && !Array.isArray(body)
          ? Object.keys(body).slice(0, 32)
          : [],
      },
    }, validate.auditEvent);
    await notifyAndRules({ event: { kind: "webhook", source, body, actor }, principal });
  };

  const serverPromise = startServer({
    port,
    host,
    registry,
    queue,
    audit,
    secrets,
    identity,
    auth,
    artifacts,
    validate,
    delegate,
    resumeTask,
    notify: notifyAndRules,
    ingestWebhook,
    wecomBot,
    webDir,
    log,
  });

  const httpServer = await serverPromise;
  const tunnel = attachTunnel({ server: httpServer, registry, queue, audit, secrets, artifacts, validate, notify: notifyAndRules, log });
  tunnelDelegate = tunnel.delegate;

  // 成员上线钩子：tunnel hello 注册成功后补下发该成员的 queued-offline 任务
  tunnel.onMemberOnline = (agentId) => {
    flushOfflineTasks(agentId).catch((error) => log.error?.(`[offline-queue] 补下发异常：${error.message}`));
  };
  // sweeper 定时器（hub 句柄关闭时清理）：离线队列 TTL + 审批门 TTL
  const sweepTimer = setInterval(() => {
    sweepOfflineQueue();
    sweepApprovalGate();
  }, offlineSweepMs);
  sweepTimer.unref?.();
  const identitySweepTimer = setInterval(() => {
    identity.pruneExpiredSessions().catch((error) => log.error?.(`[identity] 会话清理失败：${error.message}`));
  }, 60_000);
  identitySweepTimer.unref?.();
  httpServer.once("close", () => {
    clearInterval(sweepTimer);
    clearInterval(identitySweepTimer);
  });

  // 启动时扫尾：重启前留下的 queued-offline 任务，owner 在线则立即补下发，到期则转 failed
  for (const task of queue.pendingOffline()) {
    const owner = registry.resolve(task.skillId);
    if (owner && owner.agentId === task.member) {
      flushOfflineTasks(task.member).catch(() => {});
    }
  }
  sweepOfflineQueue();

  // 企微 bot 通道：server 就绪后绑定本地端口（触发转发用），异步起长连接（失败不阻塞 hub）
  const listenPort = httpServer.address?.()?.port ?? port;
  wecomBot.attach(listenPort);
  wecomBot.start().catch((error) => log.error?.(`企微 bot 启动失败：${error.message}`));

  return {
    server: httpServer,
    delegate: tunnel.delegate,
    registry,
    queue,
    audit,
    secrets,
    identity,
    auth,
    artifacts,
    validate,
    notify: notifyAndRules,
    notifyImpl: notify,
    rules,
    wecomBot,
    ingestWebhook,
    policyOf,
    resumeTask,
  };
}

export function main() {
  createHub().then((hub) => {
    const port = hub.server.address?.().port ?? process.env.NOVOARD_PORT ?? 38666;
    console.log(`Novoard hub 已启动：http://0.0.0.0:${port}`);
    console.log("  dashboard: /    tunnel: /tunnel (ws)    a2a: /a2a    card: /.well-known/agent-card.json");
    const pending = hub.queue.pendingAfterReboot();
    if (pending.length) {
      console.log(`  [重启重放] ${pending.length} 个未终态任务已恢复到内存索引，等待 agent 重连对账`);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
