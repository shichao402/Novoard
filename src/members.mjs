/**
 * 成员目录（SSOT）：agentId → 接入凭据，落盘 <stateDir>/members.json（0600，原子写）。
 *
 * 为什么单列一个存储：
 * - registry 是运行期在场状态（card / 连接 / lastSeen），进程重启即空，不能承载"谁是成员"；
 * - secrets 是扁平标量/列表配置，塞不进成员的签发时间与轮换语义，硬塞会把同一实体拆成两处。
 *
 * 旧实现正是这样裂开的：agentId → tokenHash 在 secrets.json，成员在场信息只在 registry 内存里。
 * 面板以 registry 为行、以 secrets 为列做前端 join，于是"已签发但从未上线"的成员既不可见也不可删除。
 *
 * 本模块确立的边界：
 * - 成员身份（含 tokenHash）是持久化 SSOT，跨重启稳定，与在线与否无关；
 * - 在场状态（online / card / skills / lastSeen）是它的派生态，随时可重建，只作覆盖层。
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
import {
  hashAgentToken,
  issueAgentToken,
  normalizeAgentId,
  tokenHashMatches,
} from "./agent-auth.mjs";

const SCHEMA_VERSION = 1;
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function createMemberDirectory({ dir, now = Date.now } = {}) {
  if (!dir) throw new Error("MemberDirectory 需要 dir");
  const file = join(dir, "members.json");

  function timestamp() {
    return new Date(now()).toISOString();
  }

  function load() {
    if (!existsSync(file)) return { schemaVersion: SCHEMA_VERSION, members: {} };
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`members.json 损坏，已 fail-closed：${error.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("members.json 根节点必须是对象");
    }
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`members.json schemaVersion 不支持：${parsed.schemaVersion}`);
    }
    const members = parsed.members;
    if (!members || typeof members !== "object" || Array.isArray(members)) {
      throw new Error("members.json members 必须是对象");
    }
    for (const [agentId, record] of Object.entries(members)) {
      if (!AGENT_ID_PATTERN.test(agentId)
        || record?.agentId !== agentId
        || !HASH_PATTERN.test(String(record?.tokenHash))
        || !(record?.tokenLastFour === null
          || (typeof record.tokenLastFour === "string" && record.tokenLastFour.length === 4))
        || !isTimestamp(record?.createdAt)
        || !isNullableTimestamp(record?.tokenIssuedAt)
        || !isNullableTimestamp(record?.tokenRotatedAt)) {
        throw new Error(`members.json 包含非法成员记录：${agentId}`);
      }
    }
    return { schemaVersion: SCHEMA_VERSION, members };
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
    /** 全部成员（不含 tokenHash），按 agentId 升序。 */
    list() {
      const { members } = load();
      return Object.values(members).map(toPublic).sort((a, b) => a.agentId.localeCompare(b.agentId));
    },

    get(agentId) {
      const { members } = load();
      const record = members[agentId];
      return record ? toPublic(record) : null;
    },

    has(agentId) {
      return Object.hasOwn(load().members, agentId);
    },

    /** 签发或轮换：新增成员返回 rotated=false，替换既有成员返回 rotated=true。明文只在此处返回一次。 */
    issue(agentId) {
      const normalized = normalizeAgentId(agentId);
      const token = issueAgentToken();
      const at = timestamp();
      const data = load();
      const existed = data.members[normalized];
      data.members[normalized] = {
        agentId: normalized,
        tokenHash: hashAgentToken(token),
        tokenLastFour: token.slice(-4),
        createdAt: existed?.createdAt ?? at,
        tokenIssuedAt: existed?.tokenIssuedAt ?? at,
        tokenRotatedAt: existed ? at : null,
      };
      save(data);
      return { member: toPublic(data.members[normalized]), token, rotated: !!existed };
    },

    /** 移除成员：同时删除凭据（此后该 agentId 无法通过隧道鉴权）。 */
    remove(agentId) {
      const data = load();
      if (!Object.hasOwn(data.members, agentId)) return false;
      delete data.members[agentId];
      save(data);
      return true;
    },

    /** Bearer token → agentId；未知 token 返回 null。 */
    authenticate(token) {
      const supplied = hashAgentToken(token);
      for (const record of Object.values(load().members)) {
        if (tokenHashMatches(supplied, record.tokenHash)) return record.agentId;
      }
      return null;
    },

    /**
     * 接管一个已知哈希但无明文（一次性迁移 / 测试注入）。已有成员不覆盖，保证目录优先。
     * 迁移来的记录签发时间未知，tokenIssuedAt 记 null。
     */
    adoptTokenHash,

    /** 批量接管历史 secrets.json 的 agentId → tokenHash 映射，返回实际导入的 agentId。 */
    importLegacyHashes(hashes) {
      const imported = [];
      for (const [agentId, tokenHash] of Object.entries(hashes ?? {})) {
        if (adoptTokenHash(agentId, tokenHash)) imported.push(agentId);
      }
      return imported.sort();
    },

    file,
  };

  function adoptTokenHash(agentId, tokenHash, { tokenLastFour = null } = {}) {
    const normalized = normalizeAgentId(agentId);
    if (!HASH_PATTERN.test(String(tokenHash))) throw new Error(`非法 tokenHash：${agentId}`);
    const data = load();
    if (Object.hasOwn(data.members, normalized)) return false;
    data.members[normalized] = {
      agentId: normalized,
      tokenHash: String(tokenHash),
      tokenLastFour,
      createdAt: timestamp(),
      tokenIssuedAt: null,
      tokenRotatedAt: null,
    };
    save(data);
    return true;
  }
}

/**
 * 成员视图 = 持久身份（SSOT）+ 在场覆盖层（registry）。这是 API 层唯一的成员数据来源。
 *
 * skillAllowed 语义：传 null 表示"看全量"（含只有身份、从未接入的成员）；传函数表示按 target
 * 范围裁剪，此时只返回有可见在场所需信息的成员，避免把无权的 agentId 暴露给受限主体。
 */
export function listMemberViews({
  directory,
  registry,
  includeCredentials = false,
  skillAllowed = null,
}) {
  const records = new Map(directory.list().map((record) => [record.agentId, record]));

  const presence = new Map();
  for (const member of registry?.catalog?.() ?? []) {
    const skills = (member.skills ?? []).filter(
      (skill) => !skillAllowed || skillAllowed(member.agentId, skill.id),
    );
    if (skillAllowed && skills.length === 0) continue;
    presence.set(member.agentId, { ...member, skills });
  }

  const ids = new Set([...presence.keys(), ...(skillAllowed ? [] : records.keys())]);
  const views = [];
  for (const agentId of ids) {
    const record = records.get(agentId) ?? null;
    const live = presence.get(agentId) ?? null;
    const skills = live?.skills ?? [];
    const view = {
      agentId,
      name: live?.name || agentId,
      online: !!live?.online,
      registered: !!live,
      skillCount: skills.length,
      skills: skills.map((skill) => ({ ...skill, name: skill.name || skill.id })),
    };
    if (includeCredentials) {
      view.credentials = record
        ? {
            configured: true,
            lastFour: record.tokenLastFour,
            issuedAt: record.tokenIssuedAt,
            rotatedAt: record.tokenRotatedAt,
            createdAt: record.createdAt,
          }
        : { configured: false, lastFour: null, issuedAt: null, rotatedAt: null, createdAt: null };
    }
    views.push(view);
  }
  views.sort((a, b) => Number(b.online) - Number(a.online) || a.agentId.localeCompare(b.agentId));
  return views;
}

function toPublic(record) {
  return {
    agentId: record.agentId,
    tokenLastFour: record.tokenLastFour,
    createdAt: record.createdAt,
    tokenIssuedAt: record.tokenIssuedAt,
    tokenRotatedAt: record.tokenRotatedAt,
  };
}

function isTimestamp(value) {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isNullableTimestamp(value) {
  return value === null || isTimestamp(value);
}
