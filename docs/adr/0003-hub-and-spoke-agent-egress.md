# ADR-0003: hub-and-spoke 拓扑与 agent 主动外连

- 状态：Accepted
- 日期：2026-10-12
- 讨论来源：2026-10-09 "健全 web 服务网关"讨论（业界参照：Home Assistant、Jenkins/GitLab Runner、Rundeck/AWX、Temporal、n8n）。

## Context

手机与 AI 客户端要触发 Mac 上的操作，最初设想是"薄桥"：CVM 上小服务收到请求后调用 Mac 的 CLI。这隐含一个致命假设——服务端能主动够到 Mac。但 Mac 在办公网络 NAT 后，不可能接受入站连接，只能靠 Tailscale 兜底。

同时需求已经超出"翻译一条命令"：多客户端、机器人通知、集中审计、自动化规则，都需要一个带状态的中心。

## Decision

采用 hub-and-spoke（控制平面 + 执行代理）拓扑，且连接方向固定为 agent 主动外连：

1. hub 部署在 CVM（重庆 CVM 9.134.241.248，issue-handler 同机共存、不竞争），持有任务队列、自动化规则、Agent 注册表、审计流水、通知扇出。
2. cronkit 作为 agent 向 hub 发起出站长连接（WebSocket / SSE 长轮询），任务顺这条既有连接下发。agent 侧零入站端口。
3. 三条设计原则同步定型：
   - 定义所有权：target 定义（YAML + stepTemplates）留在 cronkit 本地；连上 hub 时注册 target 目录，hub 只持镜像。
   - 调度归属：本地 cron 定时留在 cronkit（Mac 合盖时段任务在远端排队无价值且制造双中心）；hub 只管事件触发与路由。
   - 安全边界：hub 是"对 Mac 的远程执行即服务"，必须 agent 独立 token、白名单指令（运行 target X，而非任意 shell）、全量审计、离线时任务入队或拒绝并通知。

## Consequences

- 收益：天然穿 NAT（与 GitLab Runner / Buildkite Agent / Jenkins JNLP 同选型）；安全面收敛到 hub 一处；本地入口直连内核，离线完整可用。
- 代价：hub 是带状态、鉴权、队列、审计、通知的第二个产品，工作量性质从"翻译命令"升级为"建设服务"；好在 issue-handler 已攒齐同款服务端 DNA（server 统一服务、JSONL 事件流水、dashboard 单页、凭据热配置），模式可搬。
- 替代方案否决：
  - 薄桥 + Tailscale——近期单场景下是 YAGNI 正确答案，但多客户端与通知集成价值兑现后会被推翻，不如直接按终态拓扑分阶段建设。
  - hub 侧全量调度（定时也上 hub）——见 Decision 3 调度归属的否决理由。
