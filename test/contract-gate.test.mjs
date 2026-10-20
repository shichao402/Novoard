/**
 * 契约门禁行为测试（需求 6）：
 * 门禁必须能发现「手工清单漏项」这类问题——新增 / 删除 / 重命名 schema 都应失败并指出文件名，
 * 而不是因清单未更新而静默通过。
 *
 * 做法：在临时目录复制一份最小 SSOT 结构（schemas + 校验器 + 契约文档），
 * 用真实门禁脚本对这份副本执行，断言退出码与输出。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const GATE = join(ROOT, "scripts", "check-contract-copy.mjs");

/** 造一份最小可运行的 SSOT 副本：docs/schemas + contracts.md + src/frames.mjs + 版本模块。 */
function makeCopy() {
  const dir = mkdtempSync(join(tmpdir(), "novoard-gate-"));
  mkdirSync(join(dir, "docs", "architecture"), { recursive: true });
  mkdirSync(join(dir, "src", "contract"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });

  cpSync(join(ROOT, "docs", "architecture", "schemas"), join(dir, "docs", "architecture", "schemas"), { recursive: true });
  cpSync(join(ROOT, "docs", "architecture", "contracts.md"), join(dir, "docs", "architecture", "contracts.md"));
  cpSync(join(ROOT, "src", "frames.mjs"), join(dir, "src", "frames.mjs"));
  cpSync(join(ROOT, "src", "contract", "version.mjs"), join(dir, "src", "contract", "version.mjs"));
  cpSync(GATE, join(dir, "scripts", "check-contract-copy.mjs"));
  // 依赖复用：门禁会动态 import 校验器，校验器需要 ajv，软链到原仓库 node_modules
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  // package.json 的 type=module 语义
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  return dir;
}

function runGate(dir) {
  return spawnSync(process.execPath, [join(dir, "scripts", "check-contract-copy.mjs")], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, NOVOARD_AGENT_ROOT: "" },
  });
}

test("门禁：基线副本通过", () => {
  const dir = makeCopy();
  try {
    const r = runGate(dir);
    assert.equal(r.status, 0, `基线应通过：stdout=${r.stdout}\nstderr=${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("门禁：新增 schema 文件被目录发现并纳入注册，不需要改任何清单", () => {
  const dir = makeCopy();
  try {
    const newSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "novoard/frame-new.json",
      title: "新增帧",
      type: "object",
      required: ["type"],
      properties: { type: { const: "new.frame" } },
      additionalProperties: true,
    };
    writeFileSync(join(dir, "docs", "architecture", "schemas", "frame-new.json"), JSON.stringify(newSchema, null, 2), "utf8");

    const r = runGate(dir);
    assert.equal(r.status, 0, `新增 schema 应自动纳入：stdout=${r.stdout}\nstderr=${r.stderr}`);
    // 输出里的数量应随目录增长，证明不是读固定清单
    assert.match(r.stdout, /schemas 目录发现/, `输出应体现目录发现：${r.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("门禁：schema $id 与文件名不一致时失败并指出文件名", () => {
  const dir = makeCopy();
  try {
    const file = join(dir, "docs", "architecture", "schemas", "frame-agent-ping.json");
    const schema = JSON.parse(readFileSync(file, "utf8"));
    schema.$id = "novoard/wrong-name.json";
    writeFileSync(file, JSON.stringify(schema, null, 2), "utf8");

    const r = runGate(dir);
    assert.notEqual(r.status, 0, "应失败");
    assert.match(r.stderr, /frame-agent-ping\.json/, `应指出文件名：${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("门禁：schema 非法 JSON 时失败并指出文件名", () => {
  const dir = makeCopy();
  try {
    writeFileSync(join(dir, "docs", "architecture", "schemas", "frame-broken.json"), "{ not json", "utf8");
    const r = runGate(dir);
    assert.notEqual(r.status, 0, "应失败");
    assert.match(r.stderr, /frame-broken\.json/, `应指出文件名：${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("门禁：契约文档版本与常量不一致时失败", () => {
  const dir = makeCopy();
  try {
    const doc = join(dir, "docs", "architecture", "contracts.md");
    const text = readFileSync(doc, "utf8").replace(/版本：v\d+\.\d+/, "版本：v9.9");
    writeFileSync(doc, text, "utf8");

    const r = runGate(dir);
    assert.notEqual(r.status, 0, "应失败");
    assert.match(r.stderr, /版本/, `应指出版本不一致：${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("门禁：契约文档示例与 schema 冲突时失败并指出行号", () => {
  const dir = makeCopy();
  try {
    const doc = join(dir, "docs", "architecture", "contracts.md");
    // 把合法的 ping 示例改成缺必填 ts 的形态：schema 会拒它
    const text = readFileSync(doc, "utf8").replace(
      '{ "type": "agent.ping", "ts": "2026-10-12T08:00:30Z" }',
      '{ "type": "agent.ping", "agentId": 42 }',
    );
    writeFileSync(doc, text, "utf8");

    const r = runGate(dir);
    assert.notEqual(r.status, 0, "示例不合法时门禁应失败，否则文档可以随便写");
    assert.match(r.stderr, /示例与 schema 冲突/, `应指出示例冲突：${r.stderr}`);
    assert.match(r.stderr, /ops:agent\.ping/, `应指出是哪条示例：${r.stderr}`);
    assert.match(r.stderr, /第 \d+ 行/, `应给出可定位的行号：${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("门禁：文档示例全部去掉标记时失败（失去校验等于没有示例）", () => {
  const dir = makeCopy();
  try {
    const doc = join(dir, "docs", "architecture", "contracts.md");
    const text = readFileSync(doc, "utf8").replace(/<!--\s*contract-example:[\s\S]*?-->\n/g, "");
    writeFileSync(doc, text, "utf8");

    const r = runGate(dir);
    assert.notEqual(r.status, 0, "示例失去标记后不应静默通过");
    assert.match(r.stderr, /contract-example/, `应提示缺少标记：${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("门禁：示例 target 无法识别时失败，不静默放过", () => {
  const dir = makeCopy();
  try {
    const doc = join(dir, "docs", "architecture", "contracts.md");
    // 改一个标记为不存在的 target：拼错 target 名字不能被当成「这条不用校验」
    const text = readFileSync(doc, "utf8").replace("contract-example: ops:agent.ping", "contract-example: ops:agent-pin");
    writeFileSync(doc, text, "utf8");

    const r = runGate(dir);
    assert.notEqual(r.status, 0, "无法识别的 target 应失败");
    assert.match(r.stderr, /目标无法识别/, `应提示 target 无法识别：${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("门禁：agent 侧缺 schema 时跨仓比对失败并指出文件名与未同步的一侧", () => {
  const dir = makeCopy();
  const agentDir = mkdtempSync(join(tmpdir(), "novoard-gate-agent-"));
  try {
    mkdirSync(join(agentDir, "src", "contract", "schemas"), { recursive: true });
    // agent 侧只同步部分 schema，模拟漏拷
    const hubSchemas = join(dir, "docs", "architecture", "schemas");
    cpSync(join(hubSchemas, "a2a-envelope.json"), join(agentDir, "src", "contract", "schemas", "a2a-envelope.json"));
    cpSync(join(dir, "src", "frames.mjs"), join(agentDir, "src", "contract", "frames.mjs"));

    const r = spawnSync(process.execPath, [join(dir, "scripts", "check-contract-copy.mjs")], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NOVOARD_AGENT_ROOT: agentDir },
    });

    assert.notEqual(r.status, 0, "应失败");
    assert.match(r.stderr, /agent 侧缺少 schema/, `应指出未同步的一侧：${r.stderr}`);
    assert.match(r.stderr, /frame-agent-hello\.json/, `应指出文件名：${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("门禁：agent 侧存在多余 schema 时失败（Hub 已删除或重命名）", () => {
  const dir = makeCopy();
  const agentDir = mkdtempSync(join(tmpdir(), "novoard-gate-agent-extra-"));
  try {
    const hubSchemas = join(dir, "docs", "architecture", "schemas");
    cpSync(hubSchemas, join(agentDir, "src", "contract", "schemas"), { recursive: true });
    cpSync(join(dir, "src", "frames.mjs"), join(agentDir, "src", "contract", "frames.mjs"));
    const orphan = { $schema: "https://json-schema.org/draft/2020-12/schema", $id: "novoard/frame-orphan.json", type: "object" };
    writeFileSync(join(agentDir, "src", "contract", "schemas", "frame-orphan.json"), JSON.stringify(orphan), "utf8");

    const r = spawnSync(process.execPath, [join(dir, "scripts", "check-contract-copy.mjs")], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NOVOARD_AGENT_ROOT: agentDir },
    });

    assert.notEqual(r.status, 0, "应失败");
    assert.match(r.stderr, /多余 schema/, `应指出多余文件：${r.stderr}`);
    assert.match(r.stderr, /frame-orphan\.json/, `应指出文件名：${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("门禁：校验器语义漂移时跨仓比对失败", () => {
  const dir = makeCopy();
  const agentDir = mkdtempSync(join(tmpdir(), "novoard-gate-agent-drift-"));
  try {
    const hubSchemas = join(dir, "docs", "architecture", "schemas");
    cpSync(hubSchemas, join(agentDir, "src", "contract", "schemas"), { recursive: true });
    // 篡改 agent 侧校验器：故意改掉一个语义细节
    const frames = readFileSync(join(dir, "src", "frames.mjs"), "utf8").replace(
      "allErrors: true",
      "allErrors: false",
    );
    writeFileSync(join(agentDir, "src", "contract", "frames.mjs"), frames, "utf8");

    const r = spawnSync(process.execPath, [join(dir, "scripts", "check-contract-copy.mjs")], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NOVOARD_AGENT_ROOT: agentDir },
    });

    assert.notEqual(r.status, 0, "应失败");
    assert.match(r.stderr, /frames\.mjs 语义漂移/, `应指出语义漂移：${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});
