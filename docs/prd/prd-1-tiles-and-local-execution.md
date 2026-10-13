# PRD-1: 磁贴面板与本地执行

- 版本：v0.1
- 状态：Draft
- 契约引用：[contracts §1](../architecture/contracts.md)
- 相关 ADR：[0002](../adr/0002-novoard-cronkit-boundary.md) [0005](../adr/0005-route-by-definition-table-lookup.md) [0007](../adr/0007-cronkit-as-reference-only.md)
- 载体：待定（ADR-0007 后 cronkit 仅为能力参照原型）。托盘/热键/磁贴浮窗需桌面常驻进程载体，载体决策后启动（roadmap M5）；契约字段（expose/audit/requiresApproval/notify）、builtin/open-app 与 stepTemplates 不依赖桌面 UI，已由试点接入（PRD-5）部分吸收。

## 背景

用户有大量开发项目，其中不少需要"随时部署安装到本地自己体验"。现状是每次都要找部署脚本、跑命令、开实例，摩擦大。cronkit（参考原型）已具备执行内核（targets → steps）、manual trigger、stepTemplates 参数化模板，缺的是零查找成本的入口形态。本文各能力项以 cronkit 为参照原型描述，实现载体不限。

## 目标用户

用户本人（开发者），单用户。

## 用户故事

- US1：作为用户，我想点一个磁贴就完成某项目的本地部署并在固定实例（固定端口/URL）打开，这样我不需要记住每个项目的部署命令。
- US2：作为用户，我想用全局热键呼出磁贴面板（类 Raycast / iOS 快捷中心形态），这样触发的查找成本接近零。
- US3：作为用户，我想从菜单栏/托盘直接触发常用 target，这样最常用的操作一击可达。
- US4：作为用户，我想把各项目重复的部署步骤收编成 stepTemplates（deploy-webapp 一类），这样每个新项目只需提供 vars（repo、端口）。
- US5：作为用户，我想在磁贴上看到执行状态（运行中/上次结果/耗时），这样不用翻日志就知道是否成功。
- US6：作为用户，部署类 target 跑完能自动打开固定实例（浏览器开 URL、或 `open-app` 拉起桌面应用），这样"部署+体验"是一个动作。

## 功能需求

### F1 磁贴视图（Dashboard 改造，参照 cronkit Dashboard 原型）

- Dashboard 增加"快捷操作"分区，manual target 以磁贴（卡片）呈现，替代当前纯行列表的查找路径。
- 磁贴信息：图标、title、状态点（idle/running/succeeded/failed）、上次执行时间。
- 磁贴操作：单击触发；右键/长按菜单：查看定义、查看历史、编辑。
- 数据源：本地注册表（全量 target，含 `expose: local` 与 `expose: a2a`），磁贴列表不依赖 hub 在线。

### F2 全局热键浮窗（Electron globalShortcut）

- 系统级热键呼出轻量浮窗（非主窗口），列出可手动触发的 target，键盘上下选择 + 回车触发。
- 浮窗与主 Dashboard 读同一份本地注册表。
- Esc 关闭；触发后浮窗自动收起（后台继续执行）。

### F3 托盘快捷菜单

- 托盘菜单列出 N 个常用（可 pin）target 直接触发，不必开窗口。

### F4 builtin/open-app 步骤

- 新增一等 step 类型：部署完成后打开固定实例——浏览器开 URL（指定端口）或启动本地应用（指定路径/命令）。
- 与既有 `builtin/script`、`open-path` 雏形整合，纳入 stepTemplates 可复用。

### F5 stepTemplates 收编部署脚本

- 提供内置模板集（deploy-webapp、open-instance 等），用户项目只需引用模板 + vars。
- 模板仓库位置与共享方式参照 cronkit 既有 stepTemplates 机制。

## 非功能需求

- 本地闭环：以上全部能力在 hub 不在线时完整可用（离线优先）。
- 触发路径统一：磁贴、热键、托盘、CLI 最终都打 localhost A2A 端点或直连内核，同一份审计（ADR-0004 磁贴即 A2A 客户端——实现上允许先走内部 IPC，语义对齐即可）。

## 验收标准

- AC1：点磁贴 → 部署执行 → 实例自动打开，全程无需打开终端或翻脚本。
- AC2：hub 进程不存在时，磁贴/热键/托盘触发照常工作。
- AC3：新增一个项目的部署 target，只需一份 YAML（引用模板 + vars），5 分钟内完成。
- AC4：磁贴状态在执行结束后 2 秒内刷新（成功/失败可辨）。

## 范围外

- 远程触发（PRD-2）、通知（PRD-3）、AI 委派（PRD-4）、试点接入（PRD-5）。
- iOS 式事件自动化触发器（时间外的触发器类型，见 PRD-3 远期）。
