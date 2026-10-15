/**
 * M3 通知与自动化规则完备化（PRD-3）测试：
 * F1/F2 渠道与策略：Bark 降级链、per-target notify 过滤（on-failure 成功不通知）
 * 频控 digest：窗口内合并计数，到期追发汇总（增量不丢）
 * F4 webhook：鉴权、审计落流水、规则联动（webhook-X → run target）
 * F3 member-event 规则源：member-online/offline → run target
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNotify } from "../src/notify.mjs";
import { createHub } from "../src/main.mjs";
import { bootstrapTestAuth, configureTestAgentTokens } from "./test-auth.mjs";

function tmpStateDir() {
  return mkdtempSync(join(tmpdir(), "novoard-m3-"));
}

/** 假 secrets：内存键值，覆盖 get/has。 */
function fakeSecrets(data = {}) {
  return {
    get(field) { return data[field] ?? ""; },
    has(field) { return !!data[field]; },
  };
}

const CARD = (skillOverrides = {}) => ({
  name: "mac-work",
  description: "工位 Mac",
  version: "1.0.0",
  capabilities: { streaming: false, pushNotifications: true },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text", "file"],
  skills: [{
    id: "smoke-test",
    name: "冒烟",
    description: "echo ok",
    tags: ["t"],
    ...skillOverrides,
  }],
});

test("notify 单元：Bark 降级链——企微全缺时走 Bark", async () => {
  const barkCalls = [];
  const secrets = fakeSecrets({ barkUrl: "https://bark.example.com", barkDeviceKey: "devkey123" });
  const notify = createNotify({
    secrets,
    bot: null,
    fetchImpl: async (url) => {
      barkCalls.push(String(url));
      return { ok: true };
    },
  });
  await notify.emit({ event: { kind: "terminal", target: "smoke-test", state: "failed", taskId: "t-1", reason: "x" } });
  assert.equal(barkCalls.length, 1);
  assert.match(barkCalls[0], /bark\.example\.com\/devkey123$/);
});

test("notify 单元：policy=on-failure 成功终态不发送，失败终态发送", async () => {
  const sent = [];
  const notify = createNotify({ secrets: fakeSecrets(), bot: { push: async ({ markdown }) => { sent.push(markdown); return true; } } });
  await notify.emit({ event: { kind: "terminal", target: "a", state: "completed", taskId: "t-1" }, policy: "on-failure" });
  assert.equal(sent.length, 0);
  await notify.emit({ event: { kind: "terminal", target: "a", state: "failed", taskId: "t-2" }, policy: "on-failure" });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /任务终态/);
  await notify.emit({ event: { kind: "terminal", target: "a", state: "completed", taskId: "t-3" }, policy: "never" });
  assert.equal(sent.length, 1);
});

test("notify 单元：频控 digest——窗口内合并计数，到期追发汇总", async () => {
  const sent = [];
  const notify = createNotify({ secrets: fakeSecrets(), bot: { push: async ({ markdown }) => { sent.push(markdown); return true; } } });
  // 首条：立即发
  await notify.emit({ event: { kind: "terminal", target: "a", state: "failed", taskId: "t-1" } });
  assert.equal(sent.length, 1);
  // 窗口内两条：吞计数
  await notify.emit({ event: { kind: "terminal", target: "a", state: "failed", taskId: "t-2" } });
  await notify.emit({ event: { kind: "terminal", target: "a", state: "failed", taskId: "t-3" } });
  assert.equal(sent.length, 1);
  assert.equal(notify._test.windows.get("terminal:a:failed").suppressed, 2);
  // 手动触发 digest flush（测试不等 60s）
  notify._test.flushDigest("terminal:a:failed");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, 2);
  assert.match(sent[1], /频控合并/);
  assert.match(sent[1], /2 条同类事件/);
});

test("hub 装配：terminal 通知走 policyOf 查表（x-novoard-notify: on-failure）", async () => {
  const stateDir = tmpStateDir();
  const hub = await createHub({ stateDir, port: 0, offlineSweepMs: 60_000 });
  try {
    const sent = [];
    hub.registry.register({ agentId: "mac-work", card: CARD({ "x-novoard-notify": "on-failure" }) });
    // on-failure + completed → 不发送（无窗口开启）
    await hub.notify({ event: { kind: "terminal", target: "smoke-test", state: "completed", taskId: "task-x-1" } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(hub.notifyImpl._test.windows.size, 0);
    // failed → 开窗发送（首条立即发，通道全缺 → stub 日志但窗口开启）
    await hub.notify({ event: { kind: "terminal", target: "smoke-test", state: "failed", taskId: "task-x-2" } });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(hub.notifyImpl._test.windows.has("terminal:smoke-test:failed"));
  } finally {
    await new Promise((r) => hub.server.close(r));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("hub 装配：webhook 入口鉴权 + 规则联动 webhook-source → run target", async () => {
  const stateDir = tmpStateDir();
  // rules.yaml：webhook-deploy-notify → smoke-test
  const rulesDir = join(stateDir, "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, "rules.yaml"), `rules:\n  - when: { event: webhook-deploy-notify }\n    then: { target: smoke-test }\n`);
  const hub = await createHub({ stateDir: join(stateDir, "hub"), rulesPath: join(rulesDir, "rules.yaml"), port: 0, offlineSweepMs: 60_000 });
  const port = hub.server.address().port;
  const auth = await bootstrapTestAuth(hub);
  try {
    hub.registry.register({ agentId: "mac-work", card: CARD() });
    hub.registry.markOffline("mac-work"); // 离线：规则动作走离线分流（smoke-test 无 offline 标注 → reject），验证链路而非成功执行

    // 无鉴权拒
    let res = await fetch(`http://127.0.0.1:${port}/api/webhook/deploy-notify`, { method: "POST", body: "{}" });
    assert.equal(res.status, 401);

    // 带鉴权：受理 + 审计 + 规则触发（离线 → rejected 审计）
    res = await fetch(`http://127.0.0.1:${port}/api/webhook/deploy-notify`, {
      method: "POST",
      headers: auth.headers,
      body: JSON.stringify({ action: "deploy-done", version: "1.2.3" }),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.accepted, true);
    await new Promise((r) => setTimeout(r, 80));
    const events = hub.audit.list();
    const webhookEvent = events.find((e) =>
      e.actor === `pat:test-owner/${auth.pat.name}`
      && e.outcome === "accepted"
      && e.detail?.source === "deploy-notify");
    assert.ok(webhookEvent);
    assert.equal(webhookEvent.detail.body, undefined, "webhook 正文不得进入审计");
    assert.match(webhookEvent.detail.bodySha256, /^[a-f0-9]{64}$/);
    assert.ok(events.some((e) => e.actor === `pat:test-owner/${auth.pat.name}` && e.target === "smoke-test" && e.outcome === "rejected" && e.detail?.reason === "member-offline"));
  } finally {
    await new Promise((r) => hub.server.close(r));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("webhook 规则动作不得越过调用 PAT 的 target 范围", async () => {
  const stateDir = tmpStateDir();
  const rulesDir = join(stateDir, "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, "rules.yaml"), "rules:\n  - when: { event: webhook-private }\n    then: { target: secret-target }\n");
  const hub = await createHub({
    stateDir: join(stateDir, "hub"),
    rulesPath: join(rulesDir, "rules.yaml"),
    port: 0,
    offlineSweepMs: 60_000,
    log: { info() {}, error() {} },
  });
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  try {
    const auth = await bootstrapTestAuth(hub);
    const role = await hub.identity.createRole(auth.owner, {
      id: "webhook-limited",
      name: "Webhook Limited",
      permissions: ["webhooks.invoke"],
      targetAllow: ["mac-work/allowed-target"],
      targetDeny: [],
    });
    const user = await hub.identity.createUser(auth.owner, {
      username: "hook-limited",
      password: "limited webhook password",
      roleId: role.id,
      forcePasswordChange: false,
    });
    const login = await hub.identity.login({
      username: user.username,
      password: "limited webhook password",
    });
    const principal = await hub.identity.authenticateSession(login.token);
    const issued = await hub.identity.createPat(principal, {
      name: "limited-hook",
      scopes: ["webhooks.invoke"],
      targetAllow: ["mac-work/allowed-target"],
    });
    const sent = [];
    hub.registry.register({
      agentId: "mac-work",
      card: CARD({ id: "secret-target", name: "Secret", description: "Secret" }),
      conn: { readyState: 1, send: (raw) => sent.push(JSON.parse(String(raw))) },
    });

    const response = await fetch(`${base}/api/webhook/private`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issued.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ secret: "must-not-run" }),
    });
    assert.equal(response.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sent.length, 0);
    assert.equal(hub.queue.list().some((task) => task.target === "secret-target"), false);
    assert.ok(hub.audit.list().some((event) =>
      event.target === "secret-target"
      && event.outcome === "rejected"
      && event.detail?.reason === "rule-target-scope-denied"));
  } finally {
    await new Promise((resolve) => hub.server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("webhook 规则续链继承 PAT target 范围，并在 PAT 吊销后 fail-closed", async () => {
  const stateDir = tmpStateDir();
  const rulesDir = join(stateDir, "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, "rules.yaml"), `rules:
  - when: { event: webhook-chain }
    then: { target: allowed-target }
  - when: { event: task-terminal, target: allowed-target, state: completed }
    then: { target: secret-target }
`);
  const hub = await createHub({
    stateDir: join(stateDir, "hub"),
    rulesPath: join(rulesDir, "rules.yaml"),
    port: 0,
    offlineSweepMs: 60_000,
    log: { info() {}, error() {} },
  });
  const port = hub.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  configureTestAgentTokens(hub, { "mac-work": "agt_rule_chain_123456" });
  let ws;
  try {
    const auth = await bootstrapTestAuth(hub);
    const role = await hub.identity.createRole(auth.owner, {
      id: "webhook-chain-limited",
      name: "Webhook Chain Limited",
      permissions: ["webhooks.invoke"],
      targetAllow: ["mac-work/allowed-target"],
      targetDeny: [],
    });
    const user = await hub.identity.createUser(auth.owner, {
      username: "hook-chain",
      password: "limited webhook chain password",
      roleId: role.id,
      forcePasswordChange: false,
    });
    const login = await hub.identity.login({
      username: user.username,
      password: "limited webhook chain password",
    });
    const principal = await hub.identity.authenticateSession(login.token);
    const firstPat = await hub.identity.createPat(principal, {
      name: "chain-scope",
      scopes: ["webhooks.invoke"],
      targetAllow: ["mac-work/allowed-target"],
    });
    const secondPat = await hub.identity.createPat(principal, {
      name: "chain-revoked",
      scopes: ["webhooks.invoke"],
      targetAllow: ["mac-work/allowed-target"],
    });

    const { WebSocket } = await import("ws");
    ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, {
      headers: { Authorization: "Bearer agt_rule_chain_123456" },
    });
    const received = [];
    ws.on("message", (raw) => received.push(JSON.parse(String(raw))));
    await once(ws, "open");
    const card = {
      ...CARD({ id: "allowed-target", name: "Allowed", description: "Allowed" }),
      skills: [
        { id: "allowed-target", name: "Allowed", description: "Allowed", tags: [] },
        { id: "secret-target", name: "Secret", description: "Secret", tags: [] },
      ],
    };
    ws.send(JSON.stringify({
      v: 1,
      kind: "ops",
      msgId: "e-chain-hello",
      ts: new Date().toISOString(),
      body: {
        type: "agent.hello",
        contractVersion: "2.0",
        agentId: "mac-work",
        card,
        inFlightTaskIds: [],
      },
    }));
    await waitFor(() => received.some((frame) => frame.body?.type === "agent.hello.ack"));

    const invoke = (token) => fetch(`${base}/api/webhook/chain`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "run" }),
    });
    const complete = (taskId, suffix) => ws.send(JSON.stringify({
      v: 1,
      kind: "a2a",
      msgId: `e-chain-${suffix}`,
      taskId,
      ts: new Date().toISOString(),
      body: {
        jsonrpc: "2.0",
        method: "message/notification",
        params: {
          message: {
            messageId: `m-chain-${suffix}`,
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

    assert.equal((await invoke(firstPat.token)).status, 202);
    await waitFor(() => hub.queue.list().filter((task) => task.target === "allowed-target").length === 1);
    const firstTask = hub.queue.list().find((task) => task.target === "allowed-target");
    assert.deepEqual(firstTask.authorization, {
      kind: "pat",
      userId: user.id,
      patId: firstPat.pat.id,
    });
    complete(firstTask.id, "scope");
    await waitFor(() => hub.audit.list().some((event) =>
      event.target === "secret-target"
      && event.detail?.reason === "rule-target-scope-denied"));

    assert.equal((await invoke(secondPat.token)).status, 202);
    await waitFor(() => hub.queue.list().filter((task) => task.target === "allowed-target").length === 2);
    const secondTask = hub.queue.list().find((task) =>
      task.target === "allowed-target" && task.id !== firstTask.id);
    await hub.identity.revokePat(auth.owner, secondPat.pat.id);
    complete(secondTask.id, "revoked");
    await waitFor(() => hub.audit.list().some((event) =>
      event.target === "secret-target"
      && event.detail?.reason === "rule-authorization-invalid"));

    assert.equal(hub.queue.list().some((task) => task.target === "secret-target"), false);
    assert.equal(received.some((frame) =>
      frame.kind === "a2a"
      && frame.body?.method === "message/send"
      && hub.queue.get(frame.taskId)?.target === "secret-target"), false);

    const tasksResponse = await fetch(`${base}/api/tasks`, { headers: auth.headers });
    const publicTasks = (await tasksResponse.json()).tasks;
    assert.ok(publicTasks.length >= 2);
    assert.ok(publicTasks.every((task) => !Object.hasOwn(task, "authorization")));
  } finally {
    ws?.terminate();
    await new Promise((resolve) => hub.server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("hub 装配：member-event 规则源——member-offline → run target", async () => {
  const stateDir = tmpStateDir();
  const rulesDir = join(stateDir, "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, "rules.yaml"), `rules:\n  - when: { event: member-offline, target: mac-work }\n    then: { target: smoke-test }\n`);
  const hub = await createHub({ stateDir: join(stateDir, "hub"), rulesPath: join(rulesDir, "rules.yaml"), port: 0, offlineSweepMs: 60_000 });
  try {
    hub.registry.register({ agentId: "mac-work", card: CARD() });
    hub.registry.markOffline("mac-work");
    // 模拟断连事件（tunnel close 钩子路径）：直接经 hub.notify 装配层进规则引擎
    await hub.notify({ event: { kind: "member-event", target: "mac-work", state: "offline" } });
    await new Promise((r) => setTimeout(r, 80));
    const events = hub.audit.list();
    assert.ok(events.some((e) => e.actor === "rule-engine" && e.detail?.reason?.includes("member-offline")));
  } finally {
    await new Promise((r) => hub.server.close(r));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("card 扩展字段：x-novoard-notify 随 skill 声明通过 hub 校验（card 派生由 agent 仓承载）", async () => {
  const { createFrameValidator } = await import("../src/frames.mjs");
  const validate = createFrameValidator();
  const card = {
    name: "mac-work",
    description: "工位 Mac · dev builder",
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: true },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text", "file"],
    skills: [
      { id: "smoke-test", name: "冒烟", description: "echo ok", tags: ["t"], "x-novoard-notify": "on-failure" },
    ],
  };
  assert.equal(validate.agentCard(card).ok, true);
  assert.equal(card.skills[0]["x-novoard-notify"], "on-failure");
});

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

function waitFor(predicate, timeoutMs = 3_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error("waitFor 超时"));
      setTimeout(tick, 20);
    };
    tick();
  });
}
