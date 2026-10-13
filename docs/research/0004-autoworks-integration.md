# Research 0004: autoworks 接入调研——烟囱拆解与收编姿势

- 日期：2026-10-12（讨论与沉淀同日）
- 结论用途：回答"autoworks（自动化检查集合 + 定时周报 skill，自持定时器/crontab 调度与通知，诞生早于 Novoard）接入是否合适、怎么接"。本地无同名仓库，按用户描述的形态推演。用户定调：收编延后，"之后真的要把 autoworks 收编再说"——本文存判断依据，待收编时启用。

## 前提修正：cronkit 退位（ADR-0007）

同轮讨论推翻了"PRD-1 落地载体绑定 cronkit / contracts steps 语法实质依赖 cronkit"的前轮判断：cronkit 与 Novoard 无载体与语法绑定，仅作参考。本文的"宿主 agent"指任意实现契约三条的 agent 运行时，不特指 cronkit。

## 适配性结论

合适。autoworks 是诞生早于平台的迷你烟囱（调度/执行/通知三层自持），拆烟囱是 ADR-0002 分界标准（触发模型决定形态）的第四次应用（issue-handler 分家 → 薄桥隔离 → cronkit/Novoard 分界 → 本次）。

### skill 语义分岔

- 确定性脚本（如 report.py 跑完产出周报）：普通 target 内容，接入零障碍。
- AI skill（SKILL.md 教 LLM 做总结）：与 Agent Card 的 skill（= target 镜像）不是一回事；确定性 steps 跑不了 LLM，属语义类成员领地（research 0003）——steps 内部调 LLM API，或独立 LLM 成员承接。

### 三种接入姿势

| 姿势 | 适用 | 做法 |
|---|---|---|
| 一 内容收编（默认） | 检查跑在已有 agent 的机器上 | autoworks 零改动；宿主 agent 定义 target 引用其脚本（pull + run）；定时归宿主本地 cron；通知上交 hub（周报 always / 巡检 on-failure）。白得磁贴触发、远程补跑、统一审计、AI 查询 |
| 二 lite-agent 成员 | 检查需跑在无 agent 的机器（如内网服务器） | 保留 autoworks 进程做运行时，补契约三条注册为独立成员；内置定时器降级为合法本地 cron；通知仍上交。试点"内网周报 agent"即此姿势的实例化 |
| 三 语义类成员 | 周报确需 LLM | a) 委派方直连临时执行（无定时无审计）；b) LLM 盒子成员化（可定时可审计）；c) 两段式：确定性收集 target 产出 artifact → LLM 成员消费 → 规则引擎 when task completed then run 串联（M3 能力零新代码） |

### 烟囱拆解表（改造现有 autoworks 的步骤）

| 层 | 现状 | 归位 |
|---|---|---|
| 检查逻辑 | 自持 | 保留（核心资产），命令化：单入口、幂等、退出码带语义、结果落 artifact |
| 调度 | 定时器 + crontab | 宿主 agent 本地 cron；过渡期双轨开关、同一任务只在一处激活，对齐后删 crontab |
| 通知 | 自有渠道 | hub 通知扇出 |
| 触达/审计 | 无 | 白得 expose + tasks/get |

### 反模式

- 双调度器：autoworks 留常驻 cron 再接入，两边定时、审计对不上账；定时权归 agent 本地一处。
- 整仓塞进宿主 agent：内容仓与运行系统层级不同，不该嵌套。

### 新建 vs 改造

逻辑稳定改旧仓（命令化 → 调度双轨 → 通知收编 → 视形态 lite-agent 化）；逻辑换代（全面 AI skill 化）建新仓：纯内容包（checks/ + 元数据 + 接入声明，零调度零通知代码），可走 Dec bundle 分发。两者可混合：旧脚本按改造收编，新 AI 检查按内容包新建。

## 与试点的关联

"内网周报生成 agent"试点（必须部署内网服务器，否则无权限）是姿势二的先导实例；试点跑通后，autoworks 周报 skill 收编按图施工。

## 来源

内部推演；外部参照见 [0001](0001-market-scan.md)、[0002](0002-hub-references-and-a2a.md)、[0003](0003-expansion-beyond-cronkit.md)。
