/**
 * 能力包来源清单（PRD-6 H2 / H5）：落盘 <stateDir>/pack-sources.json（0600，原子写）。
 * 全局一份，不按成员区分；hello.ack 下发给所有成员（H4），agent 包管理器据此 git 拉取（PRD-7 A5）。
 *
 * v2（契约 v2.5）：来源身份是 git + branch + subdir，包名不再由人填。
 * - 每条来源带 hub 内部 key（管理台增删改用），下发时去掉；
 * - id 变成可选的「包名覆盖」，缺省时 agent 从包根 toolset.json 自动发现；
 * - 同一 git + branch + subdir 只允许一条；两条来源填了同一覆盖名也拒绝。
 * v1 文件（id 必填）读取时迁移：生成 key、丢弃旧 id（旧 id 是人填的，常填错，不保留）。
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

const SCHEMA_VERSION = 2;
const KEY_PATTERN = /^ps-[0-9a-f]{8,32}$/;
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

function newKey() {
  return `ps-${randomBytes(6).toString("hex")}`;
}

/** 来源身份：git（去掉末尾 / 与 .git、host 不分大小写）+ branch + subdir。 */
export function packSourceIdentity(source) {
  let git = source.git.replace(/\/+$/, "").replace(/\.git$/i, "");
  git = git.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/]+)/i, (_, scheme, host) => `${scheme.toLowerCase()}${host.toLowerCase()}`);
  git = git.replace(/^([^@/:]+@)([^:/]+):/, (_, user, host) => `${user}${host.toLowerCase()}:`);
  return `${git}\n${source.branch}\n${source.subdir ?? ""}`;
}

/** 校验并规范化一条来源（不含 key）；返回只含契约字段的新对象。id 可选。 */
export function normalizePackSource(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("来源必须是对象");
  const id = cleanText(input.id, "包名", { required: false });
  if (id !== undefined && (!PACK_ID_PATTERN.test(id) || id.length > 64)) {
    throw invalid(`包名不合法：${id}（字母开头，只含字母、数字、-）`);
  }
  const git = cleanText(input.git, "git", { required: true });
  const branch = cleanText(input.branch, "branch", { required: false }) ?? "main";
  if (/\s/.test(branch) || branch.startsWith("-")) throw invalid(`branch 不合法：${branch}`);
  let subdir = cleanText(input.subdir, "subdir", { required: false });
  if (subdir !== undefined) {
    subdir = subdir.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (subdir.startsWith("/") || /^[A-Za-z]:/.test(subdir) || subdir.split("/").includes("..")) {
      throw invalid(`subdir 必须是仓库内的相对路径：${input.subdir}`);
    }
    if (!subdir || subdir === ".") subdir = undefined;
  }
  const out = { git, branch };
  if (subdir !== undefined) out.subdir = subdir;
  if (id !== undefined) out.id = id;
  return out;
}

function conflict(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 新条目与其余条目查重：同来源、同覆盖名都算冲突。 */
function assertUnique(sources, candidate, exceptKey) {
  const identity = packSourceIdentity(candidate);
  for (const other of sources) {
    if (other.key === exceptKey) continue;
    if (packSourceIdentity(other) === identity) {
      throw conflict("pack-source-conflict", "同一仓库、分支、子目录的来源已存在");
    }
    if (candidate.id && other.id === candidate.id) {
      throw conflict("pack-name-conflict", `包名 ${candidate.id} 已被另一条来源占用`);
    }
  }
}

function compareSources(a, b) {
  return a.git.localeCompare(b.git) || (a.subdir ?? "").localeCompare(b.subdir ?? "") || a.branch.localeCompare(b.branch);
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
    if (!Array.isArray(parsed?.sources)) throw new Error("pack-sources.json 结构不支持");
    if (parsed.schemaVersion === 1) {
      // v1 → v2：生成 key、丢弃人填的旧 id，同来源只留第一条。迁移结果立即落盘，保证 key 稳定。
      const sources = [];
      for (const raw of parsed.sources) {
        const { id: _dropped, ...rest } = raw ?? {};
        const source = normalizePackSource(rest);
        if (sources.some((s) => packSourceIdentity(s) === packSourceIdentity(source))) continue;
        sources.push({ key: newKey(), ...source });
      }
      const data = { schemaVersion: SCHEMA_VERSION, sources };
      save(data);
      return data;
    }
    if (parsed.schemaVersion !== SCHEMA_VERSION) throw new Error("pack-sources.json 结构不支持");
    return {
      schemaVersion: SCHEMA_VERSION,
      sources: parsed.sources.map((raw) => {
        if (typeof raw?.key !== "string" || !KEY_PATTERN.test(raw.key)) throw new Error("pack-sources.json 条目缺少合法 key");
        return { key: raw.key, ...normalizePackSource(raw) };
      }),
    };
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

  function notFound(key) {
    return conflict("pack-source-not-found", `来源不存在：${key}`);
  }

  return {
    file,
    /** 全部来源（含 key），按 git / subdir / branch 排序。 */
    list() {
      return load().sources.sort(compareSources);
    },
    /** hello.ack 下发用：去掉 hub 内部 key，形状对齐契约 packSources.items。 */
    wire() {
      return this.list().map(({ key: _key, ...source }) => source);
    },
    /** 新增；同来源或同覆盖名冲突时抛 *-conflict。 */
    create(input) {
      const data = load();
      const source = { key: newKey(), ...normalizePackSource(input) };
      assertUnique(data.sources, source, null);
      data.sources.push(source);
      save(data);
      return source;
    },
    /** 按 key 整条替换。 */
    update(key, input) {
      const data = load();
      const index = data.sources.findIndex((s) => s.key === key);
      if (index < 0) throw notFound(key);
      const source = { key, ...normalizePackSource(input) };
      assertUnique(data.sources, source, key);
      data.sources[index] = source;
      save(data);
      return source;
    },
    /** 按 key 删除，返回被删条目或 null。 */
    remove(key) {
      const data = load();
      const victim = data.sources.find((s) => s.key === key) ?? null;
      if (!victim) return null;
      save({ ...data, sources: data.sources.filter((s) => s.key !== key) });
      return victim;
    },
  };
}
