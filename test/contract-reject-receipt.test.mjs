/**
 * 契约拒绝回执测试（契约 §4.2，需求 3）：
 * hub 侧两处静默丢弃分支改为显式回执后，必须能观察到明确信号。
 * - agent.hello 字段级不合法 → 回 agent.hello.nack，reason=contract-schema-mismatch，detail 带字段路径
 * - 非 hello 的 ops 帧不合法 → 回 frame.reject，refMsgId 可关联到原帧
 * - 信封不合法 → 关闭连接且 close reason 可读，不再静默保持连接
 * - JSON 无法解析 → 关闭连接而非静默丢弃
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
import { CONTRACT_VERSION } from "../src/contract/version.mjs";

const CARD = {
  name: "mac-work",
  description: "mac-work",
  version: "2.0.0",
  capabilities: { streaming: false, pushNotifications: true },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  skills: [],
};

function helloBody(overrides = {}) {
  return {
    type: "agent.hello",
    contractVersion: CONTRACT_VERSION,
    agentId: "mac-work",
    card: CARD,
    inFlightTaskIds: [],
    ...overrides,
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
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-reject-receipt-"));
  const hub = await createHub({ stateDir, port: 0, log: { info() {}, error() {} } });
  const token = "reject-receipt-token";
  configureTestAgentTokens(hub, { "mac-work": token });
  const sockets = [];
  return {
    hub,
    token,
    port: hub.server.address().port,
    async connect() {
      const ws = new WebSocket(`ws://127.0.0.1:${hub.server.address().port}/tunnel`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const frames = [];
      const closes = [];
      ws.on("message", (raw) => frames.push(JSON.parse(String(raw))));
      ws.on("close", (code, reason) => closes.push({ code, reason: String(reason) }));
      await once(ws, "open");
      sockets.push(ws);
      return { ws, frames, closes };
    },
    async close() {
      for (const ws of sockets) { try { ws.close(); } catch { /* 已关闭 */ } }
      await new Promise((resolve) => hub.server.close(resolve));
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

test("agent.hello 字段级不合法：回 nack 且携带具体字段路径，不再静默挂起", async () => {
  const ctx = await boot();
  try {
    const conn = await ctx.connect();
    // card 缺必填字段 description：body 校验失败，但 type 已可判定，应走 hello 专属 nack
    const badCard = { ...CARD };
    delete badCard.description;
    conn.ws.send(JSON.stringify({
      v: 1,
      kind: "ops",
      msgId: "e-bad-hello",
      ts: new Date().toISOString(),
      body: helloBody({ card: badCard }),
    }));

    await waitFor(() => conn.frames.length > 0);
    const nack = conn.frames.find((f) => f.body?.type === "agent.hello.nack");
    assert.ok(nack, `应回 agent.hello.nack，实际收到：${JSON.stringify(conn.frames)}`);
    assert.equal(nack.body.reason, "contract-schema-mismatch");
    assert.equal(nack.body.hubVersion, CONTRACT_VERSION);
    assert.ok(Array.isArray(nack.body.detail) && nack.body.detail.length > 0, "detail 应列出字段级错误");
    assert.ok(nack.body.detail.some((d) => d.includes("description")), `detail 应指向缺失字段：${nack.body.detail}`);
    // 连接保持（业务层拒绝，不必断链），但绝不能再是「什么都收不到」
    assert.equal(conn.ws.readyState, WebSocket.OPEN);
  } finally {
    await ctx.close();
  }
});

test("非 hello 的 ops 帧不合法：回 frame.reject 且 refMsgId 可关联原帧", async () => {
  const ctx = await boot();
  try {
    const conn = await ctx.connect();
    conn.ws.send(JSON.stringify({
      v: 1,
      kind: "ops",
      msgId: "e-bad-ping",
      ts: new Date().toISOString(),
      body: { type: "agent.ping", ts: 12345 },
    }));

    await waitFor(() => conn.frames.length > 0);
    const reject = conn.frames.find((f) => f.body?.type === "frame.reject");
    assert.ok(reject, `应回 frame.reject，实际收到：${JSON.stringify(conn.frames)}`);
    assert.equal(reject.body.refMsgId, "e-bad-ping");
    assert.equal(reject.body.reason, "ops-schema-mismatch");
    assert.equal(reject.body.hubVersion, CONTRACT_VERSION);
    assert.ok(Array.isArray(reject.body.detail) && reject.body.detail.length > 0);
  } finally {
    await ctx.close();
  }
});

test("未知 ops type：回 frame.reject reason=unknown-ops-type", async () => {
  const ctx = await boot();
  try {
    const conn = await ctx.connect();
    conn.ws.send(JSON.stringify({
      v: 1,
      kind: "ops",
      msgId: "e-unknown",
      ts: new Date().toISOString(),
      body: { type: "agent.unknown", foo: 1 },
    }));

    await waitFor(() => conn.frames.length > 0);
    const reject = conn.frames.find((f) => f.body?.type === "frame.reject");
    assert.ok(reject, `应回 frame.reject，实际收到：${JSON.stringify(conn.frames)}`);
    assert.equal(reject.body.reason, "unknown-ops-type");
    assert.equal(reject.body.refMsgId, "e-unknown");
  } finally {
    await ctx.close();
  }
});

test("信封不合法：关闭连接且 close reason 可读，不再静默保持连接", async () => {
  const ctx = await boot();
  try {
    const conn = await ctx.connect();
    // 信封缺 kind：信封校验失败，属于传输层解码前提不成立
    conn.ws.send(JSON.stringify({
      v: 1,
      msgId: "e-bad-envelope",
      ts: new Date().toISOString(),
      body: { type: "agent.ping", ts: new Date().toISOString() },
    }));

    await waitFor(() => conn.closes.length > 0);
    assert.equal(conn.closes[0].code, 1008, "应以策略违规码关闭");
    assert.ok(conn.closes[0].reason.includes("envelope"), `close reason 应可读：${conn.closes[0].reason}`);
  } finally {
    await ctx.close();
  }
});

test("JSON 解析失败：关闭连接并给出 malformed-frame 原因", async () => {
  const ctx = await boot();
  try {
    const conn = await ctx.connect();
    conn.ws.send("{ not json");

    await waitFor(() => conn.closes.length > 0);
    assert.equal(conn.closes[0].code, 1003, "应以不支持的数据类型码关闭");
    assert.ok(conn.closes[0].reason.includes("malformed-frame"), `close reason 应可读：${conn.closes[0].reason}`);
  } finally {
    await ctx.close();
  }
});
