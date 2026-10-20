/**
 * 联邦注册表（契约 §2 §3）：在场状态与路由查表（ADR-0005：路由不判断只查表）。
 *
 * 定位：本模块是成员身份的**派生态**，不是 SSOT。谁是成员、持有什么凭据由 members.mjs 持久化；
 * 这里的 members Map 只反映"当前进程内已知 card 与连接"，进程重启即清空，靠 agent 重连重建。
 * 因此面板一律以成员目录为行、本表为覆盖层（见 members.mjs 的 listMemberViews），
 * 不得反过来用本表当成员列表——那样会让"已签发但从未上线"的成员在界面上消失。
 *
 * 断线语义：连接关闭 → 成员转 offline（card 与 skills 留在表内，离线触发因此能区分
 * "member-offline 拒绝"与"no-such-skill 404"，PRD-2 US3）；重连 hello 重新注册刷新 card。
 * 移除语义：成员被吊销时由调用方显式 remove，连同 card 一起摘除。
 * 聚合 card = 所有成员 card 的 skills 并集 + x-novoard-members（契约 §2）。
 */
import { randomUUID } from "node:crypto";

export function createRegistry({ validate, log = console } = {}) {
  /** agentId → { agentId, card, skills: Map, conn, lastSeen, registeredAt } */
  const members = new Map();
  /** skillId → agentId（聚合路由表；冲突注册拒绝，先到先得） */
  const skillIndex = new Map();

  function routable(skill) {
    return skill?.["x-novoard-kind"] !== "agent";
  }

  function rebuildSkillIndex() {
    skillIndex.clear();
    for (const member of members.values()) {
      for (const [skillId, skill] of member.skills) {
        if (!routable(skill)) continue;
        if (!skillIndex.has(skillId)) skillIndex.set(skillId, member.agentId);
      }
    }
  }

  /**
   * 按连接释放身份：只有当前绑定的那条连接关闭才转离线。
   * 被新连接接管的旧连接稍后收到 close 时，`member.conn` 已不是它，返回 false 且不改状态
   * ——否则旧连接的 close 会把仍在线的新连接成员误标离线。
   * 不传 conn 时退化为"无条件转离线"，供 register 后未绑定连接的老调用点（测试桩）使用。
   */
  function releaseConn(agentId, conn) {
    const member = members.get(agentId);
    if (!member || !member.conn) return false;
    if (conn && member.conn !== conn) return false; // 已被新连接接管，旧连接的 close 不再有语义
    member.offlineSince = Date.now();
    member.conn = null;
    member.lastSeen = Date.now();
    return true;
  }

  return {
    /** agent.hello 注册 / 重连：card 校验 + skill 冲突检查（先到先得）。 */
    register({ agentId, card, conn = null, inFlightTaskIds = [] }) {
      const cardCheck = validate ? validate.agentCard(card) : { ok: true, errors: [] };
      if (!cardCheck.ok) {
        return { ok: false, reason: `invalid-card: ${cardCheck.errors.join("; ")}` };
      }
      for (const skill of card.skills ?? []) {
        if (!routable(skill)) continue;
        const owner = skillIndex.get(skill.id);
        if (owner && owner !== agentId) {
          return { ok: false, reason: `skill-conflict: ${skill.id} 已属于 ${owner}` };
        }
      }
      const skills = new Map((card.skills ?? []).map((s) => [s.id, s]));
      const existed = members.get(agentId);
      members.set(agentId, {
        agentId,
        card,
        skills,
        conn,
        lastSeen: Date.now(),
        registeredAt: existed?.registeredAt ?? new Date().toISOString(),
        inFlightTaskIds: [...inFlightTaskIds],
        bootId: existed?.bootId ?? null,
        offlineSince: null,
      });
      rebuildSkillIndex();
      return { ok: true };
    },

    /** card.update：同成员推送新 card（身份来自连接绑定，契约 §3）。 */
    updateCard(agentId, card) {
      const member = members.get(agentId);
      if (!member) return { ok: false, reason: `unknown-agent: ${agentId}` };
      const cardCheck = validate ? validate.agentCard(card) : { ok: false, errors: ["validate 未装配"] };
      if (!cardCheck.ok) {
        return { ok: false, reason: `invalid-card: ${cardCheck.errors.join("; ")}` };
      }
      for (const skill of card.skills ?? []) {
        if (!routable(skill)) continue;
        const owner = skillIndex.get(skill.id);
        if (owner && owner !== agentId) {
          return { ok: false, reason: `skill-conflict: ${skill.id} 已属于 ${owner}` };
        }
      }
      member.card = card;
      member.skills = new Map((card.skills ?? []).map((s) => [s.id, s]));
      rebuildSkillIndex();
      return { ok: true };
    },

    /** 连接关闭：转离线（不摘除——离线拒绝通知依赖 card 仍在表内）。 */
    markOffline(agentId, conn) {
      return releaseConn(agentId, conn);
    },

    /** 上一次 hello 记下的进程号。Hub 重启后为空，不落盘。 */
    bootIdOf(agentId) {
      return members.get(agentId)?.bootId ?? null;
    },

    rememberBoot(agentId, bootId) {
      const member = members.get(agentId);
      if (!member || !bootId) return;
      member.bootId = bootId;
    },

    /** 成员当前这次离线从何时开始。在线时为空。 */
    offlineSince(agentId) {
      const member = members.get(agentId);
      if (!member || member.conn) return null;
      return member.offlineSince ?? null;
    },

    /** 成员被移除（吊销凭据）：连同 card / skills 一并摘除，聚合 card 不再暴露。 */
    remove(agentId) {
      if (!members.has(agentId)) return false;
      members.delete(agentId);
      rebuildSkillIndex();
      return true;
    },

    /** 路由查表：skillId → 在线承载成员；离线/查无均返回 null（调用方用 knows() 细分）。 */
    resolve(skillId) {
      const agentId = skillIndex.get(skillId);
      if (!agentId) return null;
      const member = members.get(agentId);
      if (!member?.conn) return null;
      return member;
    },

    /** 已有任务按创建时绑定的 member 下发；不得因 skill 后续转移而漂移。 */
    connected(agentId) {
      const member = members.get(agentId);
      return member?.conn ? member : null;
    },

    /** skill 归属查询（不要求在线，M2）：offline 策略分流与离线入队定位 owner 用。 */
    ownerOf(skillId) {
      const agentId = skillIndex.get(skillId);
      if (!agentId) return null;
      const member = members.get(agentId);
      if (!member) return null;
      return { agentId, skill: member.skills.get(skillId) ?? null };
    },

    /** skill 是否为已知能力（不要求在线）——离线拒绝与 404 的分流依据。 */
    knows(skillId) {
      return skillIndex.has(skillId);
    },

    /** 成员 Card 名单。调用方自己按角色筛选，Hub 不替它选择 Target。 */
    cards() {
      return [...members.values()].map((member) => ({
        agentId: member.agentId,
        online: !!member.conn,
        card: member.card,
      }));
    },

    /** 联邦状态视图（面板 /api/status 用）。 */
    status() {
      return [...members.values()].map((m) => ({
        agentId: m.agentId,
        name: m.card.name,
        description: m.card.description,
        online: !!m.conn,
        skillCount: [...m.skills.values()].filter(routable).length,
        lastSeen: new Date(m.lastSeen).toISOString(),
        registeredAt: m.registeredAt,
      }));
    },

    /** target 目录（面板 v1 /api/targets 用）：按成员分组，含离线成员（card 留表）。 */
    catalog() {
      return [...members.values()].map((m) => ({
        agentId: m.agentId,
        name: m.card.name,
        online: !!m.conn,
        skills: [...m.skills.values()].filter(routable),
      }));
    },

    /** 聚合 Agent Card（契约 §2）：skills 并集 + x-novoard-members。 */
    aggregateCard({ skillAllowed = () => true } = {}) {
      const skills = [];
      const membersField = {};
      for (const member of members.values()) {
        const visibleSkills = [...member.skills.values()]
          .filter((skill) => routable(skill) && skillAllowed(member.agentId, skill));
        if (!visibleSkills.length) continue;
        skills.push(...visibleSkills);
        membersField[member.agentId] = { name: member.card.name, description: member.card.description };
      }
      return {
        name: "Novoard federation",
        description: "Mac dev builders · 内网周报 agent · 聚合能力面",
        version: "1.0.0",
        capabilities: { streaming: false, pushNotifications: true },
        defaultInputModes: ["text"],
        defaultOutputModes: ["text", "file"],
        skills,
        "x-novoard-members": membersField,
      };
    },
  };
}

export function newMsgId() {
  return `e-${randomUUID().slice(0, 8)}`;
}
