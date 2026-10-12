# ADR-0002: Novoard 与 cronkit 的分界——触发模型决定形态

- 状态：Accepted
- 日期：2026-10-12
- 讨论来源：2026-10-09 "快捷操作面板调研"与"issue-handler 哲学"两轮讨论。

## Context

快捷操作面板的需求与 cronkit 现有能力高度重合（manual task、执行内核、stepTemplates 参数化模板都已存在），直觉方案是全部塞进 cronkit。但历史上 issue-handler 已经演示过"功能相似就合并"的错误：webhook 即时响应塞进本地桌面应用，会强迫本地工具长出常驻 HTTP 监听、鉴权、外网暴露这些它本来没有的东西。

## Decision

功能长在哪，不看"像不像现有功能"，看它的触发模型与运行形态：

- 被动即时响应、需要对外暴露的（webhook 入口、机器人消息、远程触发、多客户端汇聚、通知扇出）→ hub，即 Novoard 本仓
- 本地主动操作、定时编排的（磁贴、热键、本地 cron、targets → steps 执行内核）→ cronkit，既有仓库内演进
- 两者通过 A2A 窄接口对接（见 ADR-0004），互不为载体、互不嵌套

Novoard 仓库承载 hub 实现、Web 面板、全系统契约 SSOT；cronkit 升级为系统中的第一个 A2A agent。这是同一判断标准的第三次应用（第一次 issue-handler 分家，第二次薄桥隔离，本次定型为 ADR）。

## Consequences

- 收益：cronkit 保持本地编排器的干净定位（离线完整可用）；hub 的服务面复杂度（鉴权、暴露、队列）收敛在专职组件里；两仓可独立演进发布。
- 代价：系统跨两个仓库，契约必须以本仓 `docs/architecture/contracts.md` 为 SSOT，两仓实现都要对齐；部署单元变多（Mac agent + CVM hub）。
- 替代方案否决：
  - 全部塞进 cronkit——重蹈 issue-handler 覆辙，本地工具被迫服务化。
  - cronkit 退化为哑执行器、定义全上 hub（Rundeck 式）——离线时本地磁贴没法定义任务，且 hub 侧 YAML 编辑体验差。定义所有权必须留在 agent 本地。
