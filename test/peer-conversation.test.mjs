/**
 * 成员之间的自然语言：列出 Card、Hub 盖 from、转发给声明了对话技能的成员，
 * 完成后再回报也不会拆掉连接。Target 精确调用仍然只发 run 文本。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

import { createHub } from "../src/main.mjs";
import { bootstrapTestAuth, configureTestAgentTokens } from "./test-auth.mjs";

function cardFor(agentId, role, skillId) {
  return {
    name: agentId,
    description: `${agentId} 的自我介绍`,
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: true },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text", "file"],
    "x-novoard-role": role,
    skills: [
      {
        id: "converse",
        name: "对话",
        description: `${agentId} 的自我介绍`,
        tags: ["kind:agent", `role:${role}`],
        "x-novoard-kind": "agent",
      },
      { id: skillId, name: skillId, description: `可以${skillId}`, tags: ["novoard"] },
    ],
  };
}

function hello(agentId, card) {
  return {
    v: 1,
    kind: "ops",
    msgId: `e-hello-${agentId}`,
    ts: new Date().toISOString(),
    body: { type: "agent.hello", contractVersion: "2.0", agentId, card, inFlightTaskIds: [] },
  };
}

async function connect(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const frames = [];
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { ws, frames };
}

function waitFor(predicate, timeoutMs = 4000) {
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

test("两台办公电脑都能注册，智脑按 Card 交谈并收回回报", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-peer-"));
  const hub = await createHub({
    stateDir,
    port: 0,
    host: "127.0.0.1",
    approvalTtlMs: 1,
    offlineSweepMs: 30,
    log: { info() {}, error() {} },
  });
  configureTestAgentTokens(hub, {
    "cloud-brain": "token-cloud-brain-0001",
    "pc-a": "token-pc-a-0000000001",
    "pc-b": "token-pc-b-0000000001",
    legacy: "token-legacy-000000001",
  });
  const auth = await bootstrapTestAuth(hub);
  const port = hub.server.address().port;
  const noticed = [];
  hub.notifyImpl.pushOwner = async (input) => {
    noticed.push(input);
    return "test";
  };
  const sockets = [];
  try {
    const cloud = await connect(port, "token-cloud-brain-0001");
    const pcA = await connect(port, "token-pc-a-0000000001");
    const pcB = await connect(port, "token-pc-b-0000000001");
    sockets.push(cloud.ws, pcA.ws, pcB.ws);
    cloud.ws.send(JSON.stringify(hello("cloud-brain", cardFor("cloud-brain", "cloud-brain", "read-tapd"))));
    pcA.ws.send(JSON.stringify(hello("pc-a", cardFor("pc-a", "office-pc", "prepare-project"))));
    pcB.ws.send(JSON.stringify(hello("pc-b", cardFor("pc-b", "office-pc", "sync-branch"))));
    await waitFor(() => hub.registry.cards().length === 3);
    assert.equal(hub.registry.resolve("converse"), null);
    assert.equal(hub.registry.catalog().some((member) => member.skills.some((skill) => skill.id === "converse")), false);
    assert.equal(hub.registry.resolve("prepare-project")?.agentId, "pc-a");
    assert.equal(hub.registry.resolve("sync-branch")?.agentId, "pc-b");

    const listed = await fetch(`http://127.0.0.1:${port}/api/cards`, {
      headers: { Authorization: "Bearer token-cloud-brain-0001" },
    });
    assert.equal(listed.status, 200);
    const offices = (await listed.json()).cards.filter((item) => item.card["x-novoard-role"] === "office-pc");
    assert.deepEqual(offices.map((item) => item.agentId).sort(), ["pc-a", "pc-b"]);

    cloud.ws.send(JSON.stringify({
      v: 1,
      kind: "a2a",
      msgId: "e-ask-pc-a",
      taskId: "task-brain-ask-1",
      ts: new Date().toISOString(),
      body: {
        jsonrpc: "2.0",
        method: "message/send",
        params: {
          message: {
            role: "user",
            parts: [{ kind: "text", text: "你们能准备工程吗？" }],
            metadata: { lane: "agent", to: "pc-a", from: "imposter" },
          },
        },
      },
    }));
    await waitFor(() => pcA.frames.some((frame) => frame.kind === "a2a" && frame.body?.method === "message/send"));
    const delivered = pcA.frames.find((frame) => frame.body?.method === "message/send");
    assert.equal(delivered.body.params.message.metadata.from, "cloud-brain");
    assert.equal(delivered.body.params.message.metadata.lane, "agent");
    assert.equal(pcA.ws.readyState, WebSocket.OPEN);

    pcA.ws.send(JSON.stringify({
      v: 1,
      kind: "a2a",
      msgId: "e-reply-1",
      taskId: delivered.taskId,
      ts: new Date().toISOString(),
      body: {
        jsonrpc: "2.0",
        method: "message/notification",
        params: {
          message: {
            role: "agent",
            parts: [{ kind: "text", text: "要准备哪个分支？" }],
            contextId: delivered.body.params.message.contextId,
            taskId: delivered.taskId,
            kind: "status-update",
            metadata: { lane: "agent", to: "cloud-brain" },
            status: { state: "input-required", message: "要准备哪个分支？" },
          },
        },
      },
    }));
    await waitFor(() => cloud.frames.some((frame) => frame.body?.params?.message?.status?.state === "input-required"));
    assert.equal(hub.queue.get(delivered.taskId).state, "input-required");
    const approve = await fetch(`http://127.0.0.1:${port}/a2a`, {
      method: "POST",
      headers: auth.headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "approve-agent-lane",
        method: "tasks/approve",
        params: { id: delivered.taskId, decision: "approve" },
      }),
    });
    assert.match((await approve.json()).error.message, /message\/send/);
    assert.equal(pcA.frames.some((frame) => frame.body?.method === "message/resume"), false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(hub.queue.get(delivered.taskId).state, "input-required");

    cloud.ws.send(JSON.stringify({
      v: 1,
      kind: "a2a",
      msgId: "e-ask-followup",
      taskId: "task-brain-ask-2",
      ts: new Date().toISOString(),
      body: {
        jsonrpc: "2.0",
        method: "message/send",
        params: {
          message: {
            role: "user",
            parts: [{ kind: "text", text: "develop 分支" }],
            contextId: delivered.body.params.message.contextId,
            metadata: { lane: "agent", to: "pc-a" },
          },
        },
      },
    }));
    await waitFor(() => pcA.frames.filter((frame) => frame.body?.method === "message/send").length === 2);
    const followup = pcA.frames.filter((frame) => frame.body?.method === "message/send")[1];
    assert.equal(followup.taskId, delivered.taskId);

    pcA.ws.send(JSON.stringify({
      v: 1,
      kind: "a2a",
      msgId: "e-reply-2",
      taskId: delivered.taskId,
      ts: new Date().toISOString(),
      body: {
        jsonrpc: "2.0",
        method: "message/notification",
        params: {
          message: {
            role: "agent",
            parts: [{ kind: "text", text: "可以。我能准备 develop 的游戏工程。" }],
            contextId: delivered.body.params.message.contextId,
            taskId: delivered.taskId,
            kind: "status-update",
            metadata: { lane: "agent", to: "cloud-brain" },
            status: { state: "completed", message: "可以。我能准备 develop 的游戏工程。" },
          },
        },
      },
    }));
    await waitFor(() => cloud.frames.some((frame) => frame.body?.params?.message?.status?.state === "completed"));

    pcA.ws.send(JSON.stringify({
      v: 1,
      kind: "a2a",
      msgId: "e-report-1",
      taskId: delivered.taskId,
      ts: new Date().toISOString(),
      body: {
        jsonrpc: "2.0",
        method: "message/notification",
        params: {
          message: {
            role: "agent",
            parts: [
              { kind: "text", text: "完成报告：工程已准备好" },
              { kind: "data", data: { ready: true } },
              { kind: "file", uri: "/api/artifacts/art-1" },
            ],
            contextId: delivered.taskId,
            taskId: delivered.taskId,
            kind: "status-update",
            metadata: { lane: "agent", to: "cloud-brain" },
            status: { state: "completed", message: "完成报告：工程已准备好" },
          },
        },
      },
    }));
    await waitFor(() => cloud.frames.filter((frame) => frame.body?.params?.message?.status?.message?.includes("完成报告")).length === 1);
    const reported = cloud.frames.find((frame) => frame.body?.params?.message?.status?.message?.includes("完成报告"));
    assert.equal(reported.body.params.message.metadata.from, "pc-a");
    const reportedParts = reported.body.params.message.parts;
    assert.equal(reportedParts.some((part) => part.kind === "data" && part.data.ready === true), true);
    assert.equal(reportedParts.some((part) => part.kind === "file" && part.uri === "/api/artifacts/art-1"), true);
    assert.equal(pcA.ws.readyState, WebSocket.OPEN);

    cloud.ws.send(JSON.stringify({
      v: 1,
      kind: "ops",
      msgId: "e-notify-1",
      ts: new Date().toISOString(),
      body: { type: "notify.owner", text: "已联系到 2 台办公电脑，工程会准备好。" },
    }));
    await waitFor(() => noticed.length === 1);
    assert.match(noticed[0].text, /2 台办公电脑/);
    assert.equal(noticed[0].from, "cloud-brain");

    const legacy = await connect(port, "token-legacy-000000001");
    sockets.push(legacy.ws);
    legacy.ws.send(JSON.stringify(hello("legacy", {
      name: "legacy",
      description: "旧成员",
      version: "1.0.0",
      capabilities: { streaming: false, pushNotifications: true },
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      skills: [{ id: "old-target", name: "旧能力", description: "只能被点名", tags: ["novoard"] }],
    })));
    await waitFor(() => legacy.frames.some((frame) => frame.body?.type === "agent.hello.ack"));
    cloud.ws.send(JSON.stringify({
      v: 1,
      kind: "a2a",
      msgId: "e-ask-legacy",
      taskId: "task-brain-legacy",
      ts: new Date().toISOString(),
      body: {
        jsonrpc: "2.0",
        method: "message/send",
        params: {
          message: {
            role: "user",
            parts: [{ kind: "text", text: "你能准备工程吗？" }],
            metadata: { lane: "agent", to: "legacy" },
          },
        },
      },
    }));
    await waitFor(() => cloud.frames.some((frame) => frame.body?.params?.message?.status?.state === "rejected"));
    assert.equal(legacy.frames.some((frame) => frame.body?.method === "message/send"), false);
    assert.equal(legacy.ws.readyState, WebSocket.OPEN);
    assert.equal(cloud.ws.readyState, WebSocket.OPEN);
  } finally {
    for (const ws of sockets) ws.terminate();
    await new Promise((resolve) => hub.server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  }
});
