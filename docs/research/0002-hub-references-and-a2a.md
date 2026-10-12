# Research 0002: hub-and-spoke 业界参照与 A2A 协议研究

- 日期：2026-10-09（讨论） / 2026-10-12（沉淀）
- 结论用途：ADR-0003（拓扑选型）、ADR-0004（A2A 通用语）的证据基础。

## Part 1: hub-and-spoke / 控制平面 + 执行代理

"客户端连服务、服务驱动 agent、服务集成通知"是业界标准解法，不是新发明：

| 系统 | 与 Novoard 的对应关系 |
| --- | --- |
| Home Assistant | hub 常驻，客户端（手机 App、Web UI）都连 hub；集成向 hub 注册能力，hub 不发明实体 |
| Jenkins / GitLab Runner / Buildkite Agent | server 管 UI、队列、通知；agent 主动外连领任务、执行、回传。cronkit 即 runner |
| Rundeck / AWX | runbook 自动化服务器：Web 定义任务、手动/定时触发、执行落远端节点、通知齐全 |
| Temporal | workers 长连接服务端拉任务流，服务端只做编排和状态 |
| n8n / Node-RED | 自托管服务集中收 webhook、编排、扇出通知 |

agent 主动外连被 Jenkins JNLP / GitLab Runner / Buildkite 共同选择的原因，对 Novoard 同样成立：agent 侧零入站端口、天然穿 NAT（Mac 在办公网 NAT 后）、安全面收敛到服务端一处。

反面参照：Rundeck 式"定义全在服务端"会让 agent 退化为哑执行器、离线失去本地定义能力——Novoard 拒绝此形态（ADR-0003 定义所有权）。

## Part 2: A2A 协议要点（2026-10 时点）

- 形态：JSON-RPC 2.0 over HTTPS，核心方法 `message/send`、`message/stream`（SSE）、`tasks/get`、`tasks/cancel`；Agent Card 经 `/.well-known/agent-card.json` 发布，v1.0 支持 JWS 签名防伪造。
- Task 生命周期：submitted → working →（input-required 审批门）→ completed / failed / canceled 终态；终态不可重启，重试须开新 task。
- 关键限制（对 Novoard）：spec 是 HTTP 请求/响应模型，无 server 主动连 agent 的原生通道——NAT 下行必须 relay（传输层反转，语义层不动）；v1.0 无原生 parent/child 任务，父子关联靠 contextId/metadata 约定。
- 概念映射：skills = target 目录镜像；Task = 一次 target 执行；Artifact = 部署日志/实例 URL/健康检查；PushNotificationConfig = 终态回推；contextId = 同项目多轮执行分组。
- 适配判断：协议本身很薄，对 Node hub 是一扇门而非一台引擎；语义资产（card/task/skill）即使换传输层也能带走。"内部全 A2A mesh"在 2026 年属 early adopter 用法，风险可控。

## 来源

- [A2A Protocol 官方规范](https://a2a-protocol.org/v0.3.0/specification/)
- [Agent2Agent (A2A) Protocol 综述（neurals.ca）](https://neurals.ca/tech/gemini/a2a-protocol)
- [A2A / ACP / ANP 生产环境对比（zylos.ai）](https://zylos.ai/research/2026-04-18-agent-to-agent-interoperability-protocols)
- [A2A Protocol Explained in 2026](https://www.360digitaltransformation.com/blogs/guides/a2a-protocol-explained-in-2026-how-agent2agent-works-mcp-vs-a2a-and-your-first-multi-agent-build)
- [The A2A Protocol Guide（agentswarms.fyi）](https://agentswarms.fyi/blog/a2a-agent-to-agent-protocol-guide)
