/**
 * 通知扇出与规则引擎最小版测试（PRD-5 F1/F5）：
 * notify：webhook 未配置降级日志、已配置推送企微 markdown、频控窗口合并。
 * rules：YAML 装载校验、终态事件匹配、动作不旁路（走队列 submit、actor=rule-engine）、ruleTrace 防环。
 * 规则端到端：dev-build completed → smoke-test 自动入队（fake agent 承接）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotify } from "../src/notify.mjs";
import { createRules } from "../src/rules.mjs";
import { createSecrets } from "../src/secrets.mjs";
import { createHub } from "../src/main.mjs";
import { createLiteAgent } from "../src/lite-agent/main.mjs";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "novoard-notify-test-"));
}

test("notify：未配置 webhook 降级日志不报错", async () => {
  const dir = tmpDir();
  const secrets = createSecrets({ dir, env: {} });
  const logs = [];
  const notify = createNotify({ secrets, log: { info: (m) => logs.push(m), error: (m) => logs.push(m) } });
  await notify.emit({ event: { kind: "terminal", target: "dev-build-investm", state: "completed", taskId: "task-x" } });
  assert.ok(logs.some((m) => m.includes("[notify:stub]")));
  rmSync(dir, { recursive: true, force: true });
});

test("notify：已配置 webhook 推送企微 markdown，频控窗口合并第二次", async () => {
  const dir = tmpDir();
  const secrets = createSecrets({ dir, env: {} });
  secrets.set({ wecomWebhook: "https://example.com/hook" });
  const calls = [];
  const notify = createNotify({
    secrets,
    log: { info: () => {}, error: () => {} },
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });
  await notify.emit({ event: { kind: "terminal", target: "t1", state: "completed", taskId: "task-1" } });
  await notify.emit({ event: { kind: "terminal", target: "t1", state: "completed", taskId: "task-2" } }); // 频控合并
  await notify.emit({ event: { kind: "terminal", target: "t1", state: "failed", taskId: "task-3" } }); // 不同状态不合并
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.msgtype, "markdown");
  assert.match(calls[0].body.markdown.content, /任务终态/);
  assert.match(calls[1].body.markdown.content, /failed/);
  rmSync(dir, { recursive: true, force: true });
});

test("rules：装载校验、终态匹配、防环", () => {
  const dir = tmpDir();
  const rulesPath = join(dir, "rules.yaml");
  writeFileSync(rulesPath, `rules:
  - when: { event: task-terminal, target: dev-build-investm, state: completed }
    then: { target: smoke-test }
  - when: { event: task-terminal, target: smoke-test, state: completed }
    then: { target: dev-build-investm }
`);
  const rules = createRules({ rulesPath, log: { info: () => {}, error: () => {} } });
  assert.equal(rules.count, 2);
  const actions = rules.evaluate({ event: "task-terminal", target: "dev-build-investm", state: "completed", taskId: "task-1", ruleTrace: [] });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].target, "smoke-test");
  assert.deepEqual(actions[0].ruleTrace, ["smoke-test"]);
  // 防环：smoke-test 完成时链上已有 dev-build-investm 的场景（A→B→A 断链）
  const loop = rules.evaluate({ event: "task-terminal", target: "smoke-test", state: "completed", taskId: "task-2", ruleTrace: ["dev-build-investm", "smoke-test"] });
  assert.equal(loop.length, 0);
  // 状态不匹配不触发
  const none = rules.evaluate({ event: "task-terminal", target: "dev-build-investm", state: "failed", taskId: "task-3" });
  assert.equal(none.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("rules：非法规则装载即报错（定义时判断）", () => {
  const dir = tmpDir();
  const rulesPath = join(dir, "rules.yaml");
  writeFileSync(rulesPath, `rules:
  - when: { state: completed }
    then: { target: x }
`);
  assert.throws(() => createRules({ rulesPath, log: { info: () => {}, error: () => {} } }), /when\.event/);
  rmSync(dir, { recursive: true, force: true });
});

test("规则端到端：dev-build completed → smoke-test 自动入队并下发（动作不旁路）", async () => {
  const hubDir = tmpDir();
  const rulesPath = join(hubDir, "rules.yaml");
  writeFileSync(rulesPath, `rules:
  - when: { event: task-terminal, target: dev-build-investm, state: completed }
    then: { target: smoke-test }
`);
  const stubDir = tmpDir();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(stubDir, "templates"), { recursive: true });
  writeFileSync(join(stubDir, "targets.yaml"), `targets:
  dev-build-investm:
    title: 构建
    steps: [{ script: "echo build" }]
    expose: a2a
    audit: summary
    requiresApproval: false
    notify: never
  smoke-test:
    title: 冒烟
    steps: [{ script: "echo smoke" }]
    expose: a2a
    audit: summary
    requiresApproval: false
    notify: never
`);
  const agentState = tmpDir();
  const hub = await createHub({ stateDir: hubDir, port: 0, rulesPath, log: { info: () => {}, error: () => {}, warn: () => {} } });
  hub.secrets.set({ agentTokens: ["agt_rule_e2e_123456"], dashboardToken: "dash-pass-123456" });
  const port = hub.server.address().port;
  let agent = null;
  try {
    const configPath = join(agentState, "agent.json");
    writeFileSync(configPath, JSON.stringify({ agentId: "mac-work", hubUrl: `ws://127.0.0.1:${port}/tunnel`, agentToken: "agt_rule_e2e_123456", contractVersion: "1.0" }));
    agent = await createLiteAgent({ configPath, agentDir: stubDir, stateDir: join(agentState, "astate"), log: {} });
    await waitFor(() => agent.tunnel.registered, 3000);

    // 触发 dev-build → completed → 规则触发 smoke-test → 自动执行到终态
    const res = await fetch(`http://127.0.0.1:${port}/api/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "dev-build-investm" }),
    });
    const { taskId } = await res.json();
    await waitFor(() => hub.queue.get(taskId)?.state === "completed", 5000);

    // 规则链上的 smoke-test 任务出现且 actor=rule-engine
    await waitFor(() => hub.queue.list().some((t) => t.target === "smoke-test" && t.actor === "rule-engine"), 3000);
    const smoke = hub.queue.list().find((t) => t.target === "smoke-test");
    assert.ok(smoke, "规则应已产生 smoke-test 任务");
    assert.deepEqual(smoke.ruleTrace, ["smoke-test"]);
    await waitFor(() => hub.queue.get(smoke.id)?.state === "completed", 5000); // 动作不旁路：委派真实执行
    // 规则触发进审计（PRD-5 NFR 审计同车道）
    assert.ok(hub.audit.list().some((e) => e.actor === "rule-engine" && e.target === "smoke-test" && e.outcome === "submitted"));
  } finally {
    agent?.tunnel.close();
    await new Promise((r) => hub.server.close(r));
    rmSync(hubDir, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
    rmSync(agentState, { recursive: true, force: true });
  }
});

function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor 超时"));
      setTimeout(tick, 20);
    };
    tick();
  });
}
