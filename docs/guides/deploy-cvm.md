# CVM 部署 runbook（M1 · PRD-5 部署形态）

目标机：重庆 CVM 9.134.241.248（TencentOS Server 4.4，4C8G，个人资产，DevCloud 内网区）。
形态：Docker 单容器 + 宿主机 nginx 子目录反代（PRD-2 F5）；hub 端口仅绑 127.0.0.1，不暴露公网。

## 一、前置

- Docker 与 nginx 已装（TencentOS：`yum install -y docker-compose-plugin nginx` 或等价）
- 本仓已推到工蜂（git remote），CVM 可拉取；或经跳板 scp
- HTTPS 证书：hub 经 nginx 暴露，若复用已有证书/网关则跳过；无证书试点期可先 http 内网验证

## 二、hub 容器

```bash
# CVM 上（仓内 deploy/ 目录）
cd deploy
mkdir -p .state/audit .state/queue .state/artifacts
# secrets.json：agentTokens / clientKeys / dashboardToken（契约 §8 令牌分池）
#   试点期最小：先手写一个 agentToken + 一个 clientKey
cat > .state/secrets.json << 'EOF'
{ "agentTokens": { "mac-work": "<token-A>", "mac-home": "<token-B>", "intranet-weekly": "<token-C>" },
  "clientKeys": ["<client-key-1>"] }
EOF
docker compose up -d --build
curl -s http://127.0.0.1:8787/.well-known/agent-card.json | head -5
```

## 三、nginx 子目录反代

```bash
cp deploy/nginx-novoard.conf /etc/nginx/conf.d/novoard.location.conf.snippet
# include 进既有 server 块（443），或最小试点：直接放 conf.d 一个独立 server
nginx -t && systemctl reload nginx
```

## 四、验证链

1. `curl -s http://127.0.0.1:8787/.well-known/agent-card.json` → 聚合 card（无 agent 注册时 skills 为空数组）
2. agent 侧 `NOVOARD_HUB_URL=wss://<对外域名>/novoard/tunnel node src/lite-agent/main.mjs` → 注册进 card
3. iOS 门验证（docs/guides/ios-shortcuts-trigger.md）：trigger → 202 submitted
4. 离线拒绝：触发一个成员未连接的 target → 202 rejected + 企微通知

## 五、回滚

```bash
docker compose down   # .state 卷保留全部审计/队列/secrets，容器可随时重建
```

## 待决事项（需用户资产/决策）

- CVM 访问方式：SSH 直连（需跳板/密码/密钥）还是 DevCloud 网页 VNC？我拿到访问方式即可执行部署
- HTTPS 对外域名与证书：复用已有网关证书，还是新配？iOS 快捷指令要求 HTTPS
- agentToken / clientKey 的值：我生成随机值还是你提供？
