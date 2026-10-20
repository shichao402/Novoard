/**
 * 契约自检（hub 仓版 / SSOT 持有方）：
 * 本仓 docs/architecture/schemas/ 是契约 SSOT，src/frames.mjs 是实现侧校验器。
 * 本门禁做 SSOT 自检：
 *   1. schema 集合按目录动态发现（不维护手工清单，新增文件自动纳入）
 *   2. 每个 schema 是合法 JSON 且 $id 与文件名一致
 *   3. 校验器行为样例（合法帧过、非法帧拒、帧层开放、信封层封闭）
 *   4. 跨仓一致性判定入口：设置 NOVOARD_AGENT_ROOT 时，比对 agent 侧锁定拷贝
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 契约版本从单一来源取（需求 4）：本文件不再自行声明字面量。
export { CONTRACT_VERSION } from "../src/contract/version.mjs";
import { CONTRACT_VERSION } from "../src/contract/version.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = join(ROOT, "docs", "architecture", "schemas");
const CONTRACTS_DOC = join(ROOT, "docs", "architecture", "contracts.md");
const FRAMES = join(ROOT, "src", "frames.mjs");

/**
 * 契约版本来源见 ../src/contract/version.mjs（单一来源）。
 * 本文件通过上面的 import 取用，不再维护自己的字面量。
 */

const AGENT_ROOT = process.env.NOVOARD_AGENT_ROOT ? resolve(ROOT, process.env.NOVOARD_AGENT_ROOT) : "";

let fail = 0;

/** 目录动态发现：新增 / 重命名 / 删除 schema 都会反映到这里。 */
const schemaFiles = readdirSync(SCHEMA_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

if (schemaFiles.length === 0) {
  console.error(`✗ 契约 schema 目录为空：${SCHEMA_DIR}`);
  fail++;
}

// 1. 每个 schema 合法且 $id 与文件名一致
const ids = new Map();
for (const file of schemaFiles) {
  let schema;
  try {
    schema = JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8"));
  } catch (err) {
    console.error(`✗ schema 非法 JSON：${file}（${err.message}）`);
    fail++;
    continue;
  }
  const expected = `novoard/${file}`;
  if (schema.$id !== expected) {
    console.error(`✗ schema $id 与文件名不一致：${file} 期望 ${expected}，实际 ${schema.$id}`);
    fail++;
  }
  ids.set(file, schema.$id);
}

// 2. 契约文档版本号与 SSOT 常量一致
if (!existsSync(CONTRACTS_DOC)) {
  console.error("✗ 契约文档缺失：docs/architecture/contracts.md");
  fail++;
} else if (!readFileSync(CONTRACTS_DOC, "utf8").includes(`版本：v${CONTRACT_VERSION}`)) {
  console.error(`✗ 契约文档版本与 SSOT 常量 ${CONTRACT_VERSION} 不一致`);
  fail++;
}

if (!existsSync(FRAMES)) {
  console.error("✗ 校验器缺失：src/frames.mjs");
  fail++;
}

// 2.1 文档示例必须能被 schema 接受（需求 10：文档示例与 schema 冲突时由 CI 检出）
// 只校验带显式标记的示例：文档里还有请求/响应等非契约结构，不能被误当成帧
const markedExamples = existsSync(CONTRACTS_DOC) ? collectContractExamples(readFileSync(CONTRACTS_DOC, "utf8")) : [];
if (markedExamples.length === 0) {
  console.error("✗ 契约文档没有任何带 contract-example 标记的示例：示例失去校验就等于没有示例");
  fail++;
}

// 3. 跨仓一致性判定入口（需求 6）：可选，未设置时只做 SSOT 自检
if (AGENT_ROOT) {
  const agentSchemaDir = join(AGENT_ROOT, "src", "contract", "schemas");
  const agentFrames = join(AGENT_ROOT, "src", "contract", "frames.mjs");

  if (!existsSync(agentSchemaDir)) {
    console.error(`✗ agent 侧契约目录不可达：${agentSchemaDir}`);
    fail++;
  } else {
    const agentFiles = readdirSync(agentSchemaDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    // 双向差集：任一侧独有的文件都算未同步
    for (const file of schemaFiles) {
      if (!agentFiles.includes(file)) {
        console.error(`✗ agent 侧缺少 schema：${file}（hub 已新增，agent 未同步）`);
        fail++;
      }
    }
    for (const file of agentFiles) {
      if (!schemaFiles.includes(file)) {
        console.error(`✗ agent 侧存在多余 schema：${file}（hub 已删除或重命名，agent 未同步）`);
        fail++;
      }
    }
    for (const file of schemaFiles) {
      if (!agentFiles.includes(file)) continue;
      const hubText = readFileSync(join(SCHEMA_DIR, file), "utf8");
      const agentText = readFileSync(join(agentSchemaDir, file), "utf8");
      if (hubText !== agentText) {
        console.error(`✗ 契约 schema 漂移：${file}（hub 与 agent 不一致，需同步 agent 侧拷贝）`);
        fail++;
      }
    }
  }

  if (!existsSync(agentFrames)) {
    console.error(`✗ agent 侧校验器缺失：${agentFrames}`);
    fail++;
  } else {
    const hubNorm = normalizeFrames(readFileSync(FRAMES, "utf8"));
    const agentNorm = normalizeFrames(readFileSync(agentFrames, "utf8"));
    if (hubNorm !== agentNorm) {
      console.error("✗ frames.mjs 语义漂移：agent 侧校验器与 hub SSOT 不一致");
      fail++;
    }
  }
}

// 4. 行为样例：加载校验器做正反向自检
if (fail === 0) {
  const { createFrameValidator } = await import(pathToFileURL(FRAMES).href);
  const validate = createFrameValidator();
  const now = new Date().toISOString();

  // 目录发现完整性：磁盘上每个 schema 都应已注册
  const registered = new Set(validate.schemaIds());
  for (const file of schemaFiles) {
    if (!registered.has(`novoard/${file}`)) {
      console.error(`✗ schema 未被注册：${file}（校验器未纳入该文件）`);
      fail++;
    }
  }

  const good = { v: 1, kind: "ops", msgId: "e-gate-1", ts: now, body: { type: "agent.ping", ts: now } };
  const badBody = { v: 1, kind: "ops", msgId: "e-gate-2", ts: now, body: { type: "agent.ping", agentId: "" } };
  const badEnvelope = { v: 1, kind: "ops", msgId: "e-gate-3", body: { type: "agent.ping", ts: now } };
  const hello = {
    type: "agent.hello",
    contractVersion: "2.1",
    agentId: "gate-agent",
    card: {
      name: "gate",
      description: "gate",
      version: "2.0.0",
      capabilities: { streaming: false, pushNotifications: true },
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      skills: [],
    },
  };

  if (!validate.envelope(good).ok || !validate.opsBody("agent.ping", good.body).ok) {
    console.error("✗ 合法样例帧被拒：校验器行为异常");
    fail++;
  }
  if (validate.opsBody("agent.ping", badBody.body).ok || validate.envelope(badEnvelope).ok) {
    console.error("✗ 非法样例帧被放行：校验器行为异常");
    fail++;
  }

  // 契约 §0 字段演进策略：帧 body 层未知字段被忽略，信封层未知字段仍被拒
  if (!validate.opsBody("agent.hello", hello).ok) {
    console.error("✗ 合法 hello 帧被拒：校验器行为异常");
    fail++;
  }
  if (!validate.opsBody("agent.hello", { ...hello, "x-future-field": "v" }).ok) {
    console.error("✗ 帧层未知字段被拒：与契约 §0 开放演进策略不一致");
    fail++;
  }
  if (validate.envelope({ ...good, "x-future-field": "v" }).ok) {
    console.error("✗ 信封层未知字段被放行：信封应保持封闭");
    fail++;
  }

  // 文档示例逐个过 schema：文档与 schema 冲突时，坏的是其中一边，必须当次就发现
  for (const example of markedExamples) {
    const result = runExample(validate, example);
    if (!result) {
      console.error(
        `✗ 契约文档示例与 schema 冲突：第 ${example.line} 行（${example.target}）——` +
          (result === false ? "示例不合法" : "目标无法识别"),
      );
      fail++;
    }
  }
}

/** 从契约文档收集带 `<!-- contract-example: <target> -->` 标记的 json 代码块。 */
function collectContractExamples(text) {
  const lines = text.split("\n");
  const examples = [];
  let pendingTarget = "";
  let inBlock = false;
  let lang = "";
  let buf = [];
  let startLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inBlock) {
      const marker = line.match(/<!--\s*contract-example:\s*([\w.:-]+)\s*-->/);
      if (marker) pendingTarget = marker[1];
      if (line.startsWith("```")) {
        inBlock = true;
        lang = line.slice(3).trim();
        buf = [];
        startLine = i + 1;
      }
      continue;
    }
    if (line.startsWith("```")) {
      inBlock = false;
      if (pendingTarget && lang === "json") {
        examples.push({ target: pendingTarget, line: startLine, raw: buf.join("\n") });
      }
      pendingTarget = "";
      continue;
    }
    buf.push(line);
  }
  return examples;
}

/** 按 target 跑一条文档示例；返回 true 通过、false 不合法、null 表示 target 无法识别。 */
function runExample(validate, example) {
  let frame;
  try {
    frame = JSON.parse(example.raw);
  } catch {
    return false;
  }
  const { target } = example;
  if (target.startsWith("ops:")) {
    const type = target.slice("ops:".length);
    // 拼错帧类型不能静默放过：校验器对未知类型会明确报 unknown ops type，据此判定
    const probe = validate.opsBody(type, { type });
    if (probe.errors?.some((e) => e.startsWith("unknown ops type"))) return null;
    return validate.opsBody(type, frame).ok;
  }
  if (target === "envelope") return validate.envelope(frame).ok;
  if (target === "agentCard") return validate.agentCard(frame).ok;
  if (target === "task") return validate.task(frame).ok;
  if (target === "auditEvent") return validate.auditEvent(frame).ok;
  if (target === "targets") return validate.targets(frame).ok;
  return null;
}

if (fail > 0) {
  console.error(`\n契约门禁失败（${fail} 处）。契约 SSOT 在本仓 docs/architecture/；同步方法见 agent 仓 scripts/check-contract-copy.mjs。`);
  process.exit(1);
}
console.log(
  `✓ 契约 SSOT 自检通过（${schemaFiles.length} schemas 目录发现 + 校验器行为样例${AGENT_ROOT ? " + agent 侧一致性" : ""}），契约版本 ${CONTRACT_VERSION}`,
);

/** 归一化校验器源码：去注释、抹平两侧路径锚定差异，仅比对语义。 */
function normalizeFrames(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/return join\(here,[^;]*;\s*\}/g, 'return "<schema-dir>"; }')
    .replace(/return join\(process\.cwd\(\),[^;]*;\s*\}/g, 'return "<schema-dir>"; }')
    .replace(/\s+/g, " ")
    .trim();
}
