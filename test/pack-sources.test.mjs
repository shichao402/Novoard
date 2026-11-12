/**
 * PRD-6 H2–H5：能力包来源清单。
 * - H2 存储：增删改、非法即拒、重启后保留、0600；
 * - H3 管理台接口：POST /api/pack-sources、PUT/DELETE /api/pack-sources/:key 需会话 + CSRF + users.manage，GET 列表；
 * - H4 下发：agent.hello.ack 附上 packSources（去掉 key），且通过契约 schema；
 * - H5 来源以 git+branch+subdir 为身份，包名可选覆盖；v1 数据迁移丢弃旧 id。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const OSG = { git: "git@git.woa.com:firoyang/OSGToolset.git", branch: "main" };
const PACKS = "https://github.com/x/novoard-packs.git";
const strip = ({ key: _key, ...rest }) => rest;

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "novoard-packsrc-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("H2：增删改、重启后保留、文件权限 0600", () => withDir((dir) => {
  const store = createPackSources({ dir });
  assert.deepEqual(store.list(), []);
  const osg = store.create(OSG);
  assert.match(osg.key, /^ps-[0-9a-f]+$/);
  const general = store.create({ git: PACKS, subdir: "./packs/general/" });
  assert.equal(general.branch, "main", "branch 缺省为 main");
  store.update(osg.key, { ...OSG, branch: "release" });

  const again = createPackSources({ dir });
  assert.deepEqual(again.list().map(strip), [
    { ...OSG, branch: "release" },
    { git: PACKS, branch: "main", subdir: "packs/general" },
  ]);
  assert.deepEqual(again.list().map((s) => s.key).sort(), [osg.key, general.key].sort(), "key 稳定");
  if (process.platform !== "win32") assert.equal(statSync(again.file).mode & 0o777, 0o600);
  assert.equal(again.remove(osg.key)?.git, OSG.git);
  assert.equal(again.remove(osg.key), null);
  assert.throws(() => again.update(osg.key, OSG), (e) => e.code === "pack-source-not-found");
  assert.deepEqual(createPackSources({ dir }).list().map((s) => s.subdir), ["packs/general"]);
}));

test("H2：非法条目拒绝且不落盘", () => withDir((dir) => {
  const store = createPackSources({ dir });
  for (const bad of [
    { ...OSG, id: "1osg" },
    { ...OSG, id: "o s g" },
    { ...OSG, id: "osg/x" },
    { ...OSG, git: "" },
    { ...OSG, branch: "--upload-pack=x" },
    { ...OSG, branch: "a b" },
    { ...OSG, subdir: "../escape" },
    { ...OSG, subdir: "/abs" },
  ]) {
    assert.throws(() => store.create(bad), (e) => e.code === "invalid-pack-source", JSON.stringify(bad));
  }
  assert.deepEqual(store.list(), []);
}));

test("H5：同来源（git 规范化后）去重，同覆盖名冲突；同仓不同子目录/分支可并存", () => withDir((dir) => {
  const store = createPackSources({ dir });
  store.create({ git: PACKS, subdir: "packs/versionControl" });
  for (const dup of [
    { git: PACKS, subdir: "packs/versionControl/" },
    { git: "https://GitHub.com/x/novoard-packs", subdir: "packs/versionControl" },
    { git: `${PACKS}/`, branch: "main", subdir: "packs/versionControl" },
  ]) {
    assert.throws(() => store.create(dup), (e) => e.code === "pack-source-conflict", JSON.stringify(dup));
  }
  store.create({ git: PACKS, subdir: "packs/general" });
  const dev = store.create({ git: PACKS, branch: "dev", subdir: "packs/versionControl", id: "vcDev" });
  assert.equal(dev.id, "vcDev");
  assert.throws(() => store.create({ ...OSG, id: "vcDev" }), (e) => e.code === "pack-name-conflict");
  store.update(dev.key, { git: PACKS, branch: "dev", subdir: "packs/versionControl", id: "vcDev" });
  assert.equal(store.list().length, 3);
  assert.deepEqual(store.wire().find((s) => s.branch === "dev"), { git: PACKS, branch: "dev", subdir: "packs/versionControl", id: "vcDev" });
  assert.ok(store.wire().every((s) => !("key" in s)), "下发不带 key");
}));

test("H5：v1 文件迁移——生成 key、丢弃旧 id、同来源只留一条并立即落盘", () => withDir((dir) => {
  writeFileSync(join(dir, "pack-sources.json"), JSON.stringify({
    schemaVersion: 1,
    sources: [
      { id: "default", git: PACKS, branch: "main", subdir: "packs/versionControl" },
      { id: "again", git: PACKS, branch: "main", subdir: "packs/versionControl" },
      { id: "osg", ...OSG },
    ],
  }));
  const store = createPackSources({ dir });
  const listed = store.list();
  assert.deepEqual(listed.map(strip), [OSG, { git: PACKS, branch: "main", subdir: "packs/versionControl" }]);
  const onDisk = JSON.parse(readFileSync(store.file, "utf8"));
  assert.equal(onDisk.schemaVersion, 2);
  assert.deepEqual(onDisk.sources.map((s) => s.key).sort(), listed.map((s) => s.key).sort());
}));

test("H2：损坏文件 fail-closed", () => withDir((dir) => {
  writeFileSync(join(dir, "pack-sources.json"), "{oops");
  assert.throws(() => createPackSources({ dir }).list(), /fail-closed/);
  writeFileSync(join(dir, "pack-sources.json"), JSON.stringify({ schemaVersion: 2, sources: [{ ...OSG }] }));
  assert.throws(() => createPackSources({ dir }).list(), /key/);
}));

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
    let response = await fetch(`${ctx.base}/api/pack-sources`, {
      method: "POST",
      headers: { ...headers, "X-CSRF-Token": "wrong" },
      body: JSON.stringify(OSG),
    });
    assert.equal(response.status, 403);

    response = await fetch(`${ctx.base}/api/pack-sources`, { method: "POST", headers, body: JSON.stringify(OSG) });
    assert.equal(response.status, 201);
    const { key } = (await response.json()).source;
    response = await fetch(`${ctx.base}/api/pack-sources`, { method: "POST", headers, body: JSON.stringify(OSG) });
    assert.equal(response.status, 409, "同来源重复");
    response = await fetch(`${ctx.base}/api/pack-sources/${key}`, { method: "PUT", headers, body: JSON.stringify({ ...OSG, branch: "dev" }) });
    assert.equal(response.status, 200);
    response = await fetch(`${ctx.base}/api/pack-sources/${key}`, { method: "PUT", headers, body: JSON.stringify({ ...OSG, id: "1bad" }) });
    assert.equal(response.status, 400);
    response = await fetch(`${ctx.base}/api/pack-sources/ps-00000000`, { method: "PUT", headers, body: JSON.stringify(OSG) });
    assert.equal(response.status, 404);

    response = await fetch(`${ctx.base}/api/pack-sources`, { headers });
    assert.deepEqual((await response.json()).sources, [{ key, ...OSG, branch: "dev" }]);
    const onDisk = JSON.parse(readFileSync(join(ctx.stateDir, "pack-sources.json"), "utf8"));
    assert.deepEqual(onDisk.sources, [{ key, ...OSG, branch: "dev" }]);

    response = await fetch(`${ctx.base}/api/pack-sources/${key}`, { method: "DELETE", headers });
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
  ctx.hub.packSources.create(OSG);
  ctx.hub.packSources.create({ git: PACKS, subdir: "packs/vc", id: "vc" });
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
    assert.deepEqual(ack.body.packSources, [OSG, { git: PACKS, branch: "main", subdir: "packs/vc", id: "vc" }]);
    const validator = createFrameValidator();
    const checked = validator.opsBody("agent.hello.ack", ack.body);
    assert.ok(checked.ok, JSON.stringify(checked.errors));
  } finally {
    ws.close();
    await ctx.close();
  }
});
