# Novoard

个人快捷操作面板 + 自动化 hub。类比 iOS 快捷中心：把散落各处的自定义操作（本地部署、环境拉起、巡检脚本）封装成一键磁贴，配合事件触发器与多端入口（桌面 / 手机 / AI 助手），在任何地方触发、在任何地方收到结果。

```
客户端（企微 bot / 手机快捷指令 / AI 助手 / Web 面板）
        │
        ▼
  Hub（CVM 常驻服务）── 任务队列 · 自动化规则 · 通知扇出 · 审计
        │  A2A over 出站隧道（agent 主动外连，穿 NAT）
        ▼
  Agents（Mac lite-agent × 2 · 内网 lite-agent）── 本地 cron · target 定义 → 执行内核
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

[cronkit](https://github.com/shichao402/cronkit)（既有仓库）为能力清单与 steps 语法的参照原型，不绑定为实现载体（[ADR-0007](docs/adr/0007-cronkit-as-reference-only.md)）。真实 agent——两台 Mac 的 dev builder lite-agent、内网服务器的周报 lite-agent——按契约三条（Agent Card、ops/A2A 帧、到 hub 的出站隧道）独立实现。桌面 UI 形态（托盘/热键/磁贴）后置至载体决策（PRD-1 / PRD-5）。

## 文档

| 目录 | 内容 |
| --- | --- |
| [docs/adr](docs/adr/README.md) | 架构决策记录（ADR） |
| [docs/architecture](docs/architecture/overview.md) | 系统总览、拓扑、契约 |
| [docs/roadmap](docs/roadmap/roadmap.md) | 里程碑 M0-M5 |
| [docs/prd](docs/prd/README.md) | 产品需求文档（按能力域拆分） |
| [docs/research](docs/research/0001-market-scan.md) | 外部调研：同类产品、业界参照、A2A 协议；扩展形态推演与接入调研 |
| [agents](agents/mac-work/targets.yaml) | 试点 target 定义（三 agent 的 targets.yaml + stepTemplates，各 lite-agent 以本仓为上游同步） |

## 状态

M0（文档与契约）已收官；M1 试点接入进行中：hub 骨架已落地（`src/` 八模块，原生 `node:http` + `ws` + `yaml` + `ajv`，契约 v1.0 字面实现）；试点 target 定义已落库（`agents/` 三 agent targets.yaml + 共用模板，lite-agent 语言定稿 Node）；lite-agent 已落地（`src/lite-agent/` 六模块：模板展开、四类 step 执行内核、单并发、断线重连 + 帧重放、双侧审计，e2e 全链路全绿）；通知扇出与最小规则引擎已落地（`src/notify.mjs` 企微 markdown + 频控；`src/rules.mjs` 终态匹配 + ruleTrace 防环 + 动作不旁路）。测试 24 项全绿。待 CVM 部署、企微 bot 与三环境部署。见 [roadmap](docs/roadmap/roadmap.md)。

## 开发

```bash
npm install                # 内网镜像
npm run dev                # node --watch 热重载
npm test                   # node --test
NOVOARD_PORT=38666 npm start
```

目录约定：`.state/`（hub 运行态，不进 git）下 `secrets.json`、`audit/`、`queue/`、`artifacts/`；`.agent-state/`（lite-agent 运行态）下 `audit.jsonl`、`replay.jsonl`。端点：`/`（dashboard）、`/tunnel`（WS 隧道）、`/a2a`（JSON-RPC）、`/.well-known/agent-card.json`、`/api/trigger`（快捷指令门）。

lite-agent（两台 Mac / 内网服务器）：

```bash
node src/lite-agent/main.mjs    # agent.json 或环境变量：NOVOARD_AGENT_ID / NOVOARD_HUB_URL / NOVOARD_AGENT_TOKEN
```

## 背景讨论

本仓库的文档沉淀自 2026-10 期间与 AI 助手的多轮架构讨论：从"快捷操作面板调研"出发，经薄桥 → hub-and-spoke → A2A 集成 → 全系统 A2A 通用语 → 契约路由纪律的演进。各文档中标注了对应讨论来源。
