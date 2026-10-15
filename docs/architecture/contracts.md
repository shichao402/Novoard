# 契约定义（SSOT）

- 版本：v2.0（v1.1 的 target / A2A 语义保持不变；v2.0 破坏性升级 agent 身份绑定与 artifact 归属：Bearer token 唯一绑定 `agentId`，hello 不再携带 token，artifact 必须绑定 task/member/target 并校验 digest）。全新安装只接受 2.x agent，不提供 1.x 兼容模式
- 形态分工：本文档定义语义与纪律；帧与数据的机器可校验格式在 [schemas/](schemas/)（JSON Schema draft 2020-12）。两者冲突时以 schema 为准，并回修本文档
- 本文件是全系统契约的唯一权威源。hub（Novoard 仓）与各 agent 实现（Mac lite-agent、内网 lite-agent 等）都必须对齐这里；cronkit 仅为参照原型（ADR-0007），实现方各自凭默契抄写即制造分叉
- 字面语纪律：A2A 帧的方法名、字段名、错误码字面对齐 A2A spec（JSON-RPC 2.0 over HTTPS），不私自改名、不改语义；Novoard 私有概念只允许出现在信封层与 `x-novoard-*` 扩展字段

## 0. 版本与变更流程

- `contractVersion` 语义化版本（当前 `2.0`）：主版本破坏兼容（字段删除、语义反转、枚举缩减），次版本向后兼容（新增可选字段、新增枚举值）
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

- 生成规则：每个 `expose: a2a` 的 target 生成一个 skill 条目；skill id = target id；description = title + vars 参数说明；target 的 `offline` / `offlineTtl` 以 `x-novoard-offline` 扩展字段随 skill 透传（hub 路由离线策略查此字段，§1.1；契约 v1.1 新增，schema `additionalProperties` 不受影响）
- 聚合 card = 所有在线成员 card 的 skills 并集，附 `x-novoard-members` 扩展字段（member id → 寻址信息）；skill id 冲突时注册拒绝并回执，先到先得
- card 经 JWS 签名（A2A 防伪造），密钥管理见 §8

## 3. ops 帧枚举（旁路车道）

报状态不走 task 状态机（ADR-0004 旁路原则）。枚举封闭，新增帧类型是契约变更（§0）：

| type | 方向 | 载荷 | 说明 |
| --- | --- | --- | --- |
| `agent.hello` | agent → hub | agentId、card、contractVersion、在途任务清单 | 注册 / 重连；身份来自 WebSocket Upgrade 的 Bearer token |
| `agent.ping` | 双向 | ts | 心跳 |
| `telemetry` | agent → hub | cpu/mem/磁盘摘要 | 可选，频率配置 |
| `card.update` | agent → hub | 新 card | target 定义变更后推送 |

### 3.1 wire 示例

```json
{ "type": "agent.hello", "contractVersion": "2.0", "agentId": "mac-work",
  "card": { "…": "§2 结构" },
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

`type` 在 ops 枚举内 → 旁路车道，不建 task、不进 task 审计（本身可按 `audit` 约定落 ops 日志）；不在枚举、不在 card → 拒绝。`contractVersion` 主版本不匹配 → 拒绝注册，回执 `{ "type": "agent.hello.nack", "reason": "contract-major-mismatch", "hubVersion": "2.0" }`。Bearer token 解析出的身份与 hello `agentId` 不一致 → `agent-identity-mismatch` 并断开；nack 属 hello 的回执语义，非新枚举帧。

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

### 4.4 断线语义（长任务纪律，dev builder 小时级任务必踩）

1. agent 侧：隧道断开不影响在途任务，继续执行；终态事件本地持久化（本地 JSONL 缓存）
2. 重连：agent 发 `agent.hello`（带 card、`inFlightTaskIds`），随后按 taskId 重放缓存信封（同 `msgId`）
3. hub 侧：按 `msgId` 幂等去重——重复终态直接回 `dedup: true` 的 ack，不重复入审计、不重复通知
4. hub 重启：队列持久化保证已入队任务不丢（ADR-0006 留白项硬约束）；agent 侧重连后以 hello 对账恢复

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

- `GET /.well-known/agent-card.json` → 聚合 Agent Card（§2）
- `POST /a2a` → JSON-RPC 2.0：`message/send`、`message/stream`（SSE，M4）、`tasks/get`、`tasks/cancel`、`tasks/approve`（审批门恢复，M4）
- `message/stream`：SSE 步骤级进度——订阅 task 状态变更；帧形状 `result: { kind: "status-update"|"artifact-update", taskId, status, final }`；agent 步骤进度以非终态 working 帧（status.message = "step i/n"）透传；15s 心跳注释行保活；连接前已终态则补发快照即关
- `message/resume`（hub → agent 下行，M4 审批门）：params `{ id, decision: "approve" }`；agent 侧 input-required 挂起 → 恢复执行；拒绝走 `tasks/cancel`
- `tasks/approve`（A2A 客户端 → hub，M4）：params `{ id, decision: "approve"|"reject" }`；仅 input-required 状态可恢复；三入口（IM AI / 面板 / 磁贴）共用此端点，状态只有一份
- 审批门 TTL：input-required 挂起超 10 分钟自动 canceled（`approval-ttl-expired`）+ 通知
- 统一授权：会话与 PAT 都解析为用户主体，按“权限 → target 范围”裁决；PAT 的有效权限和 allow/deny 分别与用户当前角色取交集，deny 优先。列表过滤无权资源，按 id 读取无权资源返回 404；拒绝留安全审计。旧 `.state/acl.yaml`、`clientKeys`、`dashboard/human` 绕过均已删除

```json
{ "jsonrpc": "2.0", "id": "req-2", "method": "tasks/get", "params": { "id": "task-20261012-001" } }
```

响应为标准 task 对象（`status.state`、`artifacts`），state 枚举字面 A2A：`submitted / working / input-required / completed / failed / canceled / rejected`。

### 5.3 错误码（字面 A2A）

| 场景 | 错误 |
| --- | --- |
| 请求 `expose: local` 的 target（查无 skill） | `-32004 Operation not supported`，message 注明 `target expose=local, no remote capability` |
| taskId 不存在 | `-32001 Task not found` |
| 任务已终态不可取消 | `-32002 Task not cancelable` |
| 身份无效或越权 target | HTTP 401/403；A2A JSON-RPC 返回 `-32000 非法请求`，且无权资源按 404 隐藏 |

## 6. 审计事件

JSONL 事件流水（issue-handler 同款模式），每行一事件：

```json
{ "ts": "2026-10-12T09:00:00Z", "actor": "client:with", "lane": "a2a",
  "target": "dev-build-investm", "taskId": "task-20261012-001",
  "outcome": "completed", "audit": "summary", "member": "mac-work" }
```

- 字段：ts、actor（`user:<id>` / `pat:<id>` / `agent:<id>` / `wecom:<senderUserId>` / `rule-engine` / `server:break-glass`）、lane（a2a/ops/local）、target、taskId、outcome（task 状态枚举）、audit 待遇、member；detail 可选。口令、会话令牌、PAT 与 agent token 明文绝不入审计
- 落 hub 侧与 agent 侧各一份，可对账（§4.4 幂等去重保证两侧不因重放错账）
- 规则触发、审批门、离线拒绝全部进流水（PRD-5 NFR 审计同车道）

### 6.5 通知扇出与外部事件入口（M3）

- per-target `notify` 策略（§1 同字段）：`always`（默认）/ `on-failure`（仅 failed 终态通知）/ `never`；经 skill `x-novoard-notify` 随 card 透传，hub 终态通知前查表过滤
- 通知渠道降级链：企微智能机器人（主）→ 企微群 webhook（备）→ Bark（iOS 直达，`barkUrl` + `barkDeviceKey` secrets）；任一成功即止，全失败进日志不阻塞主流程
- 频控（状态口径，防吞增量）：同 target 同 (kind,state) 60s 窗口内，首条立即发送，后续计数累积；窗口到期 suppressed>0 追发一条合并摘要——增量不丢，仅延后呈现
- 通知触发点：terminal（终态）/ offline-reject / input-required / member-event（上线离线，M3 新增）
- 外部事件入口（F4）：`POST /api/webhook/:source`（具备 `webhooks.invoke` 的 PAT）→ 审计落流水（actor 保留 PAT 身份并记录 source）→ 规则引擎消费（事件名 `webhook-<source>`，body 整体作为 vars 透传给动作 target）
- 规则事件源（F3 首批三源）：`task-terminal` / `member-online` / `member-offline` / `webhook-<source>`

### 6.6 审批门全链路（M4）

- target `requiresApproval: true` → agent 侧挂起（非终态 input-required，与试点期"回执即终态"语义不兼容变更），hub task 停在 input-required
- 恢复三入口共用 `tasks/approve`（状态只有一份）：IM AI 回填 / Web 面板确认 / 本地磁贴确认（磁贴随 M5 载体）
- 恢复链：`tasks/approve` → hub 下行 `message/resume` → agent `startExecution` → 上行 working/终态；拒绝走 `tasks/cancel`（挂起任务 agent 侧直接出队）
- TTL：超 10 分钟自动 canceled（`approval-ttl-expired`），sweeper 与离线队列同频扫描

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
- 浏览器登录使用随机不透明会话，服务端只存哈希；Cookie 为 `HttpOnly + Secure + SameSite=Strict + Path=/`，写请求同时校验可信 Origin 和 CSRF token。会话只保存 userId，每次请求读取用户和角色，因此禁用、改密、换角色立即生效
- 用户口令用异步 scrypt + 独立随机盐。登录采用统一失败文案，并按账号和可信来源限速。只有本机 nginx 来源才允许其 `X-Real-IP`

### 8.2 角色与个人访问令牌

- 内置角色：`superadmin`、`admin`、`operator`、`viewer`；内置角色不可编辑/删除。自定义角色只能组合固定业务权限，且 target 默认拒绝、deny 优先
- `superadmin` 只能由现有 superadmin 授予或撤销；最后一个有效 superadmin 不可禁用、删除或降级。服务器 `node src/admin.mjs recover <username>` 仅能恢复已存在的 superadmin，不能创建用户、提权或重开 setup
- PAT 前缀 `nvp_`，256 bit 随机值，identity 只存哈希；明文只在创建响应出现一次。PAT scope 只允许机器接口权限，不能登录后台、管理身份或管理 PAT；其 scope/target 范围与用户当前角色动态取交集，过期、吊销、用户禁用和角色降权立即生效
- 企微使用不可登录的 `wecom-bot` 服务账号与最小 scope PAT。单聊校验 sender 白名单，群聊同时校验 sender/chat，默认空白名单拒绝；服务 PAT 只对超级管理员可见/可吊销，轮换顺序为签发并验证新令牌 → 切换消费端 → 吊销旧令牌

### 8.3 agent 凭据

- agent token 前缀 `nva_`，hub 的 0600 私密配置仅保存 `agentId → sha256(token)`；明文只在超级管理员创建/轮换凭据时返回一次
- token 只允许 WebSocket Upgrade 与 artifact 上传，不能充当用户/PAT。吊销后新连接和上传立即 401；已建立连接在断线重连时失效
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
