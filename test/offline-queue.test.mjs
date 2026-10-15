/**
 * M2 离线策略 queue-with-ttl（契约 §1.1 / §5.1，PRD-2 F2）测试：
 * 1. reject（默认）：离线触发 → 202 rejected，不入队
 * 2. queue：离线触发 → 202 queued-offline + expiresAt，任务入队
 * 3. 成员上线 → hello 钩子自动补下发（submitted → queued-offline → working）
 * 4. TTL 到期 → sweeper 转 failed（offline-ttl-expired）+ 审计 + 通知
 * 5. 重启重放：queued-offline 任务恢复，owner 在线立即补下发
 * 6. card 透传：x-novoard-offline 随 skill 声明，hub 校验通过
 * 全部内存态或 tmp 目录，不碰 .state/。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTaskQueue } from "../src/queue.mjs";
import { createRegistry } from "../src/registry.mjs";
import { createFrameValidator } from "../src/frames.mjs";
import { createHub } from "../src/main.mjs";

function tmpStateDir() {
  return mkdtempSync(join(tmpdir(), "novoard-m2-"));
}

const CARD_QUEUE = {
  name: "mac-work",
  description: "工位 Mac · dev builder",
  version: "1.0.0",
  capabilities: { streaming: false, pushNotifications: true },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text", "file"],
  skills: [
    {
      id: "dev-build-investm",
      name: "构建 InvestM dev",
      description: "pull → build → deploy",
      tags: ["dev"],
      "x-novoard-offline": { policy: "queue", ttl: "30m" },
    },
  ],
};

const CARD_REJECT = {
  ...CARD_QUEUE,
  skills: [
    { id: "dev-build-investm", name: "构建 InvestM dev", description: "pull → build → deploy", tags: ["dev"] },
  ],
};

function cardWithSkill(skill) {
  return {
    name: "mac-work",
    description: "工位 Mac · dev builder",
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: true },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text", "file"],
    skills: [skill],
  };
}

async function bootHub({ agentTokens = ["agt_test_token_12345678"] } = {}) {
  const stateDir = tmpStateDir();
  const hub = await createHub({ stateDir, port: 0, offlineSweepMs: 50 });
  const port = hub.server.address?.()?.port;
  hub.secrets.set({ agentTokens, dashboardToken: "dash-pass-123456", clientKeys: ["with-key-abc123"] });
  return {
    hub,
    port,
    stateDir,
    close: () => new Promise((resolve) => hub.server.close(resolve)),
  };
}

test("queue 单元：markQueuedOffline / pendingOffline / isExpired", () => {
  const dir = tmpStateDir();
  const q = createTaskQueue({ dir });
  const task = q.submit({ skillId: "dev-build-investm", target: "dev-build-investm", member: "mac-work", actor: "human", lane: "a2a" });
  q.markQueuedOffline(task.id, Date.now() + 60_000);
  const queued = q.get(task.id);
  assert.equal(queued.state, "queued-offline");
  assert.ok(queued.expiresAt);
  assert.equal(q.pendingOffline().length, 1);
  assert.equal(q.isExpired(queued), false);

  // TTL 过去
  const expiredTask = q.submit({ skillId: "x", target: "x", member: "mac-work", actor: "human", lane: "a2a" });
  q.markQueuedOffline(expiredTask.id, Date.now() - 1000);
  assert.equal(q.isExpired(q.get(expiredTask.id)), true);

  // working 翻转清掉 TTL 字段
  q.transition(task.id, "working");
  assert.equal(q.get(task.id).expiresAt, "");
  assert.equal(q.pendingOffline().length, 1); // 只剩过期那个

  // 重启重放：queued-offline 保留
  const q2 = createTaskQueue({ dir });
  assert.equal(q2.get(expiredTask.id).state, "queued-offline");
  assert.equal(q2.pendingOffline().length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("registry 单元：ownerOf 查离线归属与 skill 元数据", () => {
  const validate = createFrameValidator();
  const registry = createRegistry({ validate });
  registry.register({ agentId: "mac-work", card: CARD_QUEUE });
  registry.markOffline("mac-work");
  const owned = registry.ownerOf("dev-build-investm");
  assert.equal(owned.agentId, "mac-work");
  assert.equal(owned.skill["x-novoard-offline"].policy, "queue");
  assert.equal(registry.ownerOf("no-such"), null);
});

test("card 扩展字段：x-novoard-offline 随 skill 声明通过 hub 校验（契约 v1.1，card 派生由 agent 仓承载）", () => {
  const validate = createFrameValidator();
  const card = cardWithSkill({
    id: "dev-build-investm",
    name: "构建 InvestM dev",
    description: "pull → build → deploy",
    tags: ["dev"],
    "x-novoard-offline": { policy: "queue", ttl: "2h" },
  });
  assert.equal(validate.agentCard(card).ok, true);
  const skill = card.skills.find((s) => s.id === "dev-build-investm");
  assert.equal(skill["x-novoard-offline"].policy, "queue");
  assert.equal(skill["x-novoard-offline"].ttl, "2h");
});

test("HTTP 门：offline reject（默认）行为不变", async () => {
  const { hub, port, stateDir, close } = await bootHub();
  try {
    hub.registry.register({ agentId: "mac-work", card: CARD_REJECT });
    hub.registry.markOffline("mac-work");
    const res = await fetch(`http://127.0.0.1:${port}/api/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "dev-build-investm" }),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.state, "rejected");
    assert.equal(body.reason, "member-offline");
    assert.equal(hub.queue.list().length, 0); // 未入队
    rmSync(stateDir, { recursive: true, force: true });
  } finally {
    await close();
  }
});

test("HTTP 门：offline queue 离线入队 + 成员上线自动补下发", async () => {
  const { hub, port, stateDir, close } = await bootHub();
  try {
    hub.registry.register({ agentId: "mac-work", card: CARD_QUEUE });
    hub.registry.markOffline("mac-work");

    // 离线触发 → queued-offline + expiresAt
    const res = await fetch(`http://127.0.0.1:${port}/api/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "dev-build-investm" }),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.state, "queued-offline");
    assert.equal(body.reason, "member-offline");
    assert.ok(body.taskId);
    assert.ok(Date.parse(body.expiresAt) > Date.now());

    const task = hub.queue.get(body.taskId);
    assert.equal(task.state, "queued-offline");

    // 成员上线（registry conn 恢复）→ 补下发钩子（直接模拟 tunnel hello 钩子路径）
    hub.registry.register({ agentId: "mac-work", card: CARD_QUEUE, conn: { readyState: 1, send: () => {} } });
    await new Promise((r) => setTimeout(r, 120));
    // flushOfflineTasks 由 tunnel onMemberOnline 驱动；测试直接调 delegate 验证链路（tunnel 已装配）
    const flushed = await hub.delegate({ task, vars: task.vars });
    assert.equal(flushed.ok, true);
    assert.equal(hub.queue.get(body.taskId).state, "working");

    // 审计：submitted(member-offline-queued) → working(member-online flush)
    const events = hub.audit.list().filter((e) => e.taskId === body.taskId);
    assert.ok(events.some((e) => e.detail?.reason === "member-offline-queued"));
    rmSync(stateDir, { recursive: true, force: true });
  } finally {
    await close();
  }
});

test("HTTP 门：offline queue TTL 到期 sweeper 转 failed", async () => {
  const { hub, port, stateDir, close } = await bootHub();
  try {
    // ttl 1s：入队后 1s 到期，sweep 间隔 50ms
    hub.registry.register({
      agentId: "mac-work",
      card: cardWithSkill({
        id: "dev-build-investm",
        name: "构建 InvestM dev",
        description: "pull → build → deploy",
        tags: ["dev"],
        "x-novoard-offline": { policy: "queue", ttl: "1s" },
      }),
    });
    hub.registry.markOffline("mac-work");

    const res = await fetch(`http://127.0.0.1:${port}/api/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "dev-build-investm" }),
    });
    const body = await res.json();
    assert.equal(body.state, "queued-offline");

    await new Promise((r) => setTimeout(r, 1600)); // 等 TTL 过期 + sweeper 扫
    const task = hub.queue.get(body.taskId);
    assert.equal(task.state, "failed");
    assert.equal(task.status.message, "offline-ttl-expired");
    const events = hub.audit.list().filter((e) => e.taskId === body.taskId);
    assert.ok(events.some((e) => e.outcome === "failed" && e.detail?.reason === "offline-ttl-expired"));
    rmSync(stateDir, { recursive: true, force: true });
  } finally {
    await close();
  }
});

test("A2A 门：offline queue 离线受理返回 task 对象", async () => {
  const { hub, port, stateDir, close } = await bootHub();
  try {
    hub.registry.register({ agentId: "mac-work", card: CARD_QUEUE });
    hub.registry.markOffline("mac-work");
    const res = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer with-key-abc123" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "req-1",
        method: "message/send",
        params: { message: { messageId: "msg-1", role: "user", parts: [{ kind: "text", text: "dev-build-investm" }], contextId: "ctx-1", taskId: "" } },
      }),
    });
    const body = await res.json();
    assert.equal(body.result.status.state, "queued-offline");
    assert.equal(body.result.contextId, "ctx-1");
    rmSync(stateDir, { recursive: true, force: true });
  } finally {
    await close();
  }
});

test("隧道 hello 钩子：上线补下发真实 WS 路径", async () => {
  const { hub, port, stateDir, close } = await bootHub();
  let ws = null;
  try {
    const { WebSocket } = await import("ws");

    // 先离线入队一个任务
    hub.registry.register({ agentId: "mac-work", card: CARD_QUEUE });
    hub.registry.markOffline("mac-work");
    const res = await fetch(`http://127.0.0.1:${port}/api/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "dev-build-investm" }),
    });
    const { taskId } = await res.json();
    assert.equal(hub.queue.get(taskId).state, "queued-offline");

    // agent 真实连上隧道并发 hello
    ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, { headers: { Authorization: "Bearer agt_test_token_12345678" } });
    const received = [];
    ws.on("message", (raw) => received.push(JSON.parse(String(raw))));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({
      v: 1, kind: "ops", msgId: "e-1", ts: new Date().toISOString(),
      body: { type: "agent.hello", contractVersion: "1.1", agentId: "mac-work", token: "agt_test_token_12345678", card: CARD_QUEUE, inFlightTaskIds: [] },
    }));
    // hello.ack + 补下发的 message/send 委派帧都应到达
    await waitFor(() => received.some((f) => f.body?.type === "agent.hello.ack"));
    await waitFor(() => {
      const d = received.find((f) => f.kind === "a2a" && f.taskId === taskId);
      return !!d;
    });
    const delegated = received.find((f) => f.kind === "a2a" && f.taskId === taskId);
    assert.ok(delegated, "上线后补下发帧未到达");
    assert.equal(delegated.body.method, "message/send");
    assert.equal(hub.queue.get(taskId).state, "working");
  } finally {
    try { ws?.close(); } catch { /* 忽略 */ }
    await close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

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

test("重启重放：queued-offline 恢复，owner 在线立即补下发", async () => {
  const dir = tmpStateDir();
  // 第一个 hub：离线入队
  const boot1 = await bootHub();
  try {
    boot1.hub.registry.register({ agentId: "mac-work", card: CARD_QUEUE });
    boot1.hub.registry.markOffline("mac-work");
    const res = await fetch(`http://127.0.0.1:${boot1.port}/api/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "dev-build-investm" }),
    });
    const { taskId } = await res.json();
    assert.equal(boot1.hub.queue.get(taskId).state, "queued-offline");
    // 关闭（模拟 hub 重启），保留 state 目录
    await boot1.close();
    // 复制 state 到受控目录（bootHub 每次新建 tmp，这里直接用 boot1.stateDir 重新 boot）
    const boot2 = await createHub({ stateDir: boot1.stateDir, port: 0, offlineSweepMs: 50 });
    boot2.secrets.set({ agentTokens: ["agt_test_token_12345678"], dashboardToken: "dash-pass-123456", clientKeys: ["with-key-abc123"] });
    try {
      // owner 离线（重启后无连接）→ 任务保持 queued-offline
      assert.equal(boot2.queue.get(taskId).state, "queued-offline");
      // owner 上线 → 补下发
      boot2.registry.register({ agentId: "mac-work", card: CARD_QUEUE, conn: { readyState: 1, send: () => {} } });
      const task = boot2.queue.get(taskId);
      const flushed = await boot2.delegate({ task, vars: task.vars });
      assert.equal(flushed.ok, true);
      assert.equal(boot2.queue.get(taskId).state, "working");
    } finally {
      await new Promise((r) => boot2.server.close(r));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(boot1.stateDir, { recursive: true, force: true });
  }
});
