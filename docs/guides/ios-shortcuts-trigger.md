# iOS 快捷指令门配置（M1 · PRD-5 F4）

hub 侧已就绪：`POST /api/trigger`（契约 §5.1 人类客户端门，fire-and-forget）。本文档描述 iOS Shortcuts 侧的配置步骤，属纯配置动作，无代码变更。

## 前置条件

- hub 已部署在 CVM 且有 HTTPS 入口（M1 CVM 部署后生效；试点期可先用本机 hub 验证流程）
- 一个 clientKey（hub `.state/secrets.json` 的 `clientKeys` 池），或试点期免鉴权模式（未配置 clientKeys 时 `human` 直通）

## 快捷指令搭建步骤

1. 打开 iOS「快捷指令」app → 新建快捷指令
2. 添加「获取 URL 内容」动作：
   - URL：`https://<hub-host>/api/trigger`
   - 方法：`POST`
   - 请求头：`Authorization: Bearer <clientKey>`（配置了 clientKeys 池时必填）
   - 请求体（JSON）：
     ```json
     {
       "target": "dev-build-investm",
       "member": "mac-work",
       "vars": { "repoDir": "~/dev/InvestM" }
     }
     ```
   - `target` 必填（skill id = target id，契约 §2）；`member` 可选（同 target 多机持有时的机器指定，缺省查表选在线成员）；`vars` 可选（覆盖 target 定义的默认值）
3. 可选：添加「显示通知」动作，展示返回 JSON 的 `taskId` / `state`
4. 命名（如 `构建 InvestM`）→ 可添加到主屏幕 / 控制中心 / 锁屏，即成磁贴

## 响应语义（fire-and-forget）

| 场景 | HTTP | 响应体 |
| --- | --- | --- |
| 受理 | 202 | `{ "taskId": "...", "state": "submitted" }` |
| 成员离线（skill 存在） | 202 | `{ "state": "rejected", "reason": "member-offline" }` + 通知扇出（PRD-3 US4） |
| 查无 skill / expose: local | 404 | `{ "error": "target not remotely triggerable" }` |
| JSON 非法 | 400 | `{ "error": "bad json" }` |
| 缺 target | 400 | `{ "error": "缺少 target" }` |

执行结果不经此响应返回——终态经通知扇出（企微）送达，或经 A2A 门 `tasks/get` 查询。

## 验收场景（PRD-5 F4）

对着合盖/离线的 Mac B（mac-home）触发 → 30s 内收到离线拒绝通知：

1. iOS 磁贴触发 `dev-build-investm`（两台 Mac 都持有该 target，member 缺省时查表）
2. hub 查表发现持有成员均离线 → 202 rejected + `member-offline` 审计 + 企微 offline-reject 通知
3. 通知文案含 target 名与拒绝原因，而非沉默

前提：mac-home lite-agent 已部署并至少注册过一次（离线 = 注册表中有记录但隧道断开）。三环境部署完成后即可执行本验收。
