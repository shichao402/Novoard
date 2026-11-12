# PRD-6 本地调度与能力包（hub 侧实现单）

依据 [ADR-0012](../adr/0012-absorb-cronkit-into-agent.md)。agent 侧实现见 novoard-agent PRD-7。本文件只管 hub 仓要做的事。

开工前先看 [roadmap](../roadmap/roadmap.md)「跨仓：cronkit 吸收」表，确认依赖项已完成；做完一项回那张表改状态。

## 产出总览

| 编号 | 内容 | 依赖 |
| --- | --- | --- |
| H1 | 契约 v2.4：文档、schema、示例、版本号 | 无 |
| H2 | 来源清单存储 `src/pack-sources.mjs` | 无 |
| H3 | 管理台：来源清单增删改 | H2 |
| H4 | hello.ack 下发 `packSources` | H1、H2 |
| H5 | 契约 v2.5：来源包名自动发现，来源按仓库地址 + 分支 + 子目录识别 | H2–H4 |

H1 完成后通知 agent 仓开始 A1。两仓同批发布（[contracts.md](../architecture/contracts.md) §0）。

## H1 契约 v2.4

### 改动文件

- `docs/architecture/contracts.md`：
  - 版本行改为 v2.4；
  - §1 YAML 示例加 `oncePerDay`、`deadline`；
  - §1.1 表加两行；
  - §1.2 加第 ⑤ 种 step；
  - §2 加一句 Card 排除规则；
  - §4 hello.ack 字段说明加 `packSources`。
- `docs/architecture/schemas/target.json`：加字段与 `stepUses`，见下。
- `docs/architecture/schemas/frame-agent-hello-ack.json`：加 `packSources`。
- `src/contract/version.mjs`：改为 `2.4`。
- `conformance/`：补 uses step 正反例。

### target.json 增量

`$defs.target.properties` 新增：

```json
"oncePerDay": { "type": "boolean", "default": true, "description": "schedule 触发时同一天成功后不再触发；false 时按每个触发时刻去重" },
"deadline": { "type": "string", "pattern": "^([01]\\d|2[0-3]):[0-5]\\d$", "description": "schedule 触发的硬截止（agent 时区 HH:mm）。触发时刻晚于它则取次日；到点停止剩余步骤" }
```

`$defs.step.oneOf` 追加 `{ "$ref": "#/$defs/stepUses" }`，并新增：

```json
"stepUses": {
  "type": "object",
  "required": ["uses"],
  "properties": {
    "uses": { "type": "string", "pattern": "^[A-Za-z][A-Za-z0-9-]*/[a-z][a-z0-9-]*$", "description": "<能力包 id>/<工具 id>" },
    "with": {
      "type": "object",
      "additionalProperties": { "type": ["string", "number", "boolean", "array"], "items": { "type": "string" } }
    },
    "cwd": { "type": "string", "description": "工程根，传给工具 --project-root，也是路径锁的键" },
    "retry": { "type": "integer", "minimum": 0, "maximum": 10 },
    "retryInterval": { "type": "string", "pattern": "^\\d+(s|m|h|d)$" }
  },
  "additionalProperties": false
}
```

`with`、`cwd` 支持 `{{var}}` 插值，规则同 §1.2。

### hello.ack 增量

```json
"packSources": {
  "type": "array",
  "items": {
    "type": "object",
    "required": ["id", "git", "branch"],
    "properties": {
      "id": { "type": "string", "pattern": "^[A-Za-z][A-Za-z0-9-]*$" },
      "git": { "type": "string", "minLength": 1 },
      "branch": { "type": "string", "minLength": 1 },
      "subdir": { "type": "string", "description": "包根在仓库内的相对路径，缺省为仓库根" }
    },
    "additionalProperties": false
  }
}
```

### §2 新增规则

target 依赖的能力包在本机不可用（诊断有 error）时，该 target 不得出现在 Agent Card skills 中。可用性变化时 agent 发 `card.update`。

### 验收

- `npm test` 通过，门禁跑过新示例。
- v2.3 agent 连 v2.4 hub 能正常注册（忽略 packSources）。

## H2 来源清单存储

- 新文件 `src/pack-sources.mjs`，落盘 `<stateDir>/pack-sources.json`。原子写与 0600 权限照搬 `src/members.mjs` 的写法。
- 接口：`list()`、`upsert({ id, git, branch, subdir })`、`remove(id)`。按 schema 校验，非法即拒。
- 全局一份，不按成员区分。以后需要按成员覆盖时再加。
- 验收：单测覆盖增删改、非法 id 拒绝、重启后数据保留。

## H3 管理台

- 管理台新增「能力包来源」页：表格列出 id、git、branch、subdir，提供新增、编辑、删除。
- 新增时需输入一次 id（正则校验，实时提示）；之后编辑、删除一律在列表中选择，不再手输 id。
- 提示文案："修改后，在线成员重连时生效。"
- 验收：新增 osg 来源后，`pack-sources.json` 有对应条目；删除后消失。

## H4 下发

- `src/tunnel.mjs` 组装 `agent.hello.ack` 时（约 246 行）附上 `packSources: packSources.list()`。
- 验收：agent 重连后，在其 `<dataDir>/pack-sources.json` 缓存中看到同样内容（agent A5 完成后联调）。

## H2–H4 实现偏差（2026-11-09）

以实现为准：

- HTTP 接口：`GET /api/pack-sources`、`PUT /api/pack-sources/:id`（新建返回 201，更新返回 200）、`DELETE /api/pack-sources/:id`。权限沿用 `users.manage`，只认管理台会话，写操作要 CSRF，并记审计（pack-source-added、pack-source-updated、pack-source-removed）。
- 校验之外再加：branch 不能含空白、不能以 `-` 开头；subdir 统一成 `/` 分隔，拒绝绝对路径和 `..`，值为 `.` 或空视为未设置。文件损坏时拒绝读写，不按空清单处理。
- 读来源失败时 hello.ack 不带 `packSources`，agent 保留旧缓存，不会被清空。
- H4 联调：hub 侧单测验证 ack 带 `packSources` 且通过契约校验；agent 侧单测用 mock hub 验证缓存落盘。两侧真实进程对接留到 A7 控制台验收时一起做。

## H5 契约 v2.5：包名自动发现（2026-11-11）

起因：管理台新增来源要手输包 id，容易和仓库里 toolset.json 的 id 对不上。决定：包名由 agent 安装时从 toolset.json 读出，用户不用填，但允许覆盖。

- 契约：`hello.ack.packSources[].id` 从必填改为可选，语义变成「包名覆盖」。required 为 `["git","branch"]`。版本升到 2.5，conformance 补无 id 正例、非法 id 反例。
- 来源身份：`git + branch + subdir` 三元组。git 规范化规则是去掉末尾 `/` 和 `.git`，scheme、host 小写（scp 形式的 host 也小写）。hub 的 `packSourceIdentity` 与 agent 的 `sourceIdentity` 必须一致。
- 存储：`pack-sources.json` 升到 schemaVersion 2，每条带 hub 内部 key（`ps-<12hex>`），`wire()` 下发前去掉 key。读到 v1 时丢弃 id（当时都是手输的，按自动发现处理）、生成 key、去重，并立即写回。v2 里 key 非法时拒绝读写。
- 冲突：同一身份重复返回 409 `pack-source-conflict`；两个来源填了相同的覆盖名返回 409 `pack-name-conflict`。
- HTTP 接口：`POST /api/pack-sources` 新建，`PUT`/`DELETE /api/pack-sources/:key` 修改或删除，找不到返回 404。权限、CSRF、审计同 H3。
- 管理台：列为仓库、子目录、分支、包名（未覆盖时显示「自动」）。包名覆盖收在「高级」里。提示私有仓到 agent「设置 → Git 凭据」配置。
- 凭据不经过 hub。git 仓默认按公开仓处理。
- 升级顺序：先发 agent，再发 hub。v2.4 agent 会丢掉不带 id 的条目，先升 hub 会导致旧 agent 看不到这些来源（已装的包不受影响）。
- 验收：`test/pack-sources.test.mjs` 覆盖增删改、非法输入、去重与冲突、v1 迁移、损坏文件拒绝、接口状态码（401/403/201/200/400/404/409）、下发不带 key；`web/test/pack-sources.test.tsx` 覆盖新增时显示「自动」、包名覆盖实时校验、按行 key 编辑和删除。

## 不做

- 来源修改后主动推送给在线成员（新帧），等真有需要再加。
- 能力包二进制分发、签名。能力包一律 git 拉取。
