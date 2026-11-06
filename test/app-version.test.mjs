/**
 * 契约 v2.3 agent.hello.app：Hub 记录 agent 程序版本并在成员视图展示。
 *
 * 约束：
 * 1. app 只用于展示，不参与准入——不带 app 的 2.2 agent 照常注册，视图里 app 为 null；
 * 2. Hub 只保留 version / channel / platform 三个字符串，其余字段丢弃（防止塞大对象进面板）；
 * 3. 重连 hello 携带新版本时覆盖旧值（升级后成员视图立即反映新版本）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";

import { createHub } from "../src/main.mjs";
import { normalizeApp } from "../src/registry.mjs";
import { listMemberViews } from "../src/members.mjs";
import { CONTRACT_VERSION } from "../src/contract/version.mjs";
import { configureTestAgentTokens } from "./test-auth.mjs";

const CARD = {
  name: "win-dev",
  description: "win-dev",
  version: "2.0.0",
  capabilities: { streaming: false, pushNotifications: true },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  skills: [{ id: "win-build", name: "win-build", description: "win-build", tags: [] }],
};

function helloFrame({ app, contractVersion = CONTRACT_VERSION } = {}) {
  return {
    v: 1,
    kind: "ops",
    msgId: `e-hello-${Math.random().toString(16).slice(2, 10)}`,
    ts: new Date().toISOString(),
    body: {
      type: "agent.hello",
      contractVersion,
      agentId: "win-dev",
      card: CARD,
      inFlightTaskIds: [],
      ...(app === undefined ? {} : { app }),
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
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-app-version-"));
  const hub = await createHub({ stateDir, port: 0, log: { info() {}, error() {} } });
  const token = "app-version-token";
  configureTestAgentTokens(hub, { "win-dev": token });
  const port = hub.server.address().port;
  const sockets = [];
  return {
    hub,
    async hello(app, options) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const frames = [];
      ws.on("message", (raw) => frames.push(JSON.parse(String(raw))));
      await once(ws, "open");
      sockets.push(ws);
      ws.send(JSON.stringify(helloFrame({ app, ...options })));
      await waitFor(() => frames.some((f) => f.body?.type === "agent.hello.ack"));
      return ws;
    },
    status() {
      return hub.registry.status().find((m) => m.agentId === "win-dev");
    },
    async close() {
      for (const ws of sockets) { try { ws.close(); } catch { /* 已关闭 */ } }
      await new Promise((resolve) => hub.server.close(resolve));
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

test("normalizeApp：只保留三个字符串字段，没有 version 视为未上报", () => {
  assert.deepEqual(
    normalizeApp({ version: " 0.3.4 ", channel: "stable", platform: "win32-x64", extra: { big: true } }),
    { version: "0.3.4", channel: "stable", platform: "win32-x64" },
  );
  assert.deepEqual(normalizeApp({ version: "0.3.4" }), { version: "0.3.4", channel: null, platform: null });
  assert.equal(normalizeApp({ channel: "dev" }), null);
  assert.equal(normalizeApp({ version: "" }), null);
  assert.equal(normalizeApp("0.3.4"), null);
  assert.equal(normalizeApp(null), null);
  assert.equal(normalizeApp({ version: "x".repeat(200) }).version.length, 64);
});

test("hello 带 app：注册表与成员视图都能看到版本", async () => {
  const ctx = await boot();
  try {
    await ctx.hello({ version: "0.3.4", channel: "stable", platform: "win32-x64" });
    assert.deepEqual(ctx.status().app, { version: "0.3.4", channel: "stable", platform: "win32-x64" });

    const views = listMemberViews({
      directory: { list: () => [] },
      registry: ctx.hub.registry,
    });
    const view = views.find((v) => v.agentId === "win-dev");
    assert.deepEqual(view.app, { version: "0.3.4", channel: "stable", platform: "win32-x64" });
  } finally {
    await ctx.close();
  }
});

test("老 agent（2.2、不带 app）照常注册，app 为 null", async () => {
  const ctx = await boot();
  try {
    await ctx.hello(undefined, { contractVersion: "2.2" });
    assert.equal(ctx.status().online, true);
    assert.equal(ctx.status().app, null);
  } finally {
    await ctx.close();
  }
});

test("重连 hello 带新版本时覆盖旧值", async () => {
  const ctx = await boot();
  try {
    const first = await ctx.hello({ version: "0.3.4", channel: "stable", platform: "win32-x64" });
    first.close();
    await waitFor(() => ctx.status().online === false);
    await ctx.hello({ version: "0.3.5", channel: "stable", platform: "win32-x64" });
    assert.equal(ctx.status().app.version, "0.3.5");
  } finally {
    await ctx.close();
  }
});
