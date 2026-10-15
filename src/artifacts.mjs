/**
 * 契约 2.0 artifact 存储：内容按不可猜 artifactId 落盘，旁路元数据绑定 task/member/target。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

export function createArtifacts({ dir } = {}) {
  if (!dir) throw new Error("Artifacts 需要 dir");

  function normalizeName(name) {
    const value = String(name ?? "").normalize("NFKC").trim();
    if (!value || value.length > 180 || /[\u0000-\u001f\u007f/\\]/.test(value)) {
      throw new Error("artifact 文件名无效");
    }
    return value;
  }

  return {
    save({ taskId, member, target, name, digest, buffer }) {
      if (!/^task-[a-zA-Z0-9-]+$/.test(String(taskId))) throw new Error("artifact taskId 无效");
      const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? "");
      const calculated = `sha256:${createHash("sha256").update(content).digest("hex")}`;
      if (!/^sha256:[a-f0-9]{64}$/.test(String(digest)) || digest !== calculated) {
        const error = new Error("artifact digest 校验失败");
        error.code = "digest-mismatch";
        throw error;
      }
      const artifactId = `art_${randomBytes(16).toString("hex")}`;
      const fileName = normalizeName(name);
      const metadata = {
        artifactId,
        taskId,
        member: String(member),
        target: String(target),
        name: fileName,
        digest,
        size: content.length,
        createdAt: new Date().toISOString(),
      };
      mkdirSync(dir, { recursive: true });
      atomicWrite(join(dir, `${artifactId}.bin`), content);
      atomicWrite(join(dir, `${artifactId}.json`), Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`));
      return { ...metadata, artifactUrl: `/api/artifacts/${artifactId}` };
    },
    metadata(artifactId) {
      if (!/^art_[a-f0-9]{32}$/.test(String(artifactId))) return null;
      const metadataFile = join(dir, `${artifactId}.json`);
      if (!existsSync(metadataFile)) return null;
      try {
        const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
        return metadata?.artifactId === artifactId ? metadata : null;
      } catch {
        throw new Error(`artifact 元数据损坏：${artifactId}`);
      }
    },
    read(artifactId) {
      const metadata = this.metadata(artifactId);
      if (!metadata) return null;
      const contentFile = join(dir, `${artifactId}.bin`);
      if (!existsSync(contentFile)) throw new Error(`artifact 内容缺失：${artifactId}`);
      return { metadata, buffer: readFileSync(contentFile) };
    },
  };
}

function atomicWrite(file, content) {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, content, { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
