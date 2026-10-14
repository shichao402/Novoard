/**
 * 契约锁定拷贝一致性门禁（F1）：
 * SSOT（docs/architecture/schemas/*.json + src/frames.mjs 的校验逻辑）与
 * agent 侧内建拷贝（src/lite-agent/contract/）必须逐字节一致。
 * SSOT 变更后未同步拷贝 → 本脚本退出码 1（CI 红），杜绝静默漂移。
 * 同步方式：cp docs/architecture/schemas/*.json src/lite-agent/contract/schemas/
 *           cp src/frames.mjs src/lite-agent/contract/frames.mjs 后再改 SCHEMA_DIR 锚点两行。
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SSOT_SCHEMA_DIR = join(ROOT, "docs", "architecture", "schemas");
const SSOT_FRAMES = join(ROOT, "src", "frames.mjs");
const COPY_DIR = join(ROOT, "src", "lite-agent", "contract");
const COPY_FRAMES = join(COPY_DIR, "frames.mjs");
const COPY_SCHEMA_DIR = join(COPY_DIR, "schemas");

const SCHEMA_FILES = ["a2a-envelope.json", "frame-agent-hello.json", "frame-agent-ping.json", "frame-telemetry.json", "frame-card-update.json", "agent-card.json", "task.json", "audit-event.json", "target.json"];

let fail = 0;

for (const file of SCHEMA_FILES) {
  const src = join(SSOT_SCHEMA_DIR, file);
  const dst = join(COPY_SCHEMA_DIR, file);
  if (!existsSync(src) || !existsSync(dst)) {
    console.error(`✗ 契约文件缺失：${file}（SSOT: ${existsSync(src)} / 拷贝: ${existsSync(dst)}）`);
    fail++;
    continue;
  }
  if (readFileSync(src, "utf8") !== readFileSync(dst, "utf8")) {
    console.error(`✗ schema 漂移：${file} —— SSOT 与 contract/schemas/ 不一致`);
    fail++;
  }
}

// frames.mjs 校验逻辑等价性：比较实质性代码段（export 函数 + schema 常量表），
// 头注释与 SCHEMA_DIR 锚定差异是拷贝纪律允许的（锚定必须指向 contract/schemas/）
if (!existsSync(SSOT_FRAMES) || !existsSync(COPY_FRAMES)) {
  console.error("✗ frames.mjs 缺失（SSOT 或拷贝）");
  fail++;
} else {
  const src = readFileSync(SSOT_FRAMES, "utf8");
  const dst = readFileSync(COPY_FRAMES, "utf8");
  const seg = (s) => s.match(/^(export function[\s\S]*)$/m)?.[1] ?? "";
  const table = (s) => s.match(/^const SCHEMA_FILES[\s\S]*?\n};/m)?.[0] ?? "";
  if (!seg(src) || !seg(dst) || !table(src) || !table(dst)) {
    console.error("✗ frames.mjs 结构异常：无法提取校验函数段或 schema 常量表");
    fail++;
  } else if (seg(src) !== seg(dst) || table(src) !== table(dst)) {
    console.error("✗ frames.mjs 漂移：SSOT 校验逻辑（export 函数 + schema 表）与 contract/frames.mjs 不一致");
    fail++;
  }
}

if (fail > 0) {
  console.error(`\n契约拷贝门禁失败（${fail} 处漂移）。SSOT 是 docs/architecture/schemas/ + src/frames.mjs；`);
  console.error("同步方法：cp 后按 contract/frames.mjs 头注释改锚定，再重新提交。");
  process.exit(1);
}
console.log(`✓ 契约锁定拷贝一致（${SCHEMA_FILES.length} schemas + frames 校验逻辑）`);
