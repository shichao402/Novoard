/**
 * 契约类型派生测试（hub 侧，与 agent 侧同口径）。
 *
 * hub 是契约 SSOT 的持有方，生成器也在这里；因此这一侧必须自己验证一遍，
 * 不能只依赖 agent 侧的测试——否则「两侧生效」只是称号，一旦有人只改了这一侧的生成器，
 * 门禁与 agent 侧测试都不会报警，直到发布后才发现两侧生成物不一致。
 *
 * 覆盖：
 * - 生成物与 schema 一致（未重新生成时 CI 失败）
 * - 演进策略在类型上落地：帧类主类型严格 + Inbound 视角，信封与数据类完全封闭
 * - 生成器遇到未知关键字必须报错，不静默生成不完整类型
 * - 重复生成确定性（两仓逐字节等价的前提）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const GEN = join(ROOT, "scripts", "gen-contract-types.mjs");
const OUT = join(ROOT, "src", "contract", "generated", "contract-types.d.ts");

function runGen(args = [], cwd = ROOT) {
  return spawnSync(process.execPath, [join(cwd, "scripts", "gen-contract-types.mjs"), ...args], {
    cwd,
    encoding: "utf8",
  });
}

test("生成物与 schema 一致（--check 通过）", () => {
  assert.ok(existsSync(OUT), `生成物缺失：${OUT}`);
  const r = runGen(["--check"]);
  assert.equal(r.status, 0, `--check 应通过：stdout=${r.stdout}\nstderr=${r.stderr}`);
});

test("生成物标注为机器生成并禁止手工修改", () => {
  const text = readFileSync(OUT, "utf8");
  assert.match(text, /自动生成/, "文件头应标注自动生成");
  assert.match(text, /请勿手工修改/, "应明确禁止手工修改");
});

test("帧类 schema 主类型严格，另提供 Inbound 视角承载未知字段", () => {
  const text = readFileSync(OUT, "utf8");
  const hello = text.match(/export type FrameAgentHello = \{[\s\S]*?\n\};/);
  assert.ok(hello, "应生成 FrameAgentHello");
  // 主类型严格：构造帧时拼错字段必须报错，不能被索引签名吞掉
  assert.doesNotMatch(hello[0], /\[key: string\]: unknown;/, "主类型不应带索引签名，否则拼写错误无法被发现");
  // 入站视角放宽：接收对端帧时允许未知字段（契约 §0 字段演进策略）
  assert.match(text, /export type FrameAgentHelloInbound = FrameAgentHello & \{ readonly \[key: string\]: unknown \};/);
});

test("全部 7 张帧类 schema 都生成 Inbound 视角", () => {
  const text = readFileSync(OUT, "utf8");
  const openFrames = [
    "FrameAgentHello",
    "FrameAgentHelloAck",
    "FrameAgentHelloNack",
    "FrameAgentPing",
    "FrameTelemetry",
    "FrameCardUpdate",
    "FrameReject",
  ];
  for (const name of openFrames) {
    assert.match(
      text,
      new RegExp(`export type ${name}Inbound = ${name} & \\{ readonly \\[key: string\\]: unknown \\};`),
      `${name} 应生成 Inbound 视角`,
    );
  }
});

test("信封与数据 schema 表达为封闭结构（无索引签名）", () => {
  const text = readFileSync(OUT, "utf8");
  const envelope = text.match(/export type A2aEnvelope = \{[\s\S]*?\n\};/);
  assert.ok(envelope, "应生成 A2aEnvelope");
  assert.doesNotMatch(envelope[0], /\[key: string\]: unknown;/, "信封必须封闭");

  const card = text.match(/export type AgentCard = \{[\s\S]*?\n\};/);
  assert.ok(card, "应生成 AgentCard");
  // agent-card 顶层封闭：其索引签名只出现在 x-novoard-members 内部
  assert.doesNotMatch(card[0].split("\n").slice(0, 12).join("\n"), /\[key: string\]: unknown;/, "agent-card 顶层须封闭");
});

test("封闭 schema 不生成 Inbound 视角", () => {
  const text = readFileSync(OUT, "utf8");
  for (const name of ["A2aEnvelope", "AgentCard", "Task", "AuditEvent", "Target"]) {
    assert.doesNotMatch(text, new RegExp(`${name}Inbound`), `${name} 封闭，不应有 Inbound 视角`);
  }
});

test("信封必填字段与枚举被正确表达", () => {
  const text = readFileSync(OUT, "utf8");
  const envelope = text.match(/export type A2aEnvelope = \{[\s\S]*?\n\};/);
  assert.ok(envelope);
  assert.match(envelope[0], /"v": 1;/, "v 应为字面量 1");
  assert.match(envelope[0], /"kind": "ops" \| "a2a" \| "ack";/, "kind 应展开为枚举联合");
  assert.match(envelope[0], /"msgId": string;/, "msgId 必填");
  assert.doesNotMatch(envelope[0], /"msgId"\?:/, "msgId 不应为可选");
});

test("重复生成结果确定（两仓逐字节等价的前提）", () => {
  const first = readFileSync(OUT, "utf8");
  const r = runGen();
  assert.equal(r.status, 0, r.stderr);
  const second = readFileSync(OUT, "utf8");
  assert.equal(first, second, "重复生成必须产生相同内容");
});

test("schema 变更后未重新生成则 --check 失败", () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-hub-gen-"));
  try {
    const schemaDir = join(dir, "docs", "architecture", "schemas");
    mkdirSync(schemaDir, { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    cpSync(GEN, join(dir, "scripts", "gen-contract-types.mjs"));
    writeFileSync(
      join(schemaDir, "frame-a.json"),
      JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", $id: "novoard/frame-a.json", type: "object", properties: { type: { const: "a" } } }),
      "utf8",
    );

    assert.equal(runGen([], dir).status, 0, "首次生成应成功");
    writeFileSync(
      join(schemaDir, "frame-a.json"),
      JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", $id: "novoard/frame-a.json", type: "object", properties: { type: { const: "a" }, extra: { type: "string" } } }),
      "utf8",
    );
    const r = runGen(["--check"], dir);
    assert.notEqual(r.status, 0, "schema 变更后 --check 应失败");
    assert.match(r.stderr, /不一致/, `应提示生成物不一致：${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("生成器遇到无法映射的关键字时明确报错并指出关键字与文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-hub-gen-bad-"));
  try {
    const schemaDir = join(dir, "docs", "architecture", "schemas");
    mkdirSync(schemaDir, { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    cpSync(GEN, join(dir, "scripts", "gen-contract-types.mjs"));
    writeFileSync(
      join(schemaDir, "frame-bad.json"),
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "novoard/frame-bad.json",
        type: "object",
        unevaluatedProperties: false,
      }),
      "utf8",
    );

    const r = runGen([], dir);
    assert.notEqual(r.status, 0, "应失败");
    assert.match(r.stderr, /unevaluatedProperties/, `应指出关键字：${r.stderr}`);
    assert.match(r.stderr, /frame-bad\.json/, `应指出文件：${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("生成器对 $ref 生成对应类型引用而非 unknown", () => {
  const text = readFileSync(OUT, "utf8");
  const hello = text.match(/export type FrameAgentHello = \{[\s\S]*?\n\};/);
  assert.ok(hello);
  assert.match(hello[0], /"card": AgentCard;/, "card 应引用 AgentCard 类型");
  assert.doesNotMatch(hello[0], /"card": unknown;/, "不应退化为 unknown");
});

test("每个 schema 文件都产出一个类型（新增 schema 不会漏生成）", () => {
  const text = readFileSync(OUT, "utf8");
  const schemaDir = join(ROOT, "docs", "architecture", "schemas");
  // 用生成器同口径的目录发现，避免这里再维护一份硬编码清单
  const names = readdirSync(schemaDir).filter((f) => f.endsWith(".json"));
  assert.ok(names.length >= 12, `schema 数量应不少于 12，实际 ${names.length}`);
  const produced = [...text.matchAll(/^export type (\w+) = /gm)].map((m) => m[1]);
  assert.ok(produced.length >= names.length, `类型数量应不少于 schema 数量（${produced.length} vs ${names.length}）`);
});
