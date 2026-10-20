import { readFileSync } from "node:fs";

export const VERSION_SCHEMA = "relkit.version/1";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseVersionDocument(raw, source = "VERSION.json") {
  let document;
  try {
    document = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (error) {
    throw new Error(`${source} 不是合法 JSON：${error.message}`);
  }

  if (!document || Array.isArray(document) || typeof document !== "object") {
    throw new Error(`${source} 必须是 JSON 对象`);
  }
  if (document.schema !== VERSION_SCHEMA) {
    throw new Error(
      `${source} schema 必须是 ${VERSION_SCHEMA}，实际为 ${document.schema ?? "<缺失>"}`,
    );
  }
  if (typeof document.version !== "string" || !SEMVER.test(document.version)) {
    throw new Error(
      `${source} version 必须是 SemVer（可带 +build），实际为 ${document.version ?? "<缺失>"}`,
    );
  }

  return Object.freeze({
    schema: document.schema,
    version: document.version,
  });
}

export function readProductVersion(
  path = new URL("../VERSION.json", import.meta.url),
) {
  return parseVersionDocument(readFileSync(path, "utf8"), String(path)).version;
}

export function packageVersionOf(version) {
  parseVersionDocument({ schema: VERSION_SCHEMA, version }, "version");
  return version.split("+", 1)[0];
}

export const PRODUCT_VERSION = readProductVersion();
export const PACKAGE_VERSION = packageVersionOf(PRODUCT_VERSION);
