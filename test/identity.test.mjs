import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUILTIN_ROLES, createIdentityStore } from "../src/identity.mjs";
import { runAdmin } from "../src/admin.mjs";

function tmpStateDir() {
  return mkdtempSync(join(tmpdir(), "novoard-identity-"));
}

async function initializedStore() {
  const stateDir = tmpStateDir();
  const store = await createIdentityStore({ stateDir });
  const setup = await store.setup({
    username: "owner",
    displayName: "Owner",
    password: "correct horse battery staple",
  });
  const owner = await store.authenticateSession(setup.token);
  return { stateDir, store, setup, owner };
}

test("口令强度：10 位允许，9 位拒绝", async () => {
  const stateDir = tmpStateDir();
  try {
    const store = await createIdentityStore({ stateDir });
    await assert.rejects(
      store.setup({ username: "owner", password: "123456789" }),
      (error) => error.code === "invalid-password",
    );
    const setup = await store.setup({ username: "owner", password: "1234567890" });
    assert.equal(setup.user.roleId, "superadmin");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("全新安装：首个账号原子成为 superadmin，setup 永久关闭", async () => {
  const stateDir = tmpStateDir();
  try {
    const store = await createIdentityStore({ stateDir });
    assert.equal((await store.setupStatus()).required, true);

    const attempts = await Promise.allSettled([
      store.setup({ username: "first", displayName: "First", password: "123456789012-first" }),
      store.setup({ username: "second", displayName: "Second", password: "123456789012-second" }),
    ]);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await store.setupStatus()).required, false);

    const users = await store.listUsers();
    assert.equal(users.length, 1);
    assert.equal(users[0].roleId, "superadmin");
    assert.equal(statSync(stateDir).mode & 0o777, 0o700);
    for (const file of Object.values(store.files)) {
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
    await assert.rejects(
      store.setup({ username: "third", password: "123456789012-third" }),
      (error) => error.code === "already-initialized",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("会话：口令不作为 Bearer 存储，改密后旧会话立即失效", async () => {
  const { stateDir, store, setup, owner } = await initializedStore();
  try {
    const identityText = readFileSync(store.files.identityFile, "utf8");
    const sessionsText = readFileSync(store.files.sessionsFile, "utf8");
    assert.doesNotMatch(identityText, /correct horse battery staple/);
    assert.doesNotMatch(sessionsText, new RegExp(setup.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(owner.kind, "session");
    assert.equal(owner.role.id, "superadmin");

    await store.changeOwnPassword(owner, "correct horse battery staple", "new correct horse battery staple");
    assert.equal(await store.authenticateSession(setup.token), null);
    assert.equal(await store.login({ username: "owner", password: "correct horse battery staple" }), null);
    assert.ok(await store.login({ username: "OWNER", password: "new correct horse battery staple" }));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("用户与角色：只有 superadmin 能授予 superadmin，最后一位不可降级", async () => {
  const { stateDir, store, owner } = await initializedStore();
  try {
    const admin = await store.createUser(owner, {
      username: "admin-user",
      password: "temporary admin password",
      roleId: "admin",
    });
    const adminLogin = await store.login({ username: admin.username, password: "temporary admin password" });
    const adminPrincipal = await store.authenticateSession(adminLogin.token);

    await assert.rejects(
      store.createUser(adminPrincipal, {
        username: "forbidden-root",
        password: "temporary root password",
        roleId: "superadmin",
      }),
      (error) => error.code === "forbidden",
    );
    await assert.rejects(
      store.updateUser(owner, owner.user.id, { roleId: "admin" }),
      (error) => error.code === "last-superadmin",
    );

    const backup = await store.createUser(owner, {
      username: "backup-root",
      password: "temporary backup root",
      roleId: "superadmin",
    });
    await store.updateUser(owner, owner.user.id, { roleId: "admin" });
    assert.equal((await store.listUsers()).find((user) => user.id === backup.id).roleId, "superadmin");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("自定义角色：只能组合业务权限，target 默认拒绝并显式放行", async () => {
  const { stateDir, store, owner } = await initializedStore();
  try {
    await assert.rejects(
      store.createRole(owner, {
        id: "unsafe-admin",
        name: "Unsafe",
        permissions: ["users.manage"],
        targetAllow: ["*"],
      }),
      (error) => error.code === "reserved-permission",
    );
    const role = await store.createRole(owner, {
      id: "mac-runner",
      name: "Mac Runner",
      permissions: ["system.read", "targets.read", "targets.execute"],
      targetAllow: ["mac-work/*"],
      targetDeny: ["mac-work/danger"],
    });
    assert.equal(role.builtIn, false);
    const user = await store.createUser(owner, {
      username: "runner",
      password: "temporary runner pass",
      roleId: role.id,
    });
    const login = await store.login({ username: user.username, password: "temporary runner pass" });
    const principal = await store.authenticateSession(login.token);
    assert.equal(store.targetAllowed(principal, "mac-work", "safe"), true);
    assert.equal(store.targetAllowed(principal, "mac-work", "danger"), false);
    assert.equal(store.targetAllowed(principal, "mac-home", "safe"), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("PAT：只存哈希、scope 不可越权、吊销和用户禁用立即生效", async () => {
  const { stateDir, store, owner } = await initializedStore();
  try {
    await assert.rejects(
      store.createPat(owner, { name: "identity-admin", scopes: ["users.manage"] }),
      (error) => error.code === "invalid-pat-scope",
    );
    const viewer = await store.createUser(owner, {
      username: "reader",
      password: "temporary reader pass",
      roleId: "viewer",
    });
    const login = await store.login({ username: viewer.username, password: "temporary reader pass" });
    const principal = await store.authenticateSession(login.token);
    await assert.rejects(
      store.createPat(principal, { name: "bad", scopes: ["targets.execute"] }),
      (error) => error.code === "scope-exceeds-role",
    );
    await assert.rejects(
      store.createPat(principal, { name: "empty", scopes: [] }),
      (error) => error.code === "invalid-pat-scope",
    );
    const issued = await store.createPat(principal, {
      name: "readonly",
      scopes: ["system.read", "tasks.read"],
      targetAllow: ["mac-work/*"],
    });
    assert.match(issued.token, /^nvp_/);
    assert.doesNotMatch(readFileSync(store.files.identityFile, "utf8"), new RegExp(issued.token));
    const patPrincipal = await store.authenticatePat(issued.token);
    assert.deepEqual(patPrincipal.permissions.sort(), ["system.read", "tasks.read"]);
    const persistedPat = JSON.parse(readFileSync(store.files.identityFile, "utf8"))
      .pats.find((pat) => pat.id === issued.pat.id);
    assert.ok(persistedPat.lastUsedAt, "PAT 认证返回前应完成已节流的 lastUsedAt 写入");

    await store.revokePat(principal, issued.pat.id);
    assert.equal(await store.authenticatePat(issued.token), null);

    const next = await store.createPat(principal, { name: "second", scopes: ["system.read"] });
    await store.updateUser(owner, viewer.id, { disabled: true });
    assert.equal(await store.authenticatePat(next.token), null);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("会话与 PAT 到期后立即失效，过期会话可清理", async () => {
  const stateDir = tmpStateDir();
  let clock = Date.now();
  try {
    const store = await createIdentityStore({
      stateDir,
      now: () => clock,
      sessionTtlMs: 1_000,
    });
    const setup = await store.setup({
      username: "owner",
      password: "correct horse battery staple",
    });
    const owner = await store.authenticateSession(setup.token);
    const issued = await store.createPat(owner, {
      name: "short-lived",
      expiresAt: new Date(clock + 1_000).toISOString(),
    });

    clock += 1_001;
    assert.equal(await store.authenticateSession(setup.token), null);
    assert.equal(await store.authenticatePat(issued.token), null);
    assert.equal(await store.pruneExpiredSessions(), 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("并发身份写入经过同一文件锁，不丢失用户", async () => {
  const { stateDir, store, owner } = await initializedStore();
  try {
    await Promise.all(
      ["alpha", "bravo", "charlie", "delta"].map((username) =>
        store.createUser(owner, {
          username,
          password: `temporary password ${username}`,
          roleId: "viewer",
        }),
      ),
    );
    assert.deepEqual(
      (await store.listUsers()).map((user) => user.username).sort(),
      ["alpha", "bravo", "charlie", "delta", "owner"],
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("换角色立即使旧 PAT 失效，企微服务 PAT 仅超级管理员可见和吊销", async () => {
  const { stateDir, store, owner } = await initializedStore();
  try {
    const user = await store.createUser(owner, {
      username: "operator-user",
      password: "temporary operator password",
      roleId: "operator",
      forcePasswordChange: false,
    });
    const login = await store.login({
      username: user.username,
      password: "temporary operator password",
    });
    const operator = await store.authenticateSession(login.token);
    const personal = await store.createPat(operator, {
      name: "operator-token",
      scopes: ["targets.execute"],
    });
    await store.updateUser(owner, user.id, { roleId: "viewer" });
    assert.equal(await store.authenticatePat(personal.token), null);

    const serviceUser = await store.ensureWecomServiceAccount(owner);
    const service = await store.createPat(owner, {
      userId: serviceUser.id,
      name: "wecom-service",
      kind: "service",
      scopes: ["targets.execute"],
    });
    const adminUser = await store.createUser(owner, {
      username: "admin-user",
      password: "temporary admin password",
      roleId: "admin",
      forcePasswordChange: false,
    });
    const adminLogin = await store.login({
      username: adminUser.username,
      password: "temporary admin password",
    });
    const admin = await store.authenticateSession(adminLogin.token);
    assert.equal((await store.listPats(admin)).some((pat) => pat.id === service.pat.id), false);
    await assert.rejects(
      store.revokePat(admin, service.pat.id),
      (error) => error.code === "forbidden",
    );
    assert.ok(await store.authenticatePat(service.token));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("break-glass：只能恢复已有 superadmin，并吊销其会话和 PAT", async () => {
  const { stateDir, store, setup, owner } = await initializedStore();
  try {
    const pat = await store.createPat(owner, { name: "owner-cli", scopes: ["system.read"] });
    await assert.rejects(
      store.recoverSuperadmin("missing", "a completely new password"),
      (error) => error.code === "user-not-found",
    );
    await store.recoverSuperadmin("owner", "a completely new password");
    assert.equal(await store.authenticateSession(setup.token), null);
    assert.equal(await store.authenticatePat(pat.token), null);
    assert.ok(await store.login({ username: "owner", password: "a completely new password" }));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("admin CLI：TTY 提示注入恢复口令并写安全审计", async () => {
  const { stateDir, store } = await initializedStore();
  try {
    const answers = ["cli recovery password", "cli recovery password"];
    const logs = [];
    await runAdmin({
      args: ["recover", "owner"],
      stateDir,
      promptPassword: async () => answers.shift(),
      log: { info: (message) => logs.push(message) },
    });
    assert.ok(await store.login({ username: "owner", password: "cli recovery password" }));
    assert.match(logs[0], /已恢复/);
    const audit = readFileSync(join(stateDir, "audit", "audit.jsonl"), "utf8");
    assert.match(audit, /server:break-glass/);
    assert.doesNotMatch(audit, /cli recovery password/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("状态损坏与旧凭据 fail-closed", async () => {
  const corruptDir = tmpStateDir();
  const legacyDir = tmpStateDir();
  const runtimeDir = tmpStateDir();
  const semanticDir = tmpStateDir();
  try {
    writeFileSync(join(corruptDir, "install.json"), "{bad");
    await assert.rejects(createIdentityStore({ stateDir: corruptDir }), /状态损坏/);

    writeFileSync(join(legacyDir, "secrets.json"), JSON.stringify({ dashboardToken: "legacy-pass" }));
    await assert.rejects(createIdentityStore({ stateDir: legacyDir }), /只支持空状态全新安装/);

    mkdirSync(join(runtimeDir, "queue"));
    await assert.rejects(createIdentityStore({ stateDir: runtimeDir }), /旧运行态 queue/);

    const semantic = await createIdentityStore({ stateDir: semanticDir });
    await semantic.setup({
      username: "owner",
      password: "correct horse battery staple",
    });
    const identity = JSON.parse(readFileSync(semantic.files.identityFile, "utf8"));
    identity.users[0].roleId = "missing-role";
    writeFileSync(semantic.files.identityFile, JSON.stringify(identity));
    await assert.rejects(createIdentityStore({ stateDir: semanticDir }), /无效用户/);
  } finally {
    rmSync(corruptDir, { recursive: true, force: true });
    rmSync(legacyDir, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(semanticDir, { recursive: true, force: true });
  }
});

test("内置角色权限基线固定", () => {
  assert.ok(BUILTIN_ROLES.superadmin.permissions.includes("users.manage"));
  assert.equal(BUILTIN_ROLES.admin.permissions.includes("wecom.manage"), false);
  assert.ok(BUILTIN_ROLES.operator.permissions.includes("targets.execute"));
  assert.equal(BUILTIN_ROLES.viewer.permissions.includes("targets.execute"), false);
});
