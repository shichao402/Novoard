import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub } from "../src/main.mjs";
import { configureTestAgentTokens } from "./test-auth.mjs";

const ORIGIN = "http://test.local";
const REPO = { git: "git@example.com:group/pack.git", branch: "main" };
async function boot() {
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-source-api-"));
  const hub = await createHub({ stateDir, port: 0, publicOrigin: ORIGIN, secureCookies: false, offlineSweepMs: 60_000, log: { info() {}, error() {} } });
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const response = await fetch(base + "/api/setup", { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ username: "owner", password: "correct horse battery staple" }) });
  assert.equal(response.status, 201);
  const owner = await response.json();
  const headers = { Cookie: response.headers.get("set-cookie").split(";")[0], Origin: ORIGIN, "X-CSRF-Token": owner.csrfToken, "Content-Type": "application/json" };
  const principal = await hub.identity.authenticateSession(decodeURIComponent(headers.Cookie.split("=")[1]));
  return { hub, base, stateDir, headers, principal, async close() { await new Promise((r) => hub.server.close(r)); rmSync(stateDir, { recursive: true, force: true }); } };
}
const pat = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const createPat = (ctx, name, scopes) => ctx.hub.identity.createPat(ctx.principal, { name, ...(scopes ? { scopes } : {}) });

test("来源专用 PAT 可增改删，审计保留 PAT 主体且不记录令牌", async () => {
  const c = await boot();
  try {
    const issued = await createPat(c, "source-manager", ["pack-sources.read", "pack-sources.manage"]);
    let response = await fetch(c.base + "/api/pack-sources", { method: "POST", headers: pat(issued.token), body: JSON.stringify(REPO) });
    assert.equal(response.status, 201);
    const key = (await response.json()).source.key;
    response = await fetch(c.base + "/api/pack-sources", { headers: pat(issued.token) });
    assert.deepEqual((await response.json()).sources, [{ key, ...REPO }]);
    response = await fetch(c.base + "/api/pack-sources/" + key, { method: "PUT", headers: pat(issued.token), body: JSON.stringify({ ...REPO, branch: "dev" }) });
    assert.equal(response.status, 200);
    response = await fetch(c.base + "/api/pack-sources/" + key, { method: "DELETE", headers: pat(issued.token) });
    assert.equal((await response.json()).removed, true);
    assert.deepEqual(c.hub.packSources.list(), []);
    const audit = JSON.stringify(c.hub.audit.list());
    assert.match(audit, /pat:owner\/source-manager/);
    assert.match(audit, /pack-source-updated/);
    assert.ok(!audit.includes(issued.token));
    assert.equal((await fetch(c.base + "/api/users", { headers: pat(issued.token) })).status, 401, "source scope 不是身份管理权限");
  } finally { await c.close(); }
});

test("read PAT 不能写，旧默认 PAT 不自动获得来源管理权限", async () => {
  const c = await boot();
  try {
    const read = await createPat(c, "source-reader", ["pack-sources.read"]);
    assert.equal((await fetch(c.base + "/api/pack-sources", { headers: pat(read.token) })).status, 200);
    assert.equal((await fetch(c.base + "/api/pack-sources", { method: "POST", headers: pat(read.token), body: JSON.stringify(REPO) })).status, 403);
    const old = await createPat(c, "default-client");
    assert.ok(!old.pat.scopes.some((s) => s.startsWith("pack-sources.")));
    assert.equal((await fetch(c.base + "/api/pack-sources", { headers: pat(old.token) })).status, 403);
    assert.equal((await fetch(c.base + "/api/pack-sources")).status, 401);
  } finally { await c.close(); }
});

test("来源 PAT 吊销、用户降权后立即拒绝", async () => {
  const c = await boot();
  try {
    const user = await c.hub.identity.createUser(c.principal, { username: "maintainer", password: "temporary maintainer password", roleId: "admin", forcePasswordChange: false });
    const login = await c.hub.identity.login({ username: "maintainer", password: "temporary maintainer password" });
    const principal = await c.hub.identity.authenticateSession(login.token);
    const issued = await c.hub.identity.createPat(principal, { name: "source-maintainer", scopes: ["pack-sources.read", "pack-sources.manage"] });
    assert.equal((await fetch(c.base + "/api/pack-sources", { headers: pat(issued.token) })).status, 200);
    await c.hub.identity.updateUser(c.principal, user.id, { roleId: "operator" });
    assert.equal((await fetch(c.base + "/api/pack-sources", { headers: pat(issued.token) })).status, 401);
    assert.equal(await c.hub.identity.authenticateSession(login.token), null);
    const revoke = await createPat(c, "revoked-source", ["pack-sources.read"]);
    await c.hub.identity.revokePat(c.principal, revoke.pat.id);
    assert.equal((await fetch(c.base + "/api/pack-sources", { headers: pat(revoke.token) })).status, 401);
    const relogin = await c.hub.identity.login({ username: "maintainer", password: "temporary maintainer password" });
    const operator = await c.hub.identity.authenticateSession(relogin.token);
    await assert.rejects(c.hub.identity.createPat(operator, { name: "escalate", scopes: ["pack-sources.manage"] }), /超出用户当前角色/);
  } finally { await c.close(); }
});

test("成员 token 只读 wire 来源，不能管理；吊销后读取也失效", async () => {
  const c = await boot();
  try {
    const token = "source-sync-agent-token-for-test";
    configureTestAgentTokens(c.hub, { "source-client": token });
    c.hub.packSources.create(REPO);
    const response = await fetch(c.base + "/api/agent/pack-sources", { headers: pat(token) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual(body.sources, [REPO]);
    assert.ok(!("key" in body.sources[0]));
    assert.equal((await fetch(c.base + "/api/pack-sources", { headers: pat(token) })).status, 401);
    assert.equal((await fetch(c.base + "/api/pack-sources", { method: "POST", headers: pat(token), body: JSON.stringify(REPO) })).status, 401);
    c.hub.members.remove("source-client");
    assert.equal((await fetch(c.base + "/api/agent/pack-sources", { headers: pat(token) })).status, 401);
    const issued = await createPat(c, "not-a-member", ["pack-sources.read"]);
    assert.equal((await fetch(c.base + "/api/agent/pack-sources", { headers: pat(issued.token) })).status, 401);
  } finally { await c.close(); }
});

test("会话仍要求 CSRF；来源 URL 不能嵌入凭据或查询密钥", async () => {
  const c = await boot();
  try {
    assert.equal((await fetch(c.base + "/api/pack-sources", { method: "POST", headers: { ...c.headers, "X-CSRF-Token": "wrong" }, body: JSON.stringify(REPO) })).status, 403);
    const issued = await createPat(c, "input-test", ["pack-sources.manage"]);
    for (const git of ["https://secret:passwd@example.com/repo.git", "https://example.com/repo.git?token=secret", "ssh://git:passwd@example.com/repo.git"]) {
      const response = await fetch(c.base + "/api/pack-sources", { method: "POST", headers: pat(issued.token), body: JSON.stringify({ git }) });
      assert.equal(response.status, 400);
      assert.ok(!(await response.text()).includes("passwd"));
    }
    assert.deepEqual(c.hub.packSources.list(), []);
  } finally { await c.close(); }
});
