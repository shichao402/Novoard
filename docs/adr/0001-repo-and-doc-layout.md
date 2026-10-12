# ADR-0001: 仓库与文档布局

- 状态：Accepted
- 日期：2026-10-12
- 讨论来源：2026-10 快捷操作面板系列讨论收尾，用户拍板"拆 PRD、开工、建 GitHub 仓库、沉淀文档"。

## Context

Novoard 的代码还没写，但架构讨论已经过六轮演进（调研 → 薄桥 → hub → A2A 边界 → 全系统 A2A → 契约路由纪律），产出了大量值得留存的结论。若直接开工，这些讨论会散失在对话历史里，无法被后续实现者（包括未来的 AI 助手会话）引用。

同时系统天然跨两个代码载体（Novoard 仓 hub + cronkit 仓 agent），契约必须有一个唯一的存放地。

## Decision

1. GitHub 公开仓库 `shichao402/Novoard`，本地位于 `/Users/firoyang/workspace/Novoard`。
2. 文档全部放 `docs/` 下，分五个子目录：
   - `adr/`：架构决策记录，四位数编号
   - `architecture/`：系统总览、拓扑、契约定义（SSOT）
   - `roadmap/`：里程碑
   - `prd/`：产品需求，按能力域拆分多份
   - `research/`：外部调研（同类产品、业界参照、协议研究），保留来源链接
3. 文档先于代码：M0 阶段只产出文档与契约定义，代码从 M1 开始。

## Consequences

- 收益：讨论结论全部落地为可引用文档；契约 SSOT 明确（后续 cronkit 侧实现引用本仓的 schema，而不是各自定义）。
- 代价：起步多一轮文档工作；文档需要随实现演进维护。
- 替代方案否决：文档散在 cronkit 仓 `document/` 下——会模糊"cronkit 只是系统一个 agent"的定位，且 hub 决策与 cronkit 无关。
