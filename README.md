# Novoard

个人快捷操作面板 + 自动化 hub。类比 iOS 快捷中心：把散落各处的自定义操作（本地部署、环境拉起、巡检脚本）封装成一键磁贴，配合事件触发器与多端入口（桌面 / 手机 / AI 助手），在任何地方触发、在任何地方收到结果。

```
客户端（Web 面板 / 手机 / AI 助手）
        │
        ▼
  Hub（CVM 常驻服务）── 任务队列 · 自动化规则 · 通知扇出 · 审计
        │  A2A over 出站隧道（agent 主动外连，穿 NAT）
        ▼
  cronkit（Mac · A2A agent）── 磁贴 / 热键 / 本地 cron → 执行内核
        │
        ▼
  本地部署实例（部署完成即在固定实例打开）
```

核心纪律一句话：判断在定义时做完，且只做一次；路由不判断，只查表。

## 仓库定位

Novoard 是整个系统的产品仓库，承载：

- Hub 服务实现（部署于 CVM）
- Web 面板
- 全系统契约 SSOT：target 定义 schema、Agent Card 生成规则、路由表语义

桌面 agent 与执行内核在既有仓库 [cronkit](https://github.com/shichao402/cronkit) 中演进，Novoard 与 cronkit 通过 A2A 对接，互不为载体。

## 文档

| 目录 | 内容 |
| --- | --- |
| [docs/adr](docs/adr/README.md) | 架构决策记录（ADR） |
| [docs/architecture](docs/architecture/overview.md) | 系统总览、拓扑、契约 |
| [docs/roadmap](docs/roadmap/roadmap.md) | 里程碑 M0-M4 |
| [docs/prd](docs/prd/README.md) | 产品需求文档（按能力域拆分） |
| [docs/research](docs/research/0001-market-scan.md) | 外部调研：同类产品、业界参照、A2A 协议 |

## 状态

M0（文档与契约定义）进行中。代码尚未开始，见 [roadmap](docs/roadmap/roadmap.md)。

## 背景讨论

本仓库的文档沉淀自 2026-10 期间与 AI 助手的多轮架构讨论：从"快捷操作面板调研"出发，经薄桥 → hub-and-spoke → A2A 集成 → 全系统 A2A 通用语 → 契约路由纪律的演进。各文档中标注了对应讨论来源。
