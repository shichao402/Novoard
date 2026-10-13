/**
 * lite-agent e2e（契约闭环，进程内联）：
 * 真 createHub + 真 createLiteAgent：hello 注册 → /api/trigger → 隧道委派 → runner 执行
 * （echo 桩 target）→ 终态上行 → hub 队列翻 completed → 审计两侧对账。
 * 不碰 .state/ 与 .agent-state/（全部 tmp 目录）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub } from "../src/main.mjs";
import { createLiteAgent } from "../src/lite-agent/main.mjs";

const AGENT_TOKEN = "agt_e2e_token_123456";
const CLIENT_KEY = "with-key-e2e-123";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "novoard-e2e-"));
}

function stubAgentDir(dir, script) {
  mkdirSync(join(dir, "templates"), { recursive: true });
  writeFileSync(
    join(dir, "targets.yaml"),
    [
      "targets:",
      "  echo-hello:",
      "    title: echo 测试",
      "    steps:",
      `      - script: ${script}`,
      "    expose: a2a",
      "    audit: summary",
      "    requiresApproval: false",
      "    notify: always",
      "",
    ].join("\n")
  );
}

async function bootHub(stateDir) {
  const hub = await createHub({ stateDir, port: 0 });
  hub.secrets.set({ agentTokens: [AGENT_TOKEN], dashboardToken: "dash-pass-123456", clientKeys: [CLIENT_KEY] });
  const port = hub.server.address().port;
  return { hub, port, close: () => new Promise((r) => hub.server.close(r)) };
}

function writeAgentConfig(dir, port) {
  const configPath = join(dir, "agent.json");
  writeFileSync(configPath, JSON.stringify({ agentId: "mac-work", hubUrl: `ws://127.0.0.1:${port}/tunnel`, agentToken: AGENT_TOKEN, contractVersion: "1.0" }));
  return configPath;
}

function readJsonl(file) {
  try {
    const raw = readFileSync(file, "utf8").trim();
    return raw ? raw.split("\n").map((l) => JSON.parse(l)) : [];
  } catch {
    return [];
  }
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

test("e2e：hello 注册 → trigger → 委派执行 → 终态上行 → 两侧审计", async () => {
  const hubDir = tmpDir();
  const agentDir = tmpDir();
  const agentState = tmpDir();
  stubAgentDir(agentDir, "echo hello-from-stub");
  const { hub, port, close } = await bootHub(hubDir);
  let agent = null;
  try {
    const configPath = writeAgentConfig(agentState, port);
    agent = await createLiteAgent({ configPath, agentDir, stateDir: join(agentState, "astate"), log: {} });
    await waitFor(() => agent.tunnel.registered, 3000); // hello.ack 异步到达（open 之后）
    assert.equal(hub.registry.resolve("echo-hello")?.agentId, "mac-work");

    const card = hub.registry.aggregateCard();
    assert.ok(card.skills.some((s) => s.id === "echo-hello"));

    const res = await fetch(`http://127.0.0.1:${port}/api/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "echo-hello" }),
    });
    assert.equal(res.status, 202);
    const { taskId } = await res.json();

    await waitFor(() => hub.queue.get(taskId)?.state === "completed", 5000);
    assert.equal(hub.queue.get(taskId).state, "completed");

    assert.ok(hub.audit.list().some((e) => e.taskId === taskId && e.outcome === "completed"));
    const agentAudit = readJsonl(join(agentState, "astate", "audit.jsonl"));
    assert.ok(agentAudit.some((e) => e.taskId === taskId && e.outcome === "completed"));
    assert.ok(agentAudit.some((e) => e.taskId === taskId && e.outcome === "working"));
  } finally {
    agent?.tunnel.close(); // 必须先关 agent 隧道，否则 hub.server.close() 死等 WS
    await close();
    rmSync(hubDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(agentState, { recursive: true, force: true });
  }
});

test("e2e：failed target 上行 failed 终态", async () => {
  const hubDir = tmpDir();
  const agentDir = tmpDir();
  const agentState = tmpDir();
  stubAgentDir(agentDir, "exit 3");
  const { hub, port, close } = await bootHub(hubDir);
  let agent = null;
  try {
    const configPath = writeAgentConfig(agentState, port);
    agent = await createLiteAgent({ configPath, agentDir, stateDir: join(agentState, "astate"), log: {} });
    await waitFor(() => agent.tunnel.registered, 3000);
    const res = await fetch(`http://127.0.0.1:${port}/api/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "echo-hello" }),
    });
    const { taskId } = await res.json();
    await waitFor(() => ["failed", "completed"].includes(hub.queue.get(taskId)?.state), 5000);
    assert.equal(hub.queue.get(taskId).state, "failed");
  } finally {
    agent?.tunnel.close();
    await close();
    rmSync(hubDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(agentState, { recursive: true, force: true });
  }
});

test("e2e：断线重连——close 后 start 重新注册", async () => {
  const hubDir = tmpDir();
  const agentDir = tmpDir();
  const agentState = tmpDir();
  stubAgentDir(agentDir, "echo ok");
  const { hub, port, close } = await bootHub(hubDir);
  let agent = null;
  try {
    const configPath = writeAgentConfig(agentState, port);
    agent = await createLiteAgent({ configPath, agentDir, stateDir: join(agentState, "astate"), log: {} });
    await waitFor(() => agent.tunnel.registered, 3000);
    agent.tunnel.close();
    await waitFor(() => hub.registry.resolve("echo-hello") === null, 3000); // 转离线
    await agent.tunnel.start();
    await waitFor(() => hub.registry.resolve("echo-hello") !== null, 3000); // 重新注册
  } finally {
    agent?.tunnel.close();
    await close();
    rmSync(hubDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(agentState, { recursive: true, force: true });
  }
});
