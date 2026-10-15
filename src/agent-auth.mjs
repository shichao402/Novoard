import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function hashAgentToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function issueAgentToken() {
  const id = randomBytes(8).toString("hex");
  return `nva_${id}_${randomBytes(32).toString("base64url")}`;
}

export function authenticateAgentToken(secrets, token) {
  const supplied = hashAgentToken(token);
  const entries = Object.entries(secrets.get("agentTokenHashes"));
  for (const [agentId, expected] of entries) {
    if (safeEqual(supplied, expected)) return agentId;
  }
  return null;
}

export function setAgentTokenHash(secrets, agentId, token) {
  const normalized = normalizeAgentId(agentId);
  const current = secrets.get("agentTokenHashes");
  secrets.set({ agentTokenHashes: { ...current, [normalized]: hashAgentToken(token) } });
  return normalized;
}

export function revokeAgentToken(secrets, agentId) {
  const normalized = normalizeAgentId(agentId);
  const current = secrets.get("agentTokenHashes");
  if (!Object.hasOwn(current, normalized)) return false;
  const next = { ...current };
  delete next[normalized];
  secrets.set({ agentTokenHashes: next });
  return true;
}

export function normalizeAgentId(value) {
  const agentId = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(agentId)) {
    const error = new Error("agentId 须为 2-64 位小写字母、数字或连字符");
    error.code = "invalid-agent-id";
    throw error;
  }
  return agentId;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}
