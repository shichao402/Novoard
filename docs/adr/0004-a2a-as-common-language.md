# ADR-0004: A2A 作为全系统通用语

- 状态：Accepted
- 日期：2026-10-12
- 讨论来源：2026-10-09 两轮 A2A 讨论（先"hub 对外一扇门"，后用户修正为"web 和 cronkit 之间就有 A2A，后续接入的都支持 A2A"）。

## Context

hub ↔ cronkit 若用私有 runner 协议，每接一个新节点（家里服务器、服务型 agent）都要写一次适配；外部 AI 客户端（With、Claude Code 等）接入也要定制。A2A 协议（Agent Card 能力发现、JSON-RPC 任务生命周期、SSE 流式、push 通知）恰好覆盖这些交互语义，且有官方 JavaScript SDK。

## Decision

A2A 不只放在 hub 对外边界，而是全系统通用语：

1. cronkit 升级为 A2A agent：本机持 Agent Card（skills = 暴露的 target 目录），localhost 起 A2A 端点，出站隧道承载与 hub 的 JSON-RPC 帧。
2. hub 同时是 A2A server（对外聚合 card、接受委派）与 A2A client（对成员下发）。
3. 磁贴 / 热键本身就是本机 A2A 客户端，打 localhost 端点，零网络、断网可用。
4. 两个工程问题的解法：
   - NAT 下行：A2A spec 无 server 主动连 agent 的原生通道，委派帧复用既有出站 WebSocket 承载——语义 A2A、传输走隧道（先 relay，后视需要 Tailscale 直连）。
   - 父子任务关联：A2A v1.0 无原生 parent/child，约定 hub 下发时父任务 id 放 contextId/metadata，上行事件原样带回，审计链由此拼接；审批门 input-required 沿链双向透传。
5. 旁路原则：做工作走 A2A 任务生命周期；报状态（心跳、telemetry、card 同步）走轻量旁路通道，不进 task 状态机。

## Consequences

- 收益：协议收敛，私有 runner 协议退役；新节点 = 一张 card + 一条隧道，零适配；本地磁贴、iOS 快捷指令、云端 AI 打的是同一个端点、同一套 skill 语义，只是网络路径不同（localhost / HTTPS / 隧道）；审批恢复多入口一致（状态只有一份）。
- 代价：JSON-RPC 信封 + 任务生命周期对高频小操作是税，skill 粒度做粗对冲；"内部全 A2A mesh"属 early adopter 用法，未沉淀为公认最佳实践；密钥从"hub 一把"变"每节点一把"，成员 card 需 JWS 签名，网关需维护"哪个客户端能打哪个成员"的授权矩阵。
- 替代方案否决：
  - A2A 只放对外边界、内部保留私有协议——被用户否决，理由是后续节点接入成本与协议分裂；采纳全 A2A 但以"协议本身很薄、语义资产可随传输层迁移"对冲风险。
  - 快捷指令升 A2A 客户端——它没有任务生命周期概念，协议对它是纯开销，走普通 HTTP fire-and-forget 门即可（两扇门原则）。
