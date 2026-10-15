/**
 * 契约 SSOT 自检门禁（M7 拆仓后形态）：
 * agent 已拆分至 novoard-agent 仓，锁定拷贝（src/contract/）随仓迁移；
 * 本仓作为 SSOT 持有方，门禁职责收敛为：
 * 1. 九张 schema 全集存在且为合法 JSON（draft 2020-12）
 * 2. SSOT frames.mjs 可装载、校验器可构造
 * 3. 帧校验行为样例（good/bad）通过——契约语义回归红线
 * 跨仓漂移防线在 novoard-agent 仓的 scripts/check-contract-copy.mjs（CONTRACT_VERSION 锁定 + 行为样例）。
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SSOT_SCHEMA_DIR = join(ROOT, "docs", "architecture", "schemas");
const SSOT_FRAMES = join(ROOT, "src", "frames.mjs");

const SCHEMA_FILES = ["a2a-envelope.json", "frame-agent-hello.json", "frame-agent-ping.json", "frame-telemetry.json", "frame-card-update.json", "agent-card.json", "task.json", "audit-event.json", "target.json"];

let fail = 0;

// 1. schema 全集存在 + 合法 JSON
for (const file of SCHEMA_FILES) {
  const src = join(SSOT_SCHEMA_DIR, file);
  if (!existsSync(src)) {
    console.error(`✗ schema 缺失：${file}`);
    fail++;
    continue;
  }
  try {
    const parsed = JSON.parse(readFileSync(src, "utf8"));
    if (parsed.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      console.error(`✗ schema ${file} 非 draft 2020-12`);
      fail++;
    }
  } catch (error) {
    console.error(`✗ schema ${file} JSON 解析失败：${error.message}`);
    fail++;
  }
}

// 2. frames.mjs 装载 + 校验器构造 + 行为样例
if (!existsSync(SSOT_FRAMES)) {
  console.error("✗ SSOT frames.mjs 缺失");
  fail++;
} else {
  try {
    const { createFrameValidator } = await import(SSOT_FRAMES);
    const v = createFrameValidator();

    // good：合法 ops 信封帧（hello）
    const goodHello = {
      v: 1, kind: "ops", msgId: "e-gate-hello-1", ts: new Date().toISOString(),
      body: { type: "agent.hello", contractVersion: "1.1", agentId: "gate-probe", token: "t".repeat(32), card: { name: "n", description: "d", version: "1.0.0", capabilities: { streaming: false, pushNotifications: true }, defaultInputModes: ["text"], defaultOutputModes: ["text"], skills: [] }, inFlightTaskIds: [] },
    };
    if (v.envelope(goodHello).ok !== true) {
      console.error(`✗ 行为样例失败：合法 hello 帧被拒（${v.envelope(goodHello).errors?.join("; ")}）`);
      fail++;
    }

    // bad：缺 ts 的信封
    const badEnv = { v: 1, kind: "ops", msgId: "e-gate-bad-1", body: { type: "agent.ping" } };
    if (v.envelope(badEnv).ok !== false) {
      console.error("✗ 行为样例失败：缺 ts 的非法信封未拒");
      fail++;
    }

    // good：合法 target 集合
    const goodTargets = { targets: { t: { title: "x", steps: [{ script: "echo ok" }], expose: "a2a", audit: "summary", requiresApproval: false, notify: "on-failure" } } };
    if (v.targets(goodTargets).ok !== true) {
      console.error(`✗ 行为样例失败：合法 targets 被拒（${v.targets(goodTargets).errors?.join("; ")}）`);
      fail++;
    }
  } catch (error) {
    console.error(`✗ frames.mjs 装载或校验失败：${error.message}`);
    fail++;
  }
}

if (fail > 0) {
  console.error(`\n契约 SSOT 自检失败（${fail} 处）。跨仓漂移防线见 novoard-agent 仓 scripts/check-contract-copy.mjs。`);
  process.exit(1);
}
console.log(`✓ 契约 SSOT 自检通过（${SCHEMA_FILES.length} schemas + frames 行为样例）`);
