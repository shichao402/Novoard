/**
 * 契约一致性夹具执行器（需求 5）。
 *
 * 为什么需要它：字节比对只能证明「两份拷贝完全相同」，不能证明「实现正确」。
 * 两侧抄写一致但代码写错时，门禁仍然通过。夹具让所有实现跑同一批帧样本并断言同一结论。
 *
 * fixture 结构见同目录 frames.json；每例含 target（校验入口）、expect（pass/reject）、frame。
 * 校验方必须传入自己的 createFrameValidator，确保测的是各自的实现而非共享代码。
 */
import { readFileSync } from "node:fs";

/** target → 校验调用（未知 target 直接报错，不静默跳过）。 */
const TARGETS = {
  envelope: (validate, frame) => validate.envelope(frame),
  agentCard: (validate, frame) => validate.agentCard(frame),
  task: (validate, frame) => validate.task(frame),
  auditEvent: (validate, frame) => validate.auditEvent(frame),
  targets: (validate, frame) => validate.targets(frame),
};

export function loadFixture(fixturePath) {
  const parsed = JSON.parse(readFileSync(fixturePath, "utf8"));
  if (!parsed || !Array.isArray(parsed.cases)) {
    throw new Error(`夹具格式不合法：${fixturePath}（缺少 cases 数组）`);
  }
  return parsed;
}

/**
 * 运行夹具并返回结果清单。
 * expectedVersion 不匹配时直接抛错——版本错配静默跳过等于门禁失效（需求 5.6）。
 */
export function runFixture({ validate, fixture, expectedVersion }) {
  const { version, cases } = fixture;
  if (expectedVersion !== undefined && version !== expectedVersion) {
    throw new Error(`夹具版本与实现不一致：夹具 ${version}，实现 ${expectedVersion}（禁止静默跳过）`);
  }

  const results = [];
  for (const testCase of cases) {
    const { id, target, expect, frame, desc } = testCase;
    if (!id || !target || !expect) {
      throw new Error(`夹具用例缺少必要字段（id/target/expect）：${JSON.stringify(testCase)}`);
    }

    let runner = TARGETS[target];
    if (!runner && target.startsWith("ops:")) {
      const type = target.slice("ops:".length);
      runner = (v, f) => v.opsBody(type, f);
    }
    if (!runner) {
      throw new Error(`夹具用例 ${id} 的 target 无法识别：${target}`);
    }

    const outcome = runner(validate, frame);
    const actual = outcome.ok ? "pass" : "reject";
    results.push({ id, target, expect, actual, ok: actual === expect, desc, errors: outcome.errors });
  }
  return results;
}

/** 断言全部用例符合预期；不符合时返回可读的失败清单。 */
export function assertFixture({ validate, fixture, expectedVersion }) {
  const results = runFixture({ validate, fixture, expectedVersion });
  const failed = results.filter((r) => !r.ok);
  return { results, failed, ok: failed.length === 0 };
}
