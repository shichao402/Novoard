/**
 * 契约可观测性测试（契约 §0）。
 *
 * 契约不兼容的失败形态通常是「看起来正常但结果不对」，所以必须能在运行时观察到双方版本：
 * - hub 的 /api/status 返回 contractVersion，运维不必翻代码
 * - agent.hello.ack 回带 hubVersion，agent 才能把双方版本一起落日志
 * - 注册审计记录双方契约版本，事后可回溯「那天两侧各是什么版本」
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
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-observability-"));
  const hub = await createHub({ stateDir, port: 0, log: { info() {}, error() {} } });
  const token = "observability-token";
  configureTestAgentTokens(hub, { "mac-work": token });
  const sockets = [];
  return {
    hub,
    token,
    stateDir,
    async connect() {
      const ws = new WebSocket(`ws://127.0.0.1:${hub.server.address().port}/tunnel`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const frames = [];
      ws.on("message", (raw) => frames.push(JSON.parse(String(raw))));
      await once(ws, "open");
      sockets.push(ws);
      return { ws, frames };
    },
    async close() {
      for (const ws of sockets) { try { ws.close(); } catch { /* 已关闭 */ } }
      await new Promise((resolve) => hub.server.close(resolve));
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

test("/api/status 返回当前契约版本", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-observability-status-"));
  const hub = await createHub({ stateDir, port: 0, publicOrigin: "http://test.local", secureCookies: false, log: { info() {}, error() {} } });
  try {
    const base = `http://127.0.0.1:${hub.server.address().port}`;
    // setup 首访认领 → 会话 → 签发 PAT（状态端点需要 system.read）
    const setupResponse = await fetch(`${base}/api/setup`, {
      method: "POST",
      headers: { Origin: "http://test.local", "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", displayName: "Owner", password: "correct horse battery staple" }),
    });
    assert.equal(setupResponse.status, 201, "setup 应成功");
    const cookie = setupResponse.headers.get("set-cookie").split(";")[0];
    const setup = await setupResponse.json();

    const patResponse = await fetch(`${base}/api/pats`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "http://test.local",
        "X-CSRF-Token": setup.csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "observability", scopes: ["system.read"], targetAllow: ["*"] }),
    });
    assert.equal(patResponse.status, 201, "PAT 应签发成功");
    const { token } = await patResponse.json();

    const response = await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.contractVersion, CONTRACT_VERSION, "状态端点应返回契约版本");
  } finally {
    await new Promise((resolve) => hub.server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("agent.hello.ack 回带 hubVersion，agent 可记录双方版本", async () => {
  const ctx = await boot();
  try {
    const conn = await ctx.connect();
    conn.ws.send(JSON.stringify({
      v: 1,
      kind: "ops",
      msgId: "e-hello-observability",
      ts: new Date().toISOString(),
      body: helloBody(),
    }));

    await waitFor(() => conn.frames.some((f) => f.body?.type === "agent.hello.ack"));
    const ack = conn.frames.find((f) => f.body?.type === "agent.hello.ack");
    assert.equal(ack.body.hubVersion, CONTRACT_VERSION, "ack 必须回带 hubVersion");
  } finally {
    await ctx.close();
  }
});

test("注册审计记录双方契约版本，事后可回溯", async () => {
  const ctx = await boot();
  try {
    const conn = await ctx.connect();
    conn.ws.send(JSON.stringify({
      v: 1,
      kind: "ops",
      msgId: "e-hello-audit",
      ts: new Date().toISOString(),
      body: helloBody({ contractVersion: CONTRACT_VERSION }),
    }));

    await waitFor(() => conn.frames.some((f) => f.body?.type === "agent.hello.ack"));
    const events = ctx.hub.audit?.list?.() ?? [];
    const registered = events.find((e) => e.outcome === "completed" && e.actor === "agent:mac-work");
    assert.ok(registered, `应记录注册审计，实际：${JSON.stringify(events.slice(-5))}`);
    assert.equal(registered.detail.contractVersion, CONTRACT_VERSION, "应记录 hub 契约版本");
    assert.equal(registered.detail.agentContractVersion, CONTRACT_VERSION, "应记录 agent 契约版本");
  } finally {
    await ctx.close();
  }
});

test("次版本不同仍注册成功，且审计能看出两侧版本不同", async () => {
  const ctx = await boot();
  try {
    // 构造一个同主版本、不同次版本的对端版本，避免硬编码具体次版本号
    const [major] = CONTRACT_VERSION.split(".");
    const peerMinor = `${major}.${Number(CONTRACT_VERSION.split(".")[1]) + 1}`;
    const conn = await ctx.connect();
    conn.ws.send(JSON.stringify({
      v: 1,
      kind: "ops",
      msgId: "e-hello-minor-diff",
      ts: new Date().toISOString(),
      body: helloBody({ contractVersion: peerMinor }),
    }));

    await waitFor(() => conn.frames.length > 0);
    const ack = conn.frames.find((f) => f.body?.type === "agent.hello.ack");
    assert.ok(ack, `次版本差异应被接受，实际收到：${JSON.stringify(conn.frames)}`);
    const events = ctx.hub.audit?.list?.() ?? [];
    const registered = events.find((e) => e.outcome === "completed" && e.actor === "agent:mac-work");
    assert.equal(registered.detail.agentContractVersion, peerMinor, "审计应如实记录对端版本");
    assert.notEqual(registered.detail.contractVersion, registered.detail.agentContractVersion, "两侧版本应可区分");
  } finally {
    await ctx.close();
  }
});
