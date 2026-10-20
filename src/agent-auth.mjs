/**
 * agent token 的纯函数层：生成、哈希、常量时间比较。
 * 存储与生命周期（签发/轮换/吊销/迁移）归 members.mjs，本模块不碰任何存储。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function hashAgentToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function issueAgentToken() {
  const id = randomBytes(8).toString("hex");
  return `nva_${id}_${randomBytes(32).toString("base64url")}`;
}

/** 常量时间比较两个 token 哈希；长度不同直接不等，不泄漏内容。 */
export function tokenHashMatches(supplied, expected) {
  const left = Buffer.from(String(supplied));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
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
