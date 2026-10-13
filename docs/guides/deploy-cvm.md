# CVM 部署 runbook（M1 · PRD-5 部署形态）

目标机：广州 CVM 21.130.192.111（广州 9 区，TencentOS 4.4，4C8G/200G，DevCloud 个人资产）。
形态：Docker 单容器 + 宿主机 nginx 子目录反代（PRD-2 F5）；hub 端口仅绑 127.0.0.1，不暴露公网端口。

## 〇、架构约束（先读）

hub-and-spoke 拓扑要求 hub 对所有 agent 出站可达：

- mac-work（办公 Mac）：办公网 → DevCloud 内网 ✅ 21.130.192.111 可达
- intranet-weekly（内网服务器）：内网 → DevCloud 内网 ✅（走 iGate 策略，提前审批）
- mac-home（家庭 Mac）：家庭宽带 → DevCloud 内网 ❌ 不可达
- iOS 蜂窝网络：❌ 不可达

即 DevCloud 内网机只能覆盖"办公侧"半张拓扑。家庭侧与 iOS 门需要公网入口（见「待决事项」）。若未来公网化，hub 迁容器重建即可（.state 卷全量迁移，契约 §6 审计不丢）。

## 一、前置

- 广州机登录方式：当前 Mac 所有既有密钥被拒（22 端口可达、33ms）。需要你选定：a) 你手动 ssh-copy-id 传公钥；b) DevCloud 平台 resetpwd 重置 root 密码（平台操作，影响登录凭据）；c) DevCloud 网页 VNC
- Docker 与 nginx 已装（TencentOS：`yum install -y docker-compose-plugin nginx` 或等价）
- 代码分发：仓库推工蜂后广州机 clone，或 Mac 直接 `rsync`/`scp`（33ms 内网直传，推荐试点期用）
- HTTPS：内网试点期可 http 直连 `http://21.130.192.111:8787`（hub 不暴露公网，风险面可控）；iOS 与公网 agent 待域名方案

## 二、hub 容器

```bash
# Mac 上分发（内网 33ms）
rsync -az --delete --exclude .state --exclude .git --exclude node_modules \
  /Users/firoyang/workspace/Novoard/ root@21.130.192.111:/opt/novoard/
# 带上 secrets（单独传，不进 rsync 主体的 .state）
rsync -az /Users/firoyang/workspace/Novoard/deploy/.state/ root@21.130.192.111:/opt/novoard/.state/

# 广州机上
cd /opt/novoard/deploy
docker compose up -d --build
curl -s http://127.0.0.1:8787/.well-known/agent-card.json | head -5
```

secrets 已生成（2026-10-13，`deploy/.state/secrets.json`，600 权限、gitignore 验证不入库）：agentTokens × 3（mac-work / mac-home / intranet-weekly）、clientKeys × 1、dashboardToken × 1。三个 `agents/*/agent.local.json` 已同步配好（hubUrl 占位 `<hub-host>`，部署后回填）。

## 二·五、agent 侧接入

```bash
# Mac A/B（办公/家庭）
NOVOARD_AGENT_DIR=agents/mac-work node src/lite-agent/main.mjs
# agent.local.json 已含 agentId/hubUrl/agentToken；hubUrl 回填实际地址后启动
```

## 三、nginx 子目录反代（可选，试点期可跳过）

```bash
cp deploy/nginx-novoard.conf /etc/nginx/conf.d/novoard.location.conf.snippet
# include 进既有 server 块，或最小试点：直接 8787 直连
nginx -t && systemctl reload nginx
```

## 四、验证链

1. `curl -s http://127.0.0.1:8787/.well-known/agent-card.json` → 聚合 card（skills 空数组）
2. mac-work lite-agent 启动 → 注册进 card、audit.jsonl 出现 working
3. iOS 门（docs/guides/ios-shortcuts-trigger.md）：trigger → 202 submitted（内网 WiFi 下）
4. 规则链路：trigger dev-build-investm → completed → smoke-test 自动入队（rules.yaml 放 .state）

## 五、回滚

```bash
docker compose down   # .state 卷保留全部审计/队列/secrets，容器可随时重建
```

## 待决事项

- 广州机登录：a) 手动传公钥 b) resetpwd 重置 root 密码 c) VNC —— 三选一
- 公网入口（家庭 Mac + iOS 必须）：`firoyang.com` 现解析至香港 119.28.83.73（SSH 密钥不匹配，归属与登录待你确认）；`publish.firoyang.com` → 香港 43.161.241.238（root 免密可用，但 1G 内存小规格、8787 已被既有 relkit-agent 占用）。选项：
  - A. 广州机只做内网 hub + 另议公网转发（如家庭侧经 WireGuard/frp 隧道回办公网）
  - B. hub 迁公网香港机（43.161.241.238 腾挪 8787 或换端口，域名 publish.firoyang.com 现成，certbot 补证）
  - C. 新购轻量/重塑 DNS：`novoard.firoyang.com` → 广州公网 IP（若 DevCloud 机可绑 EIP/公网带宽）
- 企微 bot：留空待配置（你已确认最后再配）
