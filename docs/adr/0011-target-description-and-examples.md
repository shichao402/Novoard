# ADR-0011: target 定位先靠描述与示例，分面检索等真实规模再做

- 状态：Accepted
- 日期：2026-11-09
- 讨论来源：2026-11-09 正式使用前的梳理。目标场景是「通过 novoard-voice 说一句『编译安装 mac 上的 xxx 项目 dev 版本』就能触发」。讨论从「target 很多时缺定位能力」出发，先后设计了 project 分面、subject 分面、Hub 过滤接口，并对照 Home Assistant Assist、A2A AgentSkill、MCP ToolAnnotations、Anthropic Tool Search 做了扩大案例测试。最后用户追问「有没有过度设计」，确认当前规模不需要分面检索，收敛为本 ADR

## Context

现在的寻址只有一种：调用方拿精确的 skill id 调 `POST /api/trigger` 或 `message/send`。发现靠 `GET /api/targets` 和聚合 Agent Card 两个平铺列表。每个 skill 可供挑选的信息只有 `name`（来自 target 的 `title`）和 `description`，后者由 agent 用 `title`、`schedule`、变量名拼出来，`tags` 固定为 `["novoard"]`。

现状规模：每台成员有个位数的 target，全系统预计 5 到 20 个。业界经验（Anthropic Tool Search）是工具数量超过 30 到 50 个，模型挑选的准确率才会明显下降；在这之前，把整张聚合 card 交给模型挑选是可行的。真正影响挑选质量的，是每个 skill 有没有足够的文字说明它做什么、在什么场景下被叫到。

另一个约束是 skill id 全局唯一、先到先得（契约 §2）。同一个动作要在两台机器上各定义一份时，后注册的成员会被拒。

## Decision

target 增加可选的 `description` 和 `examples`，原样透传到 A2A AgentSkill 的同名标准字段；skill id 用命名约定避免撞名；分面定位与过滤接口暂不做，触发条件写在下面的 defer 表里。

### 1. target 新增两个可选字段

```yaml
targets:
  novoard-agent-dev-install:
    title: 编译安装 Novoard Agent 开发版
    description: 触发 CI 编译 dev 渠道包，下载 mac 安装包，替换本机开发版并启动，约 20 分钟
    examples:
      - 编译安装 mac 上的 agent 开发版
      - 装一下 novoard-agent dev 版
    steps: [...]
    expose: a2a
    audit: summary
    requiresApproval: false
    notify: always
```

- `description`：一两句话说清做什么、作用在哪、大约多久。写了就替代 agent 自动拼出的描述。
- `examples`：人会怎么叫它，给模型做匹配用。

### 2. 派生规则：走 A2A 标准字段，不自造扩展

```json
{
  "id": "novoard-agent-dev-install",
  "name": "编译安装 Novoard Agent 开发版",
  "description": "触发 CI 编译 dev 渠道包，下载 mac 安装包，替换本机开发版并启动，约 20 分钟",
  "examples": ["编译安装 mac 上的 agent 开发版", "装一下 novoard-agent dev 版"],
  "tags": ["novoard"]
}
```

`description` 与 `examples` 都是 A2A AgentSkill 的原有字段，不认识 Novoard 的 A2A 客户端也能直接使用。没写 `description` 时，沿用现在的自动拼接规则。

### 3. 机器怎么叫：用现有的成员介绍

成员 card 已有 `description`（自我介绍）和 `x-novoard-role`。在介绍里写明「家里的 iMac，日常开发机」，模型即可把「mac 上」「家里」对上成员，本次不新增成员别名字段。

### 4. skill id 命名约定（不改代码）

- 格式 `<对象>-<动作>`，例如 `novoard-agent-dev-install`、`weather-query`。
- 只有一台机器提供时不加机器后缀。同一个 target 要接入第二台机器时，在「机器名后缀」和「多台机器共用同一个 id」之间选，见下面的推迟表。
- 只针对机器本身的动作，对象写机器：`imac-lock`、`imac-disk-query`。

### 5. 客户端规则（voice、IM AI 等，不进契约）

- 先判断意图属于哪一类：触发 target、查任务状态、和成员对话（`converse`）、建自动化规则。只有第一类去挑 target。
- 挑不出唯一结果时，列出候选让人选，不让模型自己定。
- 有副作用的 target 先复述再执行：「将在 imac5k2020 上编译安装 Novoard Agent 开发版，确认吗？」`requiresApproval` 仍是强制审批门，复述只是客户端层的口头确认。

### 6. 契约变更

契约 v2.4：`target.json` 增加可选 `description`（string）与 `examples`（string 数组）；agent `deriveCard` 透传；Hub 不需要改逻辑，聚合 card 原样带出。两仓同步改。2.3 的 agent 不带这两个字段，行为不变。

## Deferred：先不做，满足条件再立 ADR

| 推迟项 | 做的时机 | 已有的设计结论 |
| --- | --- | --- |
| 定位分面 `action` + `subject`，派生为 `tags: ["action:install", "subject:xxx"]` | 全系统 target 超过约 30 个，或实际出现挑错 | 不用 `project`（不通用）；`subject` 可选，不写表示机器本身；`action` 用小词表 `query open run build test install deploy start stop restart update turn-on turn-off set`；参照 Home Assistant 的 intent + slots |
| `GET /api/targets` 按分面过滤 | 同上 | AND + 精确匹配，Hub 不做语义理解；0 命中先放宽一个条件重查；写明合法的定位组合 |
| 触发时传参（`inputs`） | 写第一个离不开参数的 target 时，例如查任意城市的天气 | 定位条件与参数分开：「北京」是参数不是定位条件；缺必填参数时追问，参照 Alexa / App Intents |
| `readOnly` 声明 | 查询类 target 多到逐个口头确认让人烦 | 参照 MCP `readOnlyHint` / `destructiveHint`，默认按有副作用处理；只影响口头确认，不替代 `requiresApproval` |
| 成员别名字段、默认成员 | voice 做出来，并且确实说不清是哪台机器 | 参照 Home Assistant `context_area`：没说机器时默认用发话设备所在成员；`member` 永远表示执行者，不表示目的地 |
| `placement: any` | 出现在哪台机器执行结果都一样的 target（如查天气），且确实要在多台上各定义一份 | 含义是「任选一台在线成员执行」，解决可互换执行，不能替代下一行的「指定机器」 |
| 多台机器共用同一个 id（成员 + skill 联合寻址） | 同一个 target 要接入第二台机器 | 不必升大版本：`skillIndex` 改为一个 id 对应多台成员；触发请求加可选 `member`（A2A 用 `skillId@member`，agent 本机入口已能解析）；id 只在一台时行为不变，在多台且没指定 member 时返回 409 并列出候选，`offline: queue` 同样返回 409，不随便挑一台排队；Hub 一个 id 一张卡片，配机器选择器；授权 `targetAllowed(principal, member, skillId)` 和 task 的执行成员记录已经按成员区分。改动面主要是 registry 和 5 处 `ownerOf` 调用。备选做法是机器名后缀（契约零改动，代价是 N 张卡片、PAT 要逐条配）；否决 Hub 把对外 id 改成 `member/skillId`，这会让已有 PAT、快捷指令和通知里的 id 全部变化 |
| 项目仓库作为共享定义的唯一来源（`.novoard/targets.yaml`） | 上一行做完后，多台机器维护同一份定义确实出现不一致；最好再攒到一两种编译安装以外的 target 用例 | 共享部分（id、标题、描述、steps、默认超时）放在项目仓库，`cwd` 默认是仓库根目录；每台机器只登记项目路径，可选覆盖限白名单（timeout、env、vars、notify，审批只能改得更严）；同一个 id 同时出现在本机 `targets.yaml` 和项目文件里时报冲突；card 带 `x-novoard-source`（repo、commit、只对共享部分计算的 `defHash`），Hub 只标 drift，不拒绝注册，不下发定义。需要补「仓库文件变化后重新加载」；只扫描明确登记的目录。否决 Hub 当中心定义库往下推送（控制方向反转，离线机器同步不到）和「先注册的为准」（是否先上线是偶然的） |

## Consequences

- 收益：用最小的契约改动，直接提升模型挑选的准确率。两个字段都是 A2A 标准字段，没有私有扩展。前面讨论的分面方案没有丢，带着触发条件存在 defer 表里，规模上来时可以直接接着做。
- 代价：挑选质量依赖人写的 `description` 和 `examples`，写得含糊模型就会挑错。需要在 Target 编辑页给出提示和示例。
- 风险：target 数量增长时，聚合 card 会越来越长。defer 表里的第一条就是对这个风险的应对，触发条件是可观察的（数量或真实挑错）。
- 否决的方案：
  - 现在就做分面定位加过滤接口：规模没到，词表和切分方式都还没有真实用例支撑，大概率要返工，而且每个 target 要多填几个字段。
  - Hub 内置语义检索：违反 ADR-0005 与 PRD-4 的 Hub 零 LLM 原则。
  - 用 `x-novoard-aliases` 承载口语别名：A2A 已有 `examples`，不需要自造扩展。

## 参考

- [A2A Protocol Specification（AgentSkill）](https://a2a-protocol.org/dev/specification/)
- [MCP Schema 2025-06-18（ToolAnnotations）](https://modelcontextprotocol.io/specification/2025-06-18/schema.md)
- [Home Assistant Intent Recognition](https://developers.home-assistant.io/docs/voice/intent-recognition)
- [Home Assistant Built-in Intents](https://contributors.home-assistant.io/core/internals/built-in-intents/)
- [Anthropic: Advanced Tool Use](https://www.anthropic.com/engineering/advanced-tool-use)
