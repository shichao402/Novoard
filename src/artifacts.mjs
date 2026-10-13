/**
 * artifact 落盘（契约 §7）：超 5MB 内联上限的上行走这里，URL 引用回填 task。
 * 保留期 30 天清理挂 M2（骨架期不做定时任务，目录可被运维清空）。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function createArtifacts({ dir } = {}) {
  if (!dir) throw new Error("Artifacts 需要 dir");

  function safeName(name) {
    return String(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  }

  return {
    /** 落盘并返回 URL 引用（文件名加时间戳防覆盖）。 */
    save(name, buffer) {
      mkdirSync(dir, { recursive: true });
      const fileName = `${Date.now()}-${safeName(name)}`;
      writeFileSync(join(dir, fileName), buffer);
      return { fileName, artifactUrl: `/api/artifacts/${encodeURIComponent(fileName)}` };
    },
    /** 读取（文件名已消毒，无路径穿越面）。 */
    read(fileName) {
      const target = join(dir, safeName(fileName));
      if (!existsSync(target)) return null;
      return readFileSync(target);
    },
  };
}
