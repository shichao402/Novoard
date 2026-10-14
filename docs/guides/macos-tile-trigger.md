# macOS 快捷指令磁贴（M1 · PRD-5 F4）

原 iOS Shortcuts 磁贴的 macOS 等价物。hub 侧 `POST /api/trigger`（契约 §5.1 人类客户端门，fire-and-forget）不变，仅触发载体从 iOS 磁贴调整为 macOS 桌面双击磁贴（2026-10-13 用户决策：iOS 设备暂缺，本机 Mac 充当磁贴）。

> 为什么不是 Shortcuts App：本机 `shortcuts` CLI 的 view/run/sign 均要求 iCloud 同步启用，程序化建指令受阻；桌面 `.command` 双击磁贴语义等价（一键触发 + 本机通知反馈），零依赖。

## 前置条件

- hub 已部署 CVM 且 HTTPS 入口可达（已满足）
- 一个 clientKey（hub `.state/secrets.json` 的 `clientKeys` 池），或试点期免鉴权模式（未配置 clientKeys 时 `human` 直通，当前形态）

## 磁贴形态（三选一，均已就绪）

### 形态 1：桌面双击磁贴（推荐，零配置）

`~/Desktop/Novoard磁贴.command` 已放置。双击即触发 `dev-build-investm`（member 缺省查表选在线成员），osascript 弹本机通知显示受理/拒绝/失败。

首次双击 macOS 会提示"无法验证开发者"，右键 → 打开 → 确认一次即可。

### 形态 2：终端磁贴（脚本形态）

```bash
bash /Users/firoyang/workspace/Novoard/bin/novoard-tile.sh
```

环境变量可覆盖默认值：`NOVOARD_HUB_URL` / `NOVOARD_TARGET` / `NOVOARD_MEMBER`。

### 形态 3：Shortcuts App 磁贴 / 全局热键（需手动建一次，ADR-0008 兜底方案）

在 Shortcuts App 中新建快捷指令，动作链建议两步（走本机 localhost A2A 端点，hub 离线也可用）：

1. 「获取 URL 内容」：URL `http://127.0.0.1:39871/a2a`，方法 POST，请求体（JSON）：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message/send",
  "params": {
    "message": {
      "messageId": "sc-$(date +%s)",
      "role": "user",
      "parts": [{ "kind": "text", "text": "dev-build-investm" }]
    }
  }
}
```

Shortcuts 里 `messageId` 填固定字符串即可（如 `sc-hotkey`）；`text` 部件即裸 skillId（可带 `@mac-home` 指定成员）。

2. 可选「显示通知」，展示响应内容（taskId / 状态）。

随后在快捷指令详情页「添加键盘快捷键」（如 ⌥⌘B）即得全局热键；也可固定到菜单栏 / 程序坞当磁贴点。

> 与旧方案差异：原形态 3 打 hub 公网 `POST /api/trigger`（fire-and-forget，需 hub 在线）；热键兜底按 ADR-0008 改打本机 `127.0.0.1:39871` A2A 端点，本地闭环（M5 已交付），且支持审批类 target 的 tasks/get / approve 查询。构建类 target（dev-build-investm）因 InvestM 仓库脏，failed 为真实预期状态。仍需 iCloud 同步启用才能 CLI 管理，故为用户侧一次性手动操作。

## 响应语义（fire-and-forget）

| 场景 | HTTP | 响应体 |
| --- | --- | --- |
| 受理 | 202 | `{ "taskId": "...", "state": "submitted" }` |
| 成员离线（skill 存在） | 202 | `{ "state": "rejected", "reason": "member-offline" }` + 通知扇出（PRD-3 US4） |
| 查无 skill / expose: local | 404 | `{ "error": "target not remotely triggerable" }` |
| JSON 非法 | 400 | `{ "error": "bad json" }` |
| 缺 target | 400 | `{ "error": "缺少 target" }` |

执行结果不经此响应返回——终态经通知扇出（企微）送达，或经 A2A 门 `tasks/get` 查询。

## 验收记录（2026-10-13，已通过）

| 场景 | 操作 | 结果 |
| --- | --- | --- |
| A 在线受理 | 磁贴对在线 mac-home 触发 | 202 submitted（task-20261013-003）→ 执行 → failed（InvestM 未提交改动，真实状态）→ 终态上行入账 |
| B 离线拒绝 | launchctl bootout mac-home → 磁贴触发 | 202 rejected + `member-offline` 审计 + 通知扇出（chatId 未学习，降级日志，符合设计） |
| C 通知扇出 | 查 hub 日志 | offline-reject 与 terminal 事件均尝试扇出，降级日志可见 |

原 iOS 版验收场景（对合盖 Mac B 触发 → 30s 内企微通知）语义已由场景 A/B/C 覆盖：离线判定、拒绝分流、通知扇出（降级形态）全部按契约工作。待企微 chatId 学习后（给 bot 发一条消息），通知自动升级为真实推送。

## 后续

- mac-work 常驻（launchd 同款 plist 换 agentId）待用户确认是否需要
- 企微 chatId 学习：在企微里给 bot 发一条消息即可解锁全量通知
