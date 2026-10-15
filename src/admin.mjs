import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";

import { createIdentityStore } from "./identity.mjs";
import { createAuditLog } from "./audit.mjs";
import { createFrameValidator } from "./frames.mjs";

export async function runAdmin({
  args = process.argv.slice(2),
  stateDir = process.env.NOVOARD_STATE_DIR ?? join(process.cwd(), ".state"),
  promptPassword = promptHiddenPassword,
  log = console,
} = {}) {
  const [command, username, ...rest] = args;
  if (command !== "recover" || !username || rest.length) {
    throw new Error("用法：npm run admin -- recover <superadmin-username>");
  }

  const first = await promptPassword("新口令：");
  const second = await promptPassword("再次输入新口令：");
  if (first !== second) throw new Error("两次输入的口令不一致");

  const identity = await createIdentityStore({ stateDir });
  const user = await identity.recoverSuperadmin(username, first);
  const audit = createAuditLog({ dir: join(stateDir, "audit") });
  const validate = createFrameValidator();
  audit.append({
    actor: "server:break-glass",
    lane: "ops",
    target: "hub",
    outcome: "completed",
    detail: { reason: "superadmin-password-recovered", username: user.username },
  }, validate.auditEvent);
  log.info?.(`超级管理员 ${user.username} 已恢复；其会话和 PAT 已全部吊销。`);
  return user;
}

async function promptHiddenPassword(label) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("break-glass 必须在交互式 TTY 中运行");
  }
  let muted = false;
  const hiddenOutput = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk, encoding);
      callback();
    },
  });
  const readline = createInterface({ input, output: hiddenOutput, terminal: true });
  try {
    const promise = readline.question(label);
    muted = true;
    const value = await promise;
    muted = false;
    output.write("\n");
    return value;
  } finally {
    readline.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAdmin().catch((error) => {
    console.error(`admin 失败：${error.message}`);
    process.exitCode = 1;
  });
}
