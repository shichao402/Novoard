/**
 * 审计流水（契约 §6）：append-only JSONL，每行一审计事件，audit-event.json 校验后落盘。
 * 复用 issue-handler events.mjs 的裁剪模式：保留期内全量重写，字节上限对半裁剪。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DAY_MS = 86_400_000;

export function createAuditLog({ dir, maxBytes = 5_000_000, retentionDays = 30, now = Date.now } = {}) {
  if (!dir) throw new Error("AuditLog 需要 dir");
  const file = join(dir, "audit.jsonl");

  function readEntries() {
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, "utf8").trim();
    if (!raw) return [];
    return raw.split("\n").flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        return entry?.ts ? [entry] : [];
      } catch {
        return [];
      }
    });
  }

  function cutoff() {
    return now() - retentionDays * DAY_MS;
  }

  function freshEntries() {
    const minTs = cutoff();
    return readEntries().filter((entry) => Date.parse(entry.ts) >= minTs);
  }

  function serialize(entries) {
    return entries.length ? `${entries.map((e) => JSON.stringify(e)).join("\n")}\n` : "";
  }

  function writeEntries(entries) {
    mkdirSync(dir, { recursive: true });
    let kept = entries;
    let text = serialize(kept);
    while (kept.length > 1 && Buffer.byteLength(text) > maxBytes) {
      kept = kept.slice(Math.floor(kept.length / 2));
      text = serialize(kept);
    }
    writeFileSync(file, text);
    return kept;
  }

  return {
    /** 落一条审计事件；event 先过 audit-event.json 校验，不合法当场抛错（不带病落账） */
    append(event, validate) {
      const line = { ts: new Date(now()).toISOString(), ...event };
      if (validate) {
        const { ok, errors } = validate(line);
        if (!ok) throw new Error(`审计事件不合法：${errors.join("; ")}`);
      }
      writeEntries([...freshEntries(), line]);
      return line;
    },
    /** 保留期内全部流水，新的在前。 */
    list() {
      const entries = freshEntries();
      writeEntries(entries);
      return entries.reverse();
    },
    /** 按 taskId 拉全生命周期事件（新的在前）。 */
    byTask(taskId) {
      return this.list().filter((e) => e.taskId === taskId);
    },
  };
}
