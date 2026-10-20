# ADR-0010: 成员身份独立成 SSOT，在线状态降为覆盖层

- 状态：Accepted
- 日期：2026-10-20
- 讨论来源：成员令牌签发后"不上线就看不到、也删不掉"的排查与修复

## Context

成员凭据原先以 `agentId → sha256(token)` 的形式存在 `secrets.json`，而成员是否存在于系统里，只由内存注册表快照决定：`registry.register()` 在 agent 通过隧道 `agent.hello` 之后才把成员写进 Map，`markOffline()` 保留 card 但进程重启即全部丢失。

管理面板的成员表格以注册表为行、以 secrets 里的 agentId 集合为列，在前端做 join。这带来两个直接后果：

- 签发凭据后、agent 尚未首次接入前，该 agentId 在界面上完全没有行，既看不到"已签发"也无法吊销，只能等它上线或手工改文件；
- hub 重启后，所有离线成员从列表消失，直到重连才重新出现，而它们的凭据一直有效。

根因不是前端少渲染了一列，而是"成员"这个概念被拆成两处：身份在 `secrets`，在场在 `registry`，没有一个地方能回答"系统里有哪些成员"。

## Decision

成员身份独立为持久化目录 `members.json`（`src/members.mjs`），作为成员概念的唯一 SSOT：

- 记录 `agentId`、`tokenHash`、`tokenLastFour`、`createdAt`、`tokenIssuedAt`、`tokenRotatedAt`；
- 签发、轮换、吊销、鉴权全部经由该目录，不再读写 `secrets.json`；
- `secrets.json` 退回"本机单值/列表集成配置"，`agentTokenHashes` 字段废弃，启动时一次性导入并摘除；
- 运行期注册表降级为在场覆盖层：只回答"此刻谁连着、card 是什么"，允许随时重建；
- 对外 API 收口为 `GET /api/members` 与 `POST|DELETE /api/members/:agentId`，由服务端合成"身份 + 在场"，前端不再自行 join；`/api/targets` 保留为同源的兼容视图，`/api/status` 的 members 也走同一份合成结果。

配套边界：凭据视图与签发/吊销同为 superadmin，避免出现"admin 能看不能改"的中间态；吊销在线成员时同步从注册表摘除 card，避免聚合 Agent Card 继续暴露已失效成员。

## Consequences

- 收益：成员列表与在线状态彻底解耦，"已签发未接入"与"重启后离线"两类成员都可见可控；成员凭据只有一个写入点，不存在两份真相漂移；面板与 API 口径一致。
- 代价：新增一个状态文件与一次启动期迁移；`members.json` 需要 fail-closed 校验（schemaVersion、agentId 规范、哈希格式），损坏时拒绝启动而不是静默降级。
- 迁移：旧 `secrets.json` 含 `agentTokenHashes` 时，启动导入 `members.json` 后摘除该字段；已有同名成员不被历史记录覆盖，保证目录优先。迁移来的记录签发时间未知，`tokenIssuedAt` 记 `null` 而非伪造时间。
- 不变：token 仍是 `nva_` 前缀、只允许 WebSocket Upgrade 与 artifact 上传；明文仍只在签发响应出现一次；每帧 task/member 校验与契约 v2.0 语义不动。
