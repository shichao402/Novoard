/**
 * 试点 target 定义集合校验（PRD-5 落地顺序第 1 步）。
 * 纪律二（CI 门禁）：agents/ 下三份 targets.yaml + 两类模板走 docs/architecture/schemas/target.json，
 * 与 hub 运行期同一 SSOT。模板结构 = steps + vars 默认值（契约 §1.3），无 title/expose 等 target 级字段，
 * 故模板校验走"steps 数组逐元素套 step schema + vars 类型断言"，不整体套 target schema。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { createFrameValidator } from "../src/frames.mjs";

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");
const validator = createFrameValidator();

const AGENTS = ["mac-work", "mac-home", "intranet-weekly"];

/** 校验 stepTemplate 文件：steps 逐元素套 schema 的 step 定义（oneOf 四类）+ vars 值类型。 */
function validateTemplate(agentId, tplId, tpl) {
  assert.ok(Array.isArray(tpl.steps) && tpl.steps.length >= 1, `${agentId}/${tplId} steps 必须是非空数组`);
  // 复用 target schema 校验每个 step：把单 step 塞进最小合法 target 里走完整 oneOf
  const probe = {
    targets: {
      probe: { title: "probe", steps: tpl.steps, expose: "a2a", audit: "summary", requiresApproval: false, notify: "always" },
    },
  };
  const res = validator.targets(probe);
  assert.ok(res.ok, `${agentId}/${tplId} steps 非法: ${res.errors.join("; ")}`);
  if (tpl.vars) {
    for (const [k, v] of Object.entries(tpl.vars)) {
      assert.ok(["string", "number", "boolean"].includes(typeof v), `${agentId}/${tplId} vars.${k} 类型非法（${typeof v}）`);
    }
  }
}

test("试点三 agent 的 targets.yaml 全部通过 schema 校验", () => {
  for (const agentId of AGENTS) {
    const raw = readFileSync(join(AGENTS_DIR, agentId, "targets.yaml"), "utf8");
    const res = validator.targets(parse(raw));
    assert.ok(res.ok, `${agentId}/targets.yaml: ${res.errors.join("; ")}`);
  }
});

test("模板文件结构合法（steps 套 step schema + vars 类型）且 target 引用完整", () => {
  for (const agentId of AGENTS) {
    const data = parse(readFileSync(join(AGENTS_DIR, agentId, "targets.yaml"), "utf8"));
    for (const [id, t] of Object.entries(data.targets)) {
      if (!t.template) continue; // 内联 steps 型 target（如 approval-demo）不走模板链路
      const tplPath = join(AGENTS_DIR, agentId, "templates", `${t.template}.yaml`);
      const tpl = parse(readFileSync(tplPath, "utf8"));
      validateTemplate(agentId, t.template, tpl);
      // 模板未设默认值的插值变量必须被 target vars 覆盖（机器差异由 target 填）
      const templateVars = Object.keys(tpl.vars ?? {});
      const usedInSteps = collectInterpolationVars(tpl.steps);
      const requiredFromTarget = [...usedInSteps].filter((v) => !templateVars.includes(v));
      const missing = requiredFromTarget.filter((k) => !(k in (t.vars ?? {})));
      assert.deepEqual(missing, [], `${agentId}/${id} target vars 缺模板 required 项: ${missing}`);
    }
  }
});

test("两台 Mac 共用同一份 deploy-webapp 模板（PRD-5 F2 模板机制验收场景）", () => {
  const w = readFileSync(join(AGENTS_DIR, "mac-work", "templates", "deploy-webapp.yaml"), "utf8");
  const h = readFileSync(join(AGENTS_DIR, "mac-home", "templates", "deploy-webapp.yaml"), "utf8");
  assert.equal(w, h, "两台 Mac 的 deploy-webapp 模板内容必须逐字节一致");
  const wk = parse(readFileSync(join(AGENTS_DIR, "mac-work", "targets.yaml"), "utf8"));
  const hm = parse(readFileSync(join(AGENTS_DIR, "mac-home", "targets.yaml"), "utf8"));
  assert.ok(wk.targets["dev-build-investm"] && hm.targets["dev-build-investm"], "两台 Mac 都必须有 dev-build-investm target");
});

test("模板 {{var}} 插值无来源即失败（契约 §1.2：不静默替换为空串）", () => {
  for (const agentId of AGENTS) {
    const data = parse(readFileSync(join(AGENTS_DIR, agentId, "targets.yaml"), "utf8"));
    for (const [id, t] of Object.entries(data.targets)) {
      if (!t.template) continue; // 内联 steps 型：插值来源检查针对其自身 steps
      const tpl = parse(readFileSync(join(AGENTS_DIR, agentId, "templates", `${t.template}.yaml`), "utf8"));
      const available = new Set([...Object.keys(tpl.vars ?? {}), ...Object.keys(t.vars ?? {})]);
      for (const point of collectInterpolationPoints(tpl.steps)) {
        for (const m of point.value.matchAll(/\{\{(\w+)\}\}/g)) {
          assert.ok(available.has(m[1]), `${agentId}/${id} step ${point.where} 插值 {{${m[1]}}} 无来源（模板默认值/target vars 均无）`);
        }
      }
    }
  }
});

test("expose/audit/notify/requiresApproval 字段语义抽查（契约 §1.1 字面值）", () => {
  for (const agentId of AGENTS) {
    const data = parse(readFileSync(join(AGENTS_DIR, agentId, "targets.yaml"), "utf8"));
    for (const [id, t] of Object.entries(data.targets)) {
      assert.ok(["a2a", "local"].includes(t.expose), `${agentId}/${id} expose 非法`);
      assert.ok(["none", "summary", "full"].includes(t.audit), `${agentId}/${id} audit 非法`);
      assert.ok(["always", "on-failure", "never"].includes(t.notify), `${agentId}/${id} notify 非法`);
      assert.equal(typeof t.requiresApproval, "boolean", `${agentId}/${id} requiresApproval 必须是 bool`);
    }
  }
});

/** 收集 steps 里全部插值变量名。 */
function collectInterpolationVars(steps) {
  return new Set(collectInterpolationPoints(steps).flatMap((p) => [...p.value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])));
}

/** 收集 steps 里全部插值点（含 env 值）。 */
function collectInterpolationPoints(steps) {
  const points = [];
  for (const step of steps) {
    for (const [k, v] of Object.entries(step)) {
      if (typeof v === "string") points.push({ where: k, value: v });
      else if (k === "env" && v && typeof v === "object") for (const [ek, ev] of Object.entries(v)) points.push({ where: `env.${ek}`, value: ev });
    }
  }
  return points;
}
