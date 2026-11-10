/**
 * 能力包来源清单（PRD-6 H2）：落盘 <stateDir>/pack-sources.json（0600，原子写）。
 * 全局一份，不按成员区分；hello.ack 原样下发给所有成员（H4），agent 包管理器据此 git 拉取（PRD-7 A5）。
 * 条目形状与契约 frame-agent-hello-ack.json 的 packSources.items 一致，非法即拒。
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
import { basename, dirname, join } from "node:path";

const SCHEMA_VERSION = 1;
export const PACK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;
const MAX_LEN = 512;

function invalid(message) {
  const error = new Error(message);
  error.code = "invalid-pack-source";
  return error;
}

function cleanText(value, field, { required }) {
  if (value === undefined || value === null || value === "") {
    if (required) throw invalid(`${field} 不能为空`);
    return undefined;
  }
  if (typeof value !== "string") throw invalid(`${field} 必须是字符串`);
  const text = value.trim();
  if (!text) {
    if (required) throw invalid(`${field} 不能为空`);
    return undefined;
  }
  if (text.length > MAX_LEN || /[\u0000-\u001f\u007f]/.test(text)) throw invalid(`${field} 含非法字符或过长`);
  return text;
}

/** 校验并规范化一条来源；返回只含契约字段的新对象。 */
export function normalizePackSource(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("来源必须是对象");
  const id = cleanText(input.id, "id", { required: true });
  if (!PACK_ID_PATTERN.test(id) || id.length > 64) throw invalid(`id 不合法：${id}（字母开头，只含字母、数字、-）`);
  const git = cleanText(input.git, "git", { required: true });
  const branch = cleanText(input.branch, "branch", { required: true });
  if (/\s/.test(branch) || branch.startsWith("-")) throw invalid(`branch 不合法：${branch}`);
  let subdir = cleanText(input.subdir, "subdir", { required: false });
  if (subdir !== undefined) {
    subdir = subdir.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (subdir.startsWith("/") || /^[A-Za-z]:/.test(subdir) || subdir.split("/").includes("..")) {
      throw invalid(`subdir 必须是仓库内的相对路径：${input.subdir}`);
    }
    if (!subdir || subdir === ".") subdir = undefined;
  }
  return subdir === undefined ? { id, git, branch } : { id, git, branch, subdir };
}

export function createPackSources({ dir } = {}) {
  if (!dir) throw new Error("PackSources 需要 dir");
  const file = join(dir, "pack-sources.json");

  function load() {
    if (!existsSync(file)) return { schemaVersion: SCHEMA_VERSION, sources: [] };
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`pack-sources.json 损坏，已 fail-closed：${error.message}`);
    }
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.sources)) {
      throw new Error("pack-sources.json 结构不支持");
    }
    return { schemaVersion: SCHEMA_VERSION, sources: parsed.sources.map(normalizePackSource) };
  }

  function save(data) {
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
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temp, { force: true });
    }
  }

  return {
    file,
    /** 全部来源，按 id 升序。 */
    list() {
      return load().sources.sort((a, b) => a.id.localeCompare(b.id));
    },
    /** 新增或按 id 覆盖。返回 { source, created }。 */
    upsert(input) {
      const source = normalizePackSource(input);
      const data = load();
      const index = data.sources.findIndex((s) => s.id === source.id);
      const created = index < 0;
      if (created) data.sources.push(source);
      else data.sources[index] = source;
      save(data);
      return { source, created };
    },
    /** 按 id 删除，返回是否存在过。 */
    remove(id) {
      const data = load();
      const next = data.sources.filter((s) => s.id !== id);
      if (next.length === data.sources.length) return false;
      save({ ...data, sources: next });
      return true;
    },
  };
}
