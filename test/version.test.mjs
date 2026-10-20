import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PACKAGE_VERSION,
  PRODUCT_VERSION,
  VERSION_SCHEMA,
  packageVersionOf,
  parseVersionDocument,
  readProductVersion,
} from "../src/version.mjs";
import { assertReleaseTag } from "../scripts/sync-version.mjs";

test("VERSION.json 使用 relkit.version/1 且是运行态唯一版本源", () => {
  const document = parseVersionDocument({
    schema: VERSION_SCHEMA,
    version: "1.2.3-rc.1+7",
  });

  assert.equal(document.version, "1.2.3-rc.1+7");
  assert.equal(packageVersionOf(document.version), "1.2.3-rc.1");
  assert.equal(PRODUCT_VERSION, readProductVersion());
  assert.equal(PACKAGE_VERSION, packageVersionOf(PRODUCT_VERSION));
});

test("VERSION.json schema 或 SemVer 非法时 fail closed", () => {
  assert.throws(
    () => parseVersionDocument({ schema: "other/1", version: "1.2.3" }),
    /schema 必须是 relkit\.version\/1/,
  );
  assert.throws(
    () => parseVersionDocument({ schema: VERSION_SCHEMA, version: "v1.2" }),
    /version 必须是 SemVer/,
  );
});

test("发行 tag 用剥离 build 元数据的版本，带 +build 的 VERSION.json 仍可发常规 tag", () => {
  assert.doesNotThrow(() => assertReleaseTag(`v${PACKAGE_VERSION}`));
  assert.throws(() => assertReleaseTag(`v${PRODUCT_VERSION}+extra`), /必须与 VERSION\.json 一致/);
  assert.throws(() => assertReleaseTag(""), /必须与 VERSION\.json 一致/);
});
