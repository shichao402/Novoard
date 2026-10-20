/**
 * 双连接实证脚本（不属于测试套件，手动运行）：
 * 起一个真实 hub，模拟两个同 token 的 agent 连接，打印每一步的实际状态。
 * 用法：node scripts/verify-instance-conflict.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";

import { createHub } from "../src/main.mjs";
import { configureTestAgentTokens } from "../test/test-auth.mjs";

const BOOT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOOT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN = "verify-token-123456";

const card = {
  name: "verify-agent",
  description: "verify-agent",
  version: "2.0.0",
  capabilities: { streaming: false, pushNotifications: true },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  skills: [{ id: "verify-skill", name: "verify-skill", description: "verify-skill", tags: [] }],
};

const hello = (bootId) => ({
  v: 1, kind: "ops", msgId: `e-hello-${bootId}`, ts: new Date().toISOString(),
  body: { type: "agent.hello", contractVersion: "2.1", agentId: "verify-agent", card, inFlightTaskIds: [], bootId },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stateDir = mkdtempSync(join(tmpdir(), "novoard-verify-"));
const hub = await createHub({ stateDir, port: 0, log: { info() {}, error() {} } });
configureTestAgentTokens(hub, { "verify-agent": TOKEN });
const port = hub.server.address().port;

async function open(label) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const frames = [];
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw))));
  await once(ws, "open");
  console.log(`  ${label} 已连接`);
  return { ws, frames };
}

const online = () => hub.registry.status().find((m) => m.agentId === "verify-agent")?.online === true;

try {
  console.log("\n[1] A 连接并 hello");
  const a = await open("A");
  a.ws.send(JSON.stringify(hello(BOOT_A)));
  await sleep(200);
  console.log(`  A 收到：${a.frames.map((f) => f.body?.type ?? f.kind).join(", ")}`);
  console.log(`  成员在线：${online()}`);

  console.log("\n[2] B 用同 token 连接并 hello");
  const b = await open("B");
  b.ws.send(JSON.stringify(hello(BOOT_B)));
  await sleep(300);
  const nack = b.frames.find((f) => f.body?.type === "agent.hello.nack");
  console.log(`  B 收到：${b.frames.map((f) => f.body?.type ?? f.kind).join(", ") || "（无）"}`);
  console.log(`  B 的 nack：${nack ? JSON.stringify(nack.body) : "无"}`);
  console.log(`  成员仍在线：${online()}`);

  console.log("\n[3] B 关闭连接（agent 侧退避重连的行为）");
  b.ws.close();
  await once(b.ws, "close");
  await sleep(200);
  console.log(`  成员仍在线：${online()}`);

  console.log("\n[4] 任务下发：应只发给 A");
  const task = hub.queue.submit({ skillId: "verify-skill", target: "verify-skill", member: "verify-agent", actor: "verify", lane: "a2a" });
  await hub.delegate({ task, vars: {} });
  await sleep(300);
  const aGot = a.frames.some((f) => f.kind === "a2a" && f.taskId === task.id);
  console.log(`  A 收到任务 ${task.id}：${aGot}`);

  console.log("\n[5] A 退出 → 成员离线");
  a.ws.close();
  await once(a.ws, "close");
  await sleep(200);
  console.log(`  成员在线：${online()}`);

  console.log("\n[6] B 重连（模拟退避后重试）→ 应接管成功");
  const b2 = await open("B'");
  b2.ws.send(JSON.stringify({ ...hello(BOOT_B), msgId: "e-hello-b-retry" }));
  await sleep(300);
  console.log(`  B' 收到：${b2.frames.map((f) => f.body?.type ?? f.kind).join(", ")}`);
  console.log(`  成员在线：${online()}`);
  const task2 = hub.queue.submit({ skillId: "verify-skill", target: "verify-skill", member: "verify-agent", actor: "verify", lane: "a2a" });
  await hub.delegate({ task: task2, vars: {} });
  await sleep(300);
  console.log(`  B' 收到任务：${b2.frames.some((f) => f.kind === "a2a" && f.taskId === task2.id)}`);
  b2.ws.close();
} finally {
  await new Promise((resolve) => hub.server.close(resolve));
  rmSync(stateDir, { recursive: true, force: true });
  console.log("\n完成。\n");
}
