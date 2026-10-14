# ADR-0007: cronkit 退位为参考实现

- 状态：Accepted（载体决策已由 [ADR-0008](0008-desktop-shell-decision.md) 接续完成）
- 日期：2026-10-12
- 讨论来源：2026-10-12 cronkit 依赖复核。前轮判断"PRD-1 落地载体与 contracts steps 语法实质绑定 cronkit、不可删除"，用户推翻："不用，只是可以参考而已"。同轮提出三个试点接入（企微 bot、两台 Mac 的 dev builder、内网周报 agent），验证路径均不经过 cronkit。

## Context

ADR-0002 将 cronkit 定位为"系统中的第一个 A2A agent"，PRD-1 以 cronkit 仓为载体，contracts 的 steps 语法直接继承 cronkit 既有语法。复核发现两处事实动摇这一定位：其一，Novoard 立仓哲学是"面向契约不面向项目"（ADR-0001 立仓时即防过一次）；其二，cronkit 实为 Windows 托盘程序（NSIS win-x64 打包），而首个真实 agent 需要跑在 Mac 开发机与内网服务器上——形态本就对不上。三个试点接入构成的验证路径完全不经过 cronkit。

## Decision

cronkit 从架构必需项退位为参考实现：PRD-1 的能力清单（磁贴/热键/托盘/本地 cron/执行内核）与 contracts 的 steps 语法以 cronkit 为参照原型，但落地载体、实现形态与语法演进权不绑定 cronkit 仓。Novoard 只面向契约三条（Agent Card、ops/A2A 帧、到 hub 的连接）。ADR-0002 的分界标准（触发模型决定形态）不变，变化的仅是 cronkit 的角色：从"第一个 agent 实例"变为"能力与语法的参照原型"。

## Consequences

- 收益：首个真实 agent（Mac lite-agent）不背"先移植 cronkit"的前置；契约实现无关性从第一天就被两个环境（办公 Mac / 内网服务器）验证；agent 生态向"任何契约实现"开放。
- 代价/待办：既有文档需要批量修订——PRD-1 载体改写、roadmap M1 重排（原 M1 落在 cronkit 仓）、README/overview 叙述、ADR-0002 正文标注本文、contracts steps 语法注明"参考 cronkit 原型、演进权归本契约"、ADR-0006 agent 行修订。批量修订随试点接入 PRD 落地一并进行，避免二次返工。
- 替代方案否决：
  - 维持载体绑定（前轮判断）：与"面向契约不面向项目"的立仓哲学矛盾，且被试点路径事实性绕开；Windows-only 形态与 Mac/内网首落地点不匹配。
  - 抹除 cronkit 全部痕迹：矫枉过正——作为能力参照与语法原型仍有参考价值，保留参考地位。
