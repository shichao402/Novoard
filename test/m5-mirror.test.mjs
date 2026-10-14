/**
 * M5 本地镜像链路测试：磁贴本地触发（task-local-*）终态上行 → hub ack（agent 缓存可清）+ 镜像审计。
 * 验证 ADR-0008 的 hub 在线同步语义：本地闭环触发不影响 hub task 队列，但留可见性镜像。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

import { createHub } from "../src/main.mjs";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "novoard-m5mirror-"));
}

const CARD = {
  name: "mac-home",
  description: "d",
  version: "1.0.0",
  capabilities: { streaming: false, pushNotifications: true },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text", "file"],
  skills: [{ id: "smoke-test", name: "n", description: "d", tags: ["t"] }],
};

test("本地镜像：task-local-* 终态上行 → hub ack + 镜像审计，不建 task", async () => {
  const dir = tmpDir();
  const hub = await createHub({ stateDir: dir, port: 0 });
  const port = hub.server.address().port;
  hub.secrets.set({ clientKeys: ["with-key-abc123"], dashboardToken: "dash-pass-123456", agentTokens: ["agt_m5_mirror_123456"] });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, { headers: { Authorization: "Bearer agt_m5_mirror_123456" } });
  const acked = new Promise((resolve) => {
    ws.on("message", (raw) => {
      const env = JSON.parse(String(raw));
      if (env.body?.type === "agent.hello.ack") {
        // 注册成功后发本地镜像终态帧（taskId task-local-*，hub 队列无此 task）
        ws.send(JSON.stringify({
          v: 1, kind: "a2a", msgId: "e-mirror-1", taskId: "task-local-mv7test-abc123", ts: new Date().toISOString(),
          body: { jsonrpc: "2.0", method: "message/notification", params: { message: { messageId: "m1", role: "agent", parts: [], contextId: "task-local-mv7test-abc123", taskId: "task-local-mv7test-abc123", kind: "status-update", status: { state: "completed", message: "tile-trigger smoke-test", timestamp: new Date().toISOString() } } } },
        }));
      }
      if (env.kind === "ack" && env.msgId === "e-mirror-1") resolve(env);
    });
  });
  ws.on("open", () => {
    ws.send(JSON.stringify({ v: 1, kind: "ops", msgId: "e-hello", ts: new Date().toISOString(), body: { type: "agent.hello", contractVersion: "1.0", agentId: "mac-home", token: "agt_m5_mirror_123456", card: CARD, inFlightTaskIds: [] } }));
  });
  try {
    const ack = await Promise.race([acked, new Promise((_, rj) => setTimeout(() => rj(new Error("ack 超时")), 5000))]);
    assert.equal(ack.msgId, "e-mirror-1");
    await new Promise((r) => setTimeout(r, 200));
    // hub 队列不建 task
    assert.equal(hub.queue.get("task-local-mv7test-abc123"), null);
    // 镜像审计落盘
    const events = hub.audit.list();
    const mirror = events.find((e) => e.taskId === "task-local-mv7test-abc123");
    assert.ok(mirror, "镜像审计应存在");
    assert.equal(mirror.outcome, "completed");
    assert.equal(mirror.detail?.via, "tile-local-mirror");
  } finally {
    ws.close();
    await new Promise((r) => hub.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
