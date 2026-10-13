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

- 登录方式（待定）：机器绑定 SSH 密钥 `skey-rddrtk1r`，私钥不在本地。选项：a) 控制台绑定新密钥对（CAM 子密钥无 ModifyInstanceVpcConfig 类权限，需主账号操作）；b) `skey-rddrtk1r` 私钥放到 `~/.ssh/` 下告知文件名
- Docker（机器已有 nginx；docker 未见则装：`yum install -y docker docker-compose-plugin` 或等价）
- 代码分发：`rsync`/`scp` 直传（公网机，建议走 SSH）
- HTTPS：`novoard.firoyang.com` 新 DNS 记录 → 43.138.156.146（DNSPod，当前 API 凭据可直接创建）；证书走机器既有 acme.sh 流程签发 Let's Encrypt，nginx 子目录并入现有 443 server 块

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

- 登录方式：a) 控制台绑新密钥对（主账号操作）b) 提供 `skey-rddrtk1r` 私钥 —— 二选一
- DNS 记录 `novoard.firoyang.com` → 43.138.156.146：待创建（DNSPod API 凭据已就绪，等你点头即建）
- 企微 bot：留空待配置（你已确认最后再配）
