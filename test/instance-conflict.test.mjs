/**
 * 同身份并发实例（契约 §4.1）：Hub 拒绝第二条连接而不是踢掉旧连接。
 *
 * 为什么是"拒绝新连接"：踢旧连接会让旧实例立即退避重连、再踢回去，形成互踢循环；
 * 且新 bootId 会把旧实例在跑的任务判成 agent-lost（机器上却照跑完，副作用照旧）。
 * 被拒绝方按可重试处理，等旧连接消失（退出 / 心跳超时被清扫）后自然接管。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";

import { createHub } from "../src/main.mjs";
import { configureTestAgentTokens } from "./test-auth.mjs";

const CARD = {
  name: "mac-work",
  description: "mac-work",
  version: "2.0.0",
  capabilities: { streaming: false, pushNotifications: true },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  skills: [{ id: "dev-build", name: "dev-build", description: "dev-build", tags: [] }],
};

const BOOT_A = "11111111-1111-4111-8111-111111111111";
const BOOT_B = "22222222-2222-4222-8222-222222222222";

function helloFrame({ bootId, msgId } = {}) {
  return {
    v: 1,
    kind: "ops",
    msgId: msgId ?? `e-hello-${bootId ?? "none"}`,
    ts: new Date().toISOString(),
    body: {
      type: "agent.hello",
      contractVersion: "2.1",
      agentId: "mac-work",
      card: CARD,
      inFlightTaskIds: [],
      ...(bootId ? { bootId } : {}),
    },
  };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("waitFor timeout");
}

async function boot() {
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-instance-conflict-"));
  const hub = await createHub({ stateDir, port: 0, log: { info() {}, error() {} } });
  const token = "instance-conflict-token";
  configureTestAgentTokens(hub, { "mac-work": token });
  const sockets = [];
  return {
    hub,
    token,
    port: hub.server.address().port,
    async connect() {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/tunnel`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      const frames = [];
      ws.on("message", (raw) => frames.push(JSON.parse(String(raw))));
      await once(ws, "open");
      sockets.push(ws);
      return { ws, frames };
    },
    online() {
      return hub.registry.status().find((m) => m.agentId === "mac-work")?.online === true;
    },
    async close() {
      for (const ws of sockets) { try { ws.close(); } catch { /* 已关闭 */ } }
      await new Promise((resolve) => hub.server.close(resolve));
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

test("同身份第二条连接被拒（instance-conflict），首个连接保持在线", async () => {
  const ctx = await boot();
  try {
    const first = await ctx.connect();
    first.ws.send(JSON.stringify(helloFrame({ bootId: BOOT_A })));
    await waitFor(() => ctx.online());
    const firstConn = ctx.hub.registry.connected("mac-work").conn;

    const second = await ctx.connect();
    second.ws.send(JSON.stringify(helloFrame({ bootId: BOOT_B })));
    await waitFor(() => second.frames.some((f) => f.body?.type === "agent.hello.nack"));

    const nack = second.frames.find((f) => f.body?.type === "agent.hello.nack");
    assert.equal(nack.body.reason, "instance-conflict");
    assert.equal(nack.body.retryable, true, "拒绝必须标明可重试，agent 才不会致命退出");
    assert.equal(second.frames.some((f) => f.body?.type === "agent.hello.ack"), false);

    // 身份没被覆盖：仍是第一条连接（服务端 socket 未替换，成员保持在线）
    assert.equal(ctx.hub.registry.connected("mac-work").conn, firstConn);
    assert.equal(ctx.online(), true);
  } finally {
    await ctx.close();
  }
});

test("被拒连接断开后，原实例仍在线且能收到任务", async () => {
  const ctx = await boot();
  try {
    const first = await ctx.connect();
    first.ws.send(JSON.stringify(helloFrame({ bootId: BOOT_A })));
    await waitFor(() => ctx.online());

    const second = await ctx.connect();
    second.ws.send(JSON.stringify(helloFrame({ bootId: BOOT_B })));
    await waitFor(() => second.frames.some((f) => f.body?.type === "agent.hello.nack"));
    // 被拒方主动断开（agent 侧就是这么做的）：不能把原实例带下线
    second.ws.close();
    await once(second.ws, "close");
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(ctx.online(), true);

    const task = ctx.hub.queue.submit({
      skillId: "dev-build",
      target: "dev-build",
      member: "mac-work",
      actor: "test",
      lane: "a2a",
    });
    await ctx.hub.delegate({ task, vars: {} });
    await waitFor(() => first.frames.some((f) => f.kind === "a2a" && f.taskId === task.id));
  } finally {
    await ctx.close();
  }
});

test("原实例退出后，新连接可接管身份", async () => {
  const ctx = await boot();
  try {
    const first = await ctx.connect();
    first.ws.send(JSON.stringify(helloFrame({ bootId: BOOT_A })));
    await waitFor(() => ctx.online());

    const second = await ctx.connect();
    second.ws.send(JSON.stringify(helloFrame({ bootId: BOOT_B })));
    await waitFor(() => second.frames.some((f) => f.body?.type === "agent.hello.nack"));

    // 旧实例退出 → 成员转离线
    first.ws.close();
    await once(first.ws, "close");
    await waitFor(() => !ctx.online());

    // 退避后重连：这次应当成功
    second.frames.length = 0;
    second.ws.send(JSON.stringify(helloFrame({ bootId: BOOT_B, msgId: "e-hello-retry" })));
    await waitFor(() => second.frames.some((f) => f.body?.type === "agent.hello.ack"));
    assert.equal(ctx.online(), true);

    // 接管是否真的生效：任务要下发给这条连接
    const task = ctx.hub.queue.submit({
      skillId: "dev-build",
      target: "dev-build",
      member: "mac-work",
      actor: "test",
      lane: "a2a",
    });
    await ctx.hub.delegate({ task, vars: {} });
    await waitFor(() => second.frames.some((f) => f.kind === "a2a" && f.taskId === task.id));
  } finally {
    await ctx.close();
  }
});

test("被接管的旧连接稍后关闭，不得把在线成员误标离线", async () => {
  const ctx = await boot();
  try {
    const first = await ctx.connect();
    first.ws.send(JSON.stringify(helloFrame({ bootId: BOOT_A })));
    await waitFor(() => ctx.online());
    const oldConn = ctx.hub.registry.connected("mac-work").conn;

    // 模拟注册表里 conn 已被新连接接管，旧连接迟到 close
    const second = await ctx.connect();
    ctx.hub.registry.register({ agentId: "mac-work", card: CARD, conn: second.ws, inFlightTaskIds: [] });
    assert.equal(ctx.hub.registry.markOffline("mac-work", oldConn), false, "旧连接的 close 不应释放身份");
    assert.equal(ctx.online(), true);
  } finally {
    await ctx.close();
  }
});
