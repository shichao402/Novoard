/**
 * 契约一致性夹具测试（hub 侧，需求 5）。
 *
 * 本仓是夹具持有方：conformance/frames.json + conformance/run-fixture.mjs。
 * 本测试用本仓校验器实现跑一遍夹具，确保 SSOT 实现自身符合预期结论。
 * agent 侧以只读方式加载同一份夹具，两侧结论必须一致。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { createFrameValidator } from "../src/frames.mjs";
import { assertFixture, loadFixture } from "../conformance/run-fixture.mjs";
import { CONTRACT_VERSION } from "../src/contract/version.mjs";

const FIXTURE_PATH = join(process.cwd(), "conformance", "frames.json");

test("共享夹具：hub 校验器对每个样本的结论与预期一致", () => {
  const fixture = loadFixture(FIXTURE_PATH);
  const validate = createFrameValidator();
  const { results, failed } = assertFixture({ validate, fixture, expectedVersion: CONTRACT_VERSION });

  assert.ok(results.length >= 30, `夹具用例数量异常：${results.length}`);
  assert.deepEqual(
    failed.map((f) => ({ id: f.id, target: f.target, expect: f.expect, actual: f.actual, errors: f.errors })),
    [],
    "存在与预期不一致的样本：说明 SSOT 实现与夹具期望不符",
  );
});

test("共享夹具：版本号与契约常量一致，错配时报错而非跳过", () => {
  const fixture = loadFixture(FIXTURE_PATH);
  const validate = createFrameValidator();

  assert.equal(fixture.version, CONTRACT_VERSION, "夹具版本必须与契约常量一致");
  assert.throws(
    () => assertFixture({ validate, fixture, expectedVersion: "9.9" }),
    /夹具版本与实现不一致/,
    "版本错配必须抛错，不能静默通过",
  );
});

test("共享夹具：未知 target 明确报错，不静默跳过", () => {
  const validate = createFrameValidator();
  const bogus = { version: CONTRACT_VERSION, cases: [{ id: "x", target: "ops-no-such-target", expect: "pass", frame: {} }] };
  assert.throws(
    () => assertFixture({ validate, fixture: bogus, expectedVersion: CONTRACT_VERSION }),
    /target 无法识别/,
  );
});
