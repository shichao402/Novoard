import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHub } from "../src/main.mjs";

const ORIGIN = "http://test.local";

function tmpStateDir() {
  return mkdtempSync(join(tmpdir(), "novoard-auth-http-"));
}

async function boot() {
  const stateDir = tmpStateDir();
  const hub = await createHub({
    stateDir,
    port: 0,
    publicOrigin: ORIGIN,
    secureCookies: false,
    offlineSweepMs: 60_000,
    log: { info() {}, error() {} },
  });
  const port = hub.server.address().port;
  return {
    hub,
    stateDir,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => hub.server.close(resolve)),
  };
}

function cookieFrom(response) {
  return response.headers.get("set-cookie").split(";")[0];
}

function sessionHeaders(cookie, csrf, extra = {}) {
  return {
    Cookie: cookie,
    Origin: ORIGIN,
    "X-CSRF-Token": csrf,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function setupOwner(base) {
  const response = await fetch(`${base}/api/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "owner",
      displayName: "Owner",
      password: "correct horse battery staple",
    }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  return { body, cookie: cookieFrom(response), csrf: body.csrfToken };
}

test("HTTP 身份闭环：setup → session → 用户/角色/PAT → logout", async () => {
  const { base, stateDir, close } = await boot();
  try {
    let response = await fetch(`${base}/api/setup/status`);
    assert.deepEqual(await response.json(), { required: true });

    response = await fetch(`${base}/api/tasks`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "setup_required");

    const owner = await setupOwner(base);
    assert.equal(owner.body.user.roleId, "superadmin");

    response = await fetch(`${base}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "other", password: "another setup password" }),
    });
    assert.equal(response.status, 410);

    response = await fetch(`${base}/api/me`, { headers: { Cookie: owner.cookie } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.username, "owner");

    response = await fetch(`${base}/api/roles`, { headers: { Cookie: owner.cookie } });
    assert.equal(response.status, 200);
    assert.ok((await response.json()).roles.some((role) => role.id === "superadmin"));

    response = await fetch(`${base}/api/users`, {
      method: "POST",
      headers: sessionHeaders(owner.cookie, owner.csrf),
      body: JSON.stringify({
        username: "operator-user",
        displayName: "Operator",
        password: "temporary operator password",
        roleId: "operator",
      }),
    });
    assert.equal(response.status, 201);
    const operator = (await response.json()).user;
    assert.equal(operator.forcePasswordChange, true);

    response = await fetch(`${base}/api/pats`, {
      method: "POST",
      headers: sessionHeaders(owner.cookie, owner.csrf),
      body: JSON.stringify({
        name: "cli",
        scopes: ["system.read", "targets.read", "targets.execute"],
        targetAllow: ["*"],
      }),
    });
    assert.equal(response.status, 201);
    const issued = await response.json();
    assert.match(issued.token, /^nvp_/);

    response = await fetch(`${base}/api/status`, {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    assert.equal(response.status, 200);

    response = await fetch(`${base}/api/trigger`, {
      method: "POST",
      headers: { Authorization: `Bearer ${issued.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ target: "missing-target" }),
    });
    assert.equal(response.status, 404);

    response = await fetch(`${base}/api/logout`, {
      method: "POST",
      headers: sessionHeaders(owner.cookie, owner.csrf),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /Max-Age=0/);

    response = await fetch(`${base}/api/me`, { headers: { Cookie: owner.cookie } });
    assert.equal(response.status, 401);
  } finally {
    await close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("会话写操作必须通过 Origin + CSRF，强制改密用户只能改密", async () => {
  const { base, stateDir, close } = await boot();
  try {
    const owner = await setupOwner(base);
    let response = await fetch(`${base}/api/users`, {
      method: "POST",
      headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "blocked", password: "temporary blocked pass", roleId: "viewer" }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "csrf_failed");

    response = await fetch(`${base}/api/users`, {
      method: "POST",
      headers: sessionHeaders(owner.cookie, owner.csrf),
      body: JSON.stringify({ username: "reader", password: "temporary reader password", roleId: "viewer" }),
    });
    const reader = (await response.json()).user;

    response = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "reader", password: "temporary reader password" }),
    });
    assert.equal(response.status, 200);
    const readerCookie = cookieFrom(response);
    const readerLogin = await response.json();

    response = await fetch(`${base}/api/status`, { headers: { Cookie: readerCookie } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "password_change_required");

    response = await fetch(`${base}/api/me/password`, {
      method: "POST",
      headers: sessionHeaders(readerCookie, readerLogin.csrfToken),
      body: JSON.stringify({
        currentPassword: "temporary reader password",
        newPassword: "reader permanent password",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.forcePasswordChange, false);

    response = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: reader.username, password: "reader permanent password" }),
    });
    assert.equal(response.status, 200);
  } finally {
    await close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("公开登录按来源与账号限速，错误响应不泄露账号是否存在", async () => {
  const { base, stateDir, close } = await boot();
  try {
    await setupOwner(base);
    const unknown = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "not-a-user",
        password: "definitely the wrong password",
      }),
    });
    assert.equal(unknown.status, 401);
    assert.deepEqual(await unknown.json(), { error: "invalid_credentials" });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await fetch(`${base}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "owner",
          password: "definitely the wrong password",
        }),
      });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "invalid_credentials" });
    }
    const limited = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "owner",
        password: "correct horse battery staple",
      }),
    });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: "too_many_attempts" });
  } finally {
    await close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("RBAC 列表过滤与 target 范围在 REST 入口一致生效", async () => {
  const { hub, base, stateDir, close } = await boot();
  try {
    await setupOwner(base);
    const ownerLogin = await hub.identity.login({ username: "owner", password: "correct horse battery staple" });
    const owner = await hub.identity.authenticateSession(ownerLogin.token);
    const role = await hub.identity.createRole(owner, {
      id: "mac-work-only",
      name: "Mac Work Only",
      permissions: ["system.read", "targets.read", "targets.execute", "tasks.read", "audit.read"],
      targetAllow: ["mac-work/*"],
      targetDeny: [],
    });
    const user = await hub.identity.createUser(owner, {
      username: "scoped",
      password: "scoped permanent password",
      roleId: role.id,
      forcePasswordChange: false,
    });
    const login = await hub.identity.login({ username: user.username, password: "scoped permanent password" });
    const principal = await hub.identity.authenticateSession(login.token);
    const issued = await hub.identity.createPat(principal, { name: "scope-test" });
    const headers = { Authorization: `Bearer ${issued.token}` };

    const card = (name, skill) => ({
      name,
      description: name,
      version: "1.0.0",
      capabilities: { streaming: false, pushNotifications: true },
      defaultInputModes: ["text"],
      defaultOutputModes: ["text", "file"],
      skills: [{ id: skill, name: skill, description: skill, tags: [] }],
    });
    hub.registry.register({ agentId: "mac-work", card: card("work", "safe-target"), conn: { readyState: 1, send() {} } });
    hub.registry.register({ agentId: "mac-home", card: card("home", "hidden-target"), conn: { readyState: 1, send() {} } });
    hub.queue.submit({ skillId: "safe-target", target: "safe-target", member: "mac-work", actor: "test", lane: "a2a" });
    hub.queue.submit({ skillId: "hidden-target", target: "hidden-target", member: "mac-home", actor: "test", lane: "a2a" });

    let response = await fetch(`${base}/api/targets`, { headers });
    const catalog = (await response.json()).catalog;
    assert.deepEqual(catalog.map((member) => member.agentId), ["mac-work"]);

    response = await fetch(`${base}/api/tasks`, { headers });
    const tasks = (await response.json()).tasks;
    assert.deepEqual(tasks.map((task) => task.target), ["safe-target"]);

    response = await fetch(`${base}/api/status`, { headers });
    const status = await response.json();
    assert.deepEqual(status.members.map((member) => member.agentId), ["mac-work"]);
    assert.equal(status.tasks.total, 1);
    assert.equal("secrets" in status, false);

    response = await fetch(`${base}/api/trigger`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ target: "hidden-target" }),
    });
    assert.equal(response.status, 404);
  } finally {
    await close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("企微配置默认拒绝，服务账号不可登录，PAT 可验证后无中断轮换", async () => {
  const { hub, base, stateDir, close } = await boot();
  try {
    const setup = await setupOwner(base);
    const ownerHeaders = sessionHeaders(setup.cookie, setup.csrf);

    let response = await fetch(`${base}/api/wecom/config`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({
        allowedUserIds: ["FIROYANG"],
        allowedChatIds: ["wr-team"],
        notifyChatId: "wr-notify",
      }),
    });
    assert.equal(response.status, 200);
    const configured = (await response.json()).config;
    assert.deepEqual(configured.allowedUserIds, ["FIROYANG"]);
    assert.deepEqual(configured.allowedChatIds, ["wr-team"]);
    assert.equal(configured.notifyChatId, "wr-notify");
    assert.equal("botSecret" in configured, false);

    response = await fetch(`${base}/api/wecom/service-pat/rotate`, {
      method: "POST",
      headers: ownerHeaders,
    });
    assert.equal(response.status, 201);
    const first = await response.json();
    assert.equal(first.serviceAccount.accountType, "service");
    assert.deepEqual(first.pat.scopes, ["targets.read", "targets.execute", "tasks.read", "tasks.approve"]);
    assert.equal("token" in first, false, "服务 PAT 明文不得返回浏览器");
    const firstToken = hub.secrets.get("wecomServicePat");
    assert.equal((await hub.identity.authenticatePat(firstToken)).user.username, "wecom-bot");
    assert.equal(await hub.identity.login({ username: "wecom-bot", password: "any password value" }), null);

    response = await fetch(`${base}/api/wecom/service-pat/rotate`, {
      method: "POST",
      headers: ownerHeaders,
    });
    assert.equal(response.status, 201);
    const second = await response.json();
    const secondToken = hub.secrets.get("wecomServicePat");
    assert.notEqual(secondToken, firstToken);
    assert.equal(await hub.identity.authenticatePat(firstToken), null, "切换后旧 PAT 必须吊销");
    assert.equal((await hub.identity.authenticatePat(secondToken)).pat.id, second.pat.id);

    const card = {
      name: "work",
      description: "work",
      version: "1.0.0",
      capabilities: { streaming: false, pushNotifications: true },
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      skills: [{ id: "wecom-safe", name: "safe", description: "safe", tags: [] }],
    };
    hub.registry.register({ agentId: "mac-work", card, conn: { readyState: 1, send() {} } });
    await hub.wecomBot._receiveTestText({
      body: {
        chattype: "single",
        from: { userid: "FIROYANG" },
        text: { content: "run wecom-safe" },
      },
    });
    const task = hub.queue.list()[0];
    assert.equal(task.actor, "wecom:FIROYANG");
    const commandAudit = hub.audit.list().find((entry) => entry.target === "wecom" && entry.detail?.command === "run wecom-safe");
    assert.equal(commandAudit.detail.senderUserId, "FIROYANG");
    assert.equal(commandAudit.detail.chatId, "FIROYANG");
    assert.equal(commandAudit.outcome, "accepted");
  } finally {
    await close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
