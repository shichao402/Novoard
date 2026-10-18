/**
 * 契约 2.1：bootId 区分闪断与进程消失；运行记录只追加，不改状态。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

import { createHub } from "../src/main.mjs";
import { createTaskQueue } from "../src/queue.mjs";
import { bootstrapTestAuth, configureTestAgentTokens } from "./test-auth.mjs";

const BOOT_A = "11111111-1111-4111-8111-111111111111";
const BOOT_B = "22222222-2222-4222-8222-222222222222";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "novoard-reconcile-"));
}

function card(extra = {}) {
  return {
    name: "mac-work",
    description: "工位",
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: true },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text", "file"],
    skills: [{ id: "smoke-test", name: "冒烟", description: "echo", tags: ["t"], ...extra }],
  };
}

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

function connect({ port, token, agentCard, bootId, inFlight = [] }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, { headers: { Authorization: `Bearer ${token}` } });
  const sends = [];
  ws.on("open", () => {
    ws.send(JSON.stringify({
      v: 1,
      kind: "ops",
      msgId: `e-hello-${Date.now()}`,
      ts: new Date().toISOString(),
      body: {
        type: "agent.hello",
        contractVersion: "2.1",
        agentId: "mac-work",
        card: agentCard,
        inFlightTaskIds: inFlight,
        ...(bootId ? { bootId } : {}),
      },
    }));
  });
  ws.on("message", (raw) => {
    const env = JSON.parse(String(raw));
    if (env.kind === "a2a" && env.body?.method === "message/send") sends.push(env);
  });
  return { ws, sends, close: () => { try { ws.close(); } catch { /* 已关 */ } } };
}

function uplink(ws, taskId, message) {
  ws.send(JSON.stringify({
    v: 1,
    kind: "a2a",
    msgId: `e-${Math.random().toString(36).slice(2, 10)}`,
    taskId,
    ts: new Date().toISOString(),
    body: { jsonrpc: "2.0", method: "message/notification", params: { message } },
  }));
}

async function startHub(extra = {}) {
  const dir = tmpDir();
  const hub = await createHub({
    stateDir: dir,
    port: 0,
    offlineSweepMs: extra.offlineSweepMs ?? 30_000,
    log: { info() {}, error() {} },
  });
  configureTestAgentTokens(hub, { "mac-work": "agt_test_token_12345678" });
  const auth = await bootstrapTestAuth(hub);
  return { dir, hub, auth, port: hub.server.address().port };
}

async function trigger(port, headers) {
  const response = await fetch(`http://127.0.0.1:${port}/a2a`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: { message: { messageId: "m1", role: "user", parts: [{ kind: "text", text: "smoke-test" }] } },
    }),
  });
  const body = await response.json();
  return body.result;
}

test("运行记录可在终态后追加，相同 seq 不重复", () => {
  const dir = tmpDir();
  const queue = createTaskQueue({ dir });
  const task = queue.submit({ skillId: "smoke-test", target: "smoke-test", member: "mac-work", actor: "human", lane: "a2a" });
  queue.transition(task.id, "working");
  const event = { seq: 1, type: "step/start", ts: new Date().toISOString(), taskId: task.id, index: 1, command: "echo" };
  assert.equal(queue.appendTrace(task.id, event).dedup, false);
  assert.equal(queue.appendTrace(task.id, event).dedup, true);
  assert.equal(queue.get(task.id).state, "working");
  assert.equal(queue.get(task.id).trace.length, 1);
  queue.transition(task.id, "completed");
  queue.appendTrace(task.id, { seq: 2, type: "run/truncated", ts: new Date().toISOString(), taskId: task.id, last: { type: "step/start", index: 1 } });
  assert.equal(queue.get(task.id).state, "completed");
  assert.equal(queue.get(task.id).trace.length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("同一 bootId 且不在清单里：重新下发，不失败", async () => {
  const { dir, hub, auth, port } = await startHub();
  const first = connect({ port, token: "agt_test_token_12345678", agentCard: card(), bootId: BOOT_A });
  try {
    await waitFor(() => first.ws.readyState === WebSocket.OPEN);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const task = await trigger(port, auth.headers);
    await waitFor(() => first.sends.length === 1);
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = connect({ port, token: "agt_test_token_12345678", agentCard: card(), bootId: BOOT_A });
    try {
      await waitFor(() => second.sends.length === 1);
      assert.equal(hub.queue.get(task.id).state, "working");
    } finally {
      second.close();
    }
  } finally {
    first.close();
    await new Promise((resolve) => hub.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("同一 bootId 且仍在清单里：不重发", async () => {
  const { dir, hub, auth, port } = await startHub();
  const first = connect({ port, token: "agt_test_token_12345678", agentCard: card(), bootId: BOOT_A });
  try {
    await waitFor(() => first.ws.readyState === WebSocket.OPEN);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const task = await trigger(port, auth.headers);
    await waitFor(() => first.sends.length === 1);
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = connect({ port, token: "agt_test_token_12345678", agentCard: card(), bootId: BOOT_A, inFlight: [task.id] });
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(second.sends.length, 0);
      assert.equal(hub.queue.get(task.id).state, "working");
    } finally {
      second.close();
    }
  } finally {
    first.close();
    await new Promise((resolve) => hub.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bootId 变了且不在清单里：收成 agent-lost", async () => {
  const { dir, hub, auth, port } = await startHub();
  const first = connect({ port, token: "agt_test_token_12345678", agentCard: card(), bootId: BOOT_A });
  try {
    await waitFor(() => first.ws.readyState === WebSocket.OPEN);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const task = await trigger(port, auth.headers);
    await waitFor(() => first.sends.length === 1);
    uplink(first.ws, task.id, {
      messageId: "m-trace",
      role: "agent",
      parts: [],
      contextId: task.id,
      taskId: task.id,
      kind: "run-trace",
      trace: { seq: 1, type: "step/start", ts: new Date().toISOString(), taskId: task.id, index: 1, command: "npm run desktop:dev-deploy" },
    });
    await waitFor(() => hub.queue.get(task.id).trace?.length === 1);
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = connect({ port, token: "agt_test_token_12345678", agentCard: card(), bootId: BOOT_B });
    try {
      await waitFor(() => hub.queue.get(task.id).state === "failed");
      assert.match(hub.queue.get(task.id).status.message, /^agent-lost/);
      assert.match(hub.queue.get(task.id).status.message, /step\/start 1/);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(second.sends.length, 0);
    } finally {
      second.close();
    }
  } finally {
    first.close();
    await new Promise((resolve) => hub.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hub 还不记得 bootId：清单外的任务重新下发", async () => {
  const { dir, hub, auth, port } = await startHub();
  const first = connect({ port, token: "agt_test_token_12345678", agentCard: card() });
  try {
    await waitFor(() => first.ws.readyState === WebSocket.OPEN);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const task = await trigger(port, auth.headers);
    await waitFor(() => first.sends.length === 1);
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = connect({ port, token: "agt_test_token_12345678", agentCard: card(), bootId: BOOT_A });
    try {
      await waitFor(() => second.sends.length === 1);
      assert.equal(hub.queue.get(task.id).state, "working");
    } finally {
      second.close();
    }
  } finally {
    first.close();
    await new Promise((resolve) => hub.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("不带 bootId 的重连保持原任务", async () => {
  const { dir, hub, auth, port } = await startHub();
  const first = connect({ port, token: "agt_test_token_12345678", agentCard: card() });
  try {
    await waitFor(() => first.ws.readyState === WebSocket.OPEN);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const task = await trigger(port, auth.headers);
    await waitFor(() => first.sends.length === 1);
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = connect({ port, token: "agt_test_token_12345678", agentCard: card() });
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(second.sends.length, 0);
      assert.equal(hub.queue.get(task.id).state, "working");
    } finally {
      second.close();
    }
  } finally {
    first.close();
    await new Promise((resolve) => hub.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("成员断开超过 lostTtl 才收成 agent-lost", async () => {
  const { dir, hub, auth, port } = await startHub({ offlineSweepMs: 30 });
  const agent = connect({
    port,
    token: "agt_test_token_12345678",
    agentCard: card({ "x-novoard-lost": { ttl: "1s" } }),
    bootId: BOOT_A,
  });
  try {
    await waitFor(() => agent.ws.readyState === WebSocket.OPEN);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const task = await trigger(port, auth.headers);
    await waitFor(() => agent.sends.length === 1);
    assert.equal(hub.queue.get(task.id).limits.lostTtl, "1s");
    agent.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(hub.queue.get(task.id).state, "working");
    await waitFor(() => hub.queue.get(task.id).state === "failed", 2000);
    assert.match(hub.queue.get(task.id).status.message, /^agent-lost/);
    assert.ok(hub.audit.list().some((event) => event.taskId === task.id && event.detail?.reason === "agent-lost"));
  } finally {
    agent.close();
    await new Promise((resolve) => hub.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approvalTtl 抄到任务上后按该期限取消", async () => {
  const { dir, hub, auth, port } = await startHub({ offlineSweepMs: 30 });
  const agent = connect({
    port,
    token: "agt_test_token_12345678",
    agentCard: card({ "x-novoard-approval": { ttl: "1s" } }),
    bootId: BOOT_A,
  });
  try {
    await waitFor(() => agent.ws.readyState === WebSocket.OPEN);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const task = await trigger(port, auth.headers);
    await waitFor(() => agent.sends.length === 1);
    uplink(agent.ws, task.id, {
      messageId: "m-wait",
      role: "agent",
      parts: [],
      contextId: task.id,
      taskId: task.id,
      kind: "status-update",
      status: { state: "input-required", message: "等待审批", timestamp: new Date().toISOString() },
    });
    await waitFor(() => hub.queue.get(task.id).state === "canceled", 2000);
    assert.equal(hub.queue.get(task.id).status.message, "approval-ttl-expired");
  } finally {
    agent.close();
    await new Promise((resolve) => hub.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
