# Roadmap

里程碑按"先本地价值、再远程底座、再通知闭环、最后 AI 面"排序，每个里程碑独立可交付、可验收。

## M0 · 契约与文档（当前）

- [x] 仓库与文档骨架（ADR / architecture / roadmap / PRD / research）
- [x] 五条 ADR 定型（边界、拓扑、A2A 通用语、路由纪律）
- [x] 契约草案 v0.1（target schema、ops 帧枚举、隧道协议、HTTP 门、审计）
- [x] PRD 拆分（PRD-1 ~ PRD-4）
- [ ] 契约 v0.1 评审定稿（用户确认后转 Accepted，实现冻结基线）

## M1 · 磁贴与本地执行（PRD-1，cronkit 仓）

目标：人在电脑前的场景闭环——点磁贴完成部署并在固定实例打开。

- [ ] Dashboard"快捷操作"磁贴分区（数据源本地注册表）
- [ ] `builtin/open-app` 一等步骤
- [ ] 部署类 stepTemplates 收编（deploy-webapp 等）
- [ ] target 定义新增 `expose / audit / requiresApproval / notify` 契约字段（对齐 contracts §1）
- [ ] 全局热键浮窗
- [ ] 托盘快捷菜单
- 验收：PRD-1 AC1-AC4

## M2 · Hub 与远程触发（PRD-2，Novoard 仓）

目标：人不在电脑前的场景闭环——手机触发 Mac，Web 面板全局可见。

- [ ] hub 服务骨架（Node，issue-handler DNA：统一 server、JSONL 流水、dashboard、凭据热配置）
- [ ] agent 连接器（cronkit 侧：出站 WebSocket、agent.hello 注册、心跳重连）
- [ ] 任务队列与分发（离线拒绝 + 通知）
- [ ] Web 面板 v1（agent 列表、target 目录、任务历史、触发入口）
- [ ] iOS 快捷指令门（fire-and-forget HTTPS）
- [ ] CVM 部署（Docker，nginx 子目录反代，目录挂载）
- 验收：PRD-2 AC1-AC4
- 说明：本里程碑内部链路允许简化为"A2A 语义、私有帧起步"，但契约 §4 的帧语义（contextId 回带、父任务关联）从第一天就按 A2A 语义设计，避免日后协议迁移成本。

## M3 · 通知与自动化规则（PRD-3，Novoard 仓）

目标：结果主动找人；事件驱动操作。

- [ ] 企微 / Bark 通知扇出（终态、审批门、离线拒绝）
- [ ] per-target `notify` 策略字段生效（契约 §1 扩展）
- [ ] 通知频控（状态口径，防 digest 吞增量）
- [ ] 自动化规则引擎（when event then run target）
- [ ] 通用 webhook 入口
- 验收：PRD-3 AC1-AC3

## M4 · A2A 能力面（PRD-4，两仓）

目标：AI 客户端安全接入，全系统讲同一种话。

- [ ] hub Agent Card 聚合 + JWS 签名 + `/.well-known` 发布
- [ ] A2A 端点（message/send · stream · tasks/get · cancel）
- [ ] 审批门全链路透传（IM / Web / 磁贴三入口恢复）
- [ ] 授权矩阵
- [ ] cronkit localhost A2A 端点（磁贴走 A2A 语义）
- [ ] 首个真实 A2A 客户端接入验证（With 或 Claude Code）
- 验收：PRD-4 AC1-AC4

## 里程碑之外（暂不排期）

- 第二台 agent（家里服务器）——M2 架构天然支持，接入是运维动作不是开发项。
- Tailscale 直连替代 relay 隧道——等 relay 痛点真实出现。
- 事件触发器扩展（位置、NFC、app 状态类 iOS 自动化）——YAGNI 区。
