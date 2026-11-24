import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createHub } from "../src/main.mjs";
import { configureTestAgentTokens } from "./test-auth.mjs";

// 跨仓集成显式指定 agent 源码；普通单仓 CI 不假定相邻目录存在。
const agentDir = process.env.NOVOARD_AGENT_SOURCE_DIR;
test("真实 Hub PAT CRUD → 成员只读 → 本机主动同步，无需重连", { skip: !agentDir }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-source-chain-"));
  let hub;
  let local;
  try {
    hub = await createHub({ stateDir: dir, port: 0, publicOrigin: "http://test.local", secureCookies: false, log: { info() {}, error() {} } });
    const setup = await hub.identity.setup({ username: "sourceowner", password: "correct horse battery staple" });
    const principal = await hub.identity.authenticateSession(setup.token);
    const issued = await hub.identity.createPat(principal, { name: "source-chain", scopes: ["pack-sources.read", "pack-sources.manage"] });
    const base = `http://127.0.0.1:${hub.server.address().port}`;
    const cli = join(agentDir, "skills/novoard-manage/scripts/novoard.py");
    function run(args) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.env.NOVOARD_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3"), [cli, "pack-sources", ...args, "--hub", base], { env: { ...process.env, PYTHONIOENCODING: "utf-8", NOVOARD_HUB_PAT: issued.token, NOVOARD_HUB_PAT_FILE: "" }, windowsHide: true });
        let stdout = ""; let stderr = "";
        child.stdout.on("data", (c) => { stdout += c; });
        child.stderr.on("data", (c) => { stderr += c; });
        const timer = setTimeout(() => { child.kill(); reject(new Error("CLI test timeout")); }, 10_000);
        child.on("error", (error) => { clearTimeout(timer); reject(error); });
        child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
    }
    let result = await run(["add", "--git", "git@example.com:team/osg.git"]);
    assert.equal(result.code, 0, result.stderr);
    const key = JSON.parse(result.stdout).source.key;
    assert.equal((await run(["list"])).code, 0);
    assert.equal((await run(["update", "--key", key, "--branch", "dev"])).code, 0);
    const { createHubSourceSync } = await import(pathToFileURL(join(agentDir, "src/packs/hub-sync.mjs")));
    const { createSourcesCache } = await import(pathToFileURL(join(agentDir, "src/packs/sources-cache.mjs")));
    const { createLocalA2A } = await import(pathToFileURL(join(agentDir, "src/local-a2a.mjs")));
    const agentToken = "source-chain-member-token";
    configureTestAgentTokens(hub, { "source-chain-agent": agentToken });
    const sources = createSourcesCache({ file: join(dir, "agent-pack-sources.json") });
    const sync = createHubSourceSync({ config: { hubUrl: base, agentToken }, sources, manager: { reconcile() {}, listRepos() { return sources.list(); } } });
    local = createLocalA2A({ targets: {}, runtime: {}, syncPackSources: () => sync.sync(), log: { info() {} } });
    const address = await local.start();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/pack-sources/sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).count, 1);
    assert.equal(sources.list()[0].branch, "dev");
    assert.equal((await run(["remove", "--key", key])).code, 1);
    assert.equal(hub.packSources.list().length, 1);
    assert.equal((await run(["remove", "--key", key, "--confirm"])).code, 0);
    assert.equal((await sync.sync()).count, 0);
    assert.deepEqual(sources.list(), []);
    assert.ok(!JSON.stringify(hub.audit.list()).includes(issued.token));
  } finally {
    await local?.close();
    if (hub) { hub.server.closeAllConnections(); await new Promise((r) => hub.server.close(r)); }
    rmSync(dir, { recursive: true, force: true });
  }
});
