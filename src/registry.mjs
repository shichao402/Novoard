/**
 * 联邦注册表（契约 §2 §3）：成员 card、路由查表（ADR-0005：路由不判断只查表）。
 * 断线语义：连接关闭 → 成员转 offline（card 与 skills 留在表内，离线触发因此能区分
 * "member-offline 拒绝"与"no-such-skill 404"，PRD-2 US3）；重连 hello 重新注册刷新 card。
 * 聚合 card = 所有成员 card 的 skills 并集 + x-novoard-members（契约 §2）。
 */
import { randomUUID } from "node:crypto";

export function createRegistry({ validate, log = console } = {}) {
  /** agentId → { agentId, card, skills: Map, conn, lastSeen, registeredAt } */
  const members = new Map();
  /** skillId → agentId（聚合路由表；冲突注册拒绝，先到先得） */
  const skillIndex = new Map();

  function rebuildSkillIndex() {
    skillIndex.clear();
    for (const member of members.values()) {
      for (const skillId of member.skills.keys()) {
        if (!skillIndex.has(skillId)) skillIndex.set(skillId, member.agentId);
      }
    }
  }

  return {
    /** agent.hello 注册 / 重连：card 校验 + skill 冲突检查（先到先得）。 */
    register({ agentId, card, conn = null, inFlightTaskIds = [] }) {
      const cardCheck = validate ? validate.agentCard(card) : { ok: true, errors: [] };
      if (!cardCheck.ok) {
        return { ok: false, reason: `invalid-card: ${cardCheck.errors.join("; ")}` };
      }
      for (const skill of card.skills ?? []) {
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
    markOffline(agentId) {
      const member = members.get(agentId);
      if (!member) return;
      member.conn = null;
      member.lastSeen = Date.now();
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

    /** 联邦状态视图（面板 /api/status 用）。 */
    status() {
      return [...members.values()].map((m) => ({
        agentId: m.agentId,
        name: m.card.name,
        description: m.card.description,
        online: !!m.conn,
        skillCount: m.skills.size,
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
        skills: [...m.skills.values()],
      }));
    },

    /** 聚合 Agent Card（契约 §2）：skills 并集 + x-novoard-members。 */
    aggregateCard({ skillAllowed = () => true } = {}) {
      const skills = [];
      const membersField = {};
      for (const member of members.values()) {
        const visibleSkills = [...member.skills.values()]
          .filter((skill) => skillAllowed(member.agentId, skill));
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
