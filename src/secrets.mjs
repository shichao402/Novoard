/**
 * 本机私密配置：字段未落盘时才回退环境变量；显式空值作为撤销墓碑保留。
 * 写入采用临时文件 + rename，权限 0600。
 * 用户 PAT 只在 identity.json 存哈希；企微消费端是唯一需要保留服务 PAT 明文的本地组件。
 */
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname, basename } from "node:path";

const STRING_FIELDS = [
  "wecomWebhook",
  "wecomBotId",
  "wecomBotSecret",
  "wecomNotifyChatId",
  "wecomServicePat",
  "wecomServicePatId",
  "barkUrl",
  "barkDeviceKey",
];
const LIST_FIELDS = ["wecomAllowedUserIds", "wecomAllowedChatIds"];
const MAP_FIELDS = ["agentTokenHashes"];
const ENV_KEYS = {
  wecomWebhook: "NOVOARD_WECOM_WEBHOOK",
  wecomBotId: "NOVOARD_WECOM_BOT_ID",
  wecomBotSecret: "NOVOARD_WECOM_BOT_SECRET",
  wecomNotifyChatId: "NOVOARD_WECOM_NOTIFY_CHAT_ID",
  wecomServicePat: "NOVOARD_WECOM_SERVICE_PAT",
  wecomServicePatId: "NOVOARD_WECOM_SERVICE_PAT_ID",
  wecomAllowedUserIds: "NOVOARD_WECOM_ALLOWED_USER_IDS",
  wecomAllowedChatIds: "NOVOARD_WECOM_ALLOWED_CHAT_IDS",
  barkUrl: "NOVOARD_BARK_URL",
  barkDeviceKey: "NOVOARD_BARK_DEVICE_KEY",
  agentTokenHashes: "NOVOARD_AGENT_TOKEN_HASHES",
};

export function createSecrets({ dir, env = process.env } = {}) {
  if (!dir) throw new Error("SecretsManager 需要 dir");
  const file = join(dir, "secrets.json");

  function loadFile() {
    if (!existsSync(file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("根节点必须是对象");
      }
      return parsed;
    } catch (error) {
      throw new Error(`secrets.json 损坏，已 fail-closed：${error.message}`);
    }
  }

  function norm(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function toList(value) {
    if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
    if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
    if (value && typeof value === "object") return Object.values(value).map(String).map((s) => s.trim()).filter(Boolean);
    return [];
  }

  function isList(field) {
    return LIST_FIELDS.includes(field);
  }

  function isMap(field) {
    return MAP_FIELDS.includes(field);
  }

  function toAgentTokenHashes(value) {
    let parsed = value;
    if (typeof value === "string" && value.trim()) {
      try {
        parsed = JSON.parse(value);
      } catch (error) {
        throw new Error(`agentTokenHashes 必须是 JSON 对象：${error.message}`);
      }
    }
    if (parsed === undefined || parsed === null || parsed === "") return {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("agentTokenHashes 必须是对象");
    const out = {};
    for (const [agentId, hash] of Object.entries(parsed)) {
      if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(agentId) || !/^[a-f0-9]{64}$/.test(String(hash))) {
        throw new Error(`agentTokenHashes 包含非法条目：${agentId}`);
      }
      out[agentId] = String(hash);
    }
    return out;
  }

  return {
    get(field) {
      if (!STRING_FIELDS.includes(field) && !LIST_FIELDS.includes(field) && !MAP_FIELDS.includes(field)) {
        throw new Error(`未知凭据字段：${field}`);
      }
      const data = loadFile();
      const hasFileValue = Object.hasOwn(data, field);
      const fromFile = hasFileValue ? data[field] : env[ENV_KEYS[field]];
      if (isMap(field)) {
        return toAgentTokenHashes(fromFile);
      }
      if (isList(field)) {
        return toList(fromFile);
      }
      return norm(fromFile);
    },
    set(values) {
      const data = loadFile();
      for (const [key, value] of Object.entries(values ?? {})) {
        if (!STRING_FIELDS.includes(key) && !LIST_FIELDS.includes(key) && !MAP_FIELDS.includes(key)) {
          throw new Error(`未知凭据字段：${key}`);
        }
        if (isMap(key)) {
          data[key] = toAgentTokenHashes(value);
        } else if (isList(key)) {
          data[key] = toList(value);
        } else {
          data[key] = norm(value);
        }
      }
      mkdirSync(dirname(file), { recursive: true });
      const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
      let descriptor;
      try {
        descriptor = openSync(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
        writeFileSync(descriptor, `${JSON.stringify(data, null, 2)}\n`);
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temp, file);
        chmodSync(file, 0o600);
        const directory = openSync(dirname(file), fsConstants.O_RDONLY);
        try {
          fsyncSync(directory);
        } catch (error) {
          if (error?.code !== "EPERM" && error?.code !== "EINVAL") throw error;
        } finally {
          closeSync(directory);
        }
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        rmSync(temp, { force: true });
      }
    },
    has(field) {
      const value = this.get(field);
      return Array.isArray(value) ? value.length > 0 : typeof value === "object" ? Object.keys(value).length > 0 : !!value;
    },
    /** 脱敏视图（dashboard /api/status 用）。 */
    view() {
      const out = {};
      for (const field of [...STRING_FIELDS, ...LIST_FIELDS, ...MAP_FIELDS]) {
        const value = this.get(field);
        out[field] = Array.isArray(value)
          ? { configured: value.length > 0, count: value.length }
          : typeof value === "object"
            ? { configured: Object.keys(value).length > 0, count: Object.keys(value).length }
            : { configured: !!value };
      }
      return out;
    },
  };
}
