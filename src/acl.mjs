/**
 * 授权矩阵（PRD-4 F4）：哪个 A2A 客户端能打哪个成员/哪类 skill。
 * 定义时维护（白名单数据文件 acl.yaml，非 secret），运行时查表（ADR-0005 纪律延伸）。
 * 语义：
 *   - 未配置 acl（文件不存在/空）：默认放行（单用户试点系统，向后兼容）。
 *   - client 条目：clientKey 前缀（authorizeClient 返回 client:xxxxxx 的前 6 位）。
 *     allow: [ "member/skill", "member", "member/tag:*" ]——精确 > 成员整域 > 通配。
 *     deny 优先于 allow。
 *   - "dashboard" actor（人）不受限。
 * actor 标识链：Bearer key 前 6 位（key 不走 payload，契约 §8 身份在 HTTP 层）。
 */
import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export function createAcl({ aclPath = "", log = console } = {}) {
  let rules = null; // null = 未配置（默认放行）

  function load() {
    if (!aclPath || !existsSync(aclPath)) {
      rules = null;
      return;
    }
    try {
      const raw = readFileSync(aclPath, "utf8");
      const doc = parseYaml(raw) ?? {};
      const entries = Array.isArray(doc.clients) ? doc.clients : [];
      rules = new Map();
      for (const e of entries) {
        if (!e?.client) continue;
        // 键规范化：acl.yaml 可写裸前缀（with-k）或完整 actor（client:with-k），统一以完整 actor 为键
        const key = String(e.client).startsWith("client:") ? String(e.client) : `client:${e.client}`;
        rules.set(key, { allow: (e.allow ?? []).map(String), deny: (e.deny ?? []).map(String) });
      }
      log.info?.(`[acl] 授权矩阵已装载：${rules.size} 个客户端条目`);
    } catch (error) {
      log.error?.(`[acl] 装载失败（视为未配置，默认放行）：${error.message}`);
      rules = null;
    }
  }

  load();

  /**
   * 授权判定：actor 对 skillId（member 域）的调用是否放行。
   * @returns { allowed: boolean, reason?: string }
   */
  function check({ actor, skillId, member }) {
    if (rules === null || rules.size === 0) return { allowed: true }; // 未配置默认放行
    if (actor === "dashboard" || actor === "human") return { allowed: true };
    const entry = rules.get(actor);
    if (!entry) return { allowed: false, reason: `client ${actor} 未在授权矩阵注册` };
    const patterns = [`${member}/${skillId}`, `${member}`, `${member}/*`];
    const denied = entry.deny.some((p) => match(p, patterns));
    if (denied) return { allowed: false, reason: `deny: ${member}/${skillId}` };
    const allowed = entry.allow.some((p) => match(p, patterns));
    if (!allowed) return { allowed: false, reason: `allow 列表不含 ${member}/${skillId}` };
    return { allowed: true };
  }

  function match(pattern, patterns) {
    return patterns.includes(pattern);
  }

  return { check, get size() { return rules?.size ?? 0; }, reload: load };
}
