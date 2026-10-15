/**
 * Ant Design Pro 管理控制台静态托管与既有业务端点测试：
 * 1. /api/targets 端点：分组目录、离线成员可见、鉴权
 * 2. SPA fallback、缓存与 CSP
 * 3. 触发入口 member 选择路由正确（离线 + queue 策略走 queued-offline）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHub } from "../src/main.mjs";
import { bootstrapTestAuth } from "./test-auth.mjs";

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
  const webDir = mkdtempSync(join(tmpdir(), "novoard-web-dist-"));
  const assetsDir = join(webDir, "assets");
  mkdirSync(assetsDir);
  writeFileSync(join(webDir, "index.html"), "<!doctype html><html><body><div id=\"root\">Novoard SPA</div><script type=\"module\" src=\"/assets/index-DxTQRTPh.js\"></script></body></html>");
  writeFileSync(join(assetsDir, "index-DxTQRTPh.js"), "globalThis.__NOVOARD_WEB__=true;");
  const hub = await createHub({ stateDir, webDir, port: 0, offlineSweepMs: 60_000 });
  const port = hub.server.address?.()?.port;
  const auth = await bootstrapTestAuth(hub);
  return {
    hub,
    auth,
    port,
    stateDir,
    close: async () => {
      await new Promise((resolve) => hub.server.close(resolve));
      rmSync(webDir, { recursive: true, force: true });
    },
  };
}

test("管理控制台：SPA fallback、内容哈希缓存与 CSP", async () => {
  const { port, stateDir, close } = await bootHub();
  try {
    let response = await fetch(`http://127.0.0.1:${port}/users`, { headers: { Accept: "text/html" } });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Novoard SPA/);
    assert.match(response.headers.get("cache-control"), /no-cache/);
    const csp = response.headers.get("content-security-policy");
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.match(csp, /style-src 'self' 'unsafe-inline'/);
    assert.match(csp, /connect-src 'self'/);
    assert.doesNotMatch(csp, /connect-src[^;]*(?:https?:|wss?:)/);

    response = await fetch(`http://127.0.0.1:${port}/assets/index-DxTQRTPh.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /immutable/);

    response = await fetch(`http://127.0.0.1:${port}/api/not-real`, { headers: { Accept: "text/html" } });
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type"), /application\/json/);
  } finally {
    await close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("/api/targets：分组目录与离线成员可见", async () => {
  const { hub, auth, port, stateDir, close } = await bootHub();
  try {
    hub.registry.register({ agentId: "mac-work", card: CARD });
    hub.registry.markOffline("mac-work"); // 离线但 card 留表 → 目录仍可见

    let res = await fetch(`http://127.0.0.1:${port}/api/targets`);
    assert.equal(res.status, 401); // 无鉴权拒

    res = await fetch(`http://127.0.0.1:${port}/api/targets`, { headers: { Authorization: auth.authorization } });
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
  const { hub, auth, port, stateDir, close } = await bootHub();
  try {
    hub.registry.register({ agentId: "mac-work", card: CARD });
    hub.registry.markOffline("mac-work");

    // 面板触发形态：target + member（离线成员 + queue 策略 → queued-offline）
    const res = await fetch(`http://127.0.0.1:${port}/api/trigger`, {
      method: "POST",
      headers: auth.headers,
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
    assert.equal(task.actor, "pat:test-owner/" + auth.pat.name);
  } finally {
    await close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
