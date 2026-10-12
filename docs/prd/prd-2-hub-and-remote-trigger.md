# PRD-2: Hub 与远程触发

- 版本：v0.1
- 状态：Draft
- 契约引用：[contracts §4 §5](../architecture/contracts.md)
- 相关 ADR：[0002](../adr/0002-novoard-cronkit-boundary.md) [0003](../adr/0003-hub-and-spoke-agent-egress.md)
- 载体：Novoard 仓（hub 服务 + Web 面板）；agent 侧连接器在 cronkit 仓

## 背景

磁贴解决"人在电脑前"的触发；hub 解决"人不在电脑前"：手机点一下触发 Mac 部署、在 Web 面板看全部任务状态、多个入口汇聚到同一执行内核。hub 部署于 CVM（与 issue-handler 同机共存），agent 主动外连穿 NAT。

## 目标用户

用户本人 + 用户自己的客户端（手机快捷指令、Web 面板、后续 AI 客户端）。

## 用户故事

- US1：作为用户，我想在手机上点一下（iOS 快捷指令/小组件）触发家里/公司 Mac 上的部署，这样人不在电脑前也能推进工作。
- US2：作为用户，我想在一个 Web 面板看到所有 agent、所有 target、任务历史与实时状态，这样系统全局一目了然。
- US3：作为用户，我想知道触发后 Mac 到底执行了没有，Mac 离线时我要被明确告知（拒绝/入队），而不是沉默失败。
- US4：作为用户，我想在 Web 面板上直接触发任何已注册 target，与磁贴、手机触发同一套结果与历史。
- US5：作为用户，我想新增第二台机器（家里服务器）为 agent，注册即接入，不用改 hub 代码。

## 功能需求

### F1 agent 连接与注册

- agent（cronkit）启动时向 hub 发起出站 WebSocket（携带 agent token）。
- `agent.hello` 注册：上报 Agent Card、能力清单（target 目录镜像）；断线自动重连。
- hub 维护联邦注册表：在线状态、心跳（`agent.ping`）、card 版本。

### F2 任务队列与分发

- 远程触发请求 → 路由查表（contract §1 `expose: a2a` 才可远程触发）→ 任务入队 → 经隧道下发目标 agent。
- agent 离线时：默认拒绝并通知（入队策略可配置：reject / queue-with-ttl）。
- 父任务 id 写入 contextId（契约 §4），上行事件回带，审计链完整。

### F3 Web 面板

- 页面：agent 列表（在线状态）、target 目录（按 agent 分组）、任务历史（状态、耗时、触发者）、实时执行日志查看。
- 触发入口：面板上任何 target 可点击触发（走同一队列，不旁路）。
- 单页应用形态沿用 issue-handler dashboard 模式（自举：首访设口令 → 登录 → 配置）。

### F4 iOS 快捷指令门

- hub 暴露极简 HTTPS 端点（fire-and-forget）：鉴权 token + target id 即触发。
- 返回受理结果（queued/rejected-offline），详细进度走通知渠道。

### F5 部署与运维

- Docker 部署于重庆 CVM，与 issue-handler 同机；nginx 子目录反代对外（沿用 issue-handler 先例：目录挂载、不单文件挂载）。
- 凭据热配置（secrets 落盘 0600，dashboard 可改），不改代码重启即生效的部分遵循 issue-handler 模式。

## 非功能需求

- 安全：agent token 独立签发；hub 只下发白名单指令（运行 target X，非任意 shell）；远程触发全量审计。
- 时延：手机触发到 agent 收到任务，正常网络 < 2s。
- 可用性：hub 重启不丢已入队任务（队列持久化或明确丢弃并通知）。

## 验收标准

- AC1：Mac 在 NAT 后无任何入站端口，手机 4G 网络触发 Mac 部署成功，收到完成通知。
- AC2：Web 面板可见任务全生命周期（排队 → 下发 → 执行 → 终态），与 agent 侧日志对账一致。
- AC3：Mac 睡眠/离线时触发，30s 内收到"agent 离线，任务被拒绝"通知。
- AC4：第二台机器接入：安装 agent → 填 hub 地址与 token → 注册出现在面板，全程不改 hub 代码。

## 范围外

- A2A 端点与 AI 客户端（PRD-4，但 F2 队列与注册表为其预留同一底座）。
- 通知内容策略（PRD-3）。
