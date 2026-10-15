/**
 * M4 A2A 能力面完备化（PRD-4）测试：
 * F2 message/stream：SSE 步骤级进度（working 帧透传 → final 终态帧 → 连接关闭）
 * F3 审批门全链路：requiresApproval → input-required 挂起 → tasks/approve → resume → 终态；拒绝 → canceled；TTL 超时
 * F4 授权矩阵：allow/deny 查表、未注册 client 拒绝、dashboard 不受限、拒绝留审计
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

import { createHub } from "../src/main.mjs";
import { createAcl } from "../src/acl.mjs";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "novoard-m4-"));
}

const CARD = (skillOverrides = {}) => ({
  name: "mac-work",
  description: "工位 Mac",
  version: "1.0.0",
  capabilities: { streaming: true, pushNotifications: true },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text", "file"],
  skills: [{ id: "smoke-test", name: "冒烟", description: "echo ok", tags: ["t"], ...skillOverrides }],
});

/** 读 SSE 流直到 final 帧或超时。 */
async function sseUntilFinal(port, taskId, timeoutMs = 8000) {
  const res = await fetch(`http://127.0.0.1:${port}/a2a`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer with-key-abc123" },
    body: JSON.stringify({ jsonrpc: "2.0", id: `sse-${taskId}`, method: "message/stream", params: { id: taskId } }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const frames = [];
  const deadline = Date.now() + timeoutMs;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (Date.now() < deadline) {
    const { done, value } = await Promise.race([reader.read(), new Promise((_, rej) => setTimeout(() => rej(new Error("sse timeout")), timeoutMs))]);
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (const block of buf.split("\n\n")) {
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      if (line) {
        const frame = JSON.parse(line.slice(6));
        frames.push(frame);
        if (frame.result?.final) {
          reader.cancel().catch(() => {});
          return frames;
        }
      }
    }
    buf = buf.includes("\n\n") ? buf.slice(buf.lastIndexOf("\n\n") + 2) : buf;
  }
  reader.cancel().catch(() => {});
  return frames;
}

/** 起一个假 agent（ws 隧道）：hello 注册 → 应答委派（按脚本驱动状态上报）。 */
function fakeAgent({ port, token, card, driver }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, { headers: { Authorization: `Bearer ${token}` } });
  const sent = [];
  const uplink = (taskId, state, message) => {
    const env = {
      v: 1, kind: "a2a", msgId: `e-${Math.random().toString(36).slice(2, 10)}`, taskId, ts: new Date().toISOString(),
      body: { jsonrpc: "2.0", method: "message/notification", params: { message: { messageId: `m-${Date.now()}`, role: "agent", parts: [], contextId: taskId, taskId, kind: "status-update", status: { state, message: message ?? "", timestamp: new Date().toISOString() } } } },
    };
    sent.push(env);
    ws.send(JSON.stringify(env));
  };
  ws.on("open", () => {
    ws.send(JSON.stringify({ v: 1, kind: "ops", msgId: `e-hello`, ts: new Date().toISOString(), body: { type: "agent.hello", contractVersion: "1.0", agentId: "mac-work", token, card, inFlightTaskIds: [] } }));
  });
  ws.on("message", (raw) => {
    const env = JSON.parse(String(raw));
    if (env.kind === "a2a") driver?.({ env, uplink, ws });
  });
  return { ws, sent, close: () => ws.close() };
}

test("F2 message/stream：SSE 步骤进度 + final 终态帧", async () => {
  const dir = tmpDir();
  const hub = await createHub({ stateDir: dir, port: 0 });
  const port = hub.server.address().port;
  hub.secrets.set({ clientKeys: ["with-key-abc123"], dashboardToken: "dash-pass-123456", agentTokens: ["agt_test_token_12345678"] });
  let uplinkFn = null;
  const agent = fakeAgent({
    port, token: "agt_test_token_12345678", card: CARD(),
    driver: ({ env, uplink }) => {
      if (env.body?.method === "message/send") {
        uplinkFn = uplink;
        const taskId = env.taskId;
        setTimeout(() => uplink(taskId, "working", "step 1/2：echo"), 50);
        setTimeout(() => uplink(taskId, "working", "step 2/2：done"), 150);
        setTimeout(() => uplink(taskId, "completed", "ok"), 250);
      }
    },
  });
  try {
    await new Promise((r) => setTimeout(r, 300));
    // 触发任务
    const sendRes = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer with-key-abc123" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { messageId: "m1", role: "user", parts: [{ kind: "text", text: "smoke-test" }] } } }),
    });
    const { result: task } = await sendRes.json();
    assert.equal(task.status.state, "submitted");

    const frames = await sseUntilFinal(port, task.id);
    const kinds = frames.map((f) => f.result?.status?.state ?? "?");
    assert.ok(kinds.includes("working"), `应含 working 进度帧：${kinds}`);
    assert.ok(frames.some((f) => f.result?.status?.message?.includes("step")), `应含步骤进度 message：${JSON.stringify(frames.map((f) => f.result?.status?.message))}`);
    const final = frames.find((f) => f.result?.final);
    assert.equal(final.result.status.state, "completed");
  } finally {
    agent.close();
    await new Promise((r) => hub.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F3 审批门：input-required 挂起 → tasks/approve → resume → completed", async () => {
  const dir = tmpDir();
  const hub = await createHub({ stateDir: dir, port: 0 });
  const port = hub.server.address().port;
  hub.secrets.set({ clientKeys: ["with-key-abc123"], dashboardToken: "dash-pass-123456", agentTokens: ["agt_test_token_12345678"] });
  const agent = fakeAgent({
    port, token: "agt_test_token_12345678", card: CARD(),
    driver: ({ env, uplink }) => {
      if (env.body?.method === "message/send") {
        const taskId = env.taskId;
        setTimeout(() => uplink(taskId, "input-required", "requiresApproval=true，等待审批"), 50);
      }
      if (env.body?.method === "message/resume") {
        setTimeout(() => uplink(env.taskId, "working", "approval-resumed"), 30);
        setTimeout(() => uplink(env.taskId, "completed", "ok"), 80);
      }
    },
  });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const sendRes = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer with-key-abc123" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { messageId: "m1", role: "user", parts: [{ kind: "text", text: "smoke-test" }] } } }),
    });
    const { result: task } = await sendRes.json();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(hub.queue.get(task.id).state, "input-required");

    // 恢复：tasks/approve → hub 下行 message/resume → agent 继续执行
    const approveRes = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer with-key-abc123" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tasks/approve", params: { id: task.id, decision: "approve" } }),
    });
    const approveBody = await approveRes.json();
    assert.equal(approveRes.status, 200);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(hub.queue.get(task.id).state, "completed");
    const events = hub.audit.list();
    assert.ok(events.some((e) => e.taskId === task.id && e.outcome === "working" && e.detail?.reason === "approval-resumed by client:with-k"));
  } finally {
    agent.close();
    await new Promise((r) => hub.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F3 审批门：tasks/approve reject → canceled", async () => {
  const dir = tmpDir();
  const hub = await createHub({ stateDir: dir, port: 0 });
  const port = hub.server.address().port;
  hub.secrets.set({ clientKeys: ["with-key-abc123"], dashboardToken: "dash-pass-123456", agentTokens: ["agt_test_token_12345678"] });
  const agent = fakeAgent({
    port, token: "agt_test_token_12345678", card: CARD(),
    driver: ({ env, uplink }) => {
      if (env.body?.method === "message/send") {
        setTimeout(() => uplink(env.taskId, "input-required", "等待审批"), 50);
      }
    },
  });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const sendRes = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer with-key-abc123" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { messageId: "m1", role: "user", parts: [{ kind: "text", text: "smoke-test" }] } } }),
    });
    const { result: task } = await sendRes.json();
    await new Promise((r) => setTimeout(r, 200));
    const rejectRes = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer with-key-abc123" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tasks/approve", params: { id: task.id, decision: "reject" } }),
    });
    assert.equal(rejectRes.status, 200);
    assert.equal(hub.queue.get(task.id).state, "canceled");
  } finally {
    agent.close();
    await new Promise((r) => hub.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F4 授权矩阵：allow/deny 查表 + 拒绝留审计（AC4）", async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "acl.yaml"), `clients:\n  - client: with-k\n    allow:\n      - mac-home/*\n    deny:\n      - mac-home/danger-target\n`);
  const hub = await createHub({ stateDir: dir, port: 0, aclPath: join(dir, "acl.yaml") });
  const port = hub.server.address().port;
  hub.secrets.set({ clientKeys: ["with-key-abc123", "other-key-xyz999"], dashboardToken: "dash-pass-123456", agentTokens: ["agt_test_token_12345678"] });
  try {
    hub.registry.register({ agentId: "mac-home", card: { name: "h", description: "d", version: "1", capabilities: { streaming: false, pushNotifications: true }, defaultInputModes: ["text"], defaultOutputModes: ["text", "file"], skills: [{ id: "smoke-test", name: "n", description: "d", tags: [] }, { id: "danger-target", name: "n", description: "d", tags: [] }] } });

    // allow 域内：放行到路由层（成员离线 reject，但非 acl 拒绝）
    const okRes = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer with-key-abc123" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { messageId: "m1", role: "user", parts: [{ kind: "text", text: "smoke-test@mac-home" }] } } }),
    });
    const okBody = await okRes.json();
    assert.ok(okBody.error, "成员离线应返回 error（非 ACL 拒绝）");
    assert.ok(!okBody.error?.data?.includes("授权矩阵"), `不应是 ACL 拒绝：${JSON.stringify(okBody)}`);

    // deny 条目：拒绝 + 审计
    const denyRes = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer with-key-abc123" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "message/send", params: { message: { messageId: "m2", role: "user", parts: [{ kind: "text", text: "danger-target@mac-home" }] } } }),
    });
    const denyBody = await denyRes.json();
    assert.match(denyBody.error?.message ?? "", /授权矩阵拒绝/);
    assert.ok(hub.audit.list().some((e) => e.target === "danger-target" && e.outcome === "rejected" && e.detail?.reason?.includes("acl-denied")));

    // 未注册 client：拒绝
    const unregRes = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer other-key-xyz999" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "message/send", params: { message: { messageId: "m3", role: "user", parts: [{ kind: "text", text: "smoke-test@mac-home" }] } } }),
    });
    const unregBody = await unregRes.json();
    assert.match(unregBody.error?.message ?? "", /未在授权矩阵注册/);
  } finally {
    await new Promise((r) => hub.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F4 授权矩阵单元：未配置默认放行；dashboard 不受限", () => {
  const acl = createAcl({ aclPath: "/nonexistent/acl.yaml", log: { info() {} } });
  assert.deepEqual(acl.check({ actor: "client:with-k", skillId: "x", member: "m" }), { allowed: true });
  const dir = tmpDir();
  writeFileSync(join(dir, "acl.yaml"), `clients:\n  - client: with-k\n    allow: [mac-home/*]\n`);
  const acl2 = createAcl({ aclPath: join(dir, "acl.yaml"), log: { info() {} } });
  assert.equal(acl2.check({ actor: "dashboard", skillId: "anything", member: "any" }).allowed, true);
  assert.equal(acl2.check({ actor: "client:with-k", skillId: "smoke-test", member: "mac-home" }).allowed, true);
  assert.equal(acl2.check({ actor: "client:with-k", skillId: "x", member: "other-member" }).allowed, false);
  rmSync(dir, { recursive: true, force: true });
});
