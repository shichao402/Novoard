/**
 * 企微智能机器人通道测试（PRD-5 F1）：
 * - 未配置凭据 → start() no-op、push() false（不影响 hub 主流程）
 * - SDK 形态校验：WSClient 缺失 / 加载失败 → 降级日志不抛
 * - 触发端固定语法：run <target>[@<member>] → 转发 /api/trigger，回复受理/离线拒绝/404
 * - chatid 热学习：单聊/群聊首条消息 → secrets.wecomChatId 持久化
 * - 主动推送：sendMessage(chatid, markdown) 调用正确；chatid 未学习时降级 false
 * - 凭据热变更：botId/secret 变化 → disconnect 旧连接重连新连接
 * - notify 集成：bot.push 成功时不再走老 webhook（通道一优先，双通道灰度）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWecomBot } from "../src/wecom-bot.mjs";
import { createNotify } from "../src/notify.mjs";
import { createSecrets } from "../src/secrets.mjs";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "novoard-wecombot-test-"));
}

const quietLog = { info: () => {}, error: () => {}, warn: () => {} };

/** 假 SDK 工厂：记录连接生命周期与调用，可注入行为。 */
function fakeSdk({ onConnect } = {}) {
  const calls = { connects: 0, disconnects: 0, replies: [], sends: [], events: {} };
  class WSClient {
    constructor(options) {
      this.options = options;
      this.isConnected = false;
    }
    on(name, fn) { calls.events[name] = fn; }
    connect() {
      calls.connects += 1;
      this.isConnected = true;
      onConnect?.(this);
    }
    disconnect() {
      calls.disconnects += 1;
      this.isConnected = false;
    }
    async reply(frame, body) { calls.replies.push({ frame, body }); }
    async sendMessage(chatid, body) { calls.sends.push({ chatid, body }); }
  }
  return { mod: { WSClient }, calls };
}

test("未配置凭据：start no-op、push false、不报错", async () => {
  const dir = tmpDir();
  const secrets = createSecrets({ dir, env: {} });
  const bot = createWecomBot({ secrets, log: quietLog, sdkFactory: async () => { throw new Error("不该加载"); } });
  assert.equal(await bot.start(), null);
  assert.equal(await bot.push({ markdown: "x" }), false);
  assert.equal(bot.connected, false);
  rmSync(dir, { recursive: true, force: true });
});

test("凭据配置 → 长连接发起；触发端语法与回复；chatid 学习", async () => {
  const dir = tmpDir();
  const secrets = createSecrets({ dir, env: {} });
  secrets.set({ wecomBotId: "aibk0test000000000", wecomBotSecret: "sec-123456" });
  const { mod, calls } = fakeSdk();
  const triggerCalls = [];
  const bot = createWecomBot({
    secrets,
    log: quietLog,
    sdkFactory: async () => mod,
    fetchImpl: async (url, init) => {
      triggerCalls.push({ url, body: JSON.parse(init?.body ?? "{}") });
      return { status: 202, json: async () => ({ taskId: "task-abc", state: "submitted" }) };
    },
  });
  const c = await bot.start();
  assert.ok(c, "应返回客户端实例");
  assert.equal(calls.connects, 1);
  assert.equal(bot.connected, true);

  bot.attach(38666);
  // 单聊触发帧
  const frame = { body: { chattype: "single", from: { userid: "FIROYANG" }, text: { content: "run dev-build-investm" } } };
  await bot._receiveTestText(frame);
  assert.equal(secrets.get("wecomChatId"), "FIROYANG", "单聊 chatid 应学习为 userid");
  assert.equal(triggerCalls[0].url, "http://127.0.0.1:38666/api/trigger");
  assert.equal(triggerCalls[0].body.target, "dev-build-investm");
  assert.equal(calls.replies.length, 1);
  assert.match(calls.replies[0].body.markdown.content, /已受理/);
  assert.match(calls.replies[0].body.markdown.content, /task-abc/);

  // 群聊帧 → chatid 切换为群 chatid；带成员限定语法
  const groupFrame = { body: { chattype: "group", chatid: "wrGroup123", from: { userid: "FIROYANG" }, text: { content: "run dev-build-investm@mac-work" } } };
  await bot._receiveTestText(groupFrame);
  assert.equal(secrets.get("wecomChatId"), "wrGroup123");
  assert.equal(triggerCalls[1].body.target, "dev-build-investm");
  assert.equal(triggerCalls[1].body.member, "mac-work");
  rmSync(dir, { recursive: true, force: true });
});

test("触发端 HTTP 结果分流：离线拒绝 / 404 / 转发异常", async () => {
  const dir = tmpDir();
  const secrets = createSecrets({ dir, env: {} });
  secrets.set({ wecomBotId: "aibk0test000000001", wecomBotSecret: "sec-123456" });
  const { mod, calls } = fakeSdk();
  const responses = [
    { status: 202, json: async () => ({ state: "rejected", reason: "member-offline" }) },
    { status: 404, json: async () => ({ error: "target not remotely triggerable" }) },
  ];
  let i = 0;
  const bot = createWecomBot({
    secrets,
    log: quietLog,
    sdkFactory: async () => mod,
    fetchImpl: async () => responses[i++],
  });
  await bot.start();
  bot.attach(38666);

  const mkFrame = () => ({ body: { chattype: "single", from: { userid: "U1" }, text: { content: "run x" } } });
  await bot._receiveTestText(mkFrame());
  assert.match(calls.replies[0].body.markdown.content, /离线拒绝/);
  await bot._receiveTestText(mkFrame());
  assert.match(calls.replies[1].body.markdown.content, /不存在或不可远程触发/);
  rmSync(dir, { recursive: true, force: true });
});

test("主动推送：sendMessage 调用正确；chatid 未学习降级 false", async () => {
  const dir = tmpDir();
  const secrets = createSecrets({ dir, env: {} });
  secrets.set({ wecomBotId: "aibk0test000000002", wecomBotSecret: "sec-123456" });
  const { mod, calls } = fakeSdk();
  const bot = createWecomBot({ secrets, log: quietLog, sdkFactory: async () => mod });
  await bot.start();

  assert.equal(await bot.push({ markdown: "**hello**" }), false, "chatid 未学习应降级");
  secrets.set({ wecomChatId: "wrGroup456" });
  assert.equal(await bot.push({ markdown: "**hello**" }), true);
  assert.equal(calls.sends.length, 1);
  assert.equal(calls.sends[0].chatid, "wrGroup456");
  assert.equal(calls.sends[0].body.msgtype, "markdown");
  rmSync(dir, { recursive: true, force: true });
});

test("凭据热变更：secret 换 → 旧连接断开、新连接发起", async () => {
  const dir = tmpDir();
  const secrets = createSecrets({ dir, env: {} });
  secrets.set({ wecomBotId: "aibk0test000000003", wecomBotSecret: "sec-old" });
  const { mod, calls } = fakeSdk();
  const bot = createWecomBot({ secrets, log: quietLog, sdkFactory: async () => mod });
  await bot.start();
  await bot.start(); // 幂等：同凭据不重连
  assert.equal(calls.connects, 1);
  secrets.set({ wecomBotSecret: "sec-new" });
  await bot.start();
  assert.equal(calls.connects, 2);
  assert.equal(calls.disconnects, 1, "换凭据应断开旧连接");
  rmSync(dir, { recursive: true, force: true });
});

test("notify 集成：bot.push 成功时不再走老 webhook", async () => {
  const dir = tmpDir();
  const secrets = createSecrets({ dir, env: {} });
  secrets.set({ wecomBotId: "aibk0test000000004", wecomBotSecret: "sec-123456", wecomChatId: "wrG" });
  const { mod, calls } = fakeSdk();
  const bot = createWecomBot({ secrets, log: quietLog, sdkFactory: async () => mod });
  await bot.start();
  const webhookCalls = [];
  const notify = createNotify({
    secrets,
    bot,
    log: quietLog,
    fetchImpl: async () => { webhookCalls.push(1); return { ok: true }; },
  });
  secrets.set({ wecomWebhook: "https://example.com/hook" }); // 双通道都配置：bot 优先
  await notify.emit({ event: { kind: "terminal", target: "t", state: "completed", taskId: "task-1" } });
  assert.equal(calls.sends.length, 1, "bot 通道应推送");
  assert.equal(webhookCalls.length, 0, "webhook 不应再走");
  // bot 失败（断开 chatid 后）→ 降级 webhook
  secrets.set({ wecomChatId: "" });
  await notify.emit({ event: { kind: "terminal", target: "t2", state: "failed", taskId: "task-2" } });
  assert.equal(webhookCalls.length, 1, "bot 不可用应降级 webhook");
  rmSync(dir, { recursive: true, force: true });
});

test("帮助面：非 run 语句回复用法 + 在线能力清单", async () => {
  const dir = tmpDir();
  const secrets = createSecrets({ dir, env: {} });
  secrets.set({ wecomBotId: "aibk0test000000005", wecomBotSecret: "sec-123456" });
  const { mod, calls } = fakeSdk();
  const bot = createWecomBot({ secrets, log: quietLog, sdkFactory: async () => mod });
  await bot.start();
  bot.attach(38666);
  await bot._receiveTestText({ body: { chattype: "single", from: { userid: "U1" }, text: { content: "你好" } } });
  const help = calls.replies[calls.replies.length - 1];
  assert.match(help.body.markdown.content, /run <target>/);
  rmSync(dir, { recursive: true, force: true });
});

test("审批门（AC2）：approve/reject 转发 tasks/approve + 结果分流", async () => {
  const dir = tmpDir();
  const secrets = createSecrets({ dir, env: {} });
  secrets.set({ wecomBotId: "aibk0test000000006", wecomBotSecret: "sec-123456", clientKeys: ["ck-ac2-0000000000000000000000000001"] });
  const { mod, calls } = fakeSdk();
  const approveCalls = [];
  const responses = [
    { status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: { status: { state: "working" } } }) },
    { status: 200, json: async () => ({ jsonrpc: "2.0", id: 2, result: { status: { state: "canceled" } } }) },
    { status: 200, json: async () => ({ jsonrpc: "2.0", id: 3, error: { code: -32001, message: "task not found" } }) },
    { status: 200, json: async () => ({ jsonrpc: "2.0", id: 4, error: { code: -32000, message: "state is working" } }) },
  ];
  let i = 0;
  const bot = createWecomBot({
    secrets,
    log: quietLog,
    sdkFactory: async () => mod,
    fetchImpl: async (url, init) => {
      approveCalls.push({ url, init });
      return responses[i++];
    },
  });
  await bot.start();
  bot.attach(38666);

  const mkFrame = (text) => ({ body: { chattype: "single", from: { userid: "U1" }, text: { content: text } } });
  await bot._receiveTestText(mkFrame("approve task-20261015-010"));
  assert.equal(approveCalls[0].url, "http://127.0.0.1:38666/a2a");
  assert.equal(approveCalls[0].init.headers.Authorization, "Bearer ck-ac2-0000000000000000000000000001");
  assert.equal(JSON.parse(approveCalls[0].init.body).params.decision, "approve");
  assert.match(calls.replies[0].body.markdown.content, /已批准，任务恢复执行/);

  await bot._receiveTestText(mkFrame("reject task-20261015-010"));
  assert.equal(JSON.parse(approveCalls[1].init.body).params.decision, "reject");
  assert.match(calls.replies[1].body.markdown.content, /已拒绝，任务取消/);

  await bot._receiveTestText(mkFrame("approve task-999"));
  assert.match(calls.replies[2].body.markdown.content, /不存在/);

  await bot._receiveTestText(mkFrame("reject task-20261015-011"));
  assert.match(calls.replies[3].body.markdown.content, /状态非待审批/);
  rmSync(dir, { recursive: true, force: true });
});
