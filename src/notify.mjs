/**
 * 通知扇出最小版（PRD-5 F1 / PRD-3 F1 雏形）：
 * 渠道：企微群机器人 webhook（markdown 消息）；Bark 与频控留 M3 完备化。
 * 触发点（hub 侧两处钩子的 event.kind）：
 *   terminal       —— task 终态（completed/failed/canceled）
 *   offline-reject —— 成员离线触发被拒（PRD-3 US4）
 *   input-required —— 审批门打开（试点期 hub 侧未通恢复链，预留）
 * 纪律（PRD-3 NFR）：通知失败不阻塞任务主流程——异步 fire-and-forget，失败进日志（审计由调用方落）。
 * wecomWebhook 未配置（secrets）→ 降级为纯日志（骨架期行为），不报错。
 * 零新增依赖：Node 22+ 原生 fetch。
 */
export function createNotify({ secrets, bot = null, log = console, fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
  let recentByTarget = new Map(); // 状态口径频控雏形（PRD-3 F1）：同 target 同终态 60s 窗口合并
  const FLOOD_WINDOW_MS = 60_000;

  async function emit({ event }) {
    const { kind, target = "", state = "", taskId = "", reason = "" } = event;
    // 频控（状态口径）：同 target 同 (kind,state) 60s 内只推一次——试点雏形，完备化留 M3
    const key = `${kind}:${target}:${state}`;
    const last = recentByTarget.get(key) ?? 0;
    if (Date.now() - last < FLOOD_WINDOW_MS) {
      log.info?.(`[notify:skip] 频控窗口内合并 ${key}`);
      return;
    }
    recentByTarget.set(key, Date.now());
    if (recentByTarget.size > 200) recentByTarget = new Map([...recentByTarget].slice(-100)); // 防泄漏

    const markdown = render({ kind, target, state, taskId, reason, ts: now() });
    // 通道一（主）：企微智能机器人长连接 sendMessage 主动推送（PRD-5 F1 通知面）
    if (bot) {
      const ok = await bot.push({ markdown });
      if (ok) return;
      // bot 通道失败 → 降级老 webhook（若配置了）；都不可用 → stub 日志（通知失败不阻塞，PRD-3 NFR）
    }
    const webhook = secrets.get("wecomWebhook");
    if (!webhook) {
      log.info?.(`[notify:stub] ${kind} ${target} ${state || reason}（wecomWebhook 未配置，降级日志）`);
      return;
    }
    try {
      const res = await fetchImpl(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "markdown", markdown: { content: markdown } }),
      });
      if (!res.ok) log.error?.(`[notify] 企微推送失败：${res.status}`);
    } catch (error) {
      log.error?.(`[notify] 推送异常（不阻塞主流程）：${error.message}`);
    }
  }

  function render({ kind, target, state, taskId, reason, ts }) {
    if (kind === "terminal") {
      const icon = state === "completed" ? "✅" : state === "failed" ? "❌" : "⛔";
      return `**${icon} Novoard 任务终态**\n> target：${target}\n> 状态：${state}\n> 任务：${taskId || "-"}\n> 时间：${ts}`;
    }
    if (kind === "offline-reject") {
      return `**⚠️ Novoard 离线拒绝**\n> target：${target}\n> 原因：${reason || "member-offline"}\n> 提示：目标机器不在线，任务未入队\n> 时间：${ts}`;
    }
    if (kind === "input-required") {
      return `**🔐 Novoard 审批门**\n> target：${target}\n> 任务：${taskId || "-"}\n> 等待审批（试点期恢复链路建设中）\n> 时间：${ts}`;
    }
    return `**Novoard 事件**\n> ${kind} ${target} ${state} ${ts}`;
  }

  return { emit };
}
