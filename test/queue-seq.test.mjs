/**
 * M3 修复回归：queue seq 重启续号（防 taskId 撞号）。
 * 撞号后果：审计流水两条任务同 id，对账与 tasks/get 串台。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTaskQueue } from "../src/queue.mjs";

test("queue seq 重启续号：同日任务 id 不撞号", () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-seq-"));
  try {
    // 第一个实例：造 2 个任务（task-YYYYMMDD-001 / 002）
    const q1 = createTaskQueue({ dir });
    const t1 = q1.submit({ skillId: "a", target: "a", member: "m", actor: "human", lane: "a2a" });
    const t2 = q1.submit({ skillId: "a", target: "a", member: "m", actor: "human", lane: "a2a" });
    assert.match(t1.id, /-001$/);
    assert.match(t2.id, /-002$/);

    // 重启（新实例同目录）：续号应为 003，而非重新从 001 开始
    const q2 = createTaskQueue({ dir });
    const t3 = q2.submit({ skillId: "a", target: "a", member: "m", actor: "human", lane: "a2a" });
    assert.match(t3.id, /-003$/, `重启后应续号 003，实际 ${t3.id}`);

    // 历史日任务不干扰当日续号：写入昨天日期的任务，续号仍取当日最大
    const lines = readFileSync(join(dir, "queue.jsonl"), "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
    writeFileSync(join(dir, "queue.jsonl"), [...lines, JSON.stringify({ ...last, id: `task-${yesterday}-999` })].join("\n") + "\n");
    const q3 = createTaskQueue({ dir });
    const t4 = q3.submit({ skillId: "a", target: "a", member: "m", actor: "human", lane: "a2a" });
    assert.match(t4.id, /-004$/, `跨日任务不干扰当日续号，实际 ${t4.id}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
