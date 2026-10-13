# PRD-5: 试点接入——三接入与验证矩阵

- 版本：v0.1
- 状态：Draft
- 契约引用：[contracts](../architecture/contracts.md) §0-§10 全量触达；帧格式 SSOT 在 [schemas/](../architecture/schemas/)（九张 JSON Schema，启动自检 + CI 门禁）
- 相关 ADR：[0003](../adr/0003-hub-and-spoke-agent-egress.md) [0005](../adr/0005-route-by-definition-table-lookup.md) [0007](../adr/0007-cronkit-as-reference-only.md)
- 载体：Novoard 仓（hub 最小骨架）+ 试点环境（CVM 企微 bot、两台 Mac lite-agent、内网服务器 lite-agent、iOS 快捷指令、With 客户端）

## 背景

ADR-0007 将 cronkit 退位为参考实现后，首个实现路径改为三个真实接入：企微 bot、dev builder（两台 Mac）、内网周报 agent。三接入覆盖触发谱系（精确输入 / 远程语句 / 定时）、多 agent、跨环境出站隧道与通知主链路，但对表 PRD-2/3/4 验收面仍有整块未踩：事件驱动规则、iOS 门、AI 委派（A2A 消费端）、语义类执行、tasks/cancel、open-app 收尾、离线拒绝通知、Bark 与频控。本 PRD 将三接入与六个补充小东西合并为一个试点里程碑，目标：PRD-2/3/4 的验收标准全部获得真实踩点，仅 PRD-1 桌面 UI 因载体未定（ADR-0007）留白。

## 目标用户

用户本人（全部场景）；With（第一个 A2A 客户端）。

## 用户故事

- US1：作为用户，我在企微里说"构建 X 到工位机"，bot 转发 hub 查表执行，完成后企微收到终态通知。
- US2：作为用户，我在任意入口触发 dev builder，指定项目构建 dev 并部署到指定 Mac，构建完成自动打开自测页；构建中可随时取消。
- US3：作为用户，内网服务器上的周报 agent 定时生成周报，artifact 上 hub 存证，企微收通知，With 可查。
- US4：作为用户，我用 iOS 快捷指令一键触发构建；目标 Mac 离线时收到明确的拒绝通知而非沉默。
- US5：作为用户，dev builder 构建完成后自动跑冒烟 target（规则引擎）；进阶：GitHub push webhook 自动触发构建。
- US6：作为用户，我让 With 拉 hub Agent Card、message/send 触发安全 target、tasks/get 查周报 artifact；With 请求 expose: local 的 target 被明确拒绝。
- US7（可选）：周报两段式——确定性收集 target 产出数据 artifact，LLM 总结 target 消费并生成周报，规则串联。

## 功能需求

### F1 企微 bot（触发端 + 通知面）

- bot 住 CVM（与 hub 同机或独立轻服务），只做转发与鉴权，零 LLM（ADR-0004 纪律延伸至 bot）。
- 语句路径：bot → hub HTTP 门 → 查表建 task；通知路径：hub 通知扇出 → bot 推企微。
- 激活 PRD-4 审批门设计：task 转 input-required → bot 推卡片 → IM 回复恢复执行。

### F2 dev builder（Mac lite-agent × 2）

- steps：pull → 构建 → 部署本机 → 健康检查 → `builtin/open-app` 打开自测页（盖 PRD-1 F4）。
- 两台机器共用同一 stepTemplate，vars 填机器差异（路径、拉取方式、端口）。
- 验收含 tasks/cancel：构建中取消 → 进程终止 + 终态通知（盖 contracts §5.2）。
- 不做 AI skill 版：本接入验证的是精确输入模式（参数完全由定义决定）的承载能力。

### F3 内网周报 agent（lite-agent）

- 按契约三条注册为独立成员：Agent Card + ops 帧 + 出站隧道（ADR-0007 后首个真实 agent）。
- 定时归 agent 本地 cron（ADR-0003 调度归属），通知上交 hub 扇出（`notify: always`），artifact 上 hub。
- 出站 wss 到 CVM；内网策略审批（IOA 类）周期预留。

### F4 iOS 快捷指令门

- Shortcuts 按钮打 hub HTTPS 门，fire-and-forget（PRD-2 F4）。
- 验收场景：对着合盖/离线的 Mac B 触发 → 30s 内收到离线拒绝通知（PRD-3 US4）。

### F5 最小规则引擎

- 规则：`when dev-builder completed then run smoke-test`——踩事件流水、task 终态事件源、规则评估、链式审计（动作不旁路，走既有任务队列）。
- 进阶：GitHub push webhook → 自动构建，踩通用 webhook 入口（PRD-3 F4 最小版）。

### F6 With 作为第一个 A2A 客户端

- hub 侧最小 A2A 面：聚合 Agent Card 发布 `/.well-known/agent-card.json`、`message/send`、`tasks/get`、`tasks/cancel`；授权矩阵最小版（With 一把 key）。
- message/stream 以"轮询 + 终态通知"顶替：轮询自适应间隔（1-2s 起步、退避封顶 10s、对齐 step 粒度、终态或预算即停）；With 跨回合查询 + 企微通知兜底。
- 验收含反例：请求 `expose: local` 的 target 返回明确"能力不存在"（PRD-4 AC3）。

### F7（可选）周报两段式语义类试点

- 收集 target（确定性，内网跑）→ LLM 总结 target（step 内调 LLM API 或独立 LLM 成员）→ 规则串联；hub 零 LLM 纪律不破（research 0004 姿势三 c）。

### F8 Bark 双推与通知频控（顺手项）

- 选一个 target 通知双推企微 + Bark；同 target 短窗口重复失败合并（状态口径频控，PRD-3 F1 雏形）。

## 非功能需求

- hub 零 LLM：bot 与 hub 均不做语义翻译。
- 轮询纪律：tasks/get 只读幂等，闪断直接重试；单回合轮询预算（≤5 次或 ≤60s），超预算转"已触发 + 通知兜底 + 跨回合查询"；停止条件四条完备（终态 / 取消 / 预算耗尽 / 放弃），防僵尸轮询。
- 审计同车道：规则触发、审批门、离线拒绝全部进审计流水。

## 验收标准

| # | 验收项 | 覆盖 |
| --- | --- | --- |
| AC1 | 企微一句"构建 X"→ hub 查表 → Mac 执行 → 企微终态通知，全程无人工介入 | PRD-2 AC1 雏形 |
| AC2 | 构建中 cancel → 终止 + 通知 | contracts §5.2 tasks/cancel |
| AC3 | 构建完成自动打开自测页 | PRD-1 F4 |
| AC4 | 手机触发、目标 Mac 离线 → 30s 内拒绝通知 | PRD-3 US4 |
| AC5 | 规则生效：构建完成自动跑冒烟并通知；进阶 webhook 触发构建 | PRD-3 AC3 雏形 |
| AC6 | With GET card → message/send → tasks/get 取周报 artifact；expose: local 请求被明确拒绝 | PRD-4 AC1/AC3 |
| AC7 | 高危 target 停 input-required，企微回复后恢复至终态 | PRD-4 AC2 雏形 |
| AC8（可选） | 两段式周报产出（语义类首例） | research 0003/0004 |

## 落地顺序

1. target 定义先行（零代码）：三份 target YAML + 共用 stepTemplate。
2. hub 鸣枪：issue-handler DNA 骨架 → 联邦注册表 → A2A 字面帧 + 私有信封（契约 §4）→ HTTP 门 → CVM 部署。
3. 并行接入：企微 bot（CVM）、Mac lite-agent × 2（同构部署）、内网 lite-agent（策略审批提前走）。
4. 小东西串接：iOS 门 → 规则引擎 → With A2A 客户端 →（可选）两段式 → Bark/频控。

## 范围外

- 桌面托盘/热键/本地磁贴面板：后置至载体决策（ADR-0007，roadmap M5）。
- message/stream 流式：M4 完备化，试点以轮询 + 通知顶替。
- cronkit Windows 机器收编为成员：属"收编"非"试点"，规模另立（research 0004）。
- 通用 webhook 平台化、通知频控完备化、授权矩阵完备化：M3/M4 完备化范围。
