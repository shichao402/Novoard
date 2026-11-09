# ADR-0012: cronkit 被 novoard-agent 吸收

- 状态：Accepted
- 日期：2026-11-09
- 讨论来源：2026-11-09 cronkit 生态位讨论。先后评估了 cronkit 作 agent 下游、作平级 A2A 端点、保留自带调度器三种形态，都被否决
- 关系：修订 [ADR-0007](0007-cronkit-as-reference-only.md)（cronkit 角色从参考原型改为被吸收后退役）；落实 [ADR-0003](0003-hub-and-spoke-agent-egress.md) 中"本地 cron 归 agent"，调度不上 hub 不变

## Context

cronkit 现在在 Windows 工作机上每天自动干活：更新几个 SVN 工程、预热 Unity、空闲时关 Rider。它一个进程包办托盘界面、调度、执行和领域工具。novoard-agent 已经是本机唯一的联邦成员，契约里也给 target 留了 `schedule` 字段，但 agent 至今不会按它触发。

两边各有一半：cronkit 有成熟的调度语义和领域工具，agent 有身份、隧道、审批、控制台。继续并存会出现双执行内核、双调度器，同一台机器两套配置。

## Decision

1. 分界标准：一次性命令（跑完即退出）做成 novoard-agent 能力包，由 agent 内核调度；常驻、带状态、自恢复的能力做独立 A2A 成员。后者另行决策，不在本 ADR 范围。
2. 调度归 novoard-agent 内核，从 cronkit 移植，语义以 cronkit 的测试为准，不重写。hub 不做定时。
3. 领域工具外置为能力包，内核不 import 任何领域代码：
   - `versionControl`、`general`：新仓 novoard-packs；
   - `osg`：工蜂 OSGToolset。
4. 能力包协议归 novoard-agent 仓（其 ADR-0019）；target 中 `uses:` 的写法与来源清单的下发归本契约。
5. 来源清单存 hub，经 `agent.hello.ack` 下发。内网地址只存在 hub 私有数据里，不进入公开仓库。
6. cronkit 迁移完成后退役，名字不保留。

## Consequences

- 契约 v2.4（次版本）：target 新增 `uses` step、`oncePerDay`、`deadline`；`agent.hello.ack` 新增 `packSources`。
- 预检失败复用 `notify.owner`，不新增帧。
- 实现单：hub 侧 [PRD-6](../prd/prd-6-local-schedule-and-capability-packs.md)；agent 侧 novoard-agent PRD-7；跨仓进度见 [roadmap](../roadmap/roadmap.md)「跨仓：cronkit 吸收」。
- 被否决的方案：
  - cronkit 作下游：双执行内核。
  - cronkit 作平级 A2A 端点：Windows-only，同机两个成员身份。
  - cronkit 保留调度器：总复杂度更高，下一个需要定时的能力无处安放。
  - 领域代码进内核：内核随能力膨胀。
  - 通用能力包随 agent 安装包内置：agent 随能力发版，且出现两套包生命周期。
