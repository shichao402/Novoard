# Novoard

个人快捷操作面板 + 自动化 hub。类比 iOS 快捷中心：把散落各处的自定义操作（本地部署、环境拉起、巡检脚本）封装成一键磁贴，配合事件触发器与多端入口（桌面 / 手机 / AI 助手），在任何地方触发、在任何地方收到结果。

```
客户端（企微 bot / 手机快捷指令 / AI 助手 / Web 面板）
        │
        ▼
  Hub（CVM 常驻服务）── 任务队列 · 自动化规则 · 通知扇出 · 审计
        │  A2A over 出站隧道（agent 主动外连，穿 NAT）
        ▼
  Agents（novoard-agent 四平台二进制 · 身份：mac-work / mac-home / win-dev / intranet-weekly）
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
| [docs/roadmap](docs/roadmap/roadmap.md) | 里程碑 M0-M8 |
| [docs/prd](docs/prd/README.md) | 产品需求文档（按能力域拆分） |
| [docs/research](docs/research/0001-market-scan.md) | 外部调研：同类产品、业界参照、A2A 协议；扩展形态推演与接入调研 |
| [agents](agents/mac-work/targets.yaml) | 试点 target 定义（三 agent 的 targets.yaml + stepTemplates，各 lite-agent 以本仓为上游同步） |

## 状态

M8 用户体系与管理控制台已落地：全新安装通过首访向导创建第一个 `superadmin`，随后由会话 + CSRF、内置/自定义角色、target 范围和具名 PAT 统一授权；Agent 与 artifact 契约升至 2.0。Dashboard 已升级为 React 19 + Ant Design 6 / ProComponents 3 + Vite 7 + React Router 7，并仍由同一个原生 Node Hub 在根路径托管。Agent 位于独立仓 [novoard-agent](https://github.com/shichao402/novoard-agent)。见 [roadmap](docs/roadmap/roadmap.md)。

## 开发

```bash
npm install                # 内网镜像
npm install --prefix web   # 管理控制台依赖
npm run dev                # node --watch 热重载
npm test                   # 契约门禁 + Hub node:test
npm run test:all           # Hub + 前端 + Playwright 全门禁
NOVOARD_PORT=38666 npm start
```

首次本地启动前先执行 `npm run build:web`。空 `.state` 访问 `/` 会进入公开 first-claim 初始化向导；创建首位超级管理员后入口永久关闭。生产地址固定为 `https://novoard.firoyang.com/`。

目录约定：`.state/`（hub 运行态，不进 git）下含 `install.json`、`identity.json`、`sessions.json`、`secrets.json`、`audit/`、`queue/`、`artifacts/`。端点：`/`（管理控制台）、`/tunnel`（WS 隧道）、`/a2a`（JSON-RPC）、`/.well-known/agent-card.json`、`/api/trigger`（会话/PAT 快捷操作门）。

Agent（面板/runner/编辑器/接入向导）已拆分至独立仓 [novoard-agent](https://github.com/shichao402/novoard-agent)：Windows/macOS 通过桌面托盘轻壳承载同一 SEA sidecar，Linux 分发无头 SEA zip；契约 SSOT 仍以本仓 `docs/architecture/schemas/` 为准。契约 2.0 要求每个 Agent token 唯一绑定 `agentId`，artifact 带 taskId 与 sha256 digest；各成员使用 2.x Release 接入。

## 背景讨论

本仓库的文档沉淀自 2026-10 期间与 AI 助手的多轮架构讨论：从"快捷操作面板调研"出发，经薄桥 → hub-and-spoke → A2A 集成 → 全系统 A2A 通用语 → 契约路由纪律的演进。各文档中标注了对应讨论来源。
