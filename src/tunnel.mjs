/**
 * 出站隧道服务端（契约 §4）：agent 出站 wss 长连接，Bearer agent token 鉴权（§8 分池）。
 * hub 不对 agent 开任何入站端口（ADR-0003 出站纪律）。
 * 帧分车道：ops 帧（hello/ping/telemetry/card.update）旁路不建 task；a2a 帧走 task 生命周期。
 * 幂等：a2a 上行按 msgId 去重，重复帧回 dedup ack（契约 §4.4 第 3 条）。
 * card.update 的身份来自连接绑定（帧本身不带 agentId，schema 如此），冒用即无效。
 */
import { WebSocketServer } from "ws";
import { lostMessage } from "./queue.mjs";
import { newMsgId } from "./registry.mjs";

export const CONTRACT_VERSION = "2.1";
const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 60_000;
const AGENT_REPORTED_STATES = new Set(["working", "input-required", "completed", "failed", "canceled"]);
const LOCAL_MIRROR_STATES = new Set(["completed", "failed", "canceled", "rejected"]);

export function attachTunnel({ server, registry, queue, audit, artifacts, members, validate, notify, log = console }) {
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
    const agentId = token ? members.authenticate(token) : null;
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
      try {
        handleFrame(ws, envelope, (id) => {
          agentId = id;
        });
      } catch (error) {
        log.error?.(`处理 agent 帧失败：${error.message}`);
        if (envelope.kind === "a2a") rejectAgentFrame(ws, envelope, error.code ?? "invalid-agent-frame");
        else {
          try { ws.close(1008, "invalid-agent-frame"); } catch { /* noop */ }
        }
      }
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
    if (type === "notify.owner") {
      const id = boundAgentId.get(ws);
      const text = String(body?.text ?? "").trim();
      if (!id || !text) return;
      Promise.resolve(notify?.pushOwner?.({ from: id, text })).catch((error) => {
        log.error?.(`企微转发失败：${error.message}`);
      });
      if (envelope.msgId) sendEnvelope(ws, { v: 1, kind: "ack", msgId: envelope.msgId, dedup: false });
      return;
    }

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
      const previousBootId = registry.bootIdOf(body.agentId);
      sendEnvelope(ws, opsFrame({ type: "agent.hello.ack", inFlightTaskIds: body.inFlightTaskIds ?? [] }));
      reconcileCanceledTasks(ws, body.agentId, body.inFlightTaskIds ?? []);
      reconcileBoot(ws, body.agentId, body.bootId ?? "", body.inFlightTaskIds ?? [], previousBootId);
      if (body.bootId) registry.rememberBoot(body.agentId, body.bootId);
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

  function acceptsConversation(member) {
    return [...(member?.skills?.values?.() ?? [])].some((skill) => skill?.["x-novoard-kind"] === "agent");
  }

  /** 地址不对或不接受对话时，告诉发送方并留下审计，不拆掉它的连接。 */
  function refuseConversation(ws, envelope, reason) {
    const agentId = boundAgentId.get(ws) ?? authenticatedAgentId.get(ws) ?? "unknown";
    audit.append({
      actor: `agent:${agentId}`,
      lane: "ops",
      target: "hub",
      outcome: "rejected",
      detail: { reason, envelopeTaskId: envelope.taskId },
    }, validate.auditEvent);
    if (envelope.taskId) {
      sendEnvelope(ws, {
        v: 1,
        kind: "a2a",
        msgId: newMsgId(),
        taskId: envelope.taskId,
        ts: new Date().toISOString(),
        body: {
          jsonrpc: "2.0",
          method: "message/notification",
          params: {
            message: {
              role: "agent",
              parts: [{ kind: "text", text: reason }],
              contextId: envelope.taskId,
              taskId: envelope.taskId,
              kind: "status-update",
              status: { state: "rejected", message: reason, timestamp: new Date().toISOString() },
            },
          },
        },
      });
    }
    if (envelope.msgId) sendEnvelope(ws, { v: 1, kind: "ack", msgId: envelope.msgId, dedup: false });
  }

  /** 成员发给成员的自然语言。from 只用连接上的身份，忽略报文里自带的 from。 */
  function deliverConversation(ws, envelope) {
    const from = boundAgentId.get(ws);
    const message = envelope.body?.params?.message ?? {};
    const requested = message.metadata ?? {};
    const to = String(requested.to ?? "").trim();
    if (!from || !to || to === from) {
      refuseConversation(ws, envelope, "peer-address-invalid");
      return;
    }
    const target = registry.connected(to);
    if (!target || !acceptsConversation(target)) {
      refuseConversation(ws, envelope, "peer-unavailable");
      return;
    }
    const requestedContext = String(message.contextId || "").trim();
    const existing = requestedContext
      ? queue.list({ member: to }).find((task) => task.caller === from && task.contextId === requestedContext)
      : null;
    const task = existing ?? queue.submit({
      skillId: "converse",
      target: "converse",
      member: to,
      caller: from,
      actor: `agent:${from}`,
      lane: "a2a",
      contextId: requestedContext,
    });
    if (!task.contextId) task.contextId = task.id;
    const parts = Array.isArray(message.parts) && message.parts.length
      ? message.parts
      : [{ kind: "text", text: "" }];
    sendEnvelope(target.conn, {
      v: 1,
      kind: "a2a",
      msgId: newMsgId(),
      taskId: task.id,
      ts: new Date().toISOString(),
      body: {
        jsonrpc: "2.0",
        method: "message/send",
        params: {
          message: {
            messageId: `msg-${task.id}`,
            role: "user",
            parts,
            contextId: task.contextId,
            metadata: { lane: "agent", to, from },
          },
        },
      },
    });
    if (!existing) queue.transition(task.id, "working");
    if (envelope.msgId) sendEnvelope(ws, { v: 1, kind: "ack", msgId: envelope.msgId, dedup: false });
  }

  function relayToCaller(task, envelope) {
    if (!task?.caller) return;
    const caller = registry.connected(task.caller);
    if (!caller?.conn) return;
    const relay = structuredClone(envelope);
    const message = relay.body?.params?.message;
    if (message) {
      message.metadata = {
        ...(message.metadata ?? {}),
        lane: "agent",
        to: task.caller,
        from: task.member,
      };
    }
    sendEnvelope(caller.conn, relay);
  }

  function handleA2AUpstream(ws, envelope) {
    const body = envelope.body;
    const taskId = envelope.taskId;
    if (body?.method === "message/send" && body?.params?.message?.metadata?.lane === "agent") {
      deliverConversation(ws, envelope);
      return;
    }
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

    if (kind === "run-trace") {
      const task = queue.get(taskId);
      if (!task) {
        if (ws && envelope.msgId) sendEnvelope(ws, { v: 1, kind: "ack", msgId: envelope.msgId, dedup: false });
        return;
      }
      if (task.member !== agentId) {
        rejectAgentFrame(ws, envelope, "task-member-mismatch", task);
        return;
      }
      const appended = queue.appendTrace(taskId, message.trace);
      if (!appended.ok && appended.reason !== "task-not-found") {
        log.error?.(`运行记录被拒 ${taskId}：${appended.reason}`);
      }
      if (ws && envelope.msgId) sendEnvelope(ws, { v: 1, kind: "ack", msgId: envelope.msgId, dedup: appended.dedup === true });
      return;
    }

    if (kind === "status-update") {
      const state = message?.status?.state;
      const task = queue.get(taskId);
      if (!task && taskId.startsWith("task-local-")) {
        // 本地磁贴触发的终态镜像（ADR-0008）：hub 不建 task，但 ack + 落审计（本地闭环的可见性镜像）
        if (!LOCAL_MIRROR_STATES.has(state)) {
          rejectAgentFrame(ws, envelope, "invalid-local-task-state");
          return;
        }
        if (ws && envelope.msgId) sendEnvelope(ws, { v: 1, kind: "ack", msgId: envelope.msgId });
        audit.append({ actor: `agent:${agentId}`, lane: "a2a", target: "-", taskId, outcome: state, detail: { via: "tile-local-mirror" } }, validate.auditEvent);
        return;
      }
      if (!task) {
        rejectAgentFrame(ws, envelope, "task-not-found");
        return;
      }
      if (task && task.member !== agentId) {
        rejectAgentFrame(ws, envelope, "task-member-mismatch", task);
        return;
      }
      if (task?.caller) {
        relayToCaller(task, envelope);
        if (queue.isTerminal(task.state)) {
          if (ws && envelope.msgId) sendEnvelope(ws, { v: 1, kind: "ack", msgId: envelope.msgId, dedup: false });
          return;
        }
      }
      if (!AGENT_REPORTED_STATES.has(state)) {
        rejectAgentFrame(ws, envelope, "invalid-task-state", task);
        return;
      }
      let transition;
      try {
        // working 帧（步骤进度）幂等转：state 不变仅 message 更新；input-required/终态正常转。
        transition = queue.transitionChecked(taskId, state, { message: message?.status?.message });
      } catch (error) {
        rejectAgentFrame(ws, envelope, error.code ?? "invalid-task-transition", task);
        return;
      }
      if (!transition.changed) {
        sendEnvelope(ws, { v: 1, kind: "ack", msgId: envelope.msgId, dedup: false });
        return;
      }
      audit.append({
        actor: `agent:${task.member}`,
        lane: "a2a",
        target: task.target,
        taskId,
        outcome: state,
      }, validate.auditEvent);
      if (queue.isTerminal(state)) {
        Promise.resolve(notify?.({
          event: {
            kind: "terminal",
            taskId,
            target: task.target,
            state,
            actor: task.actor,
            authorization: task.authorization,
          },
        })).catch((error) => log.error?.(`终态通知或规则处理失败 ${taskId}：${error.message}`));
      }
      sendEnvelope(ws, { v: 1, kind: "ack", msgId: envelope.msgId, dedup: false });
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
    const member = registry.connected(task.member);
    if (!member?.conn) {
      log.error?.(`下发失败：任务 ${task.id} 绑定成员 ${task.member} 离线`);
      return { ok: false, reason: "member-offline" };
    }
    if (!cancel && !resume) stampRunLimits(task, member);
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

  function stampRunLimits(task, member) {
    const skill = member?.skills?.get?.(task.skillId) ?? member?.skills?.get?.(task.target);
    queue.stampLimits?.(task.id, {
      timeout: skill?.["x-novoard-timeout"] ?? "10m",
      lostTtl: skill?.["x-novoard-lost"]?.ttl ?? "10m",
      approvalTtl: skill?.["x-novoard-approval"]?.ttl ?? "",
    });
  }

  function ownedRuns(agentId) {
    return queue.list({ member: agentId }).filter((task) =>
      !task.caller && (task.state === "working" || task.state === "input-required"));
  }

  function failLost(task) {
    const current = queue.get(task.id) ?? task;
    if (queue.isTerminal(current.state)) return;
    queue.transition(current.id, "failed", { message: lostMessage(current) });
    audit.append({
      actor: "hub",
      lane: "a2a",
      target: current.target,
      taskId: current.id,
      outcome: "failed",
      detail: { reason: "agent-lost" },
    }, validate.auditEvent);
    const failed = queue.get(current.id);
    Promise.resolve(notify?.({
      event: {
        kind: "terminal",
        taskId: current.id,
        target: current.target,
        state: "failed",
        actor: current.actor,
        authorization: current.authorization,
        reason: "agent-lost",
      },
    })).catch((error) => log.error?.(`agent-lost 通知失败 ${current.id}：${error.message}`));
    return failed;
  }

  /**
   * bootId 对账（契约 §4.4）：
   * 没带 bootId 则保持 2.0 行为；Hub 不记得旧进程或进程没变，清单外的任务重新下发；
   * 进程变了且不在清单里，收成 agent-lost。清单里的任务保持原状。
   */
  function reconcileBoot(ws, agentId, bootId, inFlightTaskIds, previousBootId) {
    if (!bootId) return;
    const inFlight = new Set(inFlightTaskIds);
    const bootChanged = Boolean(previousBootId) && previousBootId !== bootId;
    for (const task of ownedRuns(agentId)) {
      if (inFlight.has(task.id)) continue;
      if (bootChanged) {
        failLost(task);
        continue;
      }
      delegate({ task, vars: task.vars ?? {} }).catch((error) => {
        log.error?.(`断线重发失败 ${task.id}：${error.message}`);
      });
    }
    void ws;
  }

  function reconcileCanceledTasks(ws, agentId, inFlightTaskIds) {
    for (const taskId of inFlightTaskIds) {
      const task = queue.get(taskId);
      if (!task || task.member !== agentId || task.state !== "canceled") continue;
      sendEnvelope(ws, {
        v: 1,
        kind: "a2a",
        msgId: newMsgId(),
        taskId: task.id,
        ts: new Date().toISOString(),
        body: { jsonrpc: "2.0", method: "tasks/cancel", params: { id: task.id } },
      });
    }
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
