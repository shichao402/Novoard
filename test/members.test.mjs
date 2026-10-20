/**
 * 成员目录 HTTP 闭环（SSOT 回归）：
 * 1. 签发后即使 agent 从未接入，成员也必须出现在 /api/members 与 /api/status；
 * 2. 同一 agentId 可直接轮换与吊销，吊销即失效（隧道鉴权不再通过）；
 * 3. 成员列表的凭据字段只对 superadmin 暴露；
 * 4. 旧 secrets.json 的 agentTokenHashes 在启动时迁移进 members.json 并摘除。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHub } from "../src/main.mjs";
import { hashAgentToken } from "../src/agent-auth.mjs";

const ORIGIN = "http://test.local";

function tmpStateDir() {
  return mkdtempSync(join(tmpdir(), "novoard-members-"));
}

function cookieFrom(response) {
  return response.headers.get("set-cookie").split(";")[0];
}

async function boot({ stateDir } = {}) {
  const dir = stateDir ?? tmpStateDir();
  const hub = await createHub({
    stateDir: dir,
    port: 0,
    publicOrigin: ORIGIN,
    secureCookies: false,
    offlineSweepMs: 60_000,
    log: { info() {}, error() {} },
  });
  const port = hub.server.address().port;
  return {
    hub,
    stateDir: dir,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => hub.server.close(resolve)),
  };
}

async function loginSuperadmin(base) {
  const response = await fetch(`${base}/api/setup`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "owner",
      displayName: "Owner",
      password: "correct horse battery staple",
    }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  return { cookie: cookieFrom(response), csrf: body.csrfToken };
}

function adminHeaders(owner, extra = {}) {
  return {
    Cookie: owner.cookie,
    Origin: ORIGIN,
    "X-CSRF-Token": owner.csrf,
    "Content-Type": "application/json",
    ...extra,
  };
}

const CARD = {
  name: "工位 Mac",
  description: "dev builder",
  version: "1.0.0",
  capabilities: { streaming: false, pushNotifications: true },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  skills: [{ id: "dev-build-investm", name: "构建 InvestM dev", description: "d", tags: [] }],
};

test("签发但从未接入的成员可列出、可吊销", async () => {
  const { base, stateDir, close } = await boot();
  try {
    const owner = await loginSuperadmin(base);

    // 签发凭据：此时 agent 不会接入，注册表里没有任何成员
    let response = await fetch(`${base}/api/members/win-dev`, {
      method: "POST",
      headers: adminHeaders(owner),
    });
    assert.equal(response.status, 201);
    const issued = await response.json();
    assert.equal(issued.agentId, "win-dev");
    assert.equal(issued.rotated, false);
    assert.match(issued.token, /^nva_/);

    // 关键回归：没有 online 成员，但成员列表必须出现这一行
    response = await fetch(`${base}/api/members`, {
      headers: { Authorization: `Bearer ${await patOf(base, owner)}` },
    });
    assert.equal(response.status, 200);
    let members = (await response.json()).members;
    assert.deepEqual(members.map((member) => member.agentId), ["win-dev"]);
    assert.equal(members[0].online, false);
    assert.equal(members[0].registered, false, "从未接入必须标记 registered=false");

    // /api/status 同源，不再依赖注册表快照
    response = await fetch(`${base}/api/status`, {
      headers: { Authorization: `Bearer ${await patOf(base, owner)}` },
    });
    const status = await response.json();
    assert.deepEqual(status.members.map((member) => member.agentId), ["win-dev"]);

    // 轮换：同一 agentId 返回 200 + rotated=true，旧 token 立即失效
    response = await fetch(`${base}/api/members/win-dev`, {
      method: "POST",
      headers: adminHeaders(owner),
    });
    assert.equal(response.status, 200);
    const rotated = await response.json();
    assert.equal(rotated.rotated, true);
    assert.notEqual(rotated.token, issued.token);
    assert.equal(hubless_authenticate(stateDir, issued.token), null, "旧 token 轮换后必须失效");
    assert.equal(hubless_authenticate(stateDir, rotated.token), "win-dev");

    // 吊销：成员消失，凭据失效
    response = await fetch(`${base}/api/members/win-dev`, {
      method: "DELETE",
      headers: adminHeaders(owner),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).removed, true);

    response = await fetch(`${base}/api/members`, {
      headers: { Authorization: `Bearer ${await patOf(base, owner)}` },
    });
    members = (await response.json()).members;
    assert.deepEqual(members, [], "吊销后成员不应再出现在列表");
    assert.equal(hubless_authenticate(stateDir, rotated.token), null);
  } finally {
    await close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("在线成员与未接入成员同表，吊销在线成员会摘除其 card", async () => {
  const { hub, base, stateDir, close } = await boot();
  try {
    const owner = await loginSuperadmin(base);
    hub.members.adoptTokenHash("mac-work", hashAgentToken("token-for-mac-work"));
    hub.registry.register({ agentId: "mac-work", card: CARD, conn: { readyState: 1, send() {}, close() {} } });

    await fetch(`${base}/api/members/ghost`, {
      method: "POST",
      headers: adminHeaders(owner),
    });

    const pat = await patOf(base, owner);
    let response = await fetch(`${base}/api/members`, {
      headers: { Authorization: `Bearer ${pat}` },
    });
    const members = (await response.json()).members;
    assert.deepEqual(
      members.map((member) => member.agentId).sort(),
      ["ghost", "mac-work"],
    );
    const online = members.find((member) => member.agentId === "mac-work");
    assert.equal(online.online, true);
    assert.equal(online.registered, true);

    // 吊销在线成员：注册表同步摘除，聚合 card 不再暴露该成员
    response = await fetch(`${base}/api/members/mac-work`, {
      method: "DELETE",
      headers: adminHeaders(owner),
    });
    assert.equal(response.status, 200);
    assert.equal(hub.registry.ownerOf("dev-build-investm"), null, "吊销后 skill 归属必须清除");
    assert.equal(hub.registry.catalog().some((m) => m.agentId === "mac-work"), false);
  } finally {
    await close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("非 superadmin 看不到凭据字段，也不能签发/吊销", async () => {
  const { base, stateDir, close } = await boot();
  try {
    const owner = await loginSuperadmin(base);
    await fetch(`${base}/api/members/win-dev`, {
      method: "POST",
      headers: adminHeaders(owner),
    });

    // 建一个 admin（非 superadmin）并登录
    let response = await fetch(`${base}/api/users`, {
      method: "POST",
      headers: adminHeaders(owner),
      body: JSON.stringify({
        username: "ops-admin",
        displayName: "Ops Admin",
        password: "ops admin password",
        roleId: "admin",
        forcePasswordChange: false,
      }),
    });
    assert.equal(response.status, 201);

    response = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ops-admin", password: "ops admin password" }),
    });
    const adminSession = await response.json();
    const adminCookie = cookieFrom(response);

    response = await fetch(`${base}/api/members`, { headers: { Cookie: adminCookie } });
    assert.equal(response.status, 200);
    const members = (await response.json()).members;
    assert.equal(members[0].agentId, "win-dev");
    assert.equal(members[0].credentials, undefined, "非 superadmin 不得看到凭据视图");

    response = await fetch(`${base}/api/members/win-dev`, {
      method: "DELETE",
      headers: {
        Cookie: adminCookie,
        Origin: ORIGIN,
        "X-CSRF-Token": adminSession.csrfToken,
        "Content-Type": "application/json",
      },
    });
    assert.equal(response.status, 403);
  } finally {
    await close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("历史 secrets.json 的 agentTokenHashes 启动时迁入 members.json 并摘除", async () => {
  const stateDir = tmpStateDir();
  const legacyHash = hashAgentToken("legacy-token-123456");
  writeFileSync(join(stateDir, "secrets.json"), JSON.stringify({
    agentTokenHashes: { "mac-home": legacyHash },
    wecomNotifyChatId: "wr-notify",
  }, null, 2));

  const { base, hub, close } = await boot({ stateDir });
  try {
    assert.deepEqual(hub.migratedMembers, ["mac-home"]);
    assert.equal(hub.members.authenticate("legacy-token-123456"), "mac-home", "迁移后旧 token 仍可用");

    const secretsAfter = JSON.parse(readFileSync(join(stateDir, "secrets.json"), "utf8"));
    assert.equal("agentTokenHashes" in secretsAfter, false, "旧字段必须摘除，避免第二份真相");
    assert.equal(secretsAfter.wecomNotifyChatId, "wr-notify", "其他配置不受影响");

    const stored = JSON.parse(readFileSync(join(stateDir, "members.json"), "utf8"));
    assert.equal(stored.members["mac-home"].tokenHash, legacyHash);
    assert.equal(stored.members["mac-home"].tokenIssuedAt, null, "迁移来的记录签发时间未知");

    // 迁移后该成员即可在列表中出现（即使从未接入）
    const owner = await loginSuperadmin(base);
    const response = await fetch(`${base}/api/members`, {
      headers: { Authorization: `Bearer ${await patOf(base, owner)}` },
    });
    const members = (await response.json()).members;
    assert.deepEqual(members.map((member) => member.agentId), ["mac-home"]);
  } finally {
    await close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

/** 直接读 members.json 判定 token 归属，避免依赖运行中的 hub 实例。 */
function hubless_authenticate(stateDir, token) {
  const stored = JSON.parse(readFileSync(join(stateDir, "members.json"), "utf8"));
  const expected = hashAgentToken(token);
  for (const [agentId, record] of Object.entries(stored.members ?? {})) {
    if (record.tokenHash === expected) return agentId;
  }
  return null;
}

/** 取一个 PAT 用于只读端点（成员列表允许 PAT）。 */
async function patOf(base, owner) {
  const response = await fetch(`${base}/api/pats`, {
    method: "POST",
    headers: adminHeaders(owner),
    body: JSON.stringify({ name: `members-test-${Date.now()}`, scopes: ["targets.read", "system.read"] }),
  });
  if (response.status !== 201) {
    throw new Error(`PAT 创建失败：${response.status} ${await response.text()}`);
  }
  return (await response.json()).token;
}
