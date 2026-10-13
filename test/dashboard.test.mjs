/**
 * M2 Web 面板 v1（PRD-2 F3）测试：
 * 1. /api/targets 端点：分组目录、离线成员可见、鉴权
 * 2. dashboard 页面直出（HTML 骨架与关键区块存在）
 * 3. 触发入口 member 选择路由正确（离线 + queue 策略走 queued-offline）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHub } from "../src/main.mjs";
import { renderDashboard } from "../src/dashboard.mjs";

function tmpStateDir() {
  return mkdtempSync(join(tmpdir(), "novoard-dash-"));
}

const CARD = {
  name: "mac-work",
  description: "工位 Mac · dev builder",
  version: "1.0.0",
  capabilities: { streaming: false, pushNotifications: true },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text", "file"],
  skills: [
    { id: "dev-build-investm", name: "构建 InvestM dev", description: "pull → build → deploy", tags: ["dev"], "x-novoard-offline": { policy: "queue", ttl: "10m" } },
  ],
};

async function bootHub() {
  const stateDir = tmpStateDir();
  const hub = await createHub({ stateDir, port: 0, offlineSweepMs: 60_000 });
  const port = hub.server.address?.()?.port;
  hub.secrets.set({ agentTokens: ["agt_test_token_12345678"], dashboardToken: "dash-pass-123456", clientKeys: ["with-key-abc123"] });
  return {
    hub,
    port,
    stateDir,
    close: () => new Promise((resolve) => hub.server.close(resolve)),
  };
}

test("dashboard 页面：v1 区块直出", () => {
  const html = renderDashboard();
  assert.match(html, /Target 目录/);
  assert.match(html, /任务历史/);
  assert.match(html, /datalist/);
  assert.match(html, /member/);
  assert.match(html, /queued-offline/);
  assert.match(html, /Artifacts/);
});

test("/api/targets：分组目录与离线成员可见", async () => {
  const { hub, port, stateDir, close } = await bootHub();
  try {
    hub.registry.register({ agentId: "mac-work", card: CARD });
    hub.registry.markOffline("mac-work"); // 离线但 card 留表 → 目录仍可见

    let res = await fetch(`http://127.0.0.1:${port}/api/targets`);
    assert.equal(res.status, 401); // 无鉴权拒

    res = await fetch(`http://127.0.0.1:${port}/api/targets`, { headers: { Authorization: "Bearer dash-pass-123456" } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.catalog.length, 1);
    const entry = body.catalog[0];
    assert.equal(entry.agentId, "mac-work");
    assert.equal(entry.online, false);
    assert.equal(entry.skills[0].id, "dev-build-investm");
    assert.equal(entry.skills[0]["x-novoard-offline"].policy, "queue");
  } finally {
    await close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("触发入口：member 指定 + 离线 queue 策略联动", async () => {
  const { hub, port, stateDir, close } = await bootHub();
  try {
    hub.registry.register({ agentId: "mac-work", card: CARD });
    hub.registry.markOffline("mac-work");

    // 面板触发形态：target + member（离线成员 + queue 策略 → queued-offline）
    const res = await fetch(`http://127.0.0.1:${port}/api/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer dash-pass-123456" },
      body: JSON.stringify({ target: "dev-build-investm", member: "mac-work" }),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.state, "queued-offline");
    assert.ok(body.expiresAt);

    // 任务历史含耗时字段来源（createdAt/updatedAt）与 actor
    const task = hub.queue.get(body.taskId);
    assert.ok(task.createdAt);
    assert.ok(task.updatedAt);
    assert.equal(task.actor, "dashboard");
  } finally {
    await close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
