/**
 * 通知扇出完备版（PRD-3 F1/F2 · M3）：
 * 渠道：企微智能机器人（主）/ 企微群 webhook（备）/ Bark（iOS 直达，双推试点）。
 * 触发点：terminal（终态）/ offline-reject（离线拒绝）/ input-required（审批门）/ member-events（上线/离线，M3 规则源）。
 * per-target notify 策略（F2）：emit 入参带 policy，调用方查表后传入——
 *   always（默认）全部放行；on-failure 仅 terminal+failed 放行；never 全拦。
 * 频控（状态口径，防 digest 吞增量——issue-handler 教训）：同 target 同 (kind,state) 短窗内
 *   不再丢弃，改为计数累积，窗口关闭时若 count>0 追发一条合并摘要（增量不丢，只是延后呈现）。
 * 纪律（PRD-3 NFR）：通知失败不阻塞任务主流程——异步 fire-and-forget，失败进日志。
 * 零新增依赖：Node 22+ 原生 fetch。
 */
export function createNotify({ secrets, bot = null, log = console, fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
  const FLOOD_WINDOW_MS = 60_000;
  /** 频控窗口表：key = kind:target:state → { windowStart, suppressed, lastTaskId, digestTimer } */
  const windows = new Map();

  function barkTarget() {
    const url = secrets.get("barkUrl");
    const key = secrets.get("barkDeviceKey");
    if (!url || !key) return null;
    return `${url.replace(/\/$/, "")}/${key}`;
  }

  /** 渠道发送（单条）：企微 bot → 企微 webhook → Bark，任一成功即止；全失败进日志。 */
  async function send(markdown) {
    if (bot) {
      const ok = await bot.push({ markdown });
      if (ok) return "wecom-bot";
    }
    const webhook = secrets.get("wecomWebhook");
    if (webhook) {
      try {
        const res = await fetchImpl(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ msgtype: "markdown", markdown: { content: markdown } }),
        });
        if (res.ok) return "wecom-webhook";
        log.error?.(`[notify] 企微 webhook 推送失败：${res.status}`);
      } catch (error) {
        log.error?.(`[notify] 企微 webhook 异常：${error.message}`);
      }
    }
    const bark = barkTarget();
    if (bark) {
      try {
        const res = await fetchImpl(bark, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: markdown.replace(/\*\*/g, "").replace(/\n> /g, "\n"), title: "Novoard" }),
        });
        if (res.ok) return "bark";
        log.error?.(`[notify] Bark 推送失败：${res.status}`);
      } catch (error) {
        log.error?.(`[notify] Bark 异常：${error.message}`);
      }
    }
    log.info?.(`[notify:stub] 无可用通道（bot 未起/未配置），仅日志：${markdown.split("\n")[0]}`);
    return null;
  }

  /** 窗口到期合并追发：suppressed > 0 则补一条汇总（增量不丢）。 */
  function flushDigest(key) {
    const win = windows.get(key);
    if (!win) return;
    windows.delete(key);
    if (win.suppressed > 0) {
      const [kind, target, state] = key.split(":");
      const markdown = `**🔁 Novoard 频控合并**\n> target：${target}\n> 事件：${kind} ${state}\n> 本窗口另有 ${win.suppressed} 条同类事件已合并（末条 ${win.lastTaskId || "-"}）\n> 时间：${now()}`;
      void send(markdown);
    }
  }

  /**
   * 频控（状态口径）：窗口内重复事件不再丢弃，改为 suppressed 计数，窗口到期合并追发。
   * 首条立即发送并开窗口；窗口内后续只计数。
   */
  function floodControl({ kind, target, state, taskId }, sendOne) {
    const key = `${kind}:${target}:${state}`;
    const nowMs = Date.now();
    const win = windows.get(key);
    if (!win || nowMs - win.windowStart > FLOOD_WINDOW_MS) {
      const w = { windowStart: nowMs, suppressed: 0, lastTaskId: taskId, digestTimer: null };
      windows.set(key, w);
      w.digestTimer = setTimeout(() => flushDigest(key), FLOOD_WINDOW_MS + 200);
      w.digestTimer.unref?.();
      return sendOne();
    }
    win.suppressed++;
    if (taskId) win.lastTaskId = taskId;
    log.info?.(`[notify:flood] 窗口内合并 ${key}（第 ${win.suppressed} 条，窗口到期合并追发）`);
    return Promise.resolve();
  }

  async function emit({ event, policy = "always" }) {
    const { kind, target = "", state = "", taskId = "", reason = "" } = event;
    // per-target notify 策略过滤（F2，契约 §1）：定义时决定，运行时查表（policy 由调用方传入）
    if (policy === "never") {
      log.info?.(`[notify:skip] notify=never ${target} ${taskId}`);
      return;
    }
    if (policy === "on-failure" && !(kind === "terminal" && state === "failed")) {
      log.info?.(`[notify:skip] notify=on-failure 且非失败终态 ${target} ${taskId}`);
      return;
    }

    const markdown = render({ kind, target, state, taskId, reason, ts: now() });
    await floodControl({ kind, target, state, taskId }, () => send(markdown));
  }

  function render({ kind, target, state, taskId, reason, ts }) {
    if (kind === "terminal") {
      const icon = state === "completed" ? "✅" : state === "failed" ? "❌" : "⛔";
      return `**${icon} Novoard 任务终态**\n> target：${target}\n> 状态：${state}\n> 任务：${taskId || "-"}\n> 原因：${reason || "-"}\n> 时间：${ts}`;
    }
    if (kind === "offline-reject") {
      return `**⚠️ Novoard 离线拒绝**\n> target：${target}\n> 原因：${reason || "member-offline"}\n> 提示：目标机器不在线，任务未入队\n> 时间：${ts}`;
    }
    if (kind === "input-required") {
      return `**🔐 Novoard 审批门**\n> target：${target}\n> 任务：${taskId || "-"}\n> 等待审批（恢复链路建设中）\n> 时间：${ts}`;
    }
    if (kind === "member-event") {
      return `**🟢 Novoard 成员事件**\n> 事件：${state}\n> 成员：${target}\n> 时间：${ts}`;
    }
    return `**Novoard 事件**\n> ${kind} ${target} ${state} ${ts}`;
  }

  return { emit, _test: { windows, send, flushDigest } };
}
