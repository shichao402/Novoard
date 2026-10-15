# ADR-0006: 技术栈基线：Node hub 与 lite-agent

- 状态：Accepted
- 日期：2026-10-12
- 修订：2026-10-12 agent 形态与留白项定稿时点依 ADR-0007 / PRD-5 更新（原"cronkit Electron 既有栈"改为 lite-agent，里程碑编号随 roadmap 重排调整）；同日 hub HTTP 框架与语言细节实测定稿（issue-handler 实为 `node:http` 零框架，候选 Fastify / Express / Hono 全部否决，回填已定项）；同日任务队列持久化定稿（JSONL 文件队列 + 扫尾重放，SQLite 否决：native 依赖链与 Docker Alpine 摩擦、单用户量级无查询瓶颈）；同日 A2A 实现定稿（自实现，不引入社区 SDK——A2A spec 语义未稳定，正式版发布后走契约 §0 变更流程评估跟进；至此 M1 动工前置留白项全部清零）；2026-10-13 lite-agent 语言定稿（Node，同族复用，`src/lite-agent/`；试点 target YAML 集合随落地顺序第 1 步落库 `agents/`）；2026-10-13 企微 bot 通道定稿；2026-10-15 Web 面板留白由 [ADR-0009](0009-hub-management-console.md) 关闭，Hub 后端仍为原生 `node:http`
- 讨论来源：2026-10-12 PRD 与架构文档核对（技术栈确认讨论）

## Context

M0 文档阶段收尾、实现动工在即，但技术栈决策散落在 roadmap / overview / PRD 各处：语言族与运行形态已定（Node hub、lite-agent），框架级选型（HTTP 框架、前端框架、队列持久化）却是空白，且没有任何单一文档承载这些决定。契约 v0.1 评审定稿在即，需要一个决策点把"已定项"冻结为基线、把"留白项"显式列出并给出定稿时点，避免实现期各自口头拍板造成分叉。

## Decision

技术栈以"复用既有资产"为基线：hub 用 Node，沿用 issue-handler DNA（统一 server、JSONL 流水、dashboard、凭据热配置）；agent 侧为新写 lite-agent（能力清单与 steps 语法参照 cronkit 原型，ADR-0007），语言选型列入留白项，桌面 Electron 形态后置至载体决策。框架级选型同为留白项，在对应里程碑动工前定稿并回填本 ADR。

### 已定项

| 层 | 选型 | 依据 |
| --- | --- | --- |
| hub 语言/运行时 | Node | roadmap M1「hub 服务骨架（Node，issue-handler DNA）」 |
| hub 部署形态 | CVM Docker + nginx 根域根路径反代 | overview 部署形态、ADR-0009 |
| hub HTTP 框架 | 原生 `node:http` + `ws`（同一 server 升级挂载），零 web 框架 | 2026-10-12 实测 issue-handler 形态定稿：server.mjs 即 `node:http` + 手写 http-helpers，零框架依赖，"同款"约束指向零框架；hub 路由面小（REST 门 + A2A 端点 + card + dashboard），中间件生态无发力点；WebSocket 无论选何框架终都挂 `ws`，框架零增益 |
| hub 后端语言细节 | 纯 JS（ESM `.mjs`，Node ≥ 22，后端零构建） | issue-handler 同款：`node --watch` 开发、`node --test` 测试；CVM Docker 直接跑后端源码；管理控制台单独构建后作为静态产物进入镜像（ADR-0009） |
| agent 形态 | lite-agent：两台 Mac（dev builder）+ 内网服务器（周报）；cronkit 退位为参照原型，桌面 Electron 形态（托盘/热键）后置至载体决策 | ADR-0007、PRD-5 |
| 协议面 | A2A 字面对齐（方法名/字段名/错误码照抄 spec）+ 隧道私有信封；Agent Card JWS 签名 | contracts §2 §4（v1.0 决策①）、ADR-0004 |
| A2A 实现 | 自实现：原生 `node:http` 手写 JSON-RPC 2.0 端点 + `ws` 隧道帧编解码，不引入社区 SDK | 2026-10-12 定稿：字面对齐纪律下端点面极小（`message/send` / `tasks/get` / `tasks/cancel` 三方法 + JSON-RPC 包装），手写比 SDK 更贴近 contracts SSOT，零新增依赖；SDK 中间层与"方法名/字段名/错误码必须可字面透传"纪律天然相斥；A2A 社区 spec 语义尚未稳定，绑 SDK 会把上游版本节奏传导进契约层——跟随策略：spec 出正式版后走契约 §0 变更流程评估跟进，届时再议是否引入 SDK |
| 审计/存储基线 | JSONL 事件流水，hub 与 agent 各落一份 | contracts §6 |
| 任务队列持久化 | JSONL 文件队列（append-only，重启扫尾重放），hub 依赖面保持 ws / yaml / ajv 三个不动 | 2026-10-12 定稿：实测 issue-handler 持久化 DNA（events.mjs append-only JSONL + state.mjs 单 JSON 文件）无 SQLite；PRD-2 NFR"重启不丢已入队任务"用 JSONL 扫尾重放达成，语义上是断线重放语义（契约 §4.4）在 hub 侧的镜像；SQLite 引入 native 编译链（better-sqlite3 node-gyp），与 CVM Docker Alpine 镜像有安装摩擦，单用户量级查询走内存索引即可 |

### 留白项（动工前定稿回填）

| 项 | 定稿时点 | 候选与约束 |
| --- | --- | --- |
| Web 面板前端 | 已于 2026-10-15 定稿 | React 19 + TypeScript + Ant Design 6 / ProComponents 3 + Vite 7 + React Router 7，详见 ADR-0009 |

全部留白项已清零；Web 面板由 ADR-0009 接续维护。

2026-10-13 lite-agent 语言定稿：Node（纯 JS ESM `.mjs`，Node ≥ 22，零构建，与 hub 同族）。依据：① 复用优先——契约帧编解码、信封、WS 隧道、schema 自检在 hub 已有实现（frames.mjs / tunnel.mjs），lite-agent 直接复用同款模块与心智，Mac 与内网服务器两套部署共用一份实现；② autoworks 周报脚本是 Python 进程外调用（research 0004 命令化姿势：`./report.py` 单入口 + 退出码语义），lite-agent 只需 shell 步骤能力即可承载，语言无强约束；③ Go 单二进制的运维优势在"个人 3 节点 + Docker 镜像统一交付"场景不成立。lite-agent 实现：`src/lite-agent/`（hub 仓内同仓多部署目标，模块直接 import hub 侧实现）。

### 已定项（增补）

| 层 | 选型 | 依据 |
| --- | --- | --- |
| lite-agent 语言 | Node（纯 JS ESM，与 hub 同族；`src/lite-agent/`，模块级复用 frames/tunnel/schema 自检） | 2026-10-13 定稿，理由见上 |

## Consequences

- 收益：实现期不再重新争论语言族；留白显式化并有明确定稿时点，防止"默认拍板"；与 ADR-0002/0007 边界一致，cronkit 内部栈不被本仓决策绑架。
- 代价：框架级决策推迟到各里程碑动工前，本 ADR 需要随讨论多次回填（状态保持 Proposed 直到留白项清零或用户确认基线）。
- 替代方案否决：
  - Go / Rust 写 hub：单二进制部署与性能占优，但与 issue-handler DNA（Node）割裂，复用 JSONL 流水、dashboard、热配置模式的成本高于收益；单用户系统无性能瓶颈。
  - Python 写 hub：脚本生态好，但常驻服务 + WebSocket 长连接的工程化与既有模式复用均弱于 Node。
  - hub 与 agent 统一到同一栈（hub 也跑桌面运行时）：hub 是服务器形态，桌面运行时对 CVM 部署是纯负担（ADR-0002 触发模型决定形态的引申）。
