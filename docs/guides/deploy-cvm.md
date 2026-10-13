# CVM 部署 runbook（M1 · PRD-5 部署形态）

目标机：腾讯云公有云广州 CVM `43.138.156.146`（实例 `ins-78r3y0si`，TencentOS 4，2C2G，200M 按流量计费，2028-10 到期）。
形态：Docker 单容器 + 宿主机 nginx 子目录反代（PRD-2 F5）；hub 端口仅绑 127.0.0.1，不暴露公网端口。

## 〇、架构约束（先读）

hub-and-spoke 拓扑要求 hub 对所有 agent 出站可达。目标机为公网机，四个成员全通：

- mac-work（办公 Mac）：办公网 → 公网 ✅
- mac-home（家庭 Mac）：家庭宽带 → 公网 ✅
- intranet-weekly（内网服务器）：内网 → 公网 ✅（出站 HTTPS 即可）
- iOS 蜂窝网络：✅（`https://novoard.firoyang.com/api/trigger`）

机器既有业务：`tasker` / `vikunja` / `board` 三个 `firoyang.com` 子域（nginx 1.26.3 + acme.sh 自管 Let's Encrypt 证书）。novoard 以子目录 `location /novoard/` 并入既有 nginx，不新开 server 块。

## 一、前置

- 登录方式（已解决）：`ssh -p 22 -i ~/.ssh/pkv_tencent_cvm root@43.138.156.146`（root 免密）
- Docker 28.4 + Compose 2.32 已装；nginx 1.26 active
- 代码分发：`rsync` 直传（见下）
- HTTPS（已完成）：DNS `novoard.firoyang.com → 43.138.156.146`（DNSPod recordId 2429632391）；证书 certbot webroot 签发（Let's Encrypt，2027-01-11 到期），80 块 ACME 验证 + 301，443 反代 127.0.0.1:38666

## 二、hub 容器

```bash
# Mac 上分发
rsync -az --delete --exclude .state --exclude .git --exclude node_modules \
  /Users/firoyang/workspace/Novoard/ root@43.138.156.146:/opt/novoard/
# 带上 secrets（单独传，不进 rsync 主体的 .state）
rsync -az /Users/firoyang/workspace/Novoard/deploy/.state/ root@43.138.156.146:/opt/novoard/.state/

# 目标机上
cd /opt/novoard/deploy
docker compose up -d --build
curl -s http://127.0.0.1:38666/.well-known/agent-card.json | head -5
```

secrets 已生成（2026-10-13，`deploy/.state/secrets.json`，600 权限、gitignore 验证不入库）：agentTokens × 3（mac-work / mac-home / intranet-weekly）、clientKeys × 1、dashboardToken × 1。三个 `agents/*/agent.local.json` 已同步配好（hubUrl 占位 `<hub-host>`，部署后回填）。

## 二·五、agent 侧接入

```bash
# Mac A/B（办公/家庭）
NOVOARD_AGENT_DIR=agents/mac-work node src/lite-agent/main.mjs
# agent.local.json 已含 agentId/hubUrl/agentToken；hubUrl 回填实际地址后启动
```

## 三、nginx + HTTPS（子目录并入既有 server 块）

```bash
cp deploy/nginx-novoard.conf /etc/nginx/conf.d/novoard.location.conf.snippet
# include 进既有 tasker/vikunja 同款 443 server 块（novoard.firoyang.com 单独 server_name 亦可）
nginx -t && systemctl reload nginx
```

## 四、验证链

1. `curl -s http://127.0.0.1:38666/.well-known/agent-card.json` → 聚合 card（skills 空数组）
2. mac-work lite-agent 启动 → 注册进 card、audit.jsonl 出现 working
3. iOS 门（docs/guides/ios-shortcuts-trigger.md）：trigger → 202 submitted（蜂窝网络下走 HTTPS）
4. 规则链路：trigger dev-build-investm → completed → smoke-test 自动入队（rules.yaml 放 .state）

## 五、回滚

```bash
docker compose down   # .state 卷保留全部审计/队列/secrets，容器可随时重建
```

## 待决事项

- ~~登录方式~~ 已解决：`~/.ssh/pkv_tencent_cvm`（dec 同步的密钥）
- ~~DNS 记录~~ 已建：recordId 2429632391
- 企微 bot：已配置（2026-10-13）。新版智能机器人（API 模式长连接），凭据 `wecomBotId` / `wecomBotSecret` 落服务器 `deploy/.state/secrets.json`，hub 进程内 SDK（`@wecom/aibot-node-sdk`）出站 wss，无入站端口。通知投递目标 `wecomChatId` 由 bot 从首条消息热学习（在企微里给 bot 发一条消息即可）。触发语法：`run <target>[@<member>]`。

## 部署实录（2026-10-13）

已完成：DNS → rsync → 容器（127.0.0.1:38666）→ certbot 证书 → nginx 443 → 公网全链路验证。
e2e 闭环已通：mac-work 注册 → trigger（HTTPS）→ agent 执行 → completed 终态回传 → 双侧审计对账。

mac-home 接入（2026-10-13，与 mac-work 同机双实例，用户决策）：配置与 state 独立目录 `~/Library/Application Support/novoard/agent-mac-home/`（agent.json 0600 + audit），launchd 常驻 `com.firoyang.novoard.agent.mac-home`（RunAtLoad + KeepAlive），环境变量 `NOVOARD_AGENT_DIR=/Users/firoyang/workspace/Novoard/agents/mac-home`。验证：task-20261013-001 公网触发真实执行，working→failed（InvestM 未提交改动，真实仓库状态），双侧审计一致。家里 Mac 到位后改 repoDir + agentDir 即可迁移。
部署中修复三个缺陷：secrets.mjs 对象形态归一化、agent 配置 contractVersion（v1.0→1.0）、runner script 步骤插值缺失（均带回归测试）。
运维注意：nginx WS 升级用 `00-novoard-map.conf` 的 map 变量；certbot 续期依赖既有 systemd timer；磁盘 83% 水位需留意。
