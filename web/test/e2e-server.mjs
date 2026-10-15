import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHub } from "../../src/main.mjs";

const stateDir = mkdtempSync(join(tmpdir(), "novoard-playwright-"));
const hub = await createHub({
  stateDir,
  webDir: resolve("dist"),
  port: 38667,
  host: "127.0.0.1",
  publicOrigin: "http://127.0.0.1:38667",
  secureCookies: false,
  log: { info() {}, warn() {}, error: console.error },
});

async function shutdown() {
  await new Promise((resolveClose) => hub.server.close(resolveClose));
  rmSync(stateDir, { recursive: true, force: true });
  process.exit(0);
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
