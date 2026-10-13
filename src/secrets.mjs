/**
 * 运行时凭据（issue-handler 模式）：secrets 文件（.state/secrets.json）优先，环境变量回退。
 * dashboard 写入后即时生效（每次读取都走最新值）；文件权限 0600；令牌不进 git、不进镜像。
 * 字段分两池（契约 §8）：agentTokens 给 agent 隧道；clientKeys 给 A2A 客户端（试点：With 一把）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";

const STRING_FIELDS = ["dashboardToken", "wecomWebhook"];
const LIST_FIELDS = ["clientKeys", "agentTokens"];
const ENV_KEYS = {
  dashboardToken: "NOVOARD_DASHBOARD_TOKEN",
  wecomWebhook: "NOVOARD_WECOM_WEBHOOK",
  clientKeys: "NOVOARD_CLIENT_KEYS",
  agentTokens: "NOVOARD_AGENT_TOKENS",
};

export function createSecrets({ dir, env = process.env } = {}) {
  if (!dir) throw new Error("SecretsManager 需要 dir");
  const file = join(dir, "secrets.json");

  function loadFile() {
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, "utf8")) ?? {};
    } catch {
      return {};
    }
  }

  function norm(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function toList(value) {
    if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
    if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
    return [];
  }

  function isList(field) {
    return LIST_FIELDS.includes(field);
  }

  return {
    get(field) {
      if (!STRING_FIELDS.includes(field) && !LIST_FIELDS.includes(field)) {
        throw new Error(`未知凭据字段：${field}`);
      }
      const fromFile = loadFile()[field];
      if (isList(field)) {
        const list = toList(fromFile);
        if (list.length) return list;
        return toList(env[ENV_KEYS[field]]);
      }
      const str = norm(fromFile);
      if (str) return str;
      return norm(env[ENV_KEYS[field]]);
    },
    set(values) {
      const data = loadFile();
      for (const [key, value] of Object.entries(values ?? {})) {
        if (!STRING_FIELDS.includes(key) && !LIST_FIELDS.includes(key)) {
          throw new Error(`未知凭据字段：${key}`);
        }
        if (isList(key)) {
          const list = toList(value);
          if (list.length) data[key] = list;
          else delete data[key];
        } else {
          const str = norm(value);
          if (str) data[key] = str;
          else delete data[key];
        }
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(data, null, 2));
      try {
        chmodSync(file, 0o600);
      } catch {
        // 部分文件系统不支持 chmod，忽略
      }
    },
    has(field) {
      const value = this.get(field);
      return Array.isArray(value) ? value.length > 0 : !!value;
    },
    /** 脱敏视图（dashboard /api/status 用）。 */
    view() {
      const out = {};
      for (const field of [...STRING_FIELDS, ...LIST_FIELDS]) {
        const value = this.get(field);
        out[field] = Array.isArray(value)
          ? { configured: value.length > 0, count: value.length }
          : { configured: !!value };
      }
      return out;
    },
  };
}
