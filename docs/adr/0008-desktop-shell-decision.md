# ADR-0008: Mac 桌面载体决策——新写轻壳（零构建 Web 面板），非 Electron/Raycast

- 状态：Accepted
- 日期：2026-10-14
- 讨论来源：M1-M4 试点期触发数据（116 条审计事件）+ PRD-1 磁贴/热键/托盘三形态需求 + ADR-0007 载体悬置。用户在 M4 收官时指示"继续"，授权按 roadmap 顺序推进 M5 首项"载体决策 ADR（三候选对比，以试点期触发数据为输入）"。

## Context

PRD-1 的磁贴视图 / 全局热键浮窗 / 托盘菜单必须长在 Mac 桌面常驻进程上。ADR-0007 将 cronkit 退位为参考实现后，桌面载体悬置，三候选：

1. **移植 cronkit Electron**——把参照原型的托盘+热键+磁贴 UI 移植到本仓
2. **新写轻壳**——在本仓技术栈基线（ADR-0006：原生 node:http + 纯 JS ESM 零构建）内新写桌面层
3. **Raycast 类启动器顶替**——不自己维护桌面载体，用 Raycast Script Command 充当"热键 → 触发"入口

决策输入：试点期 116 条审计事件的触发画像。human 触发 11 条，高频 target 集中（dev-build-investm 7 次，占 64%），全部发生在工作时段；触发路径全部经 Web 面板（浏览器开 tab → 找行 → 点按钮），入口成本 3-5 次点击。磁贴/热键的需求真实（高频 + 集中），但频次绝对值低（日均 1-2 次 human 触发），远未到"高频重度入口"量级。

## Decision

**新写轻壳：在 mac-home agent 进程内长一个 localhost Web 面板（零构建），以"浏览器 PWA 磁贴 + 系统级 shortcut 兜底"为 M5 载体形态；Electron 与 Raycast 均否决。**具体：

- mac-home agent 新增 localhost A2A 端点（M4 遗留项），同进程起 `127.0.0.1:<port>` HTTP 面板：磁贴视图（PRD-1 F1）、触发直连本地队列（hub 不在线也可用，PRD-1 非功能需求"本地闭环"）。
- 磁贴面板做成 PWA（manifest + 常驻 tab / 独立窗口），点磁贴 → localhost 端点触发 → SSE 进度。这是"零查找成本入口"的主形态。
- 全局热键不做 Electron globalShortcut，用 macOS 原生能力兜底：Shortcuts.app（快捷指令）或 Automator Service 绑定系统热键 → `curl` 打 localhost 端点。热键是入口的补充，不是主形态（试点数据：触发频次日均 1-2 次，配不上常驻 Electron）。
- 托盘菜单（PRD-1 F3）降级为可选项：PWA 常驻窗口已覆盖"不必开浏览器 tab"诉求，真需要再评估 Menu Bar Extra 一类原生形态，不进 M5 交付。
- 契约纪律不变：磁贴面板是 A2A 客户端（ADR-0004），触发打 localhost A2A 端点，审计与 hub 侧同一份语义（lane: a2a，actor: tile-client）。

## Consequences

- 收益：零新增运行时依赖（Electron ~200MB / Raycast 闭源 store 分发都省了），与 ADR-0006 技术栈基线（原生 node:http + 零构建）完全同构；磁贴面板复用 hub Dashboard 的零构建 Web 技术与 SSE 能力（M4 message/stream 直接复用）；本地闭环（hub 离线时本地队列照常）天然满足 PRD-1 AC2；PWA 形态在 iOS 上也成立（PRD-3 远期 iOS 验收的同一入口）。
- 代价：全局热键体验弱于 Electron globalShortcut（需一次性的 Shortcuts.app 配置，且浮窗形态退化为 PWA 窗口前置）；托盘形态本轮不交付。若未来触发频次上升一个数量级（日均 10+ 次），重新评估原生壳。
- 替代方案否决：
  - **移植 cronkit Electron**：与 ADR-0006 零构建基线冲突（Electron 引入 node_modules/打包链）；试点数据（日均 1-2 次触发）不支持为入口维护一个独立桌面运行时；ADR-0007 已把 cronkit 退位为参考，再移植等于走回头路。
  - **Raycast 顶替**：闭源 + store 分发，违背 Novoard 自持纪律（触发入口是系统命脉，不能交给第三方运行时）；Raycast Script Command 本质也是 curl 打端点，自己维护 PWA 面板可得到同效能力且全可控。Raycast 可作为未来可选入口之一，不作为载体。
- 后续动作：M5 按此载体推进——localhost A2A 端点（含磁贴触发 + SSE）→ 磁贴面板 UI → builtin/open-app 一等步骤 → 部署类 stepTemplates 收编（roadmap M5 四项）。
