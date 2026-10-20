# 契约定义（SSOT）

- 版本：v2.1（v2.0 的身份绑定与 artifact 归属保持不变。v2.1 只加可选字段：`agent.hello.bootId`、任务 `trace`、`run-trace` 上行，以及 Target 的 `lostTtl` / `approvalTtl`。不带这些字段的 2.0 agent 仍可注册）。全新安装只接受 2.x agent，不提供 1.x 兼容模式
- 形态分工：本文档定义语义与纪律；帧与数据的机器可校验格式在 [schemas/](schemas/)（JSON Schema draft 2020-12）。两者冲突时以 schema 为准，并回修本文档
- 本文件是全系统契约的唯一权威源。hub（Novoard 仓）与各 agent 实现（Mac lite-agent、内网 lite-agent 等）都必须对齐这里；cronkit 仅为参照原型（ADR-0007），实现方各自凭默契抄写即制造分叉
- 字面语纪律：A2A 帧的方法名、字段名、错误码字面对齐 A2A spec（JSON-RPC 2.0 over HTTPS），不私自改名、不改语义；Novoard 私有概念只允许出现在信封层与 `x-novoard-*` 扩展字段

## 0. 版本与变更流程

- `contractVersion` 语义化版本（当前 `2.1`）：主版本破坏兼容（字段删除、语义反转、枚举缩减），次版本向后兼容（新增可选字段、新增枚举值）
- 握手：`agent.hello` 必带 `contractVersion`；hub 侧主版本不匹配 → 拒绝注册并回执原因，不降级兼容
- 契约变更 = ops 枚举新增帧、字段语义变更、wire format 任何改动。流程：修订本文件 + 对应 schema + 升版本号，已注册成员对齐后生效，不做静默漂移
- 本版冻结范围与 defer 清单见 §10

## 1. target 定义（agent 侧 YAML）

target 定义留在 agent 本地（YAML + stepTemplates），是所有能力、安全与审计待遇的唯一来源（ADR-0002 定义所有权、ADR-0005 定义时判断与路由查表）。steps 语法定义于本节，演进权归本契约（ADR-0007）；与 cronkit 原型不承诺逐字兼容，仅形态参照。

```yaml
targets:
  deploy-investm:
    title: 部署 InvestM 到本地
    schedule: "0 9 * * 1"     # 可选，cron 表达式；调度归 agent 本地（ADR-0003）
    steps: [...]              # step 语法见 §1.2；与 template 二选一
    template: deploy-webapp   # 可选，引用 stepTemplates 参数化展开
    vars:
      repo: InvestM
      port: 5173
    expose: a2a              # a2a = 进 Agent Card（远程可委派）；local = 只进本地注册表
    audit: summary           # none / summary / full —— 持久化待遇
    requiresApproval: false  # true = 执行前 input-required 审批门
    notify: always           # always / on-failure / never —— 通知扇出策略（PRD-3 F2）
```

### 1.1 字段语义（ADR-0005 表的物化）

| 字段 | 取值 | 运行时行为 |
| --- | --- | --- |
| `schedule` | cron 表达式 | agent 本地调度，hub 不参与定时；周报类 target 的归属依据 |
| `expose` | `a2a` / `local` | `a2a` 进 Agent Card skills，远程可委派，走 task 生命周期；`local` 只进本地注册表与磁贴，远程请求查无此项 |
| `audit` | `none` / `summary` / `full` | 持久化待遇：不记 / 记起止与终态 / 记全步骤事件流 |
| `requiresApproval` | `bool` | `true` 则 task 转 input-required，审批门沿链双向透传，IM/Web/磁贴任一入口可恢复 |
| `notify` | `always` / `on-failure` / `never` | 终态通知扇出策略，定义时决定，运行时查表 |
| `offline` | `reject` / `queue` | 成员离线时触发策略（M2）：`reject` 拒绝并通知；`queue` 入队带 TTL，成员上线后自动下发，TTL 到期转 failed 并通知。随 card 以 `x-novoard-offline` 透传（§2） |
| `offlineTtl` | 时长字面（`30m` / `2h` / `1d`） | `offline: queue` 的等待上限，默认 `30m`；到期未上线转 failed，审计记 `offline-ttl-expired` |
| `concurrency` | 整数 `1`–`32`，默认 `1` | 这个 Target 同时允许的运行数。`1` 表示不能重叠 |
| `timeout` | 时长字面（`30s` / `10m` / `1h`），默认 `10m` | 单次运行上限，到点停止。随 card 以 `x-novoard-timeout` 透传 |
| `lostTtl` | 时长字面，默认 `10m` | 成员断开后，超过此时长仍未带着该任务重连，才把 `working` 收成 `failed` / `agent-lost`。与 `timeout` 分开。随 card 以 `x-novoard-lost` 透传。任务进入 `working` 时抄下当时的值，之后改配置不影响这一单 |
| `approvalTtl` | 时长字面，默认 `10m` | `requiresApproval` 时 `input-required` 的等待上限，到期 `canceled`（`approval-ttl-expired`）。随 card 以 `x-novoard-approval` 透传。进入 `input-required` 时抄下当时的值 |

### 1.2 steps 语法（契约内部化）

step 为有序数组，顺序执行，任一步失败即 target 失败（终态 failed，携带失败步骤号与 stderr 摘要）。四种 step 类型：

```yaml
steps:
  - script: git pull --ff-only            # ① shell 命令
  - script: pnpm build
    cwd: "{{repoDir}}"                    # 可选工作目录，默认 target 定义声明的仓库根
    env:                                  # 可选环境变量
      NODE_ENV: development
  - openApp: "http://localhost:{{port}}"  # ② 打开实例：http(s) URL 走默认浏览器；其余按应用路径/命令拉起
  - openPath: "{{repoDir}}/dist"          # ③ 打开路径：系统文件管理器揭示
  - template: smoke-check                 # ④ 引用 stepTemplate（§1.3），展开后等价 ①-③
```

- 插值语法 `{{var}}`：取值优先级为触发时传入 vars > target `vars` > stepTemplate 默认值
- `{{var}}` 无任何来源即校验失败：agent 启动自检报错（schemas/target.json），运行期不静默替换为空串
- `script` 只做 shell 转义，不提供额外安全承诺；危险动作一律走 `requiresApproval` 审批门，不靠转义保安全

### 1.3 stepTemplates

- 模板与 target 同仓（agent 本地 `templates/` 目录），结构与 target 的 steps + vars 默认值相同
- `template: deploy-webapp` 展开等价于内联其 steps；target `vars` 覆盖模板默认值
- 两台 Mac dev builder 共用同一模板、vars 填机器差异（路径/拉取方式/端口），是模板机制的试点验收场景（PRD-5 F2）

## 2. Agent Card（A2A 能力声明）

由 agent 从 target 定义派生，hub 聚合。字段字面对齐 A2A spec：

```json
{
  "name": "mac-work",
  "description": "工位 Mac · dev builder",
  "version": "1.0.0",
  "capabilities": { "streaming": false, "pushNotifications": true },
  "defaultInputModes": ["text"],
  "defaultOutputModes": ["text", "file"],
  "skills": [
    {
      "id": "dev-build-investm",
      "name": "构建 InvestM dev 并部署本机",
      "description": "pull → build → deploy → smoke → open-app；vars: repo, port",
      "tags": ["dev", "deploy"]
    }
  ]
}
```

- 生成规则：每个 `expose: a2a` 的 target 生成一个 skill 条目；skill id = target id；description 写能力、安排和参数，不只是命令标题；target 的 `offline` / `offlineTtl` 以 `x-novoard-offline` 扩展字段随 skill 透传（hub 路由离线策略查此字段，§1.1；契约 v1.1 新增，schema `additionalProperties` 不受影响）。`timeout`、`lostTtl`、`approvalTtl` 分别以 `x-novoard-timeout`、`x-novoard-lost`、`x-novoard-approval` 透传。这些时长在 Agent 的 Target 编辑页调整，Hub 不写死
- 成员介绍：card 可带 `x-novoard-role`（稳定角色，如 `office-pc`）。`description` 是给其他成员看的自我介绍。对话技能 id 为 `converse`，`x-novoard-kind` 固定为 `agent`。这种技能不进全局 skill 路由表，多台成员可以同时声明；Target id 不能占用 `converse`
- 聚合 card = 当前调用主体 target 范围内、可点名执行的 skills 并集，附同样经过过滤的 `x-novoard-members`（member id → 寻址信息）；端点要求会话或 PAT 的 `targets.read` 权限。`x-novoard-kind: agent` 的技能不进入聚合 card，也不参与 skill id 冲突。其余 skill id 冲突时注册拒绝并回执，先到先得
- `GET /api/cards`（Bearer agent token）返回各成员已经推上来的完整 card。调用方按角色和介绍自己筛选，Hub 不替它选择 Target
- card 经 JWS 签名（A2A 防伪造），密钥管理见 §8

## 3. ops 帧枚举（旁路车道）

报状态不走 task 状态机（ADR-0004 旁路原则）。枚举封闭，新增帧类型是契约变更（§0）：

| type | 方向 | 载荷 | 说明 |
| --- | --- | --- | --- |
| `agent.hello` | agent → hub | agentId、card、contractVersion、可选 bootId、在途任务清单 | 注册 / 重连；身份来自 WebSocket Upgrade 的 Bearer token |
| `agent.ping` | 双向 | ts | 心跳 |
| `telemetry` | agent → hub | cpu/mem/磁盘摘要 | 可选，频率配置 |
| `card.update` | agent → hub | 新 card | target 定义变更后推送 |
| `notify.owner` | agent → hub | text | 请 Hub 用现有通知通道把这句话发给主人。不建 task，不进入 ops schema 枚举；身份取连接上的 agentId |

### 3.1 wire 示例

```json
{ "type": "agent.hello", "contractVersion": "2.1", "agentId": "mac-work",
  "card": { "…": "§2 结构" },
  "bootId": "6f1c2a40-7b8e-4d3a-9c1e-2a4b6c8d0e1f",
  "inFlightTaskIds": ["task-20261012-001"] }
```

```json
{ "type": "agent.ping", "ts": "2026-10-12T08:00:30Z" }
```

```json
{ "type": "telemetry", "ts": "2026-10-12T08:00:30Z", "cpuPct": 12, "memPct": 61, "diskPct": 74 }
```

```json
{ "type": "card.update", "card": { "…": "§2 结构" } }
```

### 3.2 路由与拒绝规则（ADR-0005）

`type` 在 ops 枚举内 → 旁路车道，不建 task、不进 task 审计（本身可按 `audit` 约定落 ops 日志）；不在枚举、不在 card → 拒绝。`notify.owner` 是表里的例外：它在 schema 校验之前处理，只请求现有通知通道。`contractVersion` 主版本不匹配 → 拒绝注册，回执 `{ "type": "agent.hello.nack", "reason": "contract-major-mismatch", "hubVersion": "2.0" }`。Bearer token 解析出的身份与 hello `agentId` 不一致 → `agent-identity-mismatch` 并断开；nack 属 hello 的回执语义，非新枚举帧。

## 4. 隧道协议（hub ↔ agent）

### 4.1 传输与鉴权

agent 出站 WebSocket 长连接（wss），Upgrade 请求携带 `Authorization: Bearer <agent token>`（§8）。每个 token 在 hub 端只对应一个 `agentId`；鉴权通过后连接即绑定该身份，后续 hello、card update、任务状态和 artifact 上行都不得切换或冒充其他 member。hub 不对 agent 开任何入站端口（ADR-0003 出站纪律）。

### 4.2 私有信封

隧道内所有帧包私有信封；信封是 Novoard 内部物流，A2A 标准只管"消息长什么样"，不管"怎么运输"：

```json
{ "v": 1, "kind": "a2a", "msgId": "e-42", "taskId": "task-20261012-001",
  "ts": "2026-10-12T09:00:00Z", "body": { "…": "完整 JSON-RPC 消息原样" } }
```

- `kind`: `ops` / `a2a` / `ack`；`taskId` 仅 a2a 帧必带
- `msgId` 信封级幂等 id（`e-` 前缀 + 序号或 uuid），重发同 msgId 即重放
- ack 回执：`{ "v": 1, "kind": "ack", "msgId": "e-42", "dedup": false }`；`dedup: true` 表示此前已收过（重复投递），发送方可安全丢弃本地缓存

### 4.3 A2A 字面对齐（方法名/字段名/错误码照抄 spec）

hub → agent 委派（`message/send` 的 params 原样转发，taskId/contextId 由 hub 生成并关联）：

```json
{ "v": 1, "kind": "a2a", "msgId": "e-42", "taskId": "task-20261012-001", "ts": "…",
  "body": {
    "jsonrpc": "2.0", "id": "req-1", "method": "message/send",
    "params": { "message": {
      "messageId": "msg-abc", "role": "user",
      "parts": [ { "kind": "text", "text": "构建 InvestM" } ],
      "contextId": "task-20261012-001", "taskId": "task-20261012-001" } } } }
```

agent → hub 上行（终态/进度/artifact 走 A2A push notification 形状）：

```json
{ "v": 1, "kind": "a2a", "msgId": "e-91", "taskId": "task-20261012-001", "ts": "…",
  "body": {
    "jsonrpc": "2.0", "method": "message/notification",
    "params": { "message": {
      "messageId": "msg-def", "role": "agent", "parts": [],
      "contextId": "task-20261012-001", "taskId": "task-20261012-001",
      "kind": "status-update",
      "status": { "state": "completed", "timestamp": "2026-10-12T09:07:41Z" } } } } }
```

- 父子任务关联：hub 下发时父任务 id 放 `contextId`，agent 上行帧原样带回，审计链由此拼接
- A2A 帧语义不变，传输复用隧道（ADR-0004：语义 A2A、传输走隧道——语义对齐到字面，信封自主）
- hub 对每个 status/artifact 上行重新读取 task，并要求 `task.member === authenticatedAgentId`；跨 member 伪造帧写安全审计、回 nack 并断开连接

### 4.3.1 成员对话

没有 `metadata.lane` 的 `message/send` 仍是 Target 点名，正文是 `run <skillId>`。`metadata.lane = "agent"` 是成员发给成员的自然语言：

- `metadata.to` 是接收方成员 id。`from` 只由 Hub 按连接上的 Agent Token 写入，报文里自带的 `from` 丢掉
- 接收方的 card 必须有 `x-novoard-kind: agent` 的技能。没有的旧成员收不到这条通道；Hub 回 `rejected` / `peer-unavailable`，不断开发送方
- 多轮用 Hub 盖上的 `contextId`。对方要补充时上行 `input-required`，下一条同 `contextId` 的 `message/send` 续上。这不是脚本审批，`tasks/approve` 和 `message/resume` 对它无效，审批超时也不会把它取消
- 上行 `message/notification` 转回这次对话的调用方，可带 text、data，以及已有 artifact 的 file 引用。任务已经终态之后的完成报告和在场信号仍然转发，不断开连接

### 4.4 断线语义（长任务纪律，dev builder 小时级任务必踩）

1. agent 侧：隧道断开不影响在途任务，继续执行；终态事件本地持久化（本地 JSONL 缓存）
2. 重连：agent 发 `agent.hello`（带 card、可选 `bootId`、`inFlightTaskIds`），随后按 taskId 重放缓存信封（同 `msgId`）
3. hub 侧：按 `msgId` 幂等去重——重复终态直接回 `dedup: true` 的 ack，不重复入审计、不重复通知
4. hub 重启：队列持久化保证已入队任务不丢（ADR-0006 留白项硬约束）；agent 侧重连后以 hello 对账恢复。Hub 重启后没有旧 `bootId`，不把「对不上」当成进程已死
5. `bootId` 在进程启动时生成，只放内存，不落盘。不带 `bootId` 的 hello 保持 2.0 行为：不因清单缺失失败，也不自动重发
6. 带了 `bootId` 时，对该成员名下 `working` / `input-required` 且不是成员对话的任务：清单里有的保持原状态；Hub 不记得上一个 `bootId`，或 `bootId` 没变但不在清单里，视为下行没送到，重新下发；`bootId` 变了又不在清单里，转为 `failed` / `agent-lost`，状态说明带上运行记录的最后一条
7. 成员一直不回来：Hub 内部约 30 秒扫一次，间隔不进界面。从断开时刻起超过该任务抄下的 `lostTtl`（缺省 `10m`）仍未重连，才把 `working` 收成 `agent-lost`。闪断期间成员已重连的不扫

### 4.5 运行记录（只追溯，不恢复）

每次 Target 运行在 agent 本地追加 `logs/runs/<taskId>.jsonl`。副作用发生前写入并 `fsync`。事件为 `run/start`、`step/start`、`step/end`、`run/end`。链路还在时，同一条事件以 `message/notification` 的 `kind: run-trace` 上行。Hub 追加到 `task.trace`，不因此改变任务状态；`seq` 幂等，终态之后仍可追加。

没有 `run/end` 表示停在最后一条。新进程只把这个尾巴以 `run/truncated` 报上去，不继续跑剩余步骤。记录不参与要不要重跑；终态仍由 `bootId` 对账、`lostTtl` 或原有的 `status-update` 决定。

## 5. HTTP 门与 A2A 端点（两扇门，ADR-0004）

### 5.1 人类客户端门（Web 面板 / iOS 快捷指令 / 企微 bot）—— 私有 REST

```json
POST /api/trigger
{ "target": "dev-build-investm", "vars": { "branch": "main" } }

→ 202
{ "taskId": "task-20261012-001", "state": "submitted" }
```

浏览器面板使用登录会话，iOS 快捷指令和其他机器客户端使用具名 PAT；两者都按当前用户角色和 target 范围授权。匿名请求、旧 `clientKeys` 与共享 dashboard 口令均不再接受。

fire-and-forget：客户端不查进度，靠通知扇出收终态（PRD-5 F4 轮询纪律同理）。路由复用同一张查表：仅 `expose: a2a` 的 target 可触发，`expose: local` 返回 404 `target not remotely triggerable`。快捷指令与 bot 不升 A2A 客户端。

成员离线时按 target `offline` 策略分流（§1.1，M2）：

```json
→ 202
{ "taskId": "task-20261012-001", "state": "queued-offline", "reason": "member-offline", "expiresAt": "2026-10-12T09:30:00Z" }
```

- `reject`（默认）：不入队，202 `{ state: "rejected", reason: "member-offline" }` + 通知
- `queue`：入队，202 `{ state: "queued-offline", reason: "member-offline", expiresAt }`；成员上线后自动下发，TTL 到期转 failed（审计 `offline-ttl-expired`）+ 通知

### 5.2 AI 客户端门 —— A2A 字面端点

- `GET /.well-known/agent-card.json` → 聚合 Agent Card（§2）；要求会话或 PAT，并按角色与 PAT 的 target allow/deny 过滤
- `POST /a2a` → JSON-RPC 2.0：`message/send`、`message/stream`（SSE，M4）、`tasks/get`、`tasks/cancel`、`tasks/approve`（审批门恢复，M4）
- `message/stream`：SSE 步骤级进度——订阅 task 状态变更；帧形状 `result: { kind: "status-update"|"artifact-update", taskId, status, final }`；agent 步骤进度以非终态 working 帧（status.message = "step i/n"）透传；15s 心跳注释行保活；连接前已终态则补发快照即关
- `message/resume`（hub → agent 下行，M4 审批门）：params `{ id, decision: "approve" }`；agent 侧 input-required 挂起 → 恢复执行；拒绝走 `tasks/cancel`
- `tasks/approve`（A2A 客户端 → hub，M4）：params `{ id, decision: "approve"|"reject" }`；仅 input-required 状态可恢复；三入口（IM AI / 面板 / 磁贴）共用此端点，状态只有一份
- 审批门 TTL：`input-required` 挂起超过该任务抄下的 `approvalTtl`（缺省 `10m`，Target 上可改）自动 canceled（`approval-ttl-expired`）+ 通知，并向创建任务时绑定的 Agent 下发 `tasks/cancel`；Agent 离线时由 Hub 持久状态在其携带 in-flight 清单重连后补发。旧 agent 未透传该字段时，Hub 仍用自身缺省 `10m`
- 统一授权：会话与 PAT 都解析为用户主体，按“权限 → target 范围”裁决；PAT 的有效权限和 allow/deny 分别与用户当前角色取交集，deny 优先。列表（含聚合 card 和状态计数）过滤无权资源，按 id 读取无权资源返回 404；不存在与无权 target 使用相同外部错误，拒绝原因只留安全审计。旧 `.state/acl.yaml`、`clientKeys`、`dashboard/human` 绕过均已删除
- Hub 任务状态枚举与转换表封闭校验；Agent 非法状态或非法转换在写盘前拒绝并关闭违规连接。所有下发、恢复、取消都使用 task 创建时持久化的 `member`，不能因 card 更新或 skill 转移改投其他成员

```json
{ "jsonrpc": "2.0", "id": "req-2", "method": "tasks/get", "params": { "id": "task-20261012-001" } }
```

响应为标准 task 对象（`status.state`、`artifacts`），state 枚举字面 A2A：`submitted / working / input-required / completed / failed / canceled / rejected`。

### 5.3 错误码（字面 A2A）

| 场景 | 错误 |
| --- | --- |
| 请求 `expose: local` 的 target（查无 skill） | `-32004 Operation not supported：target not remotely triggerable` |
| taskId 不存在 | `-32001 Task not found` |
| 任务已终态不可取消 | `-32002 Task not cancelable` |
| 身份无效 | HTTP 401/403 或 A2A `-32000 非法请求` |
| target 不存在或调用主体无权 | REST 统一 404；A2A 统一 `-32004 Operation not supported: target not remotely triggerable` |

## 6. 审计事件

JSONL 事件流水（issue-handler 同款模式），每行一事件：

```json
{ "ts": "2026-10-12T09:00:00Z", "actor": "client:with", "lane": "a2a",
  "target": "dev-build-investm", "taskId": "task-20261012-001",
  "outcome": "completed", "audit": "summary", "member": "mac-work" }
```

- 字段：ts、actor（`user:<id>` / `pat:<id>` / `agent:<id>` / `wecom:<senderUserId>` / `rule-engine` / `server:break-glass`）、lane（a2a/ops/local）、target、taskId、outcome（task 状态枚举）、audit 待遇、member；detail 可选。口令、会话令牌、PAT、agent token 与 webhook 正文明文绝不入审计；webhook 只记录 source、正文 SHA-256、字节数和顶层键名
- 落 hub 侧与 agent 侧各一份，可对账（§4.4 幂等去重保证两侧不因重放错账）
- 规则触发、审批门、离线拒绝全部进流水（PRD-5 NFR 审计同车道）

### 6.5 通知扇出与外部事件入口（M3）

- per-target `notify` 策略（§1 同字段）：`always`（默认）/ `on-failure`（仅 failed 终态通知）/ `never`；经 skill `x-novoard-notify` 随 card 透传，hub 终态通知前查表过滤
- 通知渠道降级链：企微智能机器人（主）→ 企微群 webhook（备）→ Bark（iOS 直达，`barkUrl` + `barkDeviceKey` secrets）；任一成功即止，全失败进日志不阻塞主流程
- 频控（状态口径，防吞增量）：同 target 同 (kind,state) 60s 窗口内，首条立即发送，后续计数累积；窗口到期 suppressed>0 追发一条合并摘要——增量不丢，仅延后呈现
- 通知触发点：terminal（终态）/ offline-reject / input-required / member-event（上线离线，M3 新增）
- 外部事件入口（F4）：`POST /api/webhook/:source`（具备 `webhooks.invoke` 的 PAT）→ 审计落流水（actor 保留 PAT 身份，只记录 source 与正文摘要）→ 规则引擎消费（事件名 `webhook-<source>`，body 仅在内存中作为 vars 透传）。任务只持久化 PAT/user id，不保存明文 token；首层及后续 task-terminal 续链的每个规则动作都重新解析 PAT 当前状态与 target 范围，吊销、过期、用户禁用或降权后 fail-closed，规则引擎不得成为提权通道
- 规则事件源（F3 首批三源）：`task-terminal` / `member-online` / `member-offline` / `webhook-<source>`

### 6.6 审批门全链路（M4）

- target `requiresApproval: true` → agent 侧挂起（非终态 input-required，与试点期"回执即终态"语义不兼容变更），hub task 停在 input-required
- 恢复三入口共用 `tasks/approve`（状态只有一份）：IM AI 回填 / Web 面板确认 / 本地磁贴确认（磁贴随 M5 载体）
- 恢复链：`tasks/approve` → hub 下行 `message/resume` → agent `startExecution` → 上行 working/终态；拒绝走 `tasks/cancel`（挂起任务 agent 侧直接出队）
- TTL：超过任务进入 `input-required` 时抄下的 `approvalTtl`（缺省 `10m`）自动 canceled（`approval-ttl-expired`），sweeper 与离线队列同频扫描；reject 与 TTL 都必须下发 `tasks/cancel`，离线 Agent 重连时按 in-flight 清单补发

## 7. artifact 语义

- artifact 属 A2A 车道（task 的产出概念），不是 ops 帧；内容上传成功即进入 task，后续 `artifact-update` push notification 只能引用 hub 返回的规范 artifactId，hub 会重新核对 task/member/target 并幂等处理
- agent 通过 `POST /api/artifacts` 上传 JSON：`{ taskId, name, content, encoding: "base64", digest: "sha256:…" }`。内容上限 5MB；hub 根据 Bearer token 得到 member，要求 task 存在且 `task.member === authenticatedAgentId`，并重新计算 digest
- hub 生成不可猜的 `artifactId`，持久化 `{ artifactId, taskId, member, target, name, digest, size }` 与内容文件；响应中的 task artifact 只引用 `/api/artifacts/<artifactId>`
- 下载必须具备 `artifacts.read`，且用户/令牌当前 target 范围覆盖该 artifact 的 member/target；无权与不存在统一返回 404
- 保留期：当前随 `.state/artifacts` 保留，不自动清理；审计流水只记 artifactId/digest 等元数据，不记内容，清理策略后续单独定义

## 8. 鉴权与密钥

### 8.1 首访、用户与浏览器会话

- 全新实例只公开 `GET /api/setup/status`、`POST /api/setup` 和初始化页面。`POST /api/setup` 在跨进程锁内原子创建首个 `superadmin` 并写入 `.state/install.json` 的 `initializedAt`；并发请求只有一个成功
- setup 是明确的 first-claim：部署者必须在上线后立即认领。初始化后入口永久返回 410；identity 缺失/损坏、install 已初始化但数据不一致、检测到旧共享凭据状态时 fail-closed，绝不重新开放
- 浏览器登录使用随机不透明会话，服务端只存哈希；Cookie 为 `HttpOnly + Secure + SameSite=Strict + Path=/`。setup/login 要求精确匹配可信 Origin 与 `application/json`，已登录写请求再校验 Origin + CSRF token。会话只保存 userId，每次请求读取用户和角色，因此禁用、改密、换角色立即生效
- 用户口令用异步 scrypt + 独立随机盐。登录采用统一失败文案，并分别按账号、可信来源和全局窗口限速。只有本机 nginx 来源才允许其 `X-Real-IP`

### 8.2 角色与个人访问令牌

- 内置角色：`superadmin`、`admin`、`operator`、`viewer`；内置角色不可编辑/删除。自定义角色只能组合固定业务权限，且 target 默认拒绝、deny 优先
- `superadmin` 只能由现有 superadmin 授予或撤销；最后一个有效 superadmin 不可禁用、删除或降级。服务器 `node src/admin.mjs recover <username>` 仅能恢复已存在的 superadmin，不能创建用户、提权或重开 setup
- PAT 前缀 `nvp_`，256 bit 随机值，identity 只存哈希；明文只在创建响应出现一次。PAT scope 只允许机器接口权限，显式传入时必须是非空数组；不能登录后台、管理身份或管理 PAT。其 scope/target 范围与用户当前角色动态取交集，过期、吊销、用户禁用和角色降权立即生效
- 企微使用不可登录的 `wecom-bot` 服务账号与最小 scope PAT。单聊校验 sender 白名单，群聊同时校验 sender/chat，默认空白名单拒绝；服务 PAT 只对超级管理员可见/可吊销，轮换顺序为签发并验证新令牌 → 切换消费端 → 吊销旧令牌

### 8.3 agent 凭据

- agent token 前缀 `nva_`。成员身份（agentId、凭据哈希、签发时间）持久化在 hub 的 0600 `members.json`，是成员概念的唯一 SSOT；明文只在超级管理员签发/轮换时返回一次，落盘只存 `sha256(token)` 与末四位
- 成员与在线状态是两层：`members.json` 回答"谁是成员"，运行期注册表只回答"此刻谁连着"。面板成员列表、`/api/members` 与 `/api/status` 的 members 一律以成员目录为行、注册表为覆盖层，因此"已签发但从未接入"的成员同样可见、可轮换、可吊销，不会因离线或 hub 重启而消失
- 管理面：`GET /api/members` 返回成员视图（凭据字段仅 superadmin 可见）；`POST /api/members/:agentId` 签发或轮换（201 新建 / 200 轮换）；`DELETE /api/members/:agentId` 吊销并同步摘除在线 card。吊销后该 agentId 的 WebSocket Upgrade 与 artifact 上传立即 401，已建立连接在断线重连时失效
- token 只允许 WebSocket Upgrade 与 artifact 上传，不能充当用户/PAT。成员凭据不读取环境变量（`NOVOARD_AGENT_TOKEN_HASHES` 已废弃）；升级时若旧 `secrets.json` 仍含 `agentTokenHashes`，启动会一次性导入 `members.json` 并摘除该字段，已有同名成员不被覆盖
- JWS/card 签名仍属后续强化项；v2.0 的身份边界以 TLS + 绑定 agentId 的 Bearer token + 每帧 task/member 校验为准

## 9. schemas 目录（机器可校验的 SSOT）

| 文件 | 校验对象 |
| --- | --- |
| `target.json` | agent 的 targets YAML（转 JSON 后校验），启动自检 |
| `frame-agent-hello.json` / `frame-agent-ping.json` / `frame-telemetry.json` / `frame-card-update.json` | ops 四帧 wire format |
| `a2a-envelope.json` | 隧道信封（含 kind/taskId 条件约束与 ack 形状） |
| `agent-card.json` | 单成员 card 与聚合 card |
| `task.json` | A2A task 对象（含 state 枚举） |
| `audit-event.json` | JSONL 审计行 |

- 纪律一（启动自检）：lite-agent 启动时校验 target YAML 与待发帧，字段错误当场暴露，不带病上线
- 纪律二（CI 门禁）：hub 与各 agent 的测试用例引用同一份 schema；本文档中的 wire 示例同样纳入 CI 校验，md 与 schema 想分叉，CI 先红
- 冲突裁决：schema 为准，修 md

## 10. 冻结范围与 defer 清单

本版只冻结被三个试点（PRD-5）真实踩过的语义。以下演进点 defer，触发条件出现时走 §0 变更流程升版：

| defer 项 | 来源 | 解冻触发条件 |
| --- | --- | --- |
| `event.report` 事件上报帧 | research 0003 感知类 | 首个感知类成员（ESP32/HA 桥/日历桥）真实接入时设计，过渡期可先塞 telemetry 载荷 |
| §4 传输放宽（公网直连 / 会话式 spoke） | research 0003 传输变体 | 首个云函数 runner 或低功耗设备接入时 |
| skills 语义扩展（查询类 / 人工类 task） | research 0003 语义类 | 首个 LLM 成员或人工节点 card 声明时 |

明确不做：mesh（agent 互联）、hub 间联邦与多 hub 租户；单个 hub 支持多个受 RBAC 管理的登录用户——ADR-0003 非 target 重申。
