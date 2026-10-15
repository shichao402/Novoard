/**
 * 骨架冒烟测试（node --test）：
 * 1. schema 装载与信封校验（九张冻结基线可编译、合法/非法帧分流）
 * 2. 队列：入队落盘、终态不可逆、重启重放
 * 3. 注册表：注册/查表/离线语义（markOffline 留表）
 * 4. HTTP 门：trigger 受理、A2A 三方法、错误码字面、聚合 card
 * 5. 隧道：hello 注册、委派下发、上行终态、幂等去重
 * 全部内存态或 tmp 目录，不碰 .state/。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFrameValidator } from "../src/frames.mjs";
import { createTaskQueue } from "../src/queue.mjs";
import { createRegistry } from "../src/registry.mjs";
import { createAuditLog } from "../src/audit.mjs";
import { createSecrets } from "../src/secrets.mjs";
import { startServer } from "../src/server.mjs";
import { attachTunnel } from "../src/tunnel.mjs";
import { createHub } from "../src/main.mjs";
import { hashAgentToken } from "../src/agent-auth.mjs";
import { bootstrapTestAuth, configureTestAgentTokens } from "./test-auth.mjs";

function tmpStateDir() {
  return mkdtempSync(join(tmpdir(), "novoard-test-"));
}

const CARD = {
  name: "mac-work",
  description: "工位 Mac · dev builder",
  version: "1.0.0",
  capabilities: { streaming: false, pushNotifications: true },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text", "file"],
  skills: [
    { id: "dev-build-investm", name: "构建 InvestM dev", description: "pull → build → deploy；vars: repo, port", tags: ["dev"] },
  ],
};

const HELLO_BODY = {
  type: "agent.hello",
  contractVersion: "2.0",
  agentId: "mac-work",
  card: CARD,
  inFlightTaskIds: [],
};

test("schema 装载与信封校验", () => {
  const validate = createFrameValidator();
  const okEnvelope = { v: 1, kind: "a2a", msgId: "e-42", taskId: "task-20261012-001", ts: "2026-10-12T09:00:00Z", body: { jsonrpc: "2.0", method: "message/notification", params: {} } };
  assert.equal(validate.envelope(okEnvelope).ok, true);
  const badEnvelope = { v: 1, kind: "a2a", msgId: "bad", taskId: "task-x", ts: "t", body: {} };
  assert.equal(validate.envelope(badEnvelope).ok, false);
  assert.equal(validate.opsBody("agent.hello", HELLO_BODY).ok, true);
  assert.equal(validate.opsBody("unknown", {}).ok, false);
  assert.equal(validate.agentCard(CARD).ok, true);
  assert.equal(validate.auditEvent({ ts: "2026-10-12T09:00:00Z", actor: "human", lane: "a2a", target: "t", outcome: "submitted" }).ok, true);
});

test("队列：入队、终态不可逆、重启重放", () => {
  const dir = tmpStateDir();
  const q1 = createTaskQueue({ dir });
  const task = q1.submit({ skillId: "dev-build-investm", target: "dev-build-investm", member: "mac-work", actor: "human", lane: "a2a" });
  assert.match(task.id, /^task-\d{8}-\d{3}$/);
  assert.throws(() => q1.transition(task.id, "bogus"), (error) => error.code === "invalid-task-state");
  assert.equal(q1.get(task.id).state, "submitted");
  q1.transition(task.id, "working");
  assert.throws(() => q1.transition(task.id, "queued-offline"), (error) => error.code === "invalid-task-transition");
  q1.transition(task.id, "completed");
  assert.equal(q1.transitionChecked(task.id, "completed").changed, false);
  assert.throws(() => q1.transition(task.id, "failed"), (error) => error.code === "invalid-task-transition");

  const q2 = createTaskQueue({ dir }); // 重启重放
  assert.equal(q2.get(task.id).state, "completed");
  const t2 = q2.submit({ skillId: "x", target: "x" });
  assert.equal(t2.state, "submitted");
  const pending = q2.pendingAfterReboot();
  assert.ok(pending.some((t) => t.id === t2.id));
  rmSync(dir, { recursive: true, force: true });
});

test("队列：msgId 幂等窗口", () => {
  const dir = tmpStateDir();
  const q = createTaskQueue({ dir });
  assert.equal(q.seenMsg("e-1"), false);
  q.markMsg("e-1");
  assert.equal(q.seenMsg("e-1"), true);
  rmSync(dir, { recursive: true, force: true });
});

test("注册表：注册、查表、离线留表", () => {
  const validate = createFrameValidator();
  const registry = createRegistry({ validate });
  const r = registry.register({ agentId: "mac-work", card: CARD, conn: { readyState: 1 } });
  assert.equal(r.ok, true);
  assert.equal(registry.resolve("dev-build-investm").agentId, "mac-work");
  assert.equal(registry.knows("dev-build-investm"), true);

  // skill 冲突：另一成员挂同 id
  const CARD_B = { ...CARD, name: "mac-home", skills: [{ id: "dev-build-investm", name: "冲突", description: "" }] };
  const r2 = registry.register({ agentId: "mac-home", card: CARD_B });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /skill-conflict/);

  // 断线：转离线留表
  registry.markOffline("mac-work");
  assert.equal(registry.resolve("dev-build-investm"), null); // 离线 resolve 返回 null
  assert.equal(registry.knows("dev-build-investm"), true); // 但 knows 仍真 → 离线拒绝分流
  const agg = registry.aggregateCard();
  assert.equal(agg.skills.length, 1);
  assert.ok(agg["x-novoard-members"]["mac-work"]);
});

test("审计：落盘、校验、查询", () => {
  const dir = tmpStateDir();
  const validate = createFrameValidator();
  const audit = createAuditLog({ dir });
  audit.append({ actor: "human", lane: "a2a", target: "dev-build-investm", taskId: "task-20261012-001", outcome: "submitted" }, validate.auditEvent);
  const list = audit.list();
  assert.equal(list.length, 1);
  assert.throws(() => {
    audit.append({ actor: "", lane: "bad-lane", target: "", outcome: "nope" }, validate.auditEvent);
  });
  rmSync(dir, { recursive: true, force: true });
});

test("secrets：本机私密配置、列表字段与环境回退", () => {
  const dir = tmpStateDir();
  const s = createSecrets({
    dir,
    env: {
      NOVOARD_AGENT_TOKEN_HASHES: JSON.stringify({
        "mac-work": hashAgentToken("agt_a"),
        "mac-home": hashAgentToken("agt_b"),
      }),
      NOVOARD_WECOM_ALLOWED_USER_IDS: "U1,U2",
      NOVOARD_WECOM_NOTIFY_CHAT_ID: "wr-notify",
    },
  });
  assert.deepEqual(s.get("agentTokenHashes"), {
    "mac-work": hashAgentToken("agt_a"),
    "mac-home": hashAgentToken("agt_b"),
  });
  assert.deepEqual(s.get("wecomAllowedUserIds"), ["U1", "U2"]);
  assert.equal(s.get("wecomNotifyChatId"), "wr-notify");
  assert.equal(s.has("wecomWebhook"), false);
  s.set({ wecomAllowedChatIds: ["wr-one"] });
  assert.deepEqual(s.get("wecomAllowedChatIds"), ["wr-one"]);
  s.set({ agentTokenHashes: {}, wecomAllowedUserIds: [], wecomNotifyChatId: "" });
  assert.deepEqual(s.get("agentTokenHashes"), {}, "显式撤销后不得回退环境变量 token");
  assert.deepEqual(s.get("wecomAllowedUserIds"), [], "显式空白名单不得回退环境变量");
  assert.equal(s.get("wecomNotifyChatId"), "", "显式空字符串不得回退环境变量");
  rmSync(dir, { recursive: true, force: true });
});

test("secrets：agentId → tokenHash 映射严格校验", () => {
  const dir = tmpStateDir();
  writeFileSync(join(dir, "secrets.json"), JSON.stringify({
    agentTokenHashes: {
      "mac-work": hashAgentToken("agt_macwork_token_123456"),
      "mac-home": hashAgentToken("agt_machome_token_654321"),
    },
  }));
  const s = createSecrets({ dir, env: {} });
  assert.deepEqual(Object.keys(s.get("agentTokenHashes")), ["mac-work", "mac-home"]);
  assert.equal(s.has("agentTokenHashes"), true);
  rmSync(dir, { recursive: true, force: true });
});

async function bootHub({ agentTokens = { "mac-work": "agt_test_token_12345678" } } = {}) {
  const stateDir = tmpStateDir();
  const hub = await createHub({ stateDir, port: 0 });
  const port = hub.server.address?.().port;
  configureTestAgentTokens(hub, agentTokens);
  const auth = await bootstrapTestAuth(hub);
  return {
    hub,
    auth,
    port,
    stateDir,
    close: () => new Promise((resolve) => hub.server.close(resolve)),
  };
}

test("HTTP 门：trigger 受理与离线拒绝分流", async () => {
  const { hub, auth, port, stateDir, close } = await bootHub();
  try {
    // 无成员时：no-such-skill → 404
    let res = await fetch(`http://127.0.0.1:${port}/api/trigger`, {
      method: "POST",
      headers: auth.headers,
      body: JSON.stringify({ target: "dev-build-investm" }),
    });
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /not remotely triggerable/);

    // 注册成员（直接走 registry，跳过隧道握手细节）
    hub.registry.register({ agentId: "mac-work", card: CARD, conn: { readyState: 1, send: () => {} } });
    res = await fetch(`http://127.0.0.1:${port}/api/trigger`, {
      method: "POST",
      headers: auth.headers,
      body: JSON.stringify({ target: "dev-build-investm" }),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.match(body.taskId, /^task-/);
    assert.equal(body.state, "submitted");

    // 成员离线：knows=true → member-offline 拒绝（非 404）
    hub.registry.markOffline("mac-work");
    res = await fetch(`http://127.0.0.1:${port}/api/trigger`, {
      method: "POST",
      headers: auth.headers,
      body: JSON.stringify({ target: "dev-build-investm" }),
    });
    assert.equal(res.status, 202);
    assert.equal((await res.json()).reason, "member-offline");
  } finally {
    await close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("A2A 门：三方法与错误码字面", async () => {
  const { hub, auth, port, stateDir, close } = await bootHub();
  try {
    hub.registry.register({ agentId: "mac-work", card: CARD, conn: { readyState: 1, send: () => {} } });
    const headers = auth.headers;

    // message/send → 受理
    let res = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: "req-1", method: "message/send", params: { message: { messageId: "msg-1", role: "user", parts: [{ kind: "text", text: "dev-build-investm" }], contextId: "", taskId: "" } } }),
    });
    let body = await res.json();
    assert.equal(body.result.status.state, "submitted");
    const taskId = body.result.id;

    // tasks/get
    res = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: "req-2", method: "tasks/get", params: { id: taskId } }),
    });
    body = await res.json();
    assert.equal(body.result.id, taskId);
    assert.equal(body.result.kind, "task");

    // tasks/get 查无 → -32001 字面
    res = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: "req-3", method: "tasks/get", params: { id: "task-nope" } }),
    });
    body = await res.json();
    assert.equal(body.error.code, -32001);
    assert.equal(body.error.message, "Task not found");

    // tasks/cancel → canceled
    res = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: "req-4", method: "tasks/cancel", params: { id: taskId } }),
    });
    body = await res.json();
    assert.equal(body.result.status.state, "canceled");

    // 已终态再取消 → -32002
    res = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: "req-5", method: "tasks/cancel", params: { id: taskId } }),
    });
    body = await res.json();
    assert.equal(body.error.code, -32002);

    // expose: local（聚合 card 查无）→ -32004
    res = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: "req-6", method: "message/send", params: { message: { parts: [{ kind: "text", text: "local-only-target" }] } } }),
    });
    body = await res.json();
    assert.equal(body.error.code, -32004);
    assert.match(body.error.message, /target not remotely triggerable/);

    // message/stream（M4 已实现）：无 id → TASK_NOT_FOUND（-32001），不再是不支持
    res = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: "req-7", method: "message/stream", params: {} }),
    });
    body = await res.json();
    assert.equal(body.error.code, -32001);

    // 聚合 card 必须鉴权，并按调用者 target 范围过滤
    res = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
    assert.equal(res.status, 401);
    res = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`, { headers });
    const card = await res.json();
    assert.equal(card.skills.length, 1);
    assert.equal(card.skills[0].id, "dev-build-investm");
    assert.ok(card["x-novoard-members"]["mac-work"]);
  } finally {
    await close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("A2A 门：无 key → 401", async () => {
  const { hub, port, stateDir, close } = await bootHub();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "x", method: "tasks/get", params: { id: "task-x" } }),
    });
    assert.equal(res.status, 401);
  } finally {
    await close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("隧道：hello 注册、上行终态、幂等去重", async () => {
  const { hub, auth, port, stateDir, close } = await bootHub();
  try {
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, { headers: { Authorization: "Bearer agt_test_token_12345678" } });
    const received = [];
    ws.on("message", (raw) => received.push(JSON.parse(String(raw))));

    await once(ws, "open");
    // hello（信封包裹，契约 §4.2）
    ws.send(JSON.stringify({ v: 1, kind: "ops", msgId: "e-1", ts: new Date().toISOString(), body: HELLO_BODY }));
    await waitFor(() => received.some((f) => f.body?.type === "agent.hello.ack"));
    assert.equal(hub.registry.resolve("dev-build-investm")?.agentId, "mac-work");

    // 触发任务（HTTP 门）
    const res = await fetch(`http://127.0.0.1:${port}/api/trigger`, {
      method: "POST",
      headers: auth.headers,
      body: JSON.stringify({ target: "dev-build-investm" }),
    });
    const { taskId } = await res.json();
    // 委派下发帧到达 agent
    await waitFor(() => received.some((f) => f.kind === "a2a" && f.taskId === taskId));
    const delegated = received.find((f) => f.kind === "a2a" && f.taskId === taskId);
    assert.equal(delegated.body.method, "message/send");
    assert.equal(hub.queue.get(taskId).state, "working");

    // 上行终态（agent → hub）
    ws.send(JSON.stringify({
      v: 1, kind: "a2a", msgId: "e-100", taskId, ts: new Date().toISOString(),
      body: { jsonrpc: "2.0", method: "message/notification", params: { message: { messageId: "msg-x", role: "agent", parts: [], contextId: taskId, taskId, kind: "status-update", status: { state: "completed", timestamp: new Date().toISOString() } } } },
    }));
    await waitFor(() => hub.queue.get(taskId).state === "completed");
    assert.equal(hub.queue.get(taskId).state, "completed");

    // 同 msgId 重发 → dedup ack，且状态不被重复处理（仍是 completed，审计只一条终态）
    const auditBefore = hub.audit.list().filter((e) => e.taskId === taskId && e.outcome === "completed").length;
    ws.send(JSON.stringify({
      v: 1, kind: "a2a", msgId: "e-100", taskId, ts: new Date().toISOString(),
      body: { jsonrpc: "2.0", method: "message/notification", params: { message: { messageId: "msg-x", role: "agent", parts: [], contextId: taskId, taskId, kind: "status-update", status: { state: "failed", timestamp: new Date().toISOString() } } } },
    }));
    await waitFor(() => received.some((f) => f.kind === "ack" && f.msgId === "e-100" && f.dedup === true));
    assert.equal(hub.queue.get(taskId).state, "completed"); // 重放未翻转终态
    const auditAfter = hub.audit.list().filter((e) => e.taskId === taskId && e.outcome === "completed").length;
    assert.equal(auditBefore, auditAfter);

    // 新 msgId 的相同终态只 ACK，不重复审计；冲突终态 fail-closed，且不产生错误终态副作用
    ws.send(JSON.stringify({
      v: 1, kind: "a2a", msgId: "e-101", taskId, ts: new Date().toISOString(),
      body: { jsonrpc: "2.0", method: "message/notification", params: { message: { messageId: "msg-y", role: "agent", parts: [], contextId: taskId, taskId, kind: "status-update", status: { state: "completed", timestamp: new Date().toISOString() } } } },
    }));
    await waitFor(() => received.some((f) => f.kind === "ack" && f.msgId === "e-101"));
    assert.equal(hub.audit.list().filter((e) => e.taskId === taskId && e.outcome === "completed").length, auditAfter);

    const closed = once(ws, "close");
    ws.send(JSON.stringify({
      v: 1, kind: "a2a", msgId: "e-102", taskId, ts: new Date().toISOString(),
      body: { jsonrpc: "2.0", method: "message/notification", params: { message: { messageId: "msg-z", role: "agent", parts: [], contextId: taskId, taskId, kind: "status-update", status: { state: "failed", timestamp: new Date().toISOString() } } } },
    }));
    await closed;
    assert.equal(hub.queue.get(taskId).state, "completed");
    assert.equal(hub.audit.list().filter((e) => e.taskId === taskId && e.outcome === "failed").length, 0);
  } finally {
    await close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("隧道：canceled 后冲突 completed 不写终态审计或触发规则", async () => {
  const stateDir = tmpStateDir();
  const rulesPath = join(stateDir, "rules.yaml");
  writeFileSync(rulesPath, `rules:
  - when: { event: task-terminal, target: dev-build-investm, state: completed }
    then: { target: downstream-target }
`);
  const hub = await createHub({
    stateDir,
    port: 0,
    rulesPath,
    log: { info() {}, error() {} },
  });
  configureTestAgentTokens(hub, { "mac-work": "agt_terminal_conflict_123456" });
  const auth = await bootstrapTestAuth(hub);
  const port = hub.server.address().port;
  let ws;
  try {
    const { WebSocket } = await import("ws");
    ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, {
      headers: { Authorization: "Bearer agt_terminal_conflict_123456" },
    });
    const received = [];
    ws.on("message", (raw) => received.push(JSON.parse(String(raw))));
    await once(ws, "open");
    ws.send(JSON.stringify({
      v: 1,
      kind: "ops",
      msgId: "e-conflict-hello",
      ts: new Date().toISOString(),
      body: {
        ...HELLO_BODY,
        card: {
          ...CARD,
          skills: [
            ...CARD.skills,
            { id: "downstream-target", name: "下游", description: "不应触发", tags: [] },
          ],
        },
      },
    }));
    await waitFor(() => received.some((frame) => frame.body?.type === "agent.hello.ack"));

    let response = await fetch(`http://127.0.0.1:${port}/api/trigger`, {
      method: "POST",
      headers: auth.headers,
      body: JSON.stringify({ target: "dev-build-investm" }),
    });
    const { taskId } = await response.json();
    await waitFor(() => hub.queue.get(taskId)?.state === "working");

    response = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: "POST",
      headers: auth.headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "cancel-conflict",
        method: "tasks/cancel",
        params: { id: taskId },
      }),
    });
    assert.equal((await response.json()).result.status.state, "canceled");

    const closed = once(ws, "close");
    ws.send(JSON.stringify({
      v: 1,
      kind: "a2a",
      msgId: "e-conflict-completed",
      taskId,
      ts: new Date().toISOString(),
      body: {
        jsonrpc: "2.0",
        method: "message/notification",
        params: {
          message: {
            messageId: "m-conflict-completed",
            role: "agent",
            parts: [],
            contextId: taskId,
            taskId,
            kind: "status-update",
            status: { state: "completed", timestamp: new Date().toISOString() },
          },
        },
      },
    }));
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(hub.queue.get(taskId).state, "canceled");
    assert.equal(hub.audit.list().some((event) =>
      event.taskId === taskId && event.outcome === "completed"), false);
    assert.equal(hub.queue.list().some((task) => task.target === "downstream-target"), false);
  } finally {
    ws?.terminate();
    await new Promise((resolve) => hub.server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("隧道：心跳与断线转离线", async () => {
  const { hub, port, stateDir, close } = await bootHub();
  try {
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, { headers: { Authorization: "Bearer agt_test_token_12345678" } });
    await once(ws, "open");
    ws.send(JSON.stringify({ v: 1, kind: "ops", msgId: "e-1", ts: new Date().toISOString(), body: HELLO_BODY }));
    await waitFor(() => hub.registry.resolve("dev-build-investm") !== null);
    ws.close();
    await waitFor(() => hub.registry.resolve("dev-build-investm") === null);
    assert.equal(hub.registry.knows("dev-build-investm"), true); // 离线留表
  } finally {
    await close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function once(ws, event) {
  return new Promise((resolve) => ws.once(event, resolve));
}

function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor 超时"));
      setTimeout(tick, 20);
    };
    tick();
  });
}
