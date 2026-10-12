# PRD 总览

Novoard 的产品需求按能力域拆分，每份 PRD 独立可读，共享统一的术语与契约引用。

## 拆分逻辑

系统有两个使用面（磁贴面板 / 远程触发与通知）加一个系统面（契约与安全），拆成四份 PRD：

| PRD | 能力域 | 核心用户价值 | 依赖 |
| --- | --- | --- | --- |
| [PRD-1 磁贴面板与本地执行](prd-1-tiles-and-local-execution.md) | 手动触发的桌面体验 | 一键部署/拉起/巡检，零查找成本 | cronkit 既有内核 |
| [PRD-2 Hub 与远程触发](prd-2-hub-and-remote-trigger.md) | 多端触发、任务队列、Web 面板 | 在任何地方触发家里的 Mac | PRD-1（target 目录） |
| [PRD-3 通知与自动化规则](prd-3-notifications-and-automation-rules.md) | 事件扇出与事件触发器 | 执行结果主动找人；外部事件驱动操作 | PRD-2（hub 事件流水） |
| [PRD-4 A2A 能力面](prd-4-a2a-capability-surface.md) | AI 客户端接入、Agent Card、审批门 | 让 AI 助手安全地替你干活 | PRD-2；契约 SSOT |

## 共享术语

- target：一次可触发的操作单元（部署 InvestM、巡检磁盘），定义见[契约 §1](../architecture/contracts.md)。
- 磁贴：target 在面板上的可视形态，点击即触发。
- hub：CVM 上的常驻控制平面服务（Novoard 本仓）。
- agent：持 Agent Card、可被 A2A 委派的执行节点；第一个是 cronkit。
- 车道：A2A task 车道 / ops 旁路车道，归属由定义决定（ADR-0005）。

## 里程碑映射

PRD 与 roadmap 里程碑的对应关系见 [roadmap](../roadmap/roadmap.md)。总序：先本地（PRD-1，吃掉桌面场景），再 hub（PRD-2），再通知（PRD-3），最后 A2A 面（PRD-4）。
