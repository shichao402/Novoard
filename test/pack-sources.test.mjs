/**
 * PRD-6 H2–H4：能力包来源清单。
 * - H2 存储：增删改、非法即拒、重启后保留、0600；
 * - H3 管理台接口：PUT/DELETE /api/pack-sources/:id 需会话 + CSRF + users.manage，GET 列表；
 * - H4 下发：agent.hello.ack 附上 packSources，且通过契约 schema。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";

import { createHub } from "../src/main.mjs";
import { createPackSources } from "../src/pack-sources.mjs";
import { createFrameValidator } from "../src/frames.mjs";
import { CONTRACT_VERSION } from "../src/contract/version.mjs";
import { configureTestAgentTokens } from "./test-auth.mjs";

const ORIGIN = "http://test.local";
const OSG = { id: "osg", git: "git@git.woa.com:firoyang/OSGToolset.git", branch: "main" };

test("H2：增删改、重启后保留、文件权限 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-packsrc-"));
  try {
    const store = createPackSources({ dir });
    assert.deepEqual(store.list(), []);
    assert.equal(store.upsert(OSG).created, true);
    assert.equal(store.upsert({ id: "general", git: "https://github.com/x/novoard-packs.git", branch: "main", subdir: "./packs/general/" }).created, true);
    assert.equal(store.upsert({ ...OSG, branch: "release" }).created, false);

    const again = createPackSources({ dir });
    assert.deepEqual(again.list(), [
      { id: "general", git: "https://github.com/x/novoard-packs.git", branch: "main", subdir: "packs/general" },
      { ...OSG, branch: "release" },
    ]);
    if (process.platform !== "win32") assert.equal(statSync(again.file).mode & 0o777, 0o600);
    assert.equal(again.remove("osg"), true);
    assert.equal(again.remove("osg"), false);
    assert.deepEqual(createPackSources({ dir }).list().map((s) => s.id), ["general"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("H2：非法条目拒绝且不落盘", () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-packsrc-"));
  try {
    const store = createPackSources({ dir });
    for (const bad of [
      { ...OSG, id: "1osg" },
      { ...OSG, id: "o s g" },
      { ...OSG, id: "osg/x" },
      { ...OSG, git: "" },
      { ...OSG, branch: "" },
      { ...OSG, branch: "--upload-pack=x" },
      { ...OSG, subdir: "../escape" },
      { ...OSG, subdir: "/abs" },
    ]) {
      assert.throws(() => store.upsert(bad), (e) => e.code === "invalid-pack-source", JSON.stringify(bad));
    }
    assert.deepEqual(store.list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function bootHub() {
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-packsrc-hub-"));
  const hub = await createHub({ stateDir, port: 0, publicOrigin: ORIGIN, secureCookies: false, offlineSweepMs: 60_000, log: { info() {}, error() {} } });
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  return {
    hub,
    stateDir,
    base,
    async close() {
      await new Promise((resolve) => hub.server.close(resolve));
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

async function loginOwner(base) {
  const response = await fetch(`${base}/api/setup`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "owner", displayName: "Owner", password: "correct horse battery staple" }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  const cookie = response.headers.get("set-cookie").split(";")[0];
  return { Cookie: cookie, Origin: ORIGIN, "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json" };
}

test("H3：管理接口增改删，写入 pack-sources.json，缺 CSRF 被拒", async () => {
  const ctx = await bootHub();
  try {
    const headers = await loginOwner(ctx.base);
    let response = await fetch(`${ctx.base}/api/pack-sources/osg`, {
      method: "PUT",
      headers: { ...headers, "X-CSRF-Token": "wrong" },
      body: JSON.stringify(OSG),
    });
    assert.equal(response.status, 403);

    response = await fetch(`${ctx.base}/api/pack-sources/osg`, { method: "PUT", headers, body: JSON.stringify({ git: OSG.git, branch: "main" }) });
    assert.equal(response.status, 201);
    response = await fetch(`${ctx.base}/api/pack-sources/osg`, { method: "PUT", headers, body: JSON.stringify({ git: OSG.git, branch: "dev" }) });
    assert.equal(response.status, 200);
    response = await fetch(`${ctx.base}/api/pack-sources/bad%20id`, { method: "PUT", headers, body: JSON.stringify({ git: OSG.git, branch: "main" }) });
    assert.equal(response.status, 400);

    response = await fetch(`${ctx.base}/api/pack-sources`, { headers });
    assert.deepEqual((await response.json()).sources, [{ ...OSG, branch: "dev" }]);
    const onDisk = JSON.parse(readFileSync(join(ctx.stateDir, "pack-sources.json"), "utf8"));
    assert.deepEqual(onDisk.sources, [{ ...OSG, branch: "dev" }]);

    response = await fetch(`${ctx.base}/api/pack-sources/osg`, { method: "DELETE", headers });
    assert.equal((await response.json()).removed, true);
    assert.deepEqual(JSON.parse(readFileSync(join(ctx.stateDir, "pack-sources.json"), "utf8")).sources, []);

    response = await fetch(`${ctx.base}/api/pack-sources`);
    assert.equal(response.status, 401);
  } finally {
    await ctx.close();
  }
});

test("H4：hello.ack 附上 packSources 且通过契约校验", async () => {
  const ctx = await bootHub();
  const token = "pack-sources-token";
  configureTestAgentTokens(ctx.hub, { "mac-work": token });
  ctx.hub.packSources.upsert(OSG);
  const ws = new WebSocket(`ws://127.0.0.1:${ctx.hub.server.address().port}/tunnel`, { headers: { Authorization: `Bearer ${token}` } });
  const frames = [];
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw))));
  try {
    await once(ws, "open");
    ws.send(JSON.stringify({
      v: 1,
      kind: "ops",
      msgId: "e-hello-packs",
      ts: new Date().toISOString(),
      body: {
        type: "agent.hello",
        contractVersion: CONTRACT_VERSION,
        agentId: "mac-work",
        card: { name: "mac-work", description: "d", version: "1.0.0", capabilities: { streaming: false, pushNotifications: true }, defaultInputModes: ["text"], defaultOutputModes: ["text"], skills: [] },
        inFlightTaskIds: [],
      },
    }));
    const deadline = Date.now() + 3000;
    while (!frames.some((f) => f.body?.type === "agent.hello.ack") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const ack = frames.find((f) => f.body?.type === "agent.hello.ack");
    assert.ok(ack, "收到 hello.ack");
    assert.deepEqual(ack.body.packSources, [OSG]);
    const validator = createFrameValidator();
    const checked = validator.opsBody("agent.hello.ack", ack.body);
    assert.ok(checked.ok, JSON.stringify(checked.errors));
  } finally {
    ws.close();
    await ctx.close();
  }
});
