# 契约定义（SSOT）

- 版本：v0.1 草案（M0 阶段产出，M1 实现前定稿）
- 本文件是全系统契约的唯一权威源。hub（Novoard 仓）与 agent（cronkit 仓）的实现都必须对齐这里，各自复制字段定义即制造分叉。

## 1. target 定义（agent 侧 YAML）

target 定义留在 agent 本地（cronkit YAML + stepTemplates），是所有能力、安全与审计待遇的唯一来源（ADR-0002 定义所有权、ADR-0005 定义时判断）。

```yaml
targets:
  deploy-investm:
    title: 部署 InvestM 到本地
    steps: [...]            # cronkit 既有 step 语法，或引用 stepTemplates
    template: deploy-webapp # 可选，stepTemplates 参数化
    vars:
      repo: InvestM
      port: 5173
    expose: a2a             # a2a = 进 Agent Card（远程可委派）；local = 只进本地磁贴
    audit: summary          # none / summary / full —— 持久化待遇
    requiresApproval: false # true = 执行前 input-required 审批门
```

字段语义（ADR-0005 表的物化）：

| 字段 | 取值 | 运行时行为 |
| --- | --- | --- |
| `expose` | `a2a` / `local` | `a2a` 进 Agent Card skills，远程可委派，走 task 生命周期；`local` 只进本地注册表与磁贴，远程请求查无此项 |
| `audit` | `none` / `summary` / `full` | 持久化待遇：不记 / 记起止与终态 / 记全步骤事件流 |
| `requiresApproval` | `bool` | `true` 则 task 转 input-required，审批门沿链双向透传，IM/Web/磁贴任一入口可恢复 |

## 2. Agent Card（A2A 能力声明）

由 agent 从 target 定义派生，hub 聚合。card 生成规则：

- 每个 `expose: a2a` 的 target 生成一个 skill 条目。
- skill id = target id；skill 描述 = target title + 参数说明。
- card 经 JWS 签名（A2A v1.0 防伪造）。
- hub 的聚合 card = 所有在线成员 card 的 skills 并集，附 member 寻址信息。

## 3. ops 帧枚举（旁路车道）

报状态不走 task 状态机（ADR-0004 旁路原则）。枚举封闭，新增帧类型是契约变更：

| type | 方向 | 载荷 | 说明 |
| --- | --- | --- | --- |
| `agent.hello` | agent → hub | card、agent token、能力清单 | 注册 / 重连 |
| `agent.ping` | 双向 | ts | 心跳 |
| `telemetry` | agent → hub | cpu/mem/磁盘摘要 | 可选，频率配置 |
| `card.update` | agent → hub | 新 card | target 定义变更后推送 |

路由规则（ADR-0005）：`type` 在 ops 枚举内 → 旁路车道，不建 task、不进 task 审计（但本身可按 `audit` 约定落 ops 日志）；不在枚举、不在 card → 拒绝。

## 4. 隧道协议（hub ↔ agent）

- 传输：agent 出站 WebSocket 长连接（wss），携带 agent token 鉴权。
- 承载两种帧：ops 旁路帧（上述枚举）与 A2A JSON-RPC 帧（委派、进度、终态、push）。
- A2A 帧语义不变，传输复用隧道（ADR-0004：语义 A2A、传输走隧道）。
- 父子任务关联：hub 下发时父任务 id 放 `contextId`，agent 上行帧原样带回，审计链由此拼接。

## 5. HTTP 门（人类客户端）

- Web 面板、iOS 快捷指令走普通 HTTPS 入口，fire-and-forget，复用同一套路由表（`expose: a2a` 的 target 才可触发）。
- 快捷指令不升 A2A 客户端（两扇门原则，ADR-0004）。

## 6. 审计事件

JSONL 事件流水（issue-handler 同款模式）。每条至少含：ts、actor（谁触发：human/ai/client-id/agent-cron）、lane（a2a/ops/local）、target、task 级 outcome、audit 待遇。落 hub 侧与 agent 侧各一份，可对账。
