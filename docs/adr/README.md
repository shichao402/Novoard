# Architecture Decision Records

架构决策记录。一条 ADR 回答一个"为什么这样做而不是那样做"，正文尽量自包含：脱离对话上下文也能读懂。

## 索引

| 编号 | 标题 | 状态 | 日期 |
| --- | --- | --- | --- |
| [0001](0001-repo-and-doc-layout.md) | 仓库与文档布局 | Accepted | 2026-10-12 |
| [0002](0002-novoard-cronkit-boundary.md) | Novoard 与 cronkit 的分界：触发模型决定形态 | Accepted | 2026-10-12 |
| [0003](0003-hub-and-spoke-agent-egress.md) | hub-and-spoke 拓扑与 agent 主动外连 | Accepted | 2026-10-12 |
| [0004](0004-a2a-as-common-language.md) | A2A 作为全系统通用语 | Accepted | 2026-10-12 |
| [0005](0005-route-by-definition-table-lookup.md) | 定义时判断，路由只查表 | Accepted | 2026-10-12 |
| [0006](0006-tech-stack-baseline.md) | 技术栈基线：Node hub 与 lite-agent | Proposed | 2026-10-12 |
| [0007](0007-cronkit-as-reference-only.md) | cronkit 退位为参考实现 | Proposed | 2026-10-12 |

## 约定

- 编号四位数递增，文件名 `NNNN-kebab-case-title.md`，从 [TEMPLATE.md](TEMPLATE.md) 起草。
- 状态：Proposed → Accepted →（被取代时）Superseded。被取代不删除，在正文标注接替者。
- 每条 ADR 记录讨论来源（日期与主题），便于回溯原始语境。
