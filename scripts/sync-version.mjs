import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PACKAGE_VERSION, PRODUCT_VERSION } from "../src/version.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MIRRORS = [
  { path: "package.json", fields: [["version"]] },
  {
    path: "package-lock.json",
    fields: [["version"], ["packages", "", "version"]],
  },
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fieldName(parts) {
  return parts.filter(Boolean).join(".");
}

function currentValue(document, parts) {
  return parts.reduce((value, part) => value?.[part], document);
}

function setValue(document, parts, value) {
  const parent = parts
    .slice(0, -1)
    .reduce((target, part) => target?.[part], document);
  if (!parent || typeof parent !== "object") {
    throw new Error(`版本镜像字段不存在：${fieldName(parts)}`);
  }
  parent[parts.at(-1)] = value;
}

export function syncVersionMirrors({ root = ROOT, check = false } = {}) {
  const drift = [];

  for (const mirror of MIRRORS) {
    const path = resolve(root, mirror.path);
    const document = readJson(path);
    let changed = false;

    for (const field of mirror.fields) {
      const actual = currentValue(document, field);
      if (actual === PACKAGE_VERSION) continue;
      drift.push(
        `${relative(root, path)}:${fieldName(field)}=${actual ?? "<缺失>"}（应为 ${PACKAGE_VERSION}）`,
      );
      setValue(document, field, PACKAGE_VERSION);
      changed = true;
    }

    if (!check && changed) {
      writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    }
  }

  if (check && drift.length > 0) {
    throw new Error(
      `版本镜像与 VERSION.json 不一致：\n- ${drift.join("\n- ")}\n请运行 npm run version:sync`,
    );
  }

  return { productVersion: PRODUCT_VERSION, packageVersion: PACKAGE_VERSION, drift };
}

export function assertReleaseTag(tag) {
  const expected = `v${PACKAGE_VERSION}`;
  if (tag !== expected) {
    throw new Error(`发行 tag 必须与 VERSION.json 一致：应为 ${expected}，实际为 ${tag || "<空>"}`);
  }
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const check = process.argv.includes("--check");
    const result = syncVersionMirrors({ check });
    const tag = optionValue("--tag");
    if (tag !== undefined) assertReleaseTag(tag);
    console.log(
      `✓ VERSION.json ${result.productVersion}；package 镜像 ${result.packageVersion}${check ? " 已校验" : " 已同步"}`,
    );
  } catch (error) {
    console.error(`版本校验失败：${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
