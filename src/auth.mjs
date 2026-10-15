import { timingSafeEqual } from "node:crypto";

const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_LIMIT_PER_ACCOUNT = 8;
const LOGIN_LIMIT_PER_SOURCE = 30;
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_LIMIT = 120;

export function createAuth({
  identity,
  publicOrigin = process.env.NOVOARD_PUBLIC_ORIGIN ?? "https://novoard.firoyang.com",
  secureCookies = process.env.NOVOARD_SECURE_COOKIES !== "0",
  trustProxy = process.env.NOVOARD_TRUST_PROXY === "1",
  now = Date.now,
} = {}) {
  if (!identity) throw new Error("Auth 需要 identity");
  const cookieName = secureCookies ? "__Host-novoard_session" : "novoard_session";
  const accountAttempts = new Map();
  const sourceAttempts = new Map();
  let globalAttempts = [];
  let nextAttemptCleanupAt = 0;

  async function authenticate(req, { session = true, pat = true } = {}) {
    if (session) {
      const token = cookieOf(req.headers.cookie, cookieName);
      if (token) {
        const principal = await identity.authenticateSession(token);
        if (principal) return { principal, token, credential: "session" };
      }
    }
    if (pat) {
      const token = bearerOf(req.headers.authorization);
      if (token) {
        const principal = await identity.authenticatePat(token);
        if (principal) return { principal, token, credential: "pat" };
      }
    }
    return null;
  }

  function requireCsrf(req, authn) {
    if (!authn || authn.credential !== "session") return true;
    if (!requireOrigin(req)) return false;
    const supplied = String(req.headers["x-csrf-token"] ?? "");
    return safeEqual(supplied, authn.principal.csrfToken ?? "");
  }

  function requireOrigin(req) {
    return safeEqual(String(req.headers.origin ?? ""), publicOrigin);
  }

  function setSessionCookie(res, token, expiresAt) {
    const parts = [
      `${cookieName}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Expires=${new Date(expiresAt).toUTCString()}`,
    ];
    if (secureCookies) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  }

  function clearSessionCookie(res) {
    const parts = [
      `${cookieName}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=0",
    ];
    if (secureCookies) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  }

  function allowCredentialAttempt(req, username = "") {
    const current = now();
    globalAttempts = globalAttempts.filter((time) => current - time < GLOBAL_WINDOW_MS);
    if (current >= nextAttemptCleanupAt) {
      pruneAttempts(accountAttempts, current);
      pruneAttempts(sourceAttempts, current);
      nextAttemptCleanupAt = current + GLOBAL_WINDOW_MS;
    }
    if (globalAttempts.length >= GLOBAL_LIMIT) return false;
    globalAttempts.push(current);

    const accountKey = normalizedUsername(username);
    const sourceKey = sourceIp(req, trustProxy);
    const recentAccount = activeAttempts(accountAttempts, accountKey, current);
    const recentSource = activeAttempts(sourceAttempts, sourceKey, current);
    if (recentAccount.length >= LOGIN_LIMIT_PER_ACCOUNT
      || recentSource.length >= LOGIN_LIMIT_PER_SOURCE) return false;
    accountAttempts.set(accountKey, [...recentAccount, current]);
    sourceAttempts.set(sourceKey, [...recentSource, current]);
    return true;
  }

  function resetCredentialAttempts(_req, username = "") {
    accountAttempts.delete(normalizedUsername(username));
  }

  return {
    authenticate,
    requireCsrf,
    requireOrigin,
    setSessionCookie,
    clearSessionCookie,
    allowCredentialAttempt,
    resetCredentialAttempts,
    cookieName,
    publicOrigin,
  };
}

export function bearerOf(header) {
  if (typeof header !== "string") return "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

export function cookieOf(header, name) {
  if (typeof header !== "string") return "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function sourceIp(req, trustProxy) {
  const remote = String(req.socket?.remoteAddress ?? "");
  const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if ((loopback || trustProxy) && typeof req.headers["x-real-ip"] === "string") return req.headers["x-real-ip"].trim().slice(0, 128);
  return (remote || "unknown").slice(0, 128);
}

function normalizedUsername(username) {
  return String(username).normalize("NFKC").trim().toLowerCase().slice(0, 64);
}

function activeAttempts(attempts, key, current) {
  return (attempts.get(key) ?? []).filter((time) => current - time < LOGIN_WINDOW_MS);
}

function pruneAttempts(attempts, current) {
  for (const [key, times] of attempts) {
    const active = times.filter((time) => current - time < LOGIN_WINDOW_MS);
    if (active.length) attempts.set(key, active);
    else attempts.delete(key);
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}
