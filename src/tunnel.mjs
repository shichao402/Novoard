/**
 * 出站隧道服务端（契约 §4）：agent 出站 wss 长连接，Bearer agent token 鉴权（§8 分池）。
 * hub 不对 agent 开任何入站端口（ADR-0003 出站纪律）。
 * 帧分车道：ops 帧（hello/ping/telemetry/card.update）旁路不建 task；a2a 帧走 task 生命周期。
 * 幂等：a2a 上行按 msgId 去重，重复帧回 dedup ack（契约 §4.4 第 3 条）。
 * card.update 的身份来自连接绑定（帧本身不带 agentId，schema 如此），冒用即无效。
 */
import { WebSocketServer } from "ws";
import { newMsgId } from "./registry.mjs";
import { authenticateAgentToken } from "./agent-auth.mjs";

export const CONTRACT_VERSION = "2.0";
const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 60_000;

export function attachTunnel({ server, registry, queue, audit, secrets, artifacts, validate, notify, log = console }) {
  const wss = new WebSocketServer({ noServer: true });
  const authenticatedAgentId = new WeakMap();
  /** 成员上线钩子（M2）：main 装配层赋值 tunnel.onMemberOnline = fn 注入；hello 注册成功后调用。 */
  const callbacks = { onMemberOnline: null };

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/tunnel") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const token = bearerOf(req.headers.authorization);
    const agentId = token ? authenticateAgentToken(secrets, token) : null;
    if (!agentId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      authenticatedAgentId.set(ws, agentId);
      wss.emit("connection", ws, req);
    });
  });

  function bearerOf(header) {
    if (typeof header !== "string") return "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : "";
  }

  function sendEnvelope(ws, envelope) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(envelope));
  }

  wss.on("connection", (ws) => {
    let agentId = null;
    let lastSeen = Date.now();

    const pingTimer = setInterval(() => {
      if (Date.now() - lastSeen > PING_TIMEOUT_MS) {
        log.info?.(`agent ${agentId ?? "?"} 心跳超时，断开`);
        ws.terminate();
        return;
      }
      if (ws.readyState === 1) ws.ping();
    }, PING_INTERVAL_MS);

    ws.on("pong", () => {
      lastSeen = Date.now();
    });

    ws.on("message", (raw) => {
      lastSeen = Date.now();
      let envelope;
      try {
        envelope = JSON.parse(String(raw));
      } catch {
        log.error?.("隧道帧解析失败，丢弃");
        return;
      }
      const check = validate.envelope(envelope);
      if (!check.ok) {
        log.error?.(`信封不合法：${check.errors.join("; ")}`);
        return;
      }
      if (envelope.kind === "a2a") {
        if (queue.seenMsg(envelope.msgId)) {
          sendEnvelope(ws, { v: 1, kind: "ack", msgId: envelope.msgId, dedup: true });
          return;
        }
        queue.markMsg(envelope.msgId);
      }
      handleFrame(ws, envelope, (id) => {
        agentId = id;
      });
    });

    ws.on("close", () => {
      clearInterval(pingTimer);
      if (agentId) {
        registry.markOffline(agentId); // 转离线不摘除：离线拒绝通知依赖 card 留表
        notify?.({ event: { kind: "member-event", target: agentId, state: "offline" } }); // M3：成员事件进通知面与规则源
        log.info?.(`agent ${agentId} 断开，已转离线`);
      }
    });

    ws.on("error", () => {
      clearInterval(pingTimer);
    });
  });

  function handleFrame(ws, envelope, onAgentBound) {
    const { kind, body, msgId } = envelope;
    if (kind === "ops") {
      handleOps(ws, envelope, onAgentBound);
      return;
    }
    if (kind === "a2a") {
      handleA2AUpstream(ws, envelope);
      return;
    }
    log.info?.(`ack ${msgId} dedup=${envelope.dedup}`);
  }

  function handleOps(ws, envelope, onAgentBound) {
    const body = envelope.body;
    const type = body?.type;
    const opsCheck = validate.opsBody(type, body);
    if (!opsCheck.ok) {
      log.error?.(`ops 帧不合法：${opsCheck.errors.join("; ")}`);
      return;
    }

    if (type === "agent.hello") {
      if (majorOf(body.contractVersion) !== majorOf(CONTRACT_VERSION)) {
        sendEnvelope(ws, opsFrame({ type: "agent.hello.nack", reason: "contract-major-mismatch", hubVersion: CONTRACT_VERSION }));
        return;
      }
      const authenticatedId = authenticatedAgentId.get(ws);
      if (!authenticatedId || body.agentId !== authenticatedId) {
        sendEnvelope(ws, opsFrame({
          type: "agent.hello.nack",
          reason: "agent-identity-mismatch",
          hubVersion: CONTRACT_VERSION,
        }));
        audit.append({
          actor: `agent:${authenticatedId ?? "unknown"}`,
          lane: "ops",
          target: "hub",
          outcome: "rejected",
          detail: { reason: "agent-identity-mismatch", claimedAgentId: body.agentId },
        }, validate.auditEvent);
        return;
      }
      const result = registry.register({ agentId: body.agentId, card: body.card, conn: ws, inFlightTaskIds: body.inFlightTaskIds ?? [] });
      if (!result.ok) {
        sendEnvelope(ws, opsFrame({ type: "agent.hello.nack", reason: result.reason }));
        return;
      }
      agentIdOf(ws, body.agentId);
      onAgentBound?.(body.agentId);
      sendEnvelope(ws, opsFrame({ type: "agent.hello.ack", inFlightTaskIds: body.inFlightTaskIds ?? [] }));
      audit.append({
        actor: `agent:${body.agentId}`,
        lane: "ops",
        target: "hub",
        outcome: "completed",
        detail: { reason: `agent 注册：${body.card?.name ?? body.agentId}` },
      }, validate.auditEvent);
      callbacks.onMemberOnline?.(body.agentId); // M2：离线队列补下发钩子（main 装配层注入）
      notify?.({ event: { kind: "member-event", target: body.agentId, state: "online" } }); // M3：成员事件进通知面与规则源
      return;
    }

    if (type === "card.update") {
      const id = boundAgentId.get(ws);
      if (!id) {
        log.error?.("card.update 来自未注册连接，丢弃");
        return;
      }
      const result = registry.updateCard(id, body.card);
      log.info?.(`card.update ${id}：${result.ok ? "已更新" : result.reason}`);
      return;
    }

    if (type === "agent.ping") {
      sendEnvelope(ws, opsFrame({ type: "agent.ping", ts: new Date().toISOString() }));
      return;
    }

    if (type === "telemetry") {
      const id = boundAgentId.get(ws) ?? "";
      log.info?.(`telemetry ${id} cpu=${body.cpuPct}% mem=${body.memPct}% disk=${body.diskPct}%`);
      return;
    }
  }

  /** 连接 → agentId 绑定（card.update / telemetry 的身份来源）。 */
  const boundAgentId = new WeakMap();

  function agentIdOf(ws, id) {
    boundAgentId.set(ws, id);
  }

  function handleA2AUpstream(ws, envelope) {
    const body = envelope.body;
    const taskId = envelope.taskId;
    if (body?.method !== "message/notification") {
      log.error?.(`未知上行 a2a 方法：${body?.method}`);
      return;
    }
    const message = body?.params?.message ?? {};
    const kind = message.kind;
    const agentId = boundAgentId.get(ws);
    if (!agentId) {
      rejectAgentFrame(ws, envelope, "agent-not-registered");
      return;
    }

    if (kind === "status-update") {
      const state = message?.status?.state;
      const task = queue.get(taskId);
      if (!task && taskId.startsWith("task-local-")) {
        // 本地磁贴触发的终态镜像（ADR-0008）：hub 不建 task，但 ack + 落审计（本地闭环的可见性镜像）
        if (ws && envelope.msgId) sendEnvelope(ws, { v: 1, kind: "ack", msgId: envelope.msgId });
        if (state) {
          audit.append({ actor: `agent:${agentId}`, lane: "a2a", target: "-", taskId, outcome: state, detail: { via: "tile-local-mirror" } }, validate.auditEvent);
        }
        return;
      }
      if (task && task.member !== agentId) {
        rejectAgentFrame(ws, envelope, "task-member-mismatch", task);
        return;
      }
      if (state && task) {
        // working 帧（步骤进度）幂等转：state 不变仅 message 更新；input-required/终态正常转
        queue.transition(taskId, state, { message: message?.status?.message });
        audit.append({
          actor: `agent:${task.member}`,
          lane: "a2a",
          target: task.target,
          taskId,
          outcome: state,
        }, validate.auditEvent);
        if (queue.isTerminal(state)) {
          notify?.({ event: { kind: "terminal", taskId, target: task.target, state } });
        }
        sendEnvelope(ws, { v: 1, kind: "ack", msgId: envelope.msgId, dedup: false });
      }
      return;
    }

    if (kind === "artifact-update") {
      const task = queue.get(taskId);
      if (!task) {
        rejectAgentFrame(ws, envelope, "artifact-task-not-found");
        return;
      }
      if (task.member !== agentId) {
        rejectAgentFrame(ws, envelope, "task-member-mismatch", task);
        return;
      }
      const artifactId = artifactIdFrom(message.artifact);
      const metadata = artifactId ? artifacts?.metadata(artifactId) : null;
      if (!metadata || metadata.taskId !== task.id || metadata.member !== task.member || metadata.target !== task.target) {
        rejectAgentFrame(ws, envelope, "artifact-metadata-mismatch", task);
        return;
      }
      if (!(task.artifacts ?? []).some((artifact) => artifact.metadata?.artifactId === artifactId)) {
        queue.addArtifact(taskId, {
          name: metadata.name,
          parts: [{ kind: "file", uri: `/api/artifacts/${artifactId}` }],
          metadata: {
            artifactId,
            taskId: metadata.taskId,
            member: metadata.member,
            target: metadata.target,
            digest: metadata.digest,
            size: metadata.size,
          },
        });
      }
      audit.append({
        actor: `agent:${task.member}`,
        lane: "a2a",
        target: task.target,
        taskId,
        outcome: task.state,
        detail: { reason: "artifact-notified", artifactId },
      }, validate.auditEvent);
      sendEnvelope(ws, { v: 1, kind: "ack", msgId: envelope.msgId, dedup: false });
      return;
    }
  }

  function rejectAgentFrame(ws, envelope, reason, task = null) {
    const agentId = boundAgentId.get(ws) ?? authenticatedAgentId.get(ws) ?? "unknown";
    audit.append({
      actor: `agent:${agentId}`,
      lane: "ops",
      target: task?.target ?? "hub",
      ...(task?.id ? { taskId: task.id } : {}),
      outcome: "rejected",
      detail: { reason, envelopeTaskId: envelope.taskId, expectedMember: task?.member },
    }, validate.auditEvent);
    log.error?.(`拒绝 agent 上行：${reason}（agent=${agentId}, task=${envelope.taskId}）`);
    try { ws.close(1008, reason); } catch { /* noop */ }
  }

  /** 下发钩子（server.mjs delegate）：message/send 委派 或 tasks/cancel，走隧道 a2a 帧。 */
  async function delegate({ task, vars = {}, cancel = false, resume = false }) {
    const member = registry.resolve(task.skillId);
    if (!member?.conn) {
      log.error?.(`下发失败：${task.skillId} 成员离线`);
      return { ok: false, reason: "member-offline" };
    }
    if (cancel) {
      sendEnvelope(member.conn, {
        v: 1,
        kind: "a2a",
        msgId: newMsgId(),
        taskId: task.id,
        ts: new Date().toISOString(),
        body: { jsonrpc: "2.0", method: "tasks/cancel", params: { id: task.id } },
      });
      return { ok: true };
    }
    if (resume) {
      // M4 F3 审批门恢复：agent 侧 input-required → working，继续执行
      sendEnvelope(member.conn, {
        v: 1,
        kind: "a2a",
        msgId: newMsgId(),
        taskId: task.id,
        ts: new Date().toISOString(),
        body: { jsonrpc: "2.0", method: "message/resume", params: { id: task.id, decision: "approve" } },
      });
      return { ok: true };
    }
    sendEnvelope(member.conn, {
      v: 1,
      kind: "a2a",
      msgId: newMsgId(),
      taskId: task.id,
      ts: new Date().toISOString(),
      body: {
        jsonrpc: "2.0",
        id: `req-${task.id}`,
        method: "message/send",
        params: {
          message: {
            messageId: `msg-${task.id}`,
            role: "user",
            parts: [{ kind: "text", text: `run ${task.skillId}${Object.keys(vars).length ? ` ${JSON.stringify(vars)}` : ""}` }],
            contextId: task.contextId || task.id,
            taskId: task.id,
          },
        },
      },
    });
    queue.transition(task.id, "working");
    return { ok: true };
  }

  function opsFrame(body) {
    return { v: 1, kind: "ops", msgId: newMsgId(), ts: new Date().toISOString(), body };
  }

  function majorOf(version) {
    return String(version).split(".")[0];
  }

  function artifactIdFrom(artifact) {
    const fromMetadata = String(artifact?.metadata?.artifactId ?? "");
    if (/^art_[a-f0-9]{32}$/.test(fromMetadata)) return fromMetadata;
    for (const part of Array.isArray(artifact?.parts) ? artifact.parts : []) {
      const match = String(part?.uri ?? "").match(/^\/api\/artifacts\/(art_[a-f0-9]{32})$/);
      if (match) return match[1];
    }
    return "";
  }

  return { wss, delegate, set onMemberOnline(fn) { callbacks.onMemberOnline = fn; }, get onMemberOnline() { return callbacks.onMemberOnline; } };
}
