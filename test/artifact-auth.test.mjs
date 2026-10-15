import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";

import { createHub } from "../src/main.mjs";
import { bootstrapTestAuth, configureTestAgentTokens } from "./test-auth.mjs";

function card(agentId, skillId) {
  return {
    name: agentId,
    description: agentId,
    version: "2.0.0",
    capabilities: { streaming: false, pushNotifications: true },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text", "file"],
    skills: [{ id: skillId, name: skillId, description: skillId, tags: [] }],
  };
}

function hello(agentId, skillId) {
  return {
    v: 1,
    kind: "ops",
    msgId: `e-hello-${agentId}`,
    ts: new Date().toISOString(),
    body: {
      type: "agent.hello",
      contractVersion: "2.0",
      agentId,
      card: card(agentId, skillId),
      inFlightTaskIds: [],
    },
  };
}

function digest(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("waitFor timeout");
}

test("agent token 绑定 agentId，跨 member 状态伪造被拒", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-agent-binding-"));
  const hub = await createHub({ stateDir, port: 0, log: { info() {}, error() {} } });
  const port = hub.server.address().port;
  configureTestAgentTokens(hub, {
    "agent-a": "agent-a-secret-token",
    "agent-b": "agent-b-secret-token",
  });
  const sockets = [];
  try {
    const mismatch = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, {
      headers: { Authorization: "Bearer agent-a-secret-token" },
    });
    sockets.push(mismatch);
    await once(mismatch, "open");
    const mismatchFrames = [];
    mismatch.on("message", (raw) => mismatchFrames.push(JSON.parse(String(raw))));
    mismatch.send(JSON.stringify(hello("agent-b", "skill-b")));
    await waitFor(() => mismatchFrames.some((frame) => frame.body?.type === "agent.hello.nack"));
    assert.equal(mismatchFrames.find((frame) => frame.body?.type === "agent.hello.nack").body.reason, "agent-identity-mismatch");
    assert.equal(hub.registry.ownerOf("skill-b"), null);
    mismatch.close();

    const agentA = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, {
      headers: { Authorization: "Bearer agent-a-secret-token" },
    });
    sockets.push(agentA);
    await once(agentA, "open");
    agentA.send(JSON.stringify(hello("agent-a", "skill-a")));
    await waitFor(() => hub.registry.ownerOf("skill-a")?.agentId === "agent-a");

    const foreignTask = hub.queue.submit({
      skillId: "skill-b",
      target: "skill-b",
      member: "agent-b",
      actor: "test",
      lane: "a2a",
    });
    agentA.send(JSON.stringify({
      v: 1,
      kind: "a2a",
      msgId: "e-forged-status",
      taskId: foreignTask.id,
      ts: new Date().toISOString(),
      body: {
        jsonrpc: "2.0",
        method: "message/notification",
        params: {
          message: {
            messageId: "m-forged",
            role: "agent",
            parts: [],
            taskId: foreignTask.id,
            kind: "status-update",
            status: { state: "completed", timestamp: new Date().toISOString() },
          },
        },
      },
    }));
    await waitFor(() => hub.audit.list().some((entry) => entry.detail?.reason === "task-member-mismatch"));
    assert.equal(hub.queue.get(foreignTask.id).state, "submitted");
  } finally {
    for (const socket of sockets) socket.close();
    await new Promise((resolve) => hub.server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("非法 Agent 状态在写盘前被拒，Hub 保持可用", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-agent-state-"));
  const hub = await createHub({ stateDir, port: 0, log: { info() {}, error() {} } });
  const port = hub.server.address().port;
  configureTestAgentTokens(hub, { "agent-a": "agent-a-secret-token" });
  const socket = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, {
    headers: { Authorization: "Bearer agent-a-secret-token" },
  });
  try {
    await once(socket, "open");
    socket.send(JSON.stringify(hello("agent-a", "skill-a")));
    await waitFor(() => hub.registry.ownerOf("skill-a")?.agentId === "agent-a");
    const task = hub.queue.submit({
      skillId: "skill-a",
      target: "skill-a",
      member: "agent-a",
      actor: "test",
      lane: "a2a",
    });
    socket.send(JSON.stringify({
      v: 1,
      kind: "a2a",
      msgId: "e-invalid-state",
      taskId: task.id,
      ts: new Date().toISOString(),
      body: {
        jsonrpc: "2.0",
        method: "message/notification",
        params: {
          message: {
            messageId: "m-invalid-state",
            role: "agent",
            parts: [],
            taskId: task.id,
            kind: "status-update",
            status: { state: "bogus", timestamp: new Date().toISOString() },
          },
        },
      },
    }));
    await waitFor(() => hub.audit.list().some((entry) =>
      entry.taskId === task.id && entry.detail?.reason === "invalid-task-state"));
    assert.equal(hub.queue.get(task.id).state, "submitted");
    assert.doesNotMatch(readFileSync(join(stateDir, "queue", "queue.jsonl"), "utf8"), /bogus/);
    const response = await fetch(`http://127.0.0.1:${port}/api/setup/status`);
    assert.equal(response.status, 200);
  } finally {
    socket.close();
    await new Promise((resolve) => hub.server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("已有任务始终下发给创建时绑定的 member", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-task-binding-"));
  const hub = await createHub({ stateDir, port: 0, log: { info() {}, error() {} } });
  const sentA = [];
  const sentB = [];
  try {
    hub.registry.register({
      agentId: "agent-a",
      card: card("agent-a", "shared-skill"),
      conn: { readyState: 1, send: (raw) => sentA.push(JSON.parse(String(raw))) },
    });
    const task = hub.queue.submit({
      skillId: "shared-skill",
      target: "shared-skill",
      member: "agent-a",
      vars: { owner: "A-only" },
      actor: "test",
      lane: "a2a",
    });
    hub.registry.updateCard("agent-a", { ...card("agent-a", "shared-skill"), skills: [] });
    hub.registry.register({
      agentId: "agent-b",
      card: card("agent-b", "shared-skill"),
      conn: { readyState: 1, send: (raw) => sentB.push(JSON.parse(String(raw))) },
    });

    const delegated = await hub.delegate({ task, vars: task.vars });
    assert.equal(delegated.ok, true);
    assert.equal(sentA.some((frame) => frame.taskId === task.id && frame.body?.method === "message/send"), true);
    assert.equal(sentB.some((frame) => frame.taskId === task.id), false);
  } finally {
    await new Promise((resolve) => hub.server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Agent 重连时会收到其仍在执行但 Hub 已取消任务的 cancel", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-cancel-reconcile-"));
  const hub = await createHub({ stateDir, port: 0, log: { info() {}, error() {} } });
  const port = hub.server.address().port;
  configureTestAgentTokens(hub, { "agent-a": "agent-a-secret-token" });
  const task = hub.queue.submit({
    skillId: "skill-a",
    target: "skill-a",
    member: "agent-a",
    actor: "test",
    lane: "a2a",
  });
  hub.queue.transition(task.id, "input-required");
  hub.queue.transition(task.id, "canceled", { message: "approval-ttl-expired" });
  const socket = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, {
    headers: { Authorization: "Bearer agent-a-secret-token" },
  });
  const frames = [];
  socket.on("message", (raw) => frames.push(JSON.parse(String(raw))));
  try {
    await once(socket, "open");
    const helloFrame = hello("agent-a", "skill-a");
    helloFrame.body.inFlightTaskIds = [task.id];
    socket.send(JSON.stringify(helloFrame));
    await waitFor(() => frames.some((frame) =>
      frame.taskId === task.id && frame.body?.method === "tasks/cancel"));
  } finally {
    socket.close();
    await new Promise((resolve) => hub.server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("artifact 校验 digest 与任务归属，下载按 PAT target 范围授权", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-artifact-auth-"));
  const hub = await createHub({ stateDir, port: 0, log: { info() {}, error() {} } });
  const port = hub.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  configureTestAgentTokens(hub, {
    "agent-a": "agent-a-secret-token",
    "agent-b": "agent-b-secret-token",
  });
  let agentA;
  try {
    const auth = await bootstrapTestAuth(hub);
    const taskA = hub.queue.submit({ skillId: "skill-a", target: "skill-a", member: "agent-a", actor: "test", lane: "a2a" });
    const taskB = hub.queue.submit({ skillId: "skill-b", target: "skill-b", member: "agent-b", actor: "test", lane: "a2a" });
    const contentA = Buffer.from("artifact A");
    const payloadA = {
      taskId: taskA.id,
      name: "report-a.txt",
      content: contentA.toString("base64"),
      encoding: "base64",
      digest: digest(contentA),
    };

    let response = await fetch(`${base}/api/artifacts`, {
      method: "POST",
      headers: { Authorization: "Bearer agent-b-secret-token", "Content-Type": "application/json" },
      body: JSON.stringify(payloadA),
    });
    assert.equal(response.status, 404, "其他 member 不得给任务上传 artifact");

    response = await fetch(`${base}/api/artifacts`, {
      method: "POST",
      headers: { Authorization: "Bearer agent-a-secret-token", "Content-Type": "application/json" },
      body: JSON.stringify({ ...payloadA, digest: `sha256:${"0".repeat(64)}` }),
    });
    assert.equal(response.status, 422);

    response = await fetch(`${base}/api/artifacts`, {
      method: "POST",
      headers: { Authorization: "Bearer agent-a-secret-token", "Content-Type": "application/json" },
      body: JSON.stringify(payloadA),
    });
    assert.equal(response.status, 201);
    const artifactA = (await response.json()).artifact;
    assert.equal(artifactA.metadata.taskId, taskA.id);
    assert.equal(artifactA.metadata.member, "agent-a");
    assert.equal(artifactA.metadata.target, "skill-a");
    assert.equal(artifactA.metadata.digest, digest(contentA));

    agentA = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, {
      headers: { Authorization: "Bearer agent-a-secret-token" },
    });
    const frames = [];
    agentA.on("message", (raw) => frames.push(JSON.parse(String(raw))));
    await once(agentA, "open");
    agentA.send(JSON.stringify(hello("agent-a", "skill-a")));
    await waitFor(() => hub.registry.ownerOf("skill-a")?.agentId === "agent-a");
    agentA.send(JSON.stringify({
      v: 1,
      kind: "a2a",
      msgId: "e-artifact-notify",
      taskId: taskA.id,
      ts: new Date().toISOString(),
      body: {
        jsonrpc: "2.0",
        method: "message/notification",
        params: {
          message: {
            messageId: "m-artifact-notify",
            role: "agent",
            parts: [],
            taskId: taskA.id,
            kind: "artifact-update",
            artifact: artifactA,
          },
        },
      },
    }));
    await waitFor(() => frames.some((frame) => frame.kind === "ack" && frame.msgId === "e-artifact-notify"));
    assert.equal(hub.queue.get(taskA.id).artifacts.length, 1, "规范 artifact 通知必须幂等");
    assert.ok(hub.audit.list().some((entry) => entry.detail?.reason === "artifact-notified"
      && entry.detail?.artifactId === artifactA.metadata.artifactId));

    const contentB = Buffer.from("artifact B");
    response = await fetch(`${base}/api/artifacts`, {
      method: "POST",
      headers: { Authorization: "Bearer agent-b-secret-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: taskB.id,
        name: "report-b.txt",
        content: contentB.toString("base64"),
        encoding: "base64",
        digest: digest(contentB),
      }),
    });
    assert.equal(response.status, 201);
    const artifactB = (await response.json()).artifact;

    const role = await hub.identity.createRole(auth.owner, {
      id: "artifact-a-reader",
      name: "Artifact A Reader",
      permissions: ["artifacts.read"],
      targetAllow: ["agent-a/skill-a"],
    });
    const user = await hub.identity.createUser(auth.owner, {
      username: "artifact-reader",
      password: "artifact reader password",
      roleId: role.id,
      forcePasswordChange: false,
    });
    const login = await hub.identity.login({ username: user.username, password: "artifact reader password" });
    const principal = await hub.identity.authenticateSession(login.token);
    const issued = await hub.identity.createPat(principal, {
      name: "artifact-read",
      scopes: ["artifacts.read"],
      targetAllow: ["agent-a/skill-a"],
    });
    const headers = { Authorization: `Bearer ${issued.token}` };

    response = await fetch(`${base}${artifactA.parts[0].uri}`, { headers });
    assert.equal(response.status, 200);
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "artifact A");

    response = await fetch(`${base}${artifactB.parts[0].uri}`, { headers });
    assert.equal(response.status, 404, "无 target 范围时不得泄露 artifact 存在性");

    response = await fetch(`${base}${artifactA.parts[0].uri}`);
    assert.equal(response.status, 401);

    const identityText = readFileSync(hub.identity.files.identityFile, "utf8");
    assert.doesNotMatch(identityText, /agent-a-secret-token|artifact A/);
  } finally {
    agentA?.close();
    await new Promise((resolve) => hub.server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  }
});
