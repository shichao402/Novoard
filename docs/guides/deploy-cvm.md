# CVM 全新安装 runbook

生产地址固定为 `https://novoard.firoyang.com/`。Hub 使用 Docker 单容器，宿主机 nginx 将该域名的根路径反代到 `127.0.0.1:38666`；API、管理控制台和 `/tunnel` 共用此入口。

本版本只支持全新安装：不要复制旧 `dashboardToken`、`clientKeys`、`agentTokens`、`.state/acl.yaml`、queue/audit/artifacts 或旧 identity 状态，也不承诺用旧镜像读取新 `.state`。

## 1. 前置条件

- DNS 与有效 HTTPS 证书已配置；
- Docker 28+、Compose 2.32+、nginx 1.26+；
- 防火墙不开放 38666，只有 nginx 对公网；
- 部署者准备在服务上线后立即完成 first-claim。

## 2. 分发并启动

```bash
# 开发机：只分发源码，不分发任何运行态或真实密钥
rsync -az --delete \
  --exclude .git --exclude node_modules --exclude web/node_modules \
  --exclude .state --exclude deploy/.state \
  /Users/firoyang/workspace/Novoard/ \
  root@43.138.156.146:/opt/novoard/

# 服务器：创建全新私密状态卷并构建
cd /opt/novoard/deploy
install -d -m 700 .state
docker compose up -d --build
curl -fsS http://127.0.0.1:38666/api/setup/status
# 预期：{"required":true}
```

镜像会在第一阶段构建 React/Ant Design Pro 控制台，再把 `web/dist` 与原生 Node Hub 放入运行镜像。运行态位于 `deploy/.state`，其中 identity、sessions、secrets、queue、audit、artifacts 均不得提交仓库。

### 后续发布

产品版本唯一读取仓库根目录的 `VERSION.json`，格式与 Relkit 一致（`relkit.version/1`）。`package.json` 和 `package-lock.json` 中不带 build metadata 的版本只是生成镜像，禁止手工单独修改；修改 `VERSION.json` 后运行：

```bash
npm run version:sync
npm run version:check
```

GitHub Actions 的 `release-hub` 工作流同时监听不可变版本 tag（必须等于 `v<VERSION.json.version>`）和固定的部署通道 tag `stable`。先推版本 tag 跑完发布门禁，再把 `stable` 移到同一提交触发生产部署：

```bash
version="$(node -p "JSON.parse(require('fs').readFileSync('VERSION.json', 'utf8')).version")"
git tag "v${version}" <要发布的提交>
git push origin "v${version}"
# 等待门禁通过后：
git tag -f stable "$(git rev-list -n 1 "v${version}")"
git push origin refs/tags/stable --force
```

`stable` 必须指向 `main` 历史中的提交；契约测试、版本镜像校验、Web 测试和 Docker 构建全部通过后，工作流才会同步源码到 `/opt/novoard`、执行 `docker compose up -d --build`，并检查本机及公网入口。同步过程始终排除 `deploy/.state`。部署凭据仅配置在 GitHub `production` Environment：`DEPLOY_HOST`、`DEPLOY_PORT`、`DEPLOY_USER` 三个变量，以及 `DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS` 两个 secret。服务器授权使用独立部署密钥，不复用个人 SSH 私钥。

## 3. nginx 根路径

将 `deploy/nginx-novoard.conf` 的 `location /` 放进 `novoard.firoyang.com` 的 HTTPS `server {}`。WebSocket Upgrade 使用宿主机已有的 `$connection_upgrade` map。

```bash
nginx -t && systemctl reload nginx
curl -I https://novoard.firoyang.com/
```

不再配置 `/novoard/` 子路径；Cookie Path、Vite base、React Router 路由、API 与 artifact URL 都是 `/`。
Compose 中 `NOVOARD_TRUST_PROXY=1` 只适用于当前“容器端口仅绑定宿主机 127.0.0.1、唯一入口为本机 nginx”的拓扑，用于按真实 `X-Real-IP` 做登录限速；若直接暴露 Hub 端口，必须删除该配置。

## 4. 立即认领首位超级管理员

打开 `https://novoard.firoyang.com/`，初始化向导会要求用户名、显示名和强口令，并自动绑定内置 `superadmin`。

这是公开 first-claim：第一个成功提交者就是超级管理员。初始化成功后入口永久关闭；不要让空实例在公网无人值守。可验证：

```bash
curl -fsS https://novoard.firoyang.com/api/setup/status
# 预期：{"required":false}
```

## 5. 接入 Agent 与机器客户端

1. 以超级管理员进入“成员”页，为每个 `agentId` 创建 Agent 凭据；`nva_…` 明文只显示一次。
2. 在 novoard-agent 2.x 的向导中填写根地址、同一 `agentId` 与该 token。Hub 只接受契约 2.x，Bearer 身份必须与 hello `agentId` 一致。
3. 在“个人访问令牌”页为快捷指令、AI 客户端等分别创建具名 PAT；按最小 scope 与 target allow/deny 配置。`nvp_…` 明文同样只显示一次。
4. 不得把用户 PAT 当 Agent token，也不得让机器客户端共用超级管理员会话。

Compose 环境变量只作为字段尚未写入 `secrets.json` 时的初始回退值。管理面撤销 Agent token、清空企微白名单或通知目标后会写入空值墓碑，不会重新启用仍留在环境变量中的旧值；若要再次使用环境值，需在停机维护时同时清理对应落盘字段并审计该操作。

## 6. 企微

超级管理员在“企微”页配置 bot 凭据、固定通知会话、允许的用户和群聊。白名单默认为空，空列表拒绝所有 run/approve；群聊同时要求 sender 与 chat 命中。

启用后创建不可登录的 `wecom-bot` 服务账号，并通过“轮换服务 PAT”执行“签发验证新令牌 → 切换消费端 → 吊销旧令牌”。真实 sender/chat/command 会进入安全审计。

## 7. Break-glass

忘记超级管理员口令时，只能在服务器 TTY 内恢复一个已经存在的 superadmin：

```bash
cd /opt/novoard/deploy
docker compose exec -it novoard-hub node src/admin.mjs recover <username>
```

口令通过 TTY 输入，不进 argv。恢复会递增安全版本并吊销该账号全部会话和 PAT；该命令不能创建用户、授予 superadmin 或重新开启 setup。

## 8. 验证与备份

```bash
curl -fsS -H "Authorization: Bearer $NOVOARD_PAT" \
  https://novoard.firoyang.com/.well-known/agent-card.json
docker compose logs --tail=100 novoard-hub
```

聚合 Agent Card 需要具备 `targets.read` 的会话或 PAT，并只返回其 target 范围内的能力。再从控制台完成一次 target 触发、任务终态、artifact 下载和审计查询。备份时停止容器并整体备份 `deploy/.state`；恢复必须使用同版本镜像与完整目录，不能只恢复 identity 或 install 单文件。

```bash
docker compose down
tar -C /opt/novoard/deploy -czf /root/novoard-state-$(date +%F).tgz .state
docker compose up -d
```
