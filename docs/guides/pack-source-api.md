# 能力包来源 API 与智能体授权

来源清单是 Hub 的全局软件供给范围。原有 `/api/pack-sources` CRUD 仅允许浏览器 session；现在复用相同路径增加管理员显式委托的具名 PAT，不开放匿名入口，不将成员接入令牌升级为管理凭据。

## 权限

| 调用 | 权限 / 身份 |
| --- | --- |
| `GET /api/pack-sources` | session 或 PAT，`pack-sources.read` |
| `POST /api/pack-sources` | session 或 PAT，`pack-sources.manage` |
| `PUT /api/pack-sources/:key` | session 或 PAT，`pack-sources.manage` |
| `DELETE /api/pack-sources/:key` | session 或 PAT，`pack-sources.manage` |
| `GET /api/agent/pack-sources` | 仅有效成员接入令牌，只读 wire |

`admin`、`superadmin` 有来源 read/manage；普通业务角色不能组合这些权限。管理员在 PAT 创建页显式勾选来源 scope 才能委托，旧 PAT 与新建 PAT 的默认 scope 均不会自动获得这些权限。CLI 修改先读现有条目，所以建议专用 PAT 同时包含 `pack-sources.read` 和 `pack-sources.manage`，无需用户管理 scope。

PAT 使用 `Authorization: Bearer <PAT>`，角色与 scope 共同限制权限；吊销、到期、禁用和用户降权立即生效。session 写操作仍要求可信 Origin 和 `X-CSRF-Token`。成员接入令牌不能访问管理 CRUD，PAT 也不能冒充成员调用只读成员入口。

## 请求与返回

新增示例：

```http
POST /api/pack-sources
Authorization: Bearer <source-scoped PAT>
Content-Type: application/json

{"git":"git@git.woa.com:firoyang/OSGToolset.git","branch":"main"}
```

```json
{"source":{"key":"ps-0123456789ab","git":"git@git.woa.com:firoyang/OSGToolset.git","branch":"main"}}
```

新增成功 `201`；列表 `200` 返回 `{"sources":[...]}`，管理 key 是 `ps-...`。修改 `PUT` 使用同一条目的管理 key，提交整条来源，成功 `200`。未传 branch 的新增默认 main。无覆盖包名的来源是整仓扫描，不需填写子目录；已有覆盖条目的 `id` 与 `subdir` 应原样保留。

删除成功 `200` 返回 `{"removed":true}`。不存在 `404`，重复仓库/分支或覆盖名冲突 `409`，非法字段 `400`，身份失败 `401`，权限或 CSRF 失败 `403`，来源存储未装配 `503`。不自动重试写请求，不以删除旧条目解决 `409`。

Git 地址不能包含 URL 密码、HTTP 用户名、查询参数或 fragment，避免凭据进入全局清单和审计。私有仓已具备本机 SSH 权限时优先 SSH；Git 私钥/HTTPS 凭据只在本机管理。来源变化记录具名主体（例如 `pat:owner/source-manager`）及仓库、分支，不记录 PAT。

## 主动同步

`GET /api/agent/pack-sources` 使用已登记且有效的成员令牌，返回 `{"sources":[...]}`，去掉 `ps-...` 管理 key，设置 `Cache-Control: no-store`。清单与 hello.ack 的 packSources 字段一致，没有新增 WebSocket 帧、没有修改契约 schema。

支持新能力的 agent 提供本机 `POST /api/pack-sources/sync`，请求只能是 `{}`，使用已配置 Hub 地址和成员令牌。它拒绝调用方提供新 URL/token，同源防护及已有远程 UI 鉴权仍生效。HTTPS/WSS 默认强制，HTTP/WS 仅限回环测试；不跟随重定向。

同步单飞，HTTP 超时 15 秒；响应最多 512 KiB、512 条来源，严格校验整份 JSON、UTF-8、字段类型与来源唯一性。网络/非法清单失败不更新；缓存先原子写盘，再发布内存快照，写盘失败保留旧内存。合法空数组清空。同步不重启，不自动安装，随后通过 packs 入口沿用后台扫描，再按用户授权安装。

## 外部智能体 CLI

agent 仓 `skills/novoard-manage/scripts/novoard.py` 仅需 Python 标准库。PAT 从 `NOVOARD_HUB_PAT_FILE`（优先）或 `NOVOARD_HUB_PAT` 读取，不提供明文 token 命令行参数。不要让用户把密钥发到对话，也不要打印文件内容。

```powershell
python <skill>/scripts/novoard.py pack-sources list
python <skill>/scripts/novoard.py pack-sources add --git git@git.woa.com:firoyang/OSGToolset.git --branch main
python <skill>/scripts/novoard.py pack-sources update --key <ps-key> --git git@git.woa.com:firoyang/OSGToolset.git
python <skill>/scripts/novoard.py pack-sources remove --key <ps-key> --confirm
python <skill>/scripts/novoard.py sync-pack-sources
python <skill>/scripts/novoard.py packs
```

`--hub` 或 `NOVOARD_HUB_URL` 可显式指定管理 API 地址；省略时从本机控制台读取已配置 Hub，不改设置。全部子命令支持 `--dev`。`update` 先 GET 再 PUT，只覆盖显式给出的 git/branch，保留其余字段。删除必须先得到用户同意并传 `--confirm`。`ps-key` 是 Hub 管理身份；`packs` 的 `src-...` installKey 是 agent 发现来源/包的安装入口，两者不可互换。

CLI 禁止携带 PAT 跟随重定向，错误只返回通用状态提示，不回显服务端正文；不会从浏览器偷取 session，也不借成员 token 做管理。内置会话只提供来源同步工具，来源写管理交由带专用 PAT 的外部编码会话。

## 部署与验收

顺序：部署支持新 scope 和成员只读接口的 Hub；升级支持主动同步的 agent；发布生成技能与 CLI；管理员一次性准备具名最小 PAT；授权智能体管理并同步来源。代码或技能更新不代表线上 Hub/正式版 agent 已升级。旧版本返回 404/503 时报告能力缺失，不强杀进程绕过同步。

```powershell
node --test test/pack-source-api.test.mjs test/pack-sources.test.mjs
$env:NOVOARD_AGENT_SOURCE_DIR = '<agent repository>'
node --test test/pack-source-cli.integration.test.mjs
```

跨仓测试显式指定 agent 仓，使用临时 Hub、测试 PAT、成员令牌与临时本机服务，不访问用户真实清单。
