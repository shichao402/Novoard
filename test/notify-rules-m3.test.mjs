/**
 * M3 通知与自动化规则完备化（PRD-3）测试：
 * F1/F2 渠道与策略：Bark 降级链、per-target notify 过滤（on-failure 成功不通知）
 * 频控 digest：窗口内合并计数，到期追发汇总（增量不丢）
 * F4 webhook：鉴权、审计落流水、规则联动（webhook-X → run target）
 * F3 member-event 规则源：member-online/offline → run target
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNotify } from "../src/notify.mjs";
import { createHub } from "../src/main.mjs";

function tmpStateDir() {
  return mkdtempSync(join(tmpdir(), "novoard-m3-"));
}

/** 假 secrets：内存键值，覆盖 get/has。 */
function fakeSecrets(data = {}) {
  return {
    get(field) { return data[field] ?? ""; },
    has(field) { return !!data[field]; },
  };
}

const CARD = (skillOverrides = {}) => ({
  name: "mac-work",
  description: "工位 Mac",
  version: "1.0.0",
  capabilities: { streaming: false, pushNotifications: true },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text", "file"],
  skills: [{
    id: "smoke-test",
    name: "冒烟",
    description: "echo ok",
    tags: ["t"],
    ...skillOverrides,
  }],
});

test("notify 单元：Bark 降级链——企微全缺时走 Bark", async () => {
  const barkCalls = [];
  const secrets = fakeSecrets({ barkUrl: "https://bark.example.com", barkDeviceKey: "devkey123" });
  const notify = createNotify({
    secrets,
    bot: null,
    fetchImpl: async (url) => {
      barkCalls.push(String(url));
      return { ok: true };
    },
  });
  await notify.emit({ event: { kind: "terminal", target: "smoke-test", state: "failed", taskId: "t-1", reason: "x" } });
  assert.equal(barkCalls.length, 1);
  assert.match(barkCalls[0], /bark\.example\.com\/devkey123$/);
});

test("notify 单元：policy=on-failure 成功终态不发送，失败终态发送", async () => {
  const sent = [];
  const notify = createNotify({ secrets: fakeSecrets(), bot: { push: async ({ markdown }) => { sent.push(markdown); return true; } } });
  await notify.emit({ event: { kind: "terminal", target: "a", state: "completed", taskId: "t-1" }, policy: "on-failure" });
  assert.equal(sent.length, 0);
  await notify.emit({ event: { kind: "terminal", target: "a", state: "failed", taskId: "t-2" }, policy: "on-failure" });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /任务终态/);
  await notify.emit({ event: { kind: "terminal", target: "a", state: "completed", taskId: "t-3" }, policy: "never" });
  assert.equal(sent.length, 1);
});

test("notify 单元：频控 digest——窗口内合并计数，到期追发汇总", async () => {
  const sent = [];
  const notify = createNotify({ secrets: fakeSecrets(), bot: { push: async ({ markdown }) => { sent.push(markdown); return true; } } });
  // 首条：立即发
  await notify.emit({ event: { kind: "terminal", target: "a", state: "failed", taskId: "t-1" } });
  assert.equal(sent.length, 1);
  // 窗口内两条：吞计数
  await notify.emit({ event: { kind: "terminal", target: "a", state: "failed", taskId: "t-2" } });
  await notify.emit({ event: { kind: "terminal", target: "a", state: "failed", taskId: "t-3" } });
  assert.equal(sent.length, 1);
  assert.equal(notify._test.windows.get("terminal:a:failed").suppressed, 2);
  // 手动触发 digest flush（测试不等 60s）
  notify._test.flushDigest("terminal:a:failed");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, 2);
  assert.match(sent[1], /频控合并/);
  assert.match(sent[1], /2 条同类事件/);
});

test("hub 装配：terminal 通知走 policyOf 查表（x-novoard-notify: on-failure）", async () => {
  const stateDir = tmpStateDir();
  const hub = await createHub({ stateDir, port: 0, offlineSweepMs: 60_000 });
  try {
    const sent = [];
    hub.registry.register({ agentId: "mac-work", card: CARD({ "x-novoard-notify": "on-failure" }) });
    // on-failure + completed → 不发送（无窗口开启）
    await hub.notify({ event: { kind: "terminal", target: "smoke-test", state: "completed", taskId: "task-x-1" } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(hub.notifyImpl._test.windows.size, 0);
    // failed → 开窗发送（首条立即发，通道全缺 → stub 日志但窗口开启）
    await hub.notify({ event: { kind: "terminal", target: "smoke-test", state: "failed", taskId: "task-x-2" } });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(hub.notifyImpl._test.windows.has("terminal:smoke-test:failed"));
  } finally {
    await new Promise((r) => hub.server.close(r));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("hub 装配：webhook 入口鉴权 + 规则联动 webhook-source → run target", async () => {
  const stateDir = tmpStateDir();
  // rules.yaml：webhook-deploy-notify → smoke-test
  const rulesDir = join(stateDir, "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, "rules.yaml"), `rules:\n  - when: { event: webhook-deploy-notify }\n    then: { target: smoke-test }\n`);
  const hub = await createHub({ stateDir: join(stateDir, "hub"), rulesPath: join(rulesDir, "rules.yaml"), port: 0, offlineSweepMs: 60_000 });
  const port = hub.server.address().port;
  hub.secrets.set({ clientKeys: ["with-key-abc123"], dashboardToken: "dash-pass-123456", agentTokens: ["agt_test_token_12345678"] });
  try {
    hub.registry.register({ agentId: "mac-work", card: CARD() });
    hub.registry.markOffline("mac-work"); // 离线：规则动作走离线分流（smoke-test 无 offline 标注 → reject），验证链路而非成功执行

    // 无鉴权拒
    let res = await fetch(`http://127.0.0.1:${port}/api/webhook/deploy-notify`, { method: "POST", body: "{}" });
    assert.equal(res.status, 401);

    // 带鉴权：受理 + 审计 + 规则触发（离线 → rejected 审计）
    res = await fetch(`http://127.0.0.1:${port}/api/webhook/deploy-notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer with-key-abc123" },
      body: JSON.stringify({ action: "deploy-done", version: "1.2.3" }),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.accepted, true);
    await new Promise((r) => setTimeout(r, 80));
    const events = hub.audit.list();
    assert.ok(events.some((e) => e.actor === "webhook:deploy-notify" && e.outcome === "accepted"));
    assert.ok(events.some((e) => e.actor === "rule-engine" && e.target === "smoke-test" && e.outcome === "rejected" && e.detail?.reason === "member-offline"));
  } finally {
    await new Promise((r) => hub.server.close(r));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("hub 装配：member-event 规则源——member-offline → run target", async () => {
  const stateDir = tmpStateDir();
  const rulesDir = join(stateDir, "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, "rules.yaml"), `rules:\n  - when: { event: member-offline, target: mac-work }\n    then: { target: smoke-test }\n`);
  const hub = await createHub({ stateDir: join(stateDir, "hub"), rulesPath: join(rulesDir, "rules.yaml"), port: 0, offlineSweepMs: 60_000 });
  try {
    hub.registry.register({ agentId: "mac-work", card: CARD() });
    hub.registry.markOffline("mac-work");
    // 模拟断连事件（tunnel close 钩子路径）：直接经 hub.notify 装配层进规则引擎
    await hub.notify({ event: { kind: "member-event", target: "mac-work", state: "offline" } });
    await new Promise((r) => setTimeout(r, 80));
    const events = hub.audit.list();
    assert.ok(events.some((e) => e.actor === "rule-engine" && e.detail?.reason?.includes("member-offline")));
  } finally {
    await new Promise((r) => hub.server.close(r));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("lite-agent card：x-novoard-notify 透传", async () => {
  const { deriveCard } = await import("../src/lite-agent/card.mjs");
  const { createFrameValidator } = await import("../src/frames.mjs");
  const validate = createFrameValidator();
  const card = deriveCard({
    agentId: "mac-work",
    targets: {
      "smoke-test": { title: "冒烟", expose: "a2a", audit: "summary", requiresApproval: false, notify: "on-failure", steps: [{ script: "echo ok" }] },
    },
  });
  assert.equal(validate.agentCard(card).ok, true);
  assert.equal(card.skills[0]["x-novoard-notify"], "on-failure");
});
