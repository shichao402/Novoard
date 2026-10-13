/**
 * hub 入口：装配全部模块（依赖注入风格，测试可替换任意件）。
 * 目录约定：NOVOARD_STATE_DIR（默认 .state/）下 secrets.json、audit/、queue/、artifacts/。
 * 装配时序：先建 tunnel 的 delegate（下发/取消走隧道），再传给 HTTP server —— server 是同步
 * startServer 返回 listen Promise，delegate 以 getter 注入避免 Promise 时序问题。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createFrameValidator } from "./frames.mjs";
import { createAuditLog } from "./audit.mjs";
import { createTaskQueue } from "./queue.mjs";
import { createRegistry } from "./registry.mjs";
import { createSecrets } from "./secrets.mjs";
import { createArtifacts } from "./artifacts.mjs";
import { createNotify } from "./notify.mjs";
import { createRules } from "./rules.mjs";
import { startServer } from "./server.mjs";
import { attachTunnel } from "./tunnel.mjs";

export async function createHub({ stateDir = join(process.cwd(), ".state"), port = Number(process.env.NOVOARD_PORT ?? 38666), host = process.env.NOVOARD_HOST ?? "0.0.0.0", rulesPath = process.env.NOVOARD_RULES, log = console } = {}) {
  mkdirSync(stateDir, { recursive: true });
  const auditDir = join(stateDir, "audit");
  const queueDir = join(stateDir, "queue");
  const artifactsDir = join(stateDir, "artifacts");

  const validate = createFrameValidator();
  const secrets = createSecrets({ dir: stateDir });
  const audit = createAuditLog({ dir: auditDir });
  const queue = createTaskQueue({ dir: queueDir });
  const registry = createRegistry({ validate, log });
  const artifacts = createArtifacts({ dir: artifactsDir });
  const notify = createNotify({ secrets, log });
  const rules = createRules({ rulesPath, log });

  let tunnelDelegate = async () => ({ ok: false, reason: "tunnel not ready" });
  const delegate = (args) => tunnelDelegate(args);

  // 规则引擎接终态事件：动作不旁路（PRD-3 F3），走 submit → delegate 全链路，actor 记 rule-engine
  const notifyAndRules = async ({ event }) => {
    await notify.emit({ event });
    if (event.kind === "terminal" && rules.count > 0) {
      const source = queue.get(event.taskId);
      const actions = rules.evaluate({
        event: "task-terminal",
        target: event.target,
        state: event.state,
        taskId: event.taskId,
        ruleTrace: source?.ruleTrace ?? [],
      });
      for (const action of actions) {
        const owner = action.member
          ? registry.status().find((s) => s.agentId === action.member) && registry.resolve(action.target)?.agentId === action.member
            ? registry.resolve(action.target)
            : null
          : registry.resolve(action.target);
        if (!owner) {
          audit.append({ actor: "rule-engine", lane: "a2a", target: action.target, outcome: "rejected", detail: { reason: registry.knows(action.target) ? "member-offline" : "no-such-skill" } }, validate.auditEvent);
          continue;
        }
        const task = queue.submit({ skillId: action.target, target: action.target, member: owner.agentId, vars: {}, actor: "rule-engine", lane: "a2a", ruleTrace: action.ruleTrace });
        audit.append({ actor: "rule-engine", lane: "a2a", target: action.target, taskId: task.id, outcome: "submitted", detail: { reason: `规则触发：${event.target} ${event.state}` } }, validate.auditEvent);
        delegate({ task, vars: {} }).catch((error) => log.error?.(`规则任务下发失败 ${task.id}：${error.message}`));
      }
    }
  };

  const serverPromise = startServer({
    port,
    host,
    registry,
    queue,
    audit,
    secrets,
    artifacts,
    validate,
    delegate,
    notify: notifyAndRules,
    log,
  });

  const httpServer = await serverPromise;
  const tunnel = attachTunnel({ server: httpServer, registry, queue, audit, secrets, validate, notify: notifyAndRules, log });
  tunnelDelegate = tunnel.delegate;

  return {
    server: httpServer,
    delegate: tunnel.delegate,
    registry,
    queue,
    audit,
    secrets,
    artifacts,
    validate,
    notify: notifyAndRules,
    rules,
  };
}

export function main() {
  createHub().then((hub) => {
    const port = hub.server.address?.().port ?? process.env.NOVOARD_PORT ?? 38666;
    console.log(`Novoard hub 已启动：http://0.0.0.0:${port}`);
    console.log("  dashboard: /    tunnel: /tunnel (ws)    a2a: /a2a    card: /.well-known/agent-card.json");
    const pending = hub.queue.pendingAfterReboot();
    if (pending.length) {
      console.log(`  [重启重放] ${pending.length} 个未终态任务已恢复到内存索引，等待 agent 重连对账`);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
