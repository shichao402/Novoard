# Roadmap

Novoard 里程碑序列。每个里程碑独立可交付、可验收；已完成项只记目标、交付结论与沉淀，过程细节留在 commit 与 ADR 中。

排序原则（ADR-0007）：试点接入先行，用真实点位验证契约与 PRD 验收面；随后逐域完备化；桌面本地体验因载体未定后置为 M5。M7+ 是 M7 的收尾批次而非独立编号，保留该编号以便与历史记录对齐。

## 当前状态

- 最新交付：v0.3.5（2026-10-20），对应 M10
- 契约版本：2.2，SSOT 在 [contracts.md](../architecture/contracts.md)，12 张 JSON Schema 在 [schemas/](../architecture/schemas/)
- 现役成员：mac-home、dev-build-investm-work 常驻，win-dev 按需
- 测试基线：Hub 后端 138 · 前端组件 10 · Playwright 首装闭环 1 · Agent 120 · 契约一致性夹具 34
- 进行中：无；后续候选见文末「里程碑之外」

## 进度总览

| 里程碑 | 主题 | 状态 | 主要版本 |
| --- | --- | --- | --- |
| M0 | 契约与文档 | 收官 2026-10-12 | 契约 v1.0 |
| M1 | 试点接入与 hub 起步 | 收官 2026-10-13 | — |
| M2 | Hub 完备与远程触发 | 收官 2026-10-13 | 契约 v1.1 |
| M3 | 通知与自动化规则完备化 | 收官 2026-10-14 | — |
| M4 | A2A 能力面完备化 | 收官 2026-10-14（AC2 于 M7+ 补收） | — |
| M5 | 桌面 agent 与本地磁贴 | 收官 2026-10-14 | — |
| M6 | Windows 成员与二进制分发 | 收官 2026-10-14 | v0.2.0 |
| M7 | 拆仓与全员二进制 | 收官 2026-10-15 | hub v0.2.1 / v0.2.2 · agent v0.1.x |
| M7+ | 运行期收口 | 收官 2026-10-15 | agent v0.1.2 |
| M8 | 用户、角色、PAT 与管理控制台 | 收官 2026-10-15 | v0.3.0 – v0.3.3 |
| M9 | 契约 2.1 与成员身份 SSOT | 收官 2026-10-20 | v0.3.4 |
| M10 | 契约可演进化 | 收官 2026-10-20 | 契约 v2.2 · hub v0.3.5 · agent v0.3.3 |

## M0 · 契约与文档（收官 2026-10-12）

- [x] 仓库与文档骨架：ADR / architecture / roadmap / PRD / research
- [x] 七条 ADR 定型（0001–0007）：仓边界、拓扑与出连方向、A2A 通用语、路由纪律、技术栈基线、cronkit 参照位
- [x] 契约 v0.1 草案：target schema、ops 帧枚举、隧道协议、HTTP 门、审计
- [x] PRD-1 ~ PRD-5 拆分，research 0003/0004 扩展调研
- [x] 契约 v1.0 评审定稿：A2A 字面对齐 + 私有信封、research 演进点 defer、九张 JSON Schema 随契约冻结为实现基线

## M1 · 试点接入与 hub 起步（收官 2026-10-13）

目标：三类真实接入跑通（企微 bot、Mac agent × 2、内网周报 agent），为 PRD-2/3/4 取得真实踩点，并验证契约的实现无关性。

- [x] hub 服务骨架：原生 `node:http` + `ws`，零 web 框架、纯 JS ESM 零构建（[ADR-0006](../adr/0006-tech-stack-baseline.md)）；两扇门、WS 隧道、JSONL 审计/队列双文件、联邦注册表、聚合 card、msgId 幂等去重、断线转离线
- [x] target 定义先行（零代码）：三份 targets.yaml + 共用 stepTemplate，schema 校验进测试
- [x] CVM 上线：Docker + nginx 反代 + certbot HTTPS，域名 `novoard.firoyang.com`；公网全链路与 e2e 闭环验证
- [x] 联邦注册表与任务队列：A2A 字面帧 + 私有信封，JSONL append-only + 重启扫尾重放，contextId 回带与父任务关联首日对齐
- [x] 三接入：企微 bot（hub 进程内长连接）、mac-home / mac-work 双实例、intranet-weekly（验证 [ADR-0003](../adr/0003-hub-and-spoke-agent-egress.md) 内网出站隧道，M7+ 退役）
- [x] A2A 端点最小版：aggregated Agent Card、message/send、tasks/get、tasks/cancel，错误码字面，自实现零 SDK
- [x] 通知扇出最小版：企微终态 / 审批门 / 离线拒绝三模板
- [x] 最小规则引擎：终态事件 → run target，经队列下发不旁路，ruleTrace 防环
- [x] 触发磁贴门（fire-and-forget）：桌面双击磁贴 + 本机通知；在线受理 / 离线拒绝 / 通知扇出三场景验收

验收：PRD-5 AC1–AC7 过（AC8 两段式可选）。

沉淀：原 M2 的队列与触发门前移至此；原 M4 的 A2A 端点最小版提前触达，stream 与审批门全链路仍留 M4。

## M2 · Hub 完备与远程触发（收官 2026-10-13）

- [x] 离线策略正式化（契约 v1.1，向后兼容）：target 新增 `offline: reject|queue` + `offlineTtl`，策略经 skill `x-novoard-offline` 随 card 透传，hub 离线分流查表（ADR-0005 延伸）
- [x] queue 全链：202 `queued-offline` + expiresAt 入队；成员上线钩子自动补下发；TTL sweeper 到期转 failed（审计 `offline-ttl-expired`）并通知；hub 重启扫尾恢复
- [x] Web 面板 v1：target 按成员分组（离线灰显可见）、任务详情可展开（状态 / 耗时 / 触发者 / artifacts / history）、触发入口支持成员选择、queued-offline 徽标与等待截止时间

验收：PRD-2 AC1–AC4 过。

## M3 · 通知与自动化规则完备化（收官 2026-10-14）

- [x] 通知降级链：企微智能机器人（主）→ 企微群 webhook（备）→ Bark（直达），任一成功即止，全失败落日志
- [x] 触发点四类：terminal / offline-reject / input-required / member-event
- [x] per-target `notify` 生效：targets.yaml 经 `x-novoard-notify` 透传，hub 查表过滤终态通知
- [x] 通知频控（状态口径）：同 target 同 (kind,state) 60s 窗口首条即发、后续计数、到期追加合并摘要，增量不丢仅延后
- [x] 规则引擎完备 + 通用 webhook：`POST /api/webhook/:source`（clientKey 鉴权）→ 审计 → 规则引擎；事件源覆盖 task-terminal / member-online / member-offline / `webhook-<source>`

验收：PRD-3 AC1–AC3 过。

沉淀：queue seq 重启续号修复，防 taskId 撞号导致审计串台。

## M4 · A2A 能力面完备化（收官 2026-10-14）

- [x] message/stream：JSON-RPC 订阅 taskId → SSE status-update / artifact-update 帧，agent 逐步骤上行 working，15s 心跳保活，订阅前已终态补发快照
- [x] 审批门全链路：requiresApproval 改挂起语义（input-required 暂存执行参数），`tasks/approve` 经 `message/resume` 恢复或 canceled；IM / 面板 / 磁贴三入口共用同一状态机；input-required 超 10 分钟自动 canceled 并通知
- [x] 授权矩阵完备化：`.state/acl.yaml` 白名单（member / skill / `member/*` 通配，deny 优先），运行时查表，拒绝留审计 `acl-denied`
- [x] 桌面 agent localhost A2A 端点：由 M5 收口

验收：PRD-4 AC1 / AC3 / AC4 过；AC2（IM 审批恢复）当时仅端点通，消费侧于 M7+ 补收。

## M5 · 桌面 agent 与本地磁贴（收官 2026-10-14）

背景：托盘 / 热键 / 磁贴浮窗必须长在桌面常驻进程上。载体由 [ADR-0008](../adr/0008-desktop-shell-decision.md) 定稿为新写轻壳（agent 进程内 localhost 面板 + PWA 磁贴 + Shortcuts.app 兜底），Electron / Raycast 否决（试点数据：human 触发日均 1–2 次，配不上独立桌面运行时）。

- [x] 载体决策 ADR-0008，含 116 条审计事件的触发画像（human 11 条、dev-build-investm 占 64%、全部经面板 3–5 次点击）
- [x] 桌面 agent localhost A2A 端点：127.0.0.1 同进程 HTTP（`POST /a2a`、`/api/tiles`、`/api/stream/:id`、零构建 PWA 磁贴页）；hub 离线时本地照常闭环，在线时终态以 `task-local-*` 镜像上行（审计 `detail.via=tile-local-mirror`）
- [x] builtin/open-app 一等步骤正式化；新增 `open-instance` 内置模板（health + openApp）并在 mac-home 试点
- [x] Dashboard「快捷操作」磁贴分区：expose:a2a 技能大按钮网格（最近执行徽章 / 离线置灰）、input-required 待审批行直连 `tasks/approve`、支持内联 steps 型 target
- [x] Shortcuts.app 全局热键为一次性用户侧配置，指引已交付；托盘降级为可选项不进交付

验收：AC1–AC4 全过。

沉淀：tunnel pingTimer / 重连退避 / agent waitTimer 未 unref 挡进程退出（潜伏数轮，本轮全清）；localA2A 句柄泄漏改为 `agent.stop()` 统一停机；旧 replay 缓存 `local-` 脏帧清理。

## M6 · Windows 成员接入与二进制分发（收官 2026-10-14）

背景：Windows 设备需远程触发、本机执行指定部署命令。决策：Windows 作为第 4 个联邦成员接入，架构不变（target 定义在 agent 侧 targets.yaml，hub 只读查表）；形态定为二进制分发（Release 下载 → 向导 → 注册上线），源码 clone 否决。

- [x] F1 target 可视化编辑器：面板内嵌 `/editor`（表单 + YAML 双模式）、targets-store（schema 校验 / 备份滚动 / 原子写 / 从盘重装载）、全链热生效、`card.update` 上报即时刷新
- [x] F2 SEA 单文件二进制：esbuild CJS bundle → 九张 schema 构建期内嵌 → `--experimental-sea-config` → postject 注入（须官方发行版 node 作基底；darwin 去签名后 ad-hoc 重签）
- [x] F2 setup 首次接入向导：agent.json 缺失时起 127.0.0.1 单页，hub 地址归一化、WS upgrade 探测（401 即 token 无效且零注册痕迹）、保存落盘 0600 并生成骨架 targets.yaml、sameOrigin 防护
- [x] F2 SEA 入口与 dev 容错：cwd 锚定（exe 旁目录即数据目录）、跨平台自动开浏览器、`import.meta` 在 CJS bundle 下容错
- [x] F2 GitHub Release 流水线：tag `v*` 触发，四平台矩阵（win32-x64 / darwin-arm64 / darwin-x64 / linux-x64）
- [x] Windows 真机接入验收：win-dev 经向导接入，`win-dev-smoke` → completed 全链绿，v0.2.0 四平台产物已挂

## M7 · 拆仓与全员二进制终态（收官 2026-10-15）

背景：agent（面板 / runner / 编辑器 / 向导）从 hub 仓独立为跨平台项目 novoard-agent，「一份源码四平台产物」；win-dev / mac-home 是身份不是程序；契约 SSOT 留 hub 仓，agent 仓持锁定拷贝防漂移（relkit 模式）。

- [x] F1 契约锁定拷贝：hub 仓持 SSOT，agent 仓 `src/contract/` 持拷贝；双仓门禁 `check-contract-copy.mjs` 做结构化等价比较（export 函数段 + schema 常量表），CI 红线、漂移即红
- [x] F2 独立仓 novoard-agent：subtree split 保留历史，契约自检门禁（CONTRACT_VERSION + 九 schema 行为样例）+ 契约级 mock-hub，测试 fixture 化
- [x] F3 mac-home 切二进制：launchd 指向数据目录内二进制，targets 定义迁入数据目录；线上验证 card 聚合、面板/编辑器可达、磁贴触发闭环
- [x] F4 hub 仓收敛纯服务端：`src/lite-agent/`、SEA 打包脚本与 workflow、esbuild/postject 依赖全部退役；测试改契约级 fakeAgent；门禁改写为 SSOT 自检
- [x] 版本：hub v0.2.1（editor 引号转义致命 bug 修复）→ v0.2.2；agent 仓 v0.1.x

## M7+ · 运行期收口（收官 2026-10-15）

M7 拆仓后的运行期清理与验收面收口，一轮四件事：

- [x] intranet-weekly 退役（功能由 novoard-agent 覆盖）：CVM 停服删 unit 与专装 node，审计 / replay / 配置归档 `docs/archive/intranet-weekly-retired/`，hub 侧 fleet 与 token 同步删除；重建路径 = 任意内网机器下载 linux-x64 二进制跑向导
- [x] mac-work 常驻化：独立数据目录与端口 + launchd；实测暴露 skill 命名空间全局唯一约束，mac-work 改名 `dev-build-investm-work`（M1「两台 Mac 同 id」设计在联邦唯一命名下不成立）
- [x] AC2 IM 审批恢复收口：bot 新增 `approve/reject <taskId>` → `tasks/approve`（clientKeys 鉴权，与面板 / 磁贴同一状态机零旁路），线上 input-required → working → completed 全链验证
- [x] agent 仓 win32 CI 修复：动态 import 裸 Windows 路径被解析为 `d:` 协议致门禁失败 → `pathToFileURL`（agent v0.1.2）

## M8 · 用户、角色、PAT 与管理控制台（收官 2026-10-15）

本里程碑按全新安装交付，不迁移旧 `.state`；生产入口统一为根路径 `https://novoard.firoyang.com/`。

- [x] 首访身份闭环：公开 first-claim 向导原子创建首个 `superadmin`，成功后永久关闭；会话用不透明哈希令牌 + `HttpOnly + Secure + SameSite=Strict` Cookie + Origin/CSRF 校验；改密使旧会话失效；TTY `admin recover` 只恢复既有超管并吊销其会话与 PAT
- [x] RBAC 与 PAT：内置 / 自定义角色、最后一个有效超管保护、集中式权限与 target allow/deny 裁决；具名 PAT 明文只显示一次，权限实时取 `scope ∩ 当前角色`，管理接口仅接受浏览器会话
- [x] 契约 2.0：Agent token 绑定 `agentId`，状态与 artifact 上传禁止跨成员冒充；artifact 绑定 task/member/target/digest，下载按任务 target 授权；agent 仓 PR #1 已合并，锁定拷贝与九张 schema 一致
- [x] 企微通道收口：用户 / 会话双白名单默认拒绝，真实 sender/chat/command 写审计；服务账号用最小权限 PAT 并支持「验证新令牌 → 切换 → 吊销旧令牌」轮换
- [x] 管理控制台：React 19 + TypeScript + Ant Design 6 / ProComponents 3 + Vite 7 + React Router 7 + TanStack Query，页面按路由拆包，由原生 Node hub 在根路径静态托管
- [x] 门禁：Hub Node 测试、前端组件测试、Playwright 首装闭环、Agent 测试、前端依赖审计与 Docker 镜像构建统一进 CI
- [x] v0.3.2 安全收口：webhook 规则全链继承并动态复验调用 PAT 的 target 边界；任务状态与转换在写盘及终态副作用前校验，始终按持久化 member 下发；环境变量凭据可用空值墓碑真正撤销；审批 reject/TTL 下发 cancel，Agent 重连补报待确认帧与挂起任务以补发取消；聚合 card、状态计数与审计按 target 隔离，无权与不存在的响应一致；setup/login 强制可信 Origin + JSON
- [x] v0.3.3：最小口令长度下调至 10

## M9 · 契约 2.1 与成员身份 SSOT（收官 2026-10-20）

- [x] 成员身份独立成 SSOT（[ADR-0010](../adr/0010-member-identity-as-ssot.md)）：新增 `members.json`（0600 原子写，记录 agentId / tokenHash / tokenLastFour / 签发与轮换时间）作为「谁是成员」的唯一真相；签发、轮换、吊销、鉴权全部经由成员目录；`secrets.json` 退回本机集成配置，`agentTokenHashes` 启动期一次性导入后摘除
- [x] 运行期注册表降级为在场覆盖层：只回答「此刻谁连着、card 是什么」，允许随时重建；对外收口为 `GET /api/members` 与 `POST|DELETE /api/members/:agentId`，服务端合成「身份 + 在场」，前端不再自行 join；吊销在线成员时同步摘除 card，聚合 card 不再暴露失效成员
- [x] 契约 2.1：`agent.hello` 记录 `bootId`、run trace 改 append-only，断连按 run trace 对账——链路抖动重发在途工作，进程被替换则判 `agent-lost`；target TTL、成员 card、会话回复同源落到 hub
- [x] 版本与发布门禁：新增 `VERSION.json` 作唯一版本源 + `version:sync` / `version:check` 镜像校验；CI 在打 `v*` tag 时校验 tag 与版本一致；`stable` tag 必须与不可变 `v*` tag 指向同一 main 提交

验收：后端 104 / 前端组件 10 / typecheck / Biome / Playwright 全绿；前端交互测试超时统一放宽到 30s（环境波动不卡发布门禁）。

## M10 · 契约可演进化（收官 2026-10-20）

目标是让契约从「靠人守的约定」变成「有机械保证的工程资产」。本轮定位到六个断裂点，逐个补上保证，而不是补充条款。

- [x] 字段演进不再破坏兼容：四张帧类 schema（`frame-agent-hello` / `frame-agent-ping` / `frame-telemetry` / `frame-card-update`）的 `additionalProperties` 由 `false` 改为 `true`；信封层与 A2A 数据类保持封闭，五张封闭例外在契约 §0 逐条写明理由（身份绑定、spec 字面对齐、审计流水可回溯、用户手写配置宁严勿宽）
- [x] 契约 §0 补两张清单：主版本破坏点 7 条（字段删除、语义反转、枚举缩减等）、次版本安全改动清单 4 条，把「什么能改、什么必须升主版本」变为可引用条文
- [x] 校验失败必有回执：此前 hub 两处校验失败只打日志就 `return`，对端表现为「连接正常、任务全失败」。改为 hello 字段级失败回 `agent.hello.nack`（`reason=contract-schema-mismatch`，带 `detail` 字段路径），其余 ops 帧失败回新增的 `frame.reject`（`refMsgId` 关联原帧），信封不合法则关连接并给出可读 close reason
- [x] 补齐两张「代码有、契约没有」的帧 schema：`frame-agent-hello-nack`（其 `reason` 同时新增 `contract-schema-mismatch`，与 `contract-major-mismatch` 区分：前者字段级失败，后者主版本不匹配）、`frame-agent-hello-ack`
- [x] agent 侧不再无限等待：hello 发出后 10s 未收 ack/nack 即报「疑似契约不兼容」并触发 fatal；`frame.reject` 分支此前被 `return` 挡成死代码，现已可达，且被拒帧会退出重放队列——否则每次重连都重发同一帧，永远被拒、日志被刷满
- [x] 版本号收窄为单一来源：两侧各建 `src/contract/version.mjs`；`agent.json` 不再持久化 `contractVersion`（只换二进制不重装的环境会永久停在旧值），读到历史值时日志明确告知已被取代
- [x] 硬编码 schema 清单全部消除：五处改为目录动态发现，新增 schema 不再需要手工登记，也就不会漏校验
- [x] 门禁口径从「固定历史提交」改为「当前 SSOT」：跨仓双向差集比对（任一侧独有都算未同步），SSOT 不可达时明确失败而非默认通过。固定提交只能证明与那个旧提交一致，hub 后续改动发现不了
- [x] 类型派生：`scripts/gen-contract-types.mjs` 从 schema 生成 `contract-types.d.ts`，两仓共用同一生成器，输出确定性（逐字节一致）。开放式 schema 生成两个类型——主类型严格（拼写错误报 TS2561），`${Name}Inbound` 带索引签名承载未知字段；未知关键字直接报错不静默生成不完整类型，`--check` 纳入 `npm test`
- [x] 一致性夹具 `conformance/frames.json`：34 个用例，两仓实现跑同一批样本、断言同一结论。字节比对只能证明「抄得一致」，不能证明「实现正确」
- [x] 文档示例纳入校验：契约文档中的帧与数据示例带 `contract-example` 标记，门禁逐条跑过 schema，冲突时报出行号，避免示例在 schema 演进后悄悄变错
- [x] 可观测性：`/api/status` 返回 `contractVersion`；ack 回带 `hubVersion`；两侧日志记录同一 `msgId` 与各自契约版本；注册审计同时记 `contractVersion` 与 `agentContractVersion`，事后查「某天开始某成员行为异常」能直接看到当时两侧各是什么版本
- [x] 发布说明模板 `docs/guides/release-notes-template.md`：契约变更时必须写明单侧先发时对端会看到什么现象，不能写「不兼容」这种结论性词

验收：Hub 后端 138 / 前端组件 10 / Playwright / Docker 构建全绿（v0.3.5 发布门禁）；Agent 120 项全绿（v0.3.3）。线上握手实测两侧 `contractVersion=2.2` 对齐，`agent.json` 中残留的 2.1 值按设计被忽略并留日志。环境侧沉淀：本机 Homebrew node 为源码构建版缺 SEA fuse 串，agent 打包须显式指定官方发行版 node 作基底。

## 里程碑之外（暂不排期）

- 更多 A2A 客户端接入验证（M4 遗留）：当前已接入 With，端点能力齐备，新增客户端属验证性接入
- cronkit Windows 机器收编为成员（属「收编」而非「试点」，规模另立，见 [research 0004](../research/0004-autoworks-integration.md)）
- 新 agent 接入（家里服务器等）：架构天然支持，接入是运维动作不是开发项
- Tailscale 直连替代 relay 隧道：等 relay 痛点真实出现
- 事件触发器扩展（位置、NFC、app 状态类自动化）：YAGNI 区
