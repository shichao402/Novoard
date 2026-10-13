# Roadmap

里程碑排序（ADR-0007 重排）：试点接入先行，用真实点位验证契约与 PRD-2/3/4 验收面；随后逐域完备化；桌面本地体验（原 M1，载体原定 cronkit 仓）因载体未定后置为 M5。每个里程碑独立可交付、可验收。

## M0 · 契约与文档（收官 2026-10-12；当前推进 M1）

- [x] 仓库与文档骨架（ADR / architecture / roadmap / PRD / research）
- [x] 七条 ADR 定型（边界、拓扑、A2A 通用语、路由纪律、技术栈基线、cronkit 参照位）
- [x] 契约草案 v0.1（target schema、ops 帧枚举、隧道协议、HTTP 门、审计）
- [x] PRD 拆分（PRD-1 ~ PRD-5）与扩展调研（research 0003/0004）
- [x] 契约 v1.0 评审定稿（三决策拍板：A2A 字面对齐 + 私有信封 / research 0003 演进点 defer / schemas 落库；九张 JSON Schema 随契约冻结，实现冻结基线）

## M1 · 试点接入与 hub 起步（PRD-5 + PRD-2 核心，Novoard 仓与试点环境）

目标：三个真实接入跑通——企微 bot、dev builder（Mac lite-agent × 2）、内网周报 agent——PRD-2/3/4 的验收面获得真实踩点，并验证契约实现无关性（办公 Mac 与内网服务器两套独立实现）。

- [x] hub 服务骨架（Node，issue-handler DNA：统一 server、JSONL 流水、dashboard、凭据热配置；实测同款定稿：原生 `node:http` + `ws`，零 web 框架，纯 JS ESM 零构建——ADR-0006。2026-10-12 落地：src/ 八模块 + 11 项冒烟测试全绿——两扇门、WS 隧道、JSONL 审计/队列双文件、联邦注册表、聚合 card、msgId 幂等去重、断线转离线）
- [x] target 定义先行（零代码）：三份 target YAML + 共用 stepTemplate。2026-10-13 落库 `agents/`：mac-work / mac-home / intranet-weekly 各 targets.yaml + 模板（两台 Mac 共用 deploy-webapp，vars 填机器差异），schema 校验 5 项测试全绿（test/targets.test.mjs）
- [x] CVM 部署（Docker，nginx 子目录反代；企微 bot 同机或独立轻服务）。2026-10-13 上线：腾讯云广州 43.138.156.146（ins-78r3y0si），hub 容器 127.0.0.1:38666（deploy/ compose），DNS novoard.firoyang.com（DNSPod）+ certbot webroot HTTPS（Let's Encrypt，2027-01 到期），nginx 443 反代（WS 升级 map），公网全链路验证：card 200 / dashboard 200 / A2A 401 拒未授权 / 301 跳转 / iOS 蜂窝可访问；e2e 闭环（trigger → 执行 → completed 终态 → 双侧审计对账）；部署中修三缺陷（secrets 对象形态、contractVersion pattern、runner 插值），测试 25 项全绿
- [x] 联邦注册表与任务队列（A2A 字面帧 + 私有信封，契约 §4；队列持久化定稿：JSONL 文件队列 append-only + 重启扫尾重放，hub 依赖保持 ws / yaml / ajv 三个——ADR-0006；contextId 回带与父任务关联从第一天对齐）。2026-10-12 随 hub 骨架落地：JSONL append-only + 重启扫尾重放、msgId 幂等窗口、注册表离线留表（test/hub.test.mjs 队列/注册表四项）
- [~] 三接入：企微 bot / Mac lite-agent × 2 / 内网周报 lite-agent（内网策略审批提前走）。lite-agent 语言定稿：Node，`src/lite-agent/` 同仓实现，模块级复用 hub 侧 frames/tunnel/schema 自检（ADR-0006，2026-10-13）。2026-10-13 lite-agent 已落地：config/card/runner/agent-runtime/tunnel-client/main 六模块（模板展开、四类 step、单并发、断线重连 + 未确认帧重放、agent 侧审计 JSONL），e2e 3 项全绿（test/lite-agent.test.mjs）——注册 → 触发 → 委派 → 执行 → 终态上行 → 两侧审计全链路；剩部署动作（两台 Mac + 内网服务器跑起来 + token 分发）。企微 bot 2026-10-13 已上线（CVM hub 进程内长连接，触发端 + 通知面 + chatid 学习全链路，PRD-5 F1，测试 7 项）。2026-10-13 mac-home 接入落地：与 mac-work 同机双实例（用户决策，家里 Mac 未到位），launchd 常驻（com.firoyang.novoard.agent.mac-home，配置与 state 在 ~/Library/Application Support/novoard/agent-mac-home/，repoDir 填本机路径），公网触发 task-20261013-001 真实执行 working→failed（InvestM 未提交改动致 pull 失败，仓库真实状态非系统缺陷），双侧审计对账一致——AC4 道具就绪（对 mac-home 触发即验证）；mac-work 仍在本地试跑形态（无常驻），intranet-weekly 待内网机
- [x] A2A 端点最小版：Agent Card 聚合发布、message/send、tasks/get、tasks/cancel（stream 以轮询 + 通知顶替）；授权矩阵最小版（With 一把 key）；实现定稿：自实现原生端点，零 SDK（ADR-0006；A2A spec 正式版后再评估跟进）。2026-10-12 随 hub 骨架落地：三方法 + 错误码字面（-32000/-32001/-32002/-32004）、无 key 401、聚合 card 经 `/.well-known/agent-card.json` 发布（test/hub.test.mjs A2A 两项）
- [x] 通知扇出最小版：企微终态 / 审批门 / 离线拒绝。2026-10-13 落地 src/notify.mjs：企微 markdown 三模板（终态图标、input-required、offline-reject）+ 同 target 同态 60s 频控窗口合并 + webhook 未配置降级日志不阻塞；main.mjs 装配事件扇出，测试 5 项（test/notify-rules.test.mjs）。2026-10-13 企微智能机器人接入：hub 进程内官方 SDK 长连接（src/wecom-bot.mjs，出站 wss 零入站端口），触发端固定语法 `run <target>[@<member>]` 转发 /api/trigger，通知面 sendMessage 主动推送，chatid 热学习持久化，凭据热配置重连，CVM 上线认证成功，测试 7 项（test/wecom-bot.test.mjs），依赖增 @wecom/aibot-node-sdk
- [x] 最小规则引擎：task 终态事件 → run target（进阶：GitHub push webhook → 自动构建）。2026-10-13 落地 src/rules.mjs：rules.yaml 装载即校验（定义时判断）、终态匹配、ruleTrace 防环；动作不旁路——经 queue.submit → delegate 全链路下发（actor=rule-engine，审计 detail 记规则触发）；e2e 验证 completed → smoke-test 自动入队执行（进阶 webhook 源留 M3 通用入口）
- [~] iOS 快捷指令门（fire-and-forget）。hub 侧 `/api/trigger` + 离线拒绝分流已就绪（test/hub.test.mjs trigger 项）；Shortcuts 配置文档已落库 docs/guides/ios-shortcuts-trigger.md；剩真机磁贴验收，依赖三环境部署（对着离线 Mac B 触发 → 30s 内离线拒绝通知）
- 验收：PRD-5 AC1-AC7（AC8 两段式可选）
- 说明：原 M2 的队列与 iOS 门前移至此；原 M4 的 A2A 端点最小版提前触达，stream 与审批门全链路仍留 M4。

## M2 · Hub 完备与远程触发（PRD-2，Novoard 仓）

目标：人不在电脑前的场景闭环正式化。

- [ ] Web 面板 v1（agent 列表、target 目录、任务历史、触发入口）
- [ ] 离线拒绝与任务分发策略正式化（试点已踩点）
- 验收：PRD-2 AC1-AC4

## M3 · 通知与自动化规则完备化（PRD-3，Novoard 仓）

- [ ] 企微 / Bark 扇出完备（终态、审批门、离线拒绝；Bark 双推试点已踩）
- [ ] per-target `notify` 策略字段生效（契约 §1）
- [ ] 通知频控（状态口径，防 digest 吞增量）
- [ ] 规则引擎完备化 + 通用 webhook 入口（最小版试点已踩）
- 验收：PRD-3 AC1-AC3

## M4 · A2A 能力面完备化（PRD-4，hub + agent 侧）

- [ ] message/stream（SSE 步骤级进度，替换试点期"轮询 + 通知"顶替方案）
- [ ] 审批门全链路（IM / Web / 磁贴三入口恢复、超时 TTL）
- [ ] 授权矩阵完备化（试点最小版扩展）
- [ ] 桌面 agent localhost A2A 端点（随 M5 载体决策）
- [ ] 更多 A2A 客户端接入验证
- 验收：PRD-4 AC1-AC4

## M5 · 桌面 agent 与本地磁贴（PRD-1，载体待定）

后置说明：托盘 / 热键 / 磁贴浮窗必须长在桌面常驻进程（Electron 一类）上；ADR-0007 后 cronkit 仅为参照原型，Mac 桌面载体三候选（移植 cronkit Electron / 新写轻壳 / Raycast 类启动器顶替）待试点数据后决策。契约字段、builtin/open-app、stepTemplates 已在 M1 试点部分吸收。

- [ ] 载体决策 ADR（三候选对比，以试点期触发数据为输入）
- [ ] Dashboard"快捷操作"磁贴分区 / 全局热键浮窗 / 托盘快捷菜单
- [ ] builtin/open-app 一等步骤正式化（试点已踩）
- [ ] 部署类 stepTemplates 收编
- 验收：PRD-1 AC1-AC4

## 里程碑之外（暂不排期）

- cronkit Windows 机器收编为成员（属"收编"非"试点"，规模另立，见 research 0004）
- 新 agent 接入（家里服务器等）——架构天然支持，接入是运维动作不是开发项
- Tailscale 直连替代 relay 隧道——等 relay 痛点真实出现
- 事件触发器扩展（位置、NFC、app 状态类 iOS 自动化）——YAGNI 区
