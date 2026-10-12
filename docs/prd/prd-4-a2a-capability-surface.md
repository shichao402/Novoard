# PRD-4: A2A 能力面

- 版本：v0.1
- 状态：Draft
- 契约引用：[contracts §2 §4](../architecture/contracts.md)
- 相关 ADR：[0004](../adr/0004-a2a-as-common-language.md) [0005](../adr/0005-route-by-definition-table-lookup.md)
- 载体：Novoard 仓（hub A2A server + 网关）；agent 侧 card 与 localhost 端点在 cronkit 仓

## 背景

用户日常在 IM 里与 AI 助手（With 等）协作。"AI 帮我触发部署 / 巡检"是价值闭环最近的一条路：AI 读取能力声明自行决定调用，hub 零 LLM。A2A 是全系统通用语（hub ↔ cronkit 之间即是 A2A），对外能力面是同一协议的自然延伸。

## 目标用户

用户的 AI 客户端（With、Claude Code、未来其他 agent），最终受益人是用户本人。

## 用户故事

- US1：作为用户，我想让 IM 里的 AI 助手直接替我触发 Mac 上的 target（"帮我把 InvestM 部署到本地"），这样在对话中就能推进工作。
- US2：作为用户，我想让 AI 先查我的能力清单（Agent Card）再决定调什么，这样不需要为每个 AI 客户端定制集成。
- US3：作为用户，高危 target 被 AI 触发时要过我这一关（审批门），我在 IM 里回一句即可放行。
- US4：作为用户，我想让 AI 实时看到执行进度（流式），这样长任务不会"发出去就黑箱"。

## 功能需求

### F1 Hub Agent Card（聚合）

- `/.well-known/agent-card.json`：聚合所有在线成员 card 的 skills，JWS 签名。
- card 动态生成：成员注册/更新 card 时同步刷新（`card.update` ops 帧）。
- skill 描述由 target title + 参数说明派生，面向 AI 可读。

### F2 A2A 端点

- JSON-RPC 2.0 over HTTPS：`message/send`、`message/stream`、`tasks/get`、`tasks/cancel`。
- 路由即查表：skill id 在聚合 card → 建 task 入队；查无 → 拒绝（ADR-0005）。
- `message/stream` 映射到任务队列的下发与 agent 上行 SSE，步骤级进度透传给委派方。
- PushNotificationConfig：终态回推委派 AI（与用户通知渠道互补、各走各的）。

### F3 审批门全链路

- target `requiresApproval: true` → task 转 input-required → 沿隧道透传到 agent。
- 恢复入口三选一：IM 里 AI 转问用户后回填、Web 面板点确认、本地磁贴确认；状态只有一份，任一入口恢复同一 task。
- 超时策略：审批门默认 TTL（如 10 分钟），超时自动 rejected 并通知。

### F4 授权矩阵

- 网关维护"哪个 A2A 客户端能打哪个成员/哪类 skill"的授权表，定义时维护（白名单数据），运行时查表。
- 成员 card JWS 签名验证；agent token 与 A2A 客户端 key 分离。

### F5 agent 侧 localhost A2A（cronkit 仓实现）

- cronkit 起 localhost A2A 端点，磁贴/热键即本机 A2A 客户端（实现允许内部 IPC 起步，语义对齐契约）。
- hub 断连时 localhost 端点完整可用（离线优先）。

## 非功能需求

- hub 零 LLM：语义翻译永远在委派方；hub 不解析自然语言。
- 协议税对冲：高频小操作建议合并为粗粒度 skill（定义时决策）。
- 安全：A2A 任务全量审计；鉴权在 HTTP 层，身份不走 payload（spec 原则）。

## 验收标准

- AC1：AI 客户端 GET card → message/send 触发部署 → stream 收到步骤级进度 → 终态收到 push，全程无人工介入。
- AC2：AI 触发 `requiresApproval: true` 的 target，task 停在 input-required；用户在 IM 回复后 task 继续执行至终态。
- AC3：AI 请求一个未暴露的 target（`expose: local`），hub 返回明确的"能力不存在"，不建 task。
- AC4：授权矩阵拒绝未授权客户端对某成员的调用，审计留痕。

## 范围外

- 多租户（A2A v1.0 多逻辑 card）：单用户系统暂不需要。
- AI 客户端侧的实现（With 如何成为 A2A client 是对方的事，本仓只保证门开着）。
