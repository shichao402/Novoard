import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { basename, dirname, join } from "node:path";

const scrypt = promisify(scryptCallback);
const IDENTITY_SCHEMA_VERSION = 1;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;
const PAT_TOUCH_INTERVAL_MS = 5 * 60_000;

export const PERMISSIONS = Object.freeze([
  "system.read",
  "targets.read",
  "targets.execute",
  "tasks.read",
  "tasks.cancel",
  "tasks.approve",
  "artifacts.read",
  "audit.read",
  "pats.self.manage",
  "pats.any.revoke",
  "users.manage",
  "roles.manage",
  "webhooks.invoke",
  "wecom.manage",
]);

const OPERATIONAL_PERMISSIONS = Object.freeze(PERMISSIONS.filter((permission) => ![
  "pats.any.revoke",
  "users.manage",
  "roles.manage",
  "wecom.manage",
].includes(permission)));
const PAT_PERMISSIONS = Object.freeze(OPERATIONAL_PERMISSIONS.filter((permission) =>
  permission !== "pats.self.manage"));

export const BUILTIN_ROLES = Object.freeze({
  superadmin: Object.freeze({
    id: "superadmin",
    name: "超级管理员",
    builtIn: true,
    permissions: [...PERMISSIONS],
    targetAllow: ["*"],
    targetDeny: [],
  }),
  admin: Object.freeze({
    id: "admin",
    name: "管理员",
    builtIn: true,
    permissions: PERMISSIONS.filter((permission) => permission !== "wecom.manage"),
    targetAllow: ["*"],
    targetDeny: [],
  }),
  operator: Object.freeze({
    id: "operator",
    name: "操作员",
    builtIn: true,
    permissions: [
      "system.read",
      "targets.read",
      "targets.execute",
      "tasks.read",
      "tasks.cancel",
      "tasks.approve",
      "artifacts.read",
      "audit.read",
      "pats.self.manage",
    ],
    targetAllow: ["*"],
    targetDeny: [],
  }),
  viewer: Object.freeze({
    id: "viewer",
    name: "只读成员",
    builtIn: true,
    permissions: [
      "system.read",
      "targets.read",
      "tasks.read",
      "artifacts.read",
      "audit.read",
      "pats.self.manage",
    ],
    targetAllow: ["*"],
    targetDeny: [],
  }),
});

export async function createIdentityStore({
  stateDir,
  now = Date.now,
  sessionTtlMs = SESSION_TTL_MS,
  lockWaitMs = LOCK_WAIT_MS,
} = {}) {
  if (!stateDir) throw new Error("IdentityStore 需要 stateDir");

  const installFile = join(stateDir, "install.json");
  const identityFile = join(stateDir, "identity.json");
  const sessionsFile = join(stateDir, "sessions.json");
  const lockDir = join(stateDir, ".identity.lock");

  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  await ensureFreshOrLoadable();

  function timestamp() {
    return new Date(now()).toISOString();
  }

  async function ensureFreshOrLoadable() {
    const install = await readJsonMaybe(installFile, "install");
    const identity = await readJsonMaybe(identityFile, "identity");
    const sessions = await readJsonMaybe(sessionsFile, "sessions");

    if (!install && !identity && !sessions) {
      await rejectLegacyState();
      const createdAt = timestamp();
      await atomicWrite(installFile, {
        schemaVersion: IDENTITY_SCHEMA_VERSION,
        instanceId: randomUUID(),
        createdAt,
        initializedAt: null,
      });
      await atomicWrite(identityFile, emptyIdentity());
      await atomicWrite(sessionsFile, emptySessions());
      return;
    }

    if (!install || !identity || !sessions) {
      throw new Error("身份状态不完整，已 fail-closed；请恢复完整 .state 备份");
    }
    validateInstall(install);
    validateIdentity(identity);
    validateSessions(sessions);
    if (install.initializedAt && !identity.initializedAt) {
      throw new Error("身份状态不一致：install 已初始化但 identity 未初始化");
    }
    if (identity.initializedAt && !install.initializedAt) {
      await atomicWrite(installFile, { ...install, initializedAt: identity.initializedAt });
    } else if (identity.initializedAt !== install.initializedAt) {
      throw new Error("身份状态不一致：install 与 identity 初始化时间不同");
    }
    await Promise.all([
      chmod(installFile, 0o600),
      chmod(identityFile, 0o600),
      chmod(sessionsFile, 0o600),
    ]);
  }

  async function rejectLegacyState() {
    const entries = await readdir(stateDir).catch(() => []);
    const runtimeEntries = ["acl.yaml", "queue", "audit", "artifacts"].filter((entry) => entries.includes(entry));
    if (runtimeEntries.length) {
      throw new Error(`检测到旧运行态 ${runtimeEntries.join(", ")}；本版本只支持空状态全新安装`);
    }
    if (!entries.includes("secrets.json")) return;
    const secrets = await readJsonMaybe(join(stateDir, "secrets.json"), "secrets");
    if (secrets?.dashboardToken || (Array.isArray(secrets?.clientKeys) && secrets.clientKeys.length)
      || secrets?.clientKeys || secrets?.agentTokens) {
      throw new Error("检测到旧 dashboardToken/clientKeys/agentTokens；本版本只支持空状态全新安装");
    }
  }

  function emptyIdentity() {
    return {
      schemaVersion: IDENTITY_SCHEMA_VERSION,
      initializedAt: null,
      users: [],
      customRoles: [],
      pats: [],
    };
  }

  function emptySessions() {
    return { schemaVersion: IDENTITY_SCHEMA_VERSION, sessions: [] };
  }

  async function setupStatus() {
    const { install, identity } = await loadState();
    return {
      required: !identity.initializedAt,
      initializedAt: identity.initializedAt,
      instanceId: install.instanceId,
    };
  }

  async function setup({ username, displayName, password } = {}) {
    const normalized = normalizeUsername(username);
    validatePassword(password);
    return withLock(async () => {
      const { install, identity, sessions } = await loadState();
      if (identity.initializedAt || install.initializedAt) {
        throw identityError("already-initialized", "实例已经初始化");
      }
      if (identity.users.length) {
        throw new Error("未初始化 identity 中出现用户，已 fail-closed");
      }
      const createdAt = timestamp();
      const user = {
        id: randomUUID(),
        username: normalized,
        displayName: normalizeDisplayName(displayName, normalized),
        accountType: "human",
        passwordHash: await hashPassword(password),
        roleId: "superadmin",
        disabled: false,
        forcePasswordChange: false,
        securityVersion: 1,
        createdAt,
        updatedAt: createdAt,
      };
      const nextIdentity = { ...identity, initializedAt: createdAt, users: [user] };
      validateIdentity(nextIdentity);
      await atomicWrite(identityFile, nextIdentity);
      await atomicWrite(installFile, { ...install, initializedAt: createdAt });
      const issued = issueSessionRecord(user, sessions);
      await atomicWrite(sessionsFile, issued.next);
      return { user: publicUser(user), token: issued.token, csrfToken: issued.csrfToken, expiresAt: issued.record.expiresAt };
    });
  }

  async function login({ username, password } = {}) {
    const normalized = normalizeUsername(username, { throwOnInvalid: false });
    return withLock(async () => {
      const identity = await loadIdentity();
      const user = identity.users.find((candidate) => candidate.username === normalized);
      if (!user || user.accountType === "service") {
        await dummyPasswordCheck(password);
        return null;
      }
      if (!await verifyPassword(password, user.passwordHash) || user.disabled) return null;
      const sessions = await loadSessions();
      const issued = issueSessionRecord(user, pruneSessions(sessions, identity));
      await atomicWrite(sessionsFile, issued.next);
      return { user: publicUser(user), token: issued.token, csrfToken: issued.csrfToken, expiresAt: issued.record.expiresAt };
    });
  }

  async function authenticateSession(token) {
    const parsed = parseOpaqueToken(token, "nvs");
    if (!parsed) return null;
    const { identity, sessions } = await loadState();
    const record = sessions.sessions.find((session) => session.id === parsed.id);
    if (!record || !safeEqual(record.tokenHash, sha256(token)) || Date.parse(record.expiresAt) <= now()) return null;
    const user = identity.users.find((candidate) => candidate.id === record.userId);
    if (!user || user.accountType === "service" || user.disabled || user.securityVersion !== record.securityVersion) return null;
    return principalFor({ kind: "session", user, identity, session: record });
  }

  async function authenticatePat(token) {
    const parsed = parseOpaqueToken(token, "nvp");
    if (!parsed) return null;
    const { identity } = await loadState();
    const pat = identity.pats.find((candidate) => candidate.id === parsed.id);
    if (!pat || pat.revokedAt || (pat.expiresAt && Date.parse(pat.expiresAt) <= now())) return null;
    if (!safeEqual(pat.tokenHash, sha256(token))) return null;
    const user = identity.users.find((candidate) => candidate.id === pat.userId);
    if (!user || user.disabled || user.securityVersion !== pat.securityVersion) return null;
    if (!pat.lastUsedAt || now() - Date.parse(pat.lastUsedAt) >= PAT_TOUCH_INTERVAL_MS) {
      await touchPat(pat.id);
    }
    return principalFor({ kind: "pat", user, identity, pat });
  }

  async function logout(token) {
    const parsed = parseOpaqueToken(token, "nvs");
    if (!parsed) return false;
    return withLock(async () => {
      const sessions = await loadSessions();
      const next = sessions.sessions.filter((session) => session.id !== parsed.id);
      if (next.length === sessions.sessions.length) return false;
      await atomicWrite(sessionsFile, { ...sessions, sessions: next });
      return true;
    });
  }

  async function listUsers() {
    const identity = await loadIdentity();
    return identity.users.map(publicUser);
  }

  async function listRoles() {
    const identity = await loadIdentity();
    return [...Object.values(BUILTIN_ROLES).map(copyRole), ...identity.customRoles.map(copyRole)];
  }

  async function createUser(actor, { username, displayName, password, roleId = "viewer", forcePasswordChange = true } = {}) {
    assertPermission(actor, "users.manage");
    const normalized = normalizeUsername(username);
    validatePassword(password);
    return withLock(async () => {
      const identity = await loadIdentity();
      if (identity.users.some((user) => user.username === normalized)) {
        throw identityError("username-conflict", "用户名已存在");
      }
      const role = roleById(identity, roleId);
      if (!role) throw identityError("role-not-found", "角色不存在");
      if (role.id === "superadmin" && actor.role.id !== "superadmin") {
        throw identityError("forbidden", "只有超级管理员能授予 superadmin");
      }
      const createdAt = timestamp();
      const user = {
        id: randomUUID(),
        username: normalized,
        displayName: normalizeDisplayName(displayName, normalized),
        accountType: "human",
        passwordHash: await hashPassword(password),
        roleId: role.id,
        disabled: false,
        forcePasswordChange: !!forcePasswordChange,
        securityVersion: 1,
        createdAt,
        updatedAt: createdAt,
      };
      await atomicWrite(identityFile, { ...identity, users: [...identity.users, user] });
      return publicUser(user);
    });
  }

  async function updateUser(actor, userId, changes = {}) {
    assertPermission(actor, "users.manage");
    return withLock(async () => {
      const identity = await loadIdentity();
      const index = identity.users.findIndex((user) => user.id === userId);
      if (index < 0) throw identityError("user-not-found", "用户不存在");
      const current = identity.users[index];
      if (current.accountType === "service") {
        throw identityError("forbidden", "服务账号只能由对应的通道配置管理");
      }
      if (current.roleId === "superadmin" && actor.role.id !== "superadmin") {
        throw identityError("forbidden", "管理员不能修改超级管理员");
      }
      const nextRoleId = changes.roleId ?? current.roleId;
      const role = roleById(identity, nextRoleId);
      if (!role) throw identityError("role-not-found", "角色不存在");
      if (role.id === "superadmin" && actor.role.id !== "superadmin") {
        throw identityError("forbidden", "只有超级管理员能授予 superadmin");
      }
      const disabled = changes.disabled === undefined ? current.disabled : !!changes.disabled;
      if (current.roleId === "superadmin" && (disabled || nextRoleId !== "superadmin")) {
        assertAnotherSuperadmin(identity, current.id);
      }
      const updated = {
        ...current,
        displayName: changes.displayName === undefined
          ? current.displayName
          : normalizeDisplayName(changes.displayName, current.username),
        roleId: nextRoleId,
        disabled,
        securityVersion: (disabled !== current.disabled || nextRoleId !== current.roleId)
          ? current.securityVersion + 1
          : current.securityVersion,
        updatedAt: timestamp(),
      };
      const users = [...identity.users];
      users[index] = updated;
      await atomicWrite(identityFile, { ...identity, users });
      if (updated.securityVersion !== current.securityVersion) await revokeSessionsFor(current.id);
      return publicUser(updated);
    });
  }

  async function resetPassword(actor, userId, password) {
    assertPermission(actor, "users.manage");
    validatePassword(password);
    return mutatePassword({
      userId,
      password,
      forcePasswordChange: true,
      guard(identity, user) {
        if (user.accountType === "service") {
          throw identityError("forbidden", "服务账号不能设置登录口令");
        }
        if (user.roleId === "superadmin") {
          throw identityError("forbidden", "超级管理员口令只能本人修改或通过服务器 break-glass 恢复");
        }
      },
    });
  }

  async function changeOwnPassword(actor, currentPassword, nextPassword) {
    if (!actor?.user?.id) throw identityError("unauthorized", "需要登录");
    validatePassword(nextPassword);
    return mutatePassword({
      userId: actor.user.id,
      password: nextPassword,
      forcePasswordChange: false,
      async guard(_identity, user) {
        if (!await verifyPassword(currentPassword, user.passwordHash)) {
          throw identityError("invalid-password", "当前口令错误");
        }
      },
    });
  }

  async function recoverSuperadmin(username, password) {
    const normalized = normalizeUsername(username);
    validatePassword(password);
    return mutatePassword({
      username: normalized,
      password,
      forcePasswordChange: false,
      revokePats: true,
      guard(_identity, user) {
        if (user.roleId !== "superadmin") {
          throw identityError("forbidden", "break-glass 只能恢复已有超级管理员");
        }
      },
    });
  }

  async function mutatePassword({
    userId,
    username,
    password,
    forcePasswordChange,
    revokePats = false,
    guard,
  }) {
    return withLock(async () => {
      const identity = await loadIdentity();
      const index = identity.users.findIndex((user) => userId ? user.id === userId : user.username === username);
      if (index < 0) throw identityError("user-not-found", "用户不存在");
      const current = identity.users[index];
      await guard?.(identity, current);
      const updated = {
        ...current,
        passwordHash: await hashPassword(password),
        forcePasswordChange,
        securityVersion: current.securityVersion + 1,
        updatedAt: timestamp(),
      };
      const users = [...identity.users];
      users[index] = updated;
      const changedAt = timestamp();
      const pats = revokePats
        ? identity.pats.map((pat) => pat.userId === current.id && !pat.revokedAt ? { ...pat, revokedAt: changedAt } : pat)
        : identity.pats;
      await atomicWrite(identityFile, { ...identity, users, pats });
      await revokeSessionsFor(current.id);
      return publicUser(updated);
    });
  }

  async function createRole(actor, { id, name, permissions = [], targetAllow = [], targetDeny = [] } = {}) {
    assertPermission(actor, "roles.manage");
    const roleId = normalizeRoleId(id);
    const role = normalizeCustomRole({ id: roleId, name, permissions, targetAllow, targetDeny });
    return withLock(async () => {
      const identity = await loadIdentity();
      if (roleById(identity, roleId)) throw identityError("role-conflict", "角色 id 已存在");
      await atomicWrite(identityFile, { ...identity, customRoles: [...identity.customRoles, role] });
      return copyRole(role);
    });
  }

  async function updateRole(actor, roleId, changes = {}) {
    assertPermission(actor, "roles.manage");
    if (BUILTIN_ROLES[roleId]) throw identityError("forbidden", "内置角色不可编辑");
    return withLock(async () => {
      const identity = await loadIdentity();
      const index = identity.customRoles.findIndex((role) => role.id === roleId);
      if (index < 0) throw identityError("role-not-found", "角色不存在");
      const role = normalizeCustomRole({ ...identity.customRoles[index], ...changes, id: roleId });
      const customRoles = [...identity.customRoles];
      customRoles[index] = role;
      await atomicWrite(identityFile, { ...identity, customRoles });
      return copyRole(role);
    });
  }

  async function deleteRole(actor, roleId) {
    assertPermission(actor, "roles.manage");
    if (BUILTIN_ROLES[roleId]) throw identityError("forbidden", "内置角色不可删除");
    return withLock(async () => {
      const identity = await loadIdentity();
      if (identity.users.some((user) => user.roleId === roleId)) {
        throw identityError("role-in-use", "角色仍被用户使用");
      }
      const customRoles = identity.customRoles.filter((role) => role.id !== roleId);
      if (customRoles.length === identity.customRoles.length) throw identityError("role-not-found", "角色不存在");
      await atomicWrite(identityFile, { ...identity, customRoles });
      return true;
    });
  }

  async function createPat(actor, {
    name,
    scopes,
    targetAllow = ["*"],
    targetDeny = [],
    expiresAt = null,
    userId,
    kind = "personal",
  } = {}) {
    const targetUserId = userId ?? actor?.user?.id;
    if (!targetUserId) throw identityError("unauthorized", "需要登录");
    if (!["personal", "service"].includes(kind)) throw identityError("invalid-pat-kind", "PAT 类型无效");
    if (targetUserId !== actor?.user?.id) assertPermission(actor, "pats.any.revoke");
    if (kind === "service") assertPermission(actor, "wecom.manage");
    return withLock(async () => {
      const identity = await loadIdentity();
      const user = identity.users.find((candidate) => candidate.id === targetUserId);
      if (!user || user.disabled) throw identityError("user-not-found", "用户不存在或已禁用");
      if ((kind === "service") !== (user.accountType === "service")) {
        throw identityError("invalid-pat-kind", "服务 PAT 只能属于服务账号，个人 PAT 只能属于登录用户");
      }
      const role = roleById(identity, user.roleId);
      const requestedScopes = Array.isArray(scopes) && scopes.length
        ? uniqueStrings(scopes)
        : role.permissions.filter((permission) => PAT_PERMISSIONS.includes(permission));
      if (requestedScopes.some((scope) => !PAT_PERMISSIONS.includes(scope))) {
        throw identityError("invalid-pat-scope", "PAT scope 只能包含机器接口权限");
      }
      if (requestedScopes.some((scope) => !role.permissions.includes(scope))) {
        throw identityError("scope-exceeds-role", "PAT scope 超出用户当前角色");
      }
      if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now())) {
        throw identityError("invalid-expiry", "PAT 过期时间无效");
      }
      const id = randomBytes(8).toString("hex");
      const token = `nvp_${id}_${randomBytes(32).toString("base64url")}`;
      const createdAt = timestamp();
      const pat = {
        id,
        userId: user.id,
        name: normalizeTokenName(name),
        kind,
        tokenHash: sha256(token),
        tokenLastFour: token.slice(-4),
        scopes: requestedScopes,
        targetAllow: normalizePatterns(targetAllow),
        targetDeny: normalizePatterns(targetDeny),
        securityVersion: user.securityVersion,
        createdAt,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        lastUsedAt: null,
        revokedAt: null,
      };
      await atomicWrite(identityFile, { ...identity, pats: [...identity.pats, pat] });
      return { pat: publicPat(pat, user), token };
    });
  }

  async function listPats(actor) {
    if (!actor?.user?.id) throw identityError("unauthorized", "需要登录");
    const identity = await loadIdentity();
    const all = actor.permissions.includes("pats.any.revoke");
    return identity.pats
      .filter((pat) => all || pat.userId === actor.user.id)
      .filter((pat) => pat.kind !== "service" || actor.permissions.includes("wecom.manage"))
      .map((pat) => publicPat(pat, identity.users.find((user) => user.id === pat.userId)));
  }

  async function revokePat(actor, patId) {
    if (!actor?.user?.id) throw identityError("unauthorized", "需要登录");
    return withLock(async () => {
      const identity = await loadIdentity();
      const index = identity.pats.findIndex((pat) => pat.id === patId);
      if (index < 0) throw identityError("pat-not-found", "PAT 不存在");
      const current = identity.pats[index];
      if (current.kind === "service") assertPermission(actor, "wecom.manage");
      if (current.userId !== actor.user.id) assertPermission(actor, "pats.any.revoke");
      const pats = [...identity.pats];
      pats[index] = { ...current, revokedAt: current.revokedAt ?? timestamp() };
      await atomicWrite(identityFile, { ...identity, pats });
      return true;
    });
  }

  async function touchPat(patId) {
    try {
      await withLock(async () => {
        const identity = await loadIdentity();
        const index = identity.pats.findIndex((pat) => pat.id === patId);
        if (index < 0) return;
        const current = identity.pats[index];
        if (current.lastUsedAt && now() - Date.parse(current.lastUsedAt) < PAT_TOUCH_INTERVAL_MS) return;
        const pats = [...identity.pats];
        pats[index] = { ...current, lastUsedAt: timestamp() };
        await atomicWrite(identityFile, { ...identity, pats });
      });
    } catch {
      // lastUsedAt 是非关键遥测，失败不影响请求。
    }
  }

  async function pruneExpiredSessions() {
    return withLock(async () => {
      const identity = await loadIdentity();
      const sessions = await loadSessions();
      const next = pruneSessions(sessions, identity);
      if (next.sessions.length !== sessions.sessions.length) await atomicWrite(sessionsFile, next);
      return sessions.sessions.length - next.sessions.length;
    });
  }

  async function ensureWecomServiceAccount(actor) {
    assertPermission(actor, "wecom.manage");
    if (actor.role.id !== "superadmin") {
      throw identityError("forbidden", "只有超级管理员能配置企微服务账号");
    }
    return withLock(async () => {
      const identity = await loadIdentity();
      const existing = identity.users.find((user) => user.username === "wecom-bot");
      if (existing) {
        if (existing.accountType !== "service") {
          throw identityError("username-conflict", "用户名 wecom-bot 已被登录用户占用");
        }
        if (existing.disabled || existing.roleId !== "operator") {
          const users = identity.users.map((user) => user.id === existing.id
            ? {
                ...user,
                disabled: false,
                roleId: "operator",
                securityVersion: user.securityVersion + 1,
                updatedAt: timestamp(),
              }
            : user);
          await atomicWrite(identityFile, { ...identity, users });
          return publicUser(users.find((user) => user.id === existing.id));
        }
        return publicUser(existing);
      }
      const createdAt = timestamp();
      const user = {
        id: randomUUID(),
        username: "wecom-bot",
        displayName: "企微机器人",
        accountType: "service",
        passwordHash: null,
        roleId: "operator",
        disabled: false,
        forcePasswordChange: false,
        securityVersion: 1,
        createdAt,
        updatedAt: createdAt,
      };
      await atomicWrite(identityFile, { ...identity, users: [...identity.users, user] });
      return publicUser(user);
    });
  }

  function issueSessionRecord(user, sessions) {
    const id = randomBytes(8).toString("hex");
    const token = `nvs_${id}_${randomBytes(32).toString("base64url")}`;
    const csrfToken = randomBytes(32).toString("base64url");
    const createdAt = timestamp();
    const record = {
      id,
      userId: user.id,
      tokenHash: sha256(token),
      csrfToken,
      securityVersion: user.securityVersion,
      createdAt,
      expiresAt: new Date(now() + sessionTtlMs).toISOString(),
    };
    return { token, csrfToken, record, next: { ...sessions, sessions: [...sessions.sessions, record] } };
  }

  function pruneSessions(sessions, identity) {
    const users = new Map(identity.users.map((user) => [user.id, user]));
    return {
      ...sessions,
      sessions: sessions.sessions.filter((session) => {
        const user = users.get(session.userId);
        return user && !user.disabled && user.securityVersion === session.securityVersion && Date.parse(session.expiresAt) > now();
      }),
    };
  }

  async function revokeSessionsFor(userId) {
    const sessions = await loadSessions();
    const next = sessions.sessions.filter((session) => session.userId !== userId);
    await atomicWrite(sessionsFile, { ...sessions, sessions: next });
  }

  function principalFor({ kind, user, identity, session, pat }) {
    const role = roleById(identity, user.roleId);
    if (!role) return null;
    const permissions = kind === "pat"
      ? role.permissions.filter((permission) => pat.scopes.includes(permission))
      : [...role.permissions];
    return {
      kind,
      actor: kind === "pat" ? `pat:${user.username}/${pat.name}` : `user:${user.username}`,
      user: publicUser(user),
      role: copyRole(role),
      permissions,
      targetAllow: kind === "pat" ? intersectScopes(role.targetAllow, pat.targetAllow) : [...role.targetAllow],
      targetDeny: kind === "pat" ? uniqueStrings([...role.targetDeny, ...pat.targetDeny]) : [...role.targetDeny],
      roleTargetAllow: [...role.targetAllow],
      roleTargetDeny: [...role.targetDeny],
      patTargetAllow: pat ? [...pat.targetAllow] : [],
      patTargetDeny: pat ? [...pat.targetDeny] : [],
      csrfToken: session?.csrfToken,
      pat: pat ? publicPat(pat, user) : undefined,
    };
  }

  async function loadState() {
    const [install, identity, sessions] = await Promise.all([
      readJsonStrict(installFile, "install"),
      readJsonStrict(identityFile, "identity"),
      readJsonStrict(sessionsFile, "sessions"),
    ]);
    validateInstall(install);
    validateIdentity(identity);
    validateSessions(sessions);
    return { install, identity, sessions };
  }

  async function loadIdentity() {
    const identity = await readJsonStrict(identityFile, "identity");
    validateIdentity(identity);
    return identity;
  }

  async function loadSessions() {
    const sessions = await readJsonStrict(sessionsFile, "sessions");
    validateSessions(sessions);
    return sessions;
  }

  async function withLock(fn) {
    const started = now();
    while (true) {
      try {
        await mkdir(lockDir, { mode: 0o700 });
        await atomicWrite(join(lockDir, "owner.json"), { pid: process.pid, createdAt: timestamp() });
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const info = await stat(lockDir).catch(() => null);
        if (info && now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
        if (now() - started > lockWaitMs) throw new Error("身份存储锁等待超时");
        await sleep(25);
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  }

  return {
    setupStatus,
    setup,
    login,
    logout,
    authenticateSession,
    authenticatePat,
    listUsers,
    listRoles,
    createUser,
    updateUser,
    resetPassword,
    changeOwnPassword,
    recoverSuperadmin,
    createRole,
    updateRole,
    deleteRole,
    createPat,
    listPats,
    revokePat,
    ensureWecomServiceAccount,
    pruneExpiredSessions,
    hasPermission(principal, permission) {
      return !!principal?.permissions?.includes(permission);
    },
    targetAllowed(principal, member, skillId) {
      if (!principal) return false;
      const resource = `${member}/${skillId}`;
      if (!scopeAllows(principal.roleTargetAllow, principal.roleTargetDeny, resource, member)) return false;
      if (principal.kind !== "pat") return true;
      return scopeAllows(principal.patTargetAllow, principal.patTargetDeny, resource, member);
    },
    files: { installFile, identityFile, sessionsFile },
  };
}

export function assertPermission(principal, permission) {
  if (!principal?.permissions?.includes(permission)) {
    throw identityError("forbidden", `缺少权限：${permission}`);
  }
}

export function identityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function roleById(identity, roleId) {
  return BUILTIN_ROLES[roleId] ?? identity.customRoles.find((role) => role.id === roleId) ?? null;
}

function copyRole(role) {
  return {
    id: role.id,
    name: role.name,
    builtIn: !!role.builtIn,
    permissions: [...role.permissions],
    targetAllow: [...role.targetAllow],
    targetDeny: [...role.targetDeny],
  };
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    accountType: user.accountType ?? "human",
    roleId: user.roleId,
    disabled: user.disabled,
    forcePasswordChange: user.forcePasswordChange,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function publicPat(pat, user) {
  return {
    id: pat.id,
    userId: pat.userId,
    username: user?.username ?? "",
    name: pat.name,
    kind: pat.kind,
    tokenLastFour: pat.tokenLastFour,
    scopes: [...pat.scopes],
    targetAllow: [...pat.targetAllow],
    targetDeny: [...pat.targetDeny],
    createdAt: pat.createdAt,
    expiresAt: pat.expiresAt,
    lastUsedAt: pat.lastUsedAt,
    revokedAt: pat.revokedAt,
  };
}

function normalizeUsername(value, { throwOnInvalid = true } = {}) {
  const username = String(value ?? "").normalize("NFKC").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    if (throwOnInvalid) throw identityError("invalid-username", "用户名须为 3-32 位小写字母、数字、点、下划线或连字符");
    return "";
  }
  return username;
}

function normalizeDisplayName(value, fallback) {
  const displayName = String(value ?? "").normalize("NFKC").trim() || fallback;
  if (displayName.length > 80) throw identityError("invalid-display-name", "显示名不能超过 80 个字符");
  return displayName;
}

function normalizeRoleId(value) {
  const roleId = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(roleId)) {
    throw identityError("invalid-role-id", "角色 id 须为 3-32 位小写字母、数字或连字符");
  }
  return roleId;
}

function normalizeCustomRole({ id, name, permissions, targetAllow, targetDeny }) {
  const normalizedPermissions = uniqueStrings(permissions);
  if (normalizedPermissions.some((permission) => !OPERATIONAL_PERMISSIONS.includes(permission))) {
    throw identityError("reserved-permission", "自定义角色只能组合业务权限");
  }
  return {
    id,
    name: normalizeDisplayName(name, id),
    builtIn: false,
    permissions: normalizedPermissions,
    targetAllow: normalizePatterns(targetAllow),
    targetDeny: normalizePatterns(targetDeny),
  };
}

function normalizePatterns(patterns) {
  return uniqueStrings(patterns).map((pattern) => {
    if (pattern === "*" || /^[a-z0-9][a-z0-9-]*(?:\/(?:\*|[a-z0-9][a-z0-9-]*))?$/.test(pattern)) return pattern;
    throw identityError("invalid-target-pattern", `非法 target 范围：${pattern}`);
  });
}

function normalizeTokenName(value) {
  const name = String(value ?? "").normalize("NFKC").trim();
  if (!name || name.length > 80) throw identityError("invalid-token-name", "PAT 名称须为 1-80 个字符");
  return name;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).map((value) => value.trim()).filter(Boolean))];
}

function intersectScopes(rolePatterns, patPatterns) {
  if (rolePatterns.includes("*")) return [...patPatterns];
  if (patPatterns.includes("*")) return [...rolePatterns];
  return patPatterns.filter((pattern) => rolePatterns.includes(pattern));
}

function patternMatches(pattern, resource, member) {
  return pattern === "*" || pattern === resource || pattern === member || pattern === `${member}/*`;
}

function scopeAllows(allow, deny, resource, member) {
  if (deny.some((pattern) => patternMatches(pattern, resource, member))) return false;
  return allow.some((pattern) => patternMatches(pattern, resource, member));
}

function assertAnotherSuperadmin(identity, excludedUserId) {
  const remaining = identity.users.filter((user) => user.id !== excludedUserId && !user.disabled && user.roleId === "superadmin");
  if (!remaining.length) throw identityError("last-superadmin", "不能禁用或降级最后一个有效超级管理员");
}

function validatePassword(password) {
  const text = String(password ?? "");
  if (text.length < 12 || text.length > 256) {
    throw identityError("invalid-password", "口令长度须为 12-256 个字符");
  }
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(String(password), salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
}

async function verifyPassword(password, encoded) {
  const parts = String(encoded).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltText, hashText] = parts;
  const expected = Buffer.from(hashText, "base64url");
  const actual = await scrypt(String(password ?? ""), Buffer.from(saltText, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function dummyPasswordCheck(password) {
  await scrypt(String(password ?? ""), Buffer.alloc(16, 7), 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseOpaqueToken(token, prefix) {
  const match = String(token ?? "").match(new RegExp(`^${prefix}_([a-f0-9]{16})_([A-Za-z0-9_-]{40,})$`));
  return match ? { id: match[1] } : null;
}

function validateInstall(install) {
  if (!install || install.schemaVersion !== IDENTITY_SCHEMA_VERSION
    || !isUuid(install.instanceId)
    || !isTimestamp(install.createdAt)
    || !isNullableTimestamp(install.initializedAt)) {
    throw new Error("install.json 无效或版本不支持");
  }
}

function validateIdentity(identity) {
  if (!identity || identity.schemaVersion !== IDENTITY_SCHEMA_VERSION || !Array.isArray(identity.users)
    || !Array.isArray(identity.customRoles) || !Array.isArray(identity.pats)
    || !isNullableTimestamp(identity.initializedAt)) {
    throw new Error("identity.json 无效或版本不支持");
  }
  const roleIds = new Set(Object.keys(BUILTIN_ROLES));
  for (const role of identity.customRoles) {
    if (!role || role.builtIn !== false || roleIds.has(role.id)
      || normalizeRoleId(role.id) !== role.id) {
      throw new Error("identity.json 包含重复或无效角色");
    }
    const normalized = normalizeCustomRole(role);
    if (normalized.id !== role.id || normalized.name !== role.name
      || JSON.stringify(normalized.permissions) !== JSON.stringify(role.permissions)
      || JSON.stringify(normalized.targetAllow) !== JSON.stringify(role.targetAllow)
      || JSON.stringify(normalized.targetDeny) !== JSON.stringify(role.targetDeny)) {
      throw new Error("identity.json 包含未规范化角色");
    }
    roleIds.add(role.id);
  }
  const userIds = new Set();
  const usersById = new Map();
  const usernames = new Set();
  for (const user of identity.users) {
    const normalizedUsername = normalizeUsername(user?.username, { throwOnInvalid: false });
    if (!user || !isUuid(user.id) || !normalizedUsername || normalizedUsername !== user.username
      || userIds.has(user.id) || usernames.has(user.username)
      || !roleIds.has(user.roleId)
      || !["human", "service"].includes(user.accountType)
      || normalizeDisplayName(user.displayName, user.username) !== user.displayName
      || typeof user.disabled !== "boolean" || typeof user.forcePasswordChange !== "boolean"
      || !Number.isSafeInteger(user.securityVersion) || user.securityVersion < 1
      || !isTimestamp(user.createdAt) || !isTimestamp(user.updatedAt)) {
      throw new Error("identity.json 包含无效用户");
    }
    if (user.accountType === "human"
      && !/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(String(user.passwordHash))) {
      throw new Error("identity.json 登录用户缺少口令哈希");
    }
    if (user.accountType === "service" && user.passwordHash !== null) {
      throw new Error("identity.json 服务账号不得包含登录口令");
    }
    userIds.add(user.id);
    usersById.set(user.id, user);
    usernames.add(user.username);
  }
  if (!identity.initializedAt && identity.users.length) {
    throw new Error("identity.json 未初始化状态不得包含用户");
  }
  if (identity.initializedAt
    && !identity.users.some((user) => !user.disabled && user.roleId === "superadmin")) {
    throw new Error("identity.json 已初始化但没有有效超级管理员");
  }
  const patIds = new Set();
  for (const pat of identity.pats) {
    if (!pat || !/^[a-f0-9]{16}$/.test(String(pat.id)) || patIds.has(pat.id)
      || !userIds.has(pat.userId) || !["personal", "service"].includes(pat.kind)
      || (pat.kind === "service") !== (usersById.get(pat.userId)?.accountType === "service")
      || !/^[a-f0-9]{64}$/.test(String(pat.tokenHash))
      || typeof pat.tokenLastFour !== "string" || pat.tokenLastFour.length !== 4
      || !Array.isArray(pat.scopes) || pat.scopes.some((scope) => !PAT_PERMISSIONS.includes(scope))
      || uniqueStrings(pat.scopes).length !== pat.scopes.length
      || !Array.isArray(pat.targetAllow) || !Array.isArray(pat.targetDeny)
      || !Number.isSafeInteger(pat.securityVersion) || pat.securityVersion < 1
      || !isTimestamp(pat.createdAt) || !isNullableTimestamp(pat.expiresAt)
      || !isNullableTimestamp(pat.lastUsedAt) || !isNullableTimestamp(pat.revokedAt)) {
      throw new Error("identity.json 包含无效 PAT");
    }
    if (JSON.stringify(normalizePatterns(pat.targetAllow)) !== JSON.stringify(pat.targetAllow)
      || JSON.stringify(normalizePatterns(pat.targetDeny)) !== JSON.stringify(pat.targetDeny)) {
      throw new Error("identity.json 包含未规范化 PAT target 范围");
    }
    patIds.add(pat.id);
  }
}

function validateSessions(sessions) {
  if (!sessions || sessions.schemaVersion !== IDENTITY_SCHEMA_VERSION || !Array.isArray(sessions.sessions)) {
    throw new Error("sessions.json 无效或版本不支持");
  }
  const ids = new Set();
  for (const session of sessions.sessions) {
    if (!session || !/^[a-f0-9]{16}$/.test(String(session.id)) || ids.has(session.id)
      || !isUuid(session.userId) || !/^[a-f0-9]{64}$/.test(String(session.tokenHash))
      || !/^[A-Za-z0-9_-]{40,}$/.test(String(session.csrfToken))
      || !Number.isSafeInteger(session.securityVersion) || session.securityVersion < 1
      || !isTimestamp(session.createdAt) || !isTimestamp(session.expiresAt)) {
      throw new Error("sessions.json 包含无效会话");
    }
    ids.add(session.id);
  }
}

function isUuid(value) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(String(value));
}

function isTimestamp(value) {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isNullableTimestamp(value) {
  return value === null || isTimestamp(value);
}

async function readJsonMaybe(file, label) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`${label} 状态损坏：${error.message}`);
  }
}

async function readJsonStrict(file, label) {
  const value = await readJsonMaybe(file, label);
  if (!value) throw new Error(`${label} 状态缺失，已 fail-closed`);
  return value;
}

async function atomicWrite(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, file);
    await chmod(file, 0o600);
    const directory = await open(dirname(file), fsConstants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
