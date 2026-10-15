/**
 * 最小规则引擎（PRD-5 F5 / PRD-3 F3 雏形）：
 * 规则形态：when <event> then run <target>（YAML 定义，定义时判断，运行时只匹配——ADR-0005 同款纪律）。
 * 事件源（首批）：task 终态事件（hub 侧 tunnel 上行钩子）。
 * 动作不旁路：规则触发的新任务走既有 submit → delegate 全链路（PRD-3 F3 硬约束）；
 * 装配层保留来源 actor/授权上下文，无来源的系统事件才记 rule-engine。
 * 防环：规则产生的任务带 ruleTrace（链上出现同规则即拒绝）——A 完成触发 B、B 完成触发 A 的死循环在定义期挡不住，运行期靠 trace 断链。
 * 规则完备化（时间窗口、webhook 源、agent 上线/离线源）留 M3。
 */
import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";

export function createRules({ rulesPath, log = console } = {}) {
  /** rules.yaml：rules: [{ when: {event, target?, state?}, then: {target, member?} }] */
  let rules = [];
  if (rulesPath && existsSync(rulesPath)) {
    const data = parse(readFileSync(rulesPath, "utf8"));
    rules = Array.isArray(data?.rules) ? data.rules : [];
    for (const r of rules) {
      if (!r?.when?.event || !r?.then?.target) {
        throw new Error(`规则不合法（需要 when.event 与 then.target）：${JSON.stringify(r)}`);
      }
    }
    log.info?.(`[rules] 装载 ${rules.length} 条规则`);
  }

  /** 评估：task 终态事件 → 匹配规则 → 返回待触发动作（不直接执行，由 main 装配层走队列）。 */
  function evaluate({ event, target, state, taskId, ruleTrace = [] }) {
    const actions = [];
    for (const rule of rules) {
      const { event: ev, target: t, state: s } = rule.when;
      if (ev !== event) continue;
      if (t && t !== target) continue;
      if (s && s !== state) continue;
      if (ruleTrace.includes(rule.then.target)) {
        log.info?.(`[rules] 环路防护：${rule.then.target} 已在链上（${ruleTrace.join(" → ")}），拒绝触发`);
        continue;
      }
      actions.push({ target: rule.then.target, member: rule.then.member ?? "", viaRule: rule.then.target, ruleTrace: [...ruleTrace, rule.then.target] });
    }
    return actions;
  }

  return { evaluate, get count() { return rules.length; } };
}
