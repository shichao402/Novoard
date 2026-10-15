/**
 * 企微智能机器人通道（PRD-5 F1 触发端 + 通知面）：
 * - 通道：@wecom/aibot-node-sdk 长连接（出站 wss → openws.work.weixin.qq.com，无入站端口，ADR-0003 出站拓扑）
 * - 触发端：message.text → 固定语法 `run <target>[@<member>]`（零 LLM，ADR-0004 纪律延伸至 bot）
 *   → POST 本地 /api/trigger 复用人类门全链路（查表/审计/离线拒绝/通知扇出，零旁路）
 * - 通知面：sendMessage(chatid, markdown) 主动推送；通知目标只能由管理员固定配置
 * - 默认拒绝：单聊校验 sender，群聊同时校验 sender + chat；run/approve/reject 均使用服务 PAT
 * - 热配置：凭据变更（dashboard secrets.set）下次 ensure 自动断开重连
 * - 未配置凭据或 SDK 未安装 → 全部降级 no-op / false，不影响 hub 主流程（通知失败不阻塞，PRD-3 NFR）
 * - 依赖注入：sdkFactory（默认动态 import 官方 SDK）、fetchImpl 供测试替换
 */
import { createHash } from "node:crypto";

export function createWecomBot({
  secrets,
  log = console,
  sdkFactory,
  fetchImpl = fetch,
  auditCommand = () => {},
} = {}) {
  let client = null; // SDK WSClient 实例
  let startedKey = ""; // 已启动的不可逆凭据指纹
  let localPort = 0; // hub 本地端口（attach 后生效，触发转发用）
  let ensurePromise = null; // ensure 并发去重锁

  function chatOf(frame) {
    const body = frame?.body ?? {};
    return body.chattype === "group" ? body.chatid : body.from?.userid;
  }

  function commandContext(frame, command) {
    const body = frame?.body ?? {};
    return {
      senderUserId: String(body.from?.userid ?? "").trim(),
      chatId: String(chatOf(frame) ?? "").trim(),
      chatType: body.chattype === "group" ? "group" : "single",
      command: String(command ?? "").slice(0, 256),
    };
  }

  function authorizeCommand(context) {
    const allowedUsers = new Set(secrets.get("wecomAllowedUserIds"));
    if (!context.senderUserId || !allowedUsers.has(context.senderUserId)) return "sender-not-allowed";
    if (context.chatType === "group") {
      const allowedChats = new Set(secrets.get("wecomAllowedChatIds"));
      if (!context.chatId || !allowedChats.has(context.chatId)) return "chat-not-allowed";
    }
    return "";
  }

  async function recordCommand(context, authorized, reason) {
    try {
      await auditCommand({ ...context, authorized, reason });
    } catch (error) {
      log.error?.(`[wecom-bot] 指令审计失败：${error.message}`);
    }
  }

  function serviceHeaders(context) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secrets.get("wecomServicePat")}`,
      "X-Novoard-WeCom-Sender": context.senderUserId,
      "X-Novoard-WeCom-Chat": context.chatId,
      "X-Novoard-WeCom-Command": context.command,
    };
  }

  async function authorizeOrReply(frame, command) {
    const context = commandContext(frame, command);
    const reason = authorizeCommand(context);
    if (reason) {
      await recordCommand(context, false, reason);
      await safeReply(frame, "**⛔ Novoard 拒绝**\n> 当前企微用户或会话不在管理员白名单中");
      return null;
    }
    if (!secrets.get("wecomServicePat")) {
      await recordCommand(context, false, "service-pat-missing");
      await safeReply(frame, "**⚠️ Novoard 未配置完成**\n> 请管理员创建或轮换企微服务 PAT");
      return null;
    }
    await recordCommand(context, true, "allowlist-passed");
    return context;
  }

  async function doEnsure() {
    const botId = secrets.get("wecomBotId");
    const botSecret = secrets.get("wecomBotSecret");
    if (!botId || !botSecret) {
      if (client) {
        try { client.disconnect(); } catch { /* 忽略 */ }
        client = null;
        startedKey = "";
        log.info?.("[wecom-bot] 凭据已清除，长连接断开");
      }
      return null;
    }
    const key = createHash("sha256").update(`${botId}\0${botSecret}`).digest("hex");
    if (client && startedKey === key) return client;
    if (client) {
      try { client.disconnect(); } catch { /* 忽略 */ }
      client = null;
    }
    let mod;
    try {
      const factory = sdkFactory ?? (async () => import("@wecom/aibot-node-sdk"));
      mod = await factory();
    } catch (error) {
      log.error?.(`[wecom-bot] SDK 加载失败（依赖未安装？）：${error.message}`);
      return null;
    }
    const WSClient = mod.WSClient ?? mod.default?.WSClient;
    if (typeof WSClient !== "function") {
      log.error?.("[wecom-bot] SDK 导出形态不符（缺 WSClient），跳过");
      return null;
    }
    client = new WSClient({ botId, secret: botSecret });
    client.on("authenticated", () => log.info?.(`[wecom-bot] 长连接认证成功（${botId.slice(0, 10)}…）`));
    client.on("message.text", (frame) => {
      onText(frame).catch((error) => log.error?.(`[wecom-bot] 消息处理异常：${error.message}`));
    });
    try {
      client.connect();
      startedKey = key;
      log.info?.("[wecom-bot] 长连接已发起（出站 wss，凭据热配置生效）");
    } catch (error) {
      log.error?.(`[wecom-bot] 连接发起失败：${error.message}`);
      client = null;
      return null;
    }
    return client;
  }

  function ensure() {
    if (!ensurePromise) {
      ensurePromise = doEnsure().finally(() => { ensurePromise = null; });
    }
    return ensurePromise;
  }

  async function onText(frame) {
    const text = String(frame?.body?.text?.content ?? "").trim();

    const match = text.match(/^run\s+([a-z0-9][a-z0-9-]*)(?:@([a-z0-9][a-z0-9-]*))?$/i);
    if (match) {
      const context = await authorizeOrReply(frame, text);
      if (!context) return;
      const [, target, member] = match;
      let res;
      try {
        res = await fetchImpl(`http://127.0.0.1:${localPort}/api/trigger`, {
          method: "POST",
          headers: serviceHeaders(context),
          body: JSON.stringify(member ? { target, member } : { target }),
        });
      } catch (error) {
        await safeReply(frame, `**⚠️ Novoard 触发失败**\n> 转发异常：${error.message}`);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (res.status === 202 && data.taskId) {
        await safeReply(frame, `**🚀 Novoard 已受理**\n> target：\`${target}\`\n> 任务：\`${data.taskId}\`\n> 终态将推送到本会话`);
      } else if (res.status === 202 && data.state === "rejected") {
        await safeReply(frame, `**⚠️ Novoard 离线拒绝**\n> target：\`${target}\`\n> 原因：${data.reason ?? "member-offline"}（目标成员不在线，任务未入队）`);
      } else if (res.status === 404) {
        await safeReply(frame, `**❌ Novoard 拒绝**\n> target：\`${target}\` 不存在或不可远程触发（expose: local）`);
      } else {
        await safeReply(frame, `**⚠️ Novoard 触发异常**\n> HTTP ${res.status}：${data.error ?? "unknown"}`);
      }
      return;
    }

    // 审批门（M4 AC2）：approve/reject <taskId> → tasks/approve 端点（与面板/磁贴同一状态机，零旁路）
    const approval = text.match(/^(approve|reject)\s+(task-[a-z0-9-]+)$/i);
    if (approval) {
      const context = await authorizeOrReply(frame, text);
      if (!context) return;
      const [, decision, taskId] = approval;
      let res;
      try {
        res = await fetchImpl(`http://127.0.0.1:${localPort}/a2a`, {
          method: "POST",
          headers: serviceHeaders(context),
          body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tasks/approve", params: { id: taskId, decision } }),
        });
      } catch (error) {
        await safeReply(frame, `**⚠️ Novoard 审批失败**\n> 转发异常：${error.message}`);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (res.status === 200 && !data.error) {
        const state = data.result?.status?.state ?? "working";
        const icon = decision === "approve" ? "✅" : "🚫";
        const word = decision === "approve" ? "已批准，任务恢复执行" : "已拒绝，任务取消";
        await safeReply(frame, `**${icon} Novoard 审批回执**\n> 任务：\`${taskId}\`\n> ${word}（当前状态：\`${state}\`）`);
      } else if (data.error?.code === -32001) {
        await safeReply(frame, `**❌ Novoard 拒绝**\n> 任务 \`${taskId}\` 不存在`);
      } else if (data.error?.code === -32000) {
        await safeReply(frame, `**❌ Novoard 拒绝**\n> 任务 \`${taskId}\` 状态非待审批（已处理或已过期）`);
      } else {
        await safeReply(frame, `**⚠️ Novoard 审批异常**\n> HTTP ${res.status}：${data.error?.message ?? "unknown"}`);
      }
      return;
    }

    // 帮助面：拉聚合 card 列出在线可触发能力
    let skills = "";
    try {
      const card = await fetchImpl(`http://127.0.0.1:${localPort}/.well-known/agent-card.json`).then((r) => r.json());
      skills = (card?.skills ?? []).map((s) => `> \`${s.id}\`（${s.name ?? ""}）`).join("\n") || "> （暂无在线能力，成员均离线）";
    } catch {
      skills = "> （能力清单暂不可用）";
    }
    await safeReply(frame, `**Novoard bot 用法**\n> 触发语法：\`run <target>[@<成员>]\`\n> 审批语法：\`approve <任务ID>\` / \`reject <任务ID>\`（待审批任务会主动推送到本会话）\n> 示例：\`run dev-build-investm-work@mac-work\`\n\n**当前可触发**\n${skills}`);
  }

  async function safeReply(frame, content) {
    if (!client) return;
    try {
      await client.reply(frame, { msgtype: "markdown", markdown: { content } });
    } catch (error) {
      log.error?.(`[wecom-bot] 回执失败（不阻塞）：${error.message}`);
    }
  }

  return {
    /** hub server 起来后绑定本地端口（触发转发目标）。 */
    attach(port) {
      localPort = Number(port) || 0;
    },
    /** 启动长连接（未配置凭据时 no-op）。 */
    async start() {
      return ensure();
    },
    /** 主动推送（notify 扇出调用）：markdown 文本 → 管理员固定的企微会话。 */
    async push({ markdown }) {
      const c = await ensure();
      if (!c) return false;
      const chat = secrets.get("wecomNotifyChatId");
      if (!chat) {
        log.info?.("[wecom-bot] wecomNotifyChatId 未配置，本次通知降级");
        return false;
      }
      try {
        await c.sendMessage(String(chat), { msgtype: "markdown", markdown: { content: markdown } });
        return true;
      } catch (error) {
        log.error?.(`[wecom-bot] 推送失败（不阻塞主流程）：${error.message}`);
        return false;
      }
    },
    /** 触发端测试钩子：模拟一帧文本消息。 */
    async _receiveTestText(frame) {
      return onText(frame);
    },
    get connected() {
      return !!client?.isConnected;
    },
  };
}
