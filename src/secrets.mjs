/**
 * 本机私密配置：字段未落盘时才回退环境变量；显式空值作为撤销墓碑保留。
 * 写入采用临时文件 + rename，权限 0600。
 * 用户 PAT 只在 identity.json 存哈希；企微消费端是唯一需要保留服务 PAT 明文的本地组件。
 *
 * 边界：agent 成员的接入凭据（agentId → token 哈希）不在这里，见 members.mjs。
 * 这里只放"单值 / 列表形态的本机集成配置"；成员是带生命周期的实体，需要自己的 SSOT。
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
};

function isKnownField(field) {
  return STRING_FIELDS.includes(field) || LIST_FIELDS.includes(field);
}

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

  function persist(data) {
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
  }

  return {
    get(field) {
      if (!isKnownField(field)) {
        throw new Error(`未知凭据字段：${field}`);
      }
      const data = loadFile();
      const hasFileValue = Object.hasOwn(data, field);
      const fromFile = hasFileValue ? data[field] : env[ENV_KEYS[field]];
      if (isList(field)) {
        return toList(fromFile);
      }
      return norm(fromFile);
    },
    set(values) {
      const data = loadFile();
      for (const [key, value] of Object.entries(values ?? {})) {
        if (!isKnownField(key)) {
          throw new Error(`未知凭据字段：${key}`);
        }
        data[key] = isList(key) ? toList(value) : norm(value);
      }
      persist(data);
    },
    /** 摘除历史遗留字段（一次性迁移用）：返回被摘除的值。 */
    drop(field) {
      const data = loadFile();
      if (!Object.hasOwn(data, field)) return undefined;
      const removed = data[field];
      delete data[field];
      persist(data);
      return removed;
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
    file,
  };
}
