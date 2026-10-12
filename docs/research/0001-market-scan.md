# Research 0001: 同类产品扫描（快捷操作面板）

- 日期：2026-10-09（讨论） / 2026-10-12（沉淀）
- 结论用途：PRD-1 磁贴面板的形态参照；script/automation 双轨架构参照。

## 扫描结论

| 产品 | 形态 | 与 Novoard 概念的重合点 |
| --- | --- | --- |
| iOS 快捷指令 | 手动指令 + 自动化触发器 + 控制中心磁贴 | 产品概念的直接原型 |
| Raycast / Alfred / Flow Launcher | 快捷键呼出的命令面板，脚本/扩展封装操作 | 手动封装操作；本质"交互响应型"而非后台服务 |
| Keyboard Maestro | 宏引擎，触发器最丰富（时间/热键/app 启动） | 自动化触发器的天花板形态 |
| Stream Deck / GridBar | 可视化磁贴墙，一键多动作 | 磁贴表现形式的直接参照（视觉派磁贴、键盘派面板） |
| Home Assistant | tile 卡片 + automation（触发器+条件+动作）与 script（纯动作序列）分离 | 手动磁贴与自动化双轨的最成熟架构范式 |
| n8n + n8nDash | self-host 工作流 + webhook 按钮面板 | "手机点按钮触发另一端自动化"的形态参考 |

## 最重要的可借鉴设计

Home Assistant 的 script / automation 分离：无触发器的纯动作序列（对应 manual target）和带触发器的自动化（对应 cron/事件触发）是两种一等公民，磁贴调 script、自动化走自己的触发器。Novoard 的契约设计沿用此分轨：手动触发与定时/事件触发都是 target 的触发路径，定义里的字段决定待遇（ADR-0005）。

## cronkit 现状对照（2026-10 扫描时点）

已具备：targets → steps 编排模型、toolset、stepTemplates + vars 参数化、manual trigger 一等公民、Dashboard 每 target 运行按钮、CLI `run --target`。缺：零摩擦入口（全局热键/磁贴）、事件触发器谱系（只有 cron + manual）、服务面（纯本地应用）。

分野结论（详见 ADR-0002）：磁贴化是 cronkit 的自然延伸（PRD-1）；事件触发器与远程入口是 hub 的领地（PRD-2/3/4）。

## 来源

- [Keyboard Maestro vs Raycast vs Alfred: Which Tool Wins?](https://startupik.com/keyboard-maestro-vs-raycast-vs-alfred-which-tool-wins?noamp=mobile)
- [8 Best Launcher Apps for Mac 2025](https://www.techbloat.com/?p=1564772/)
- [Stream Deck Software for Mac 2026（GridBar 磁贴对比）](https://www.balane.app/en/blog/stream-deck-software-for-mac-2026)
- [Home Assistant 2025.9: Features for tiles and automations](https://www.home-assistant.io/blog/2025/09/03/release-20259/)
- [Home Assistant: Interactive button on dashboard（script/automation 分离）](https://community.home-assistant.io/t/interactive-button-on-dashboard/674592/1)
- [Home Assistant: Button pressed 触发器文档](https://home-assistant.io/triggers/button.pressed)
- [n8nDash：webhook 按钮仪表盘](https://wrnmd.com/jeanpetri/n8nDash)
- [raycast/extensions 生态分析](https://hysenlabs.com/zh-cn/projects/raycast-extensions)
- [Best Mac Keyboard Shortcut Apps 2026](https://textexpander.com/?p=90135)
- [Best Hot Key Software 2026](https://statpit.com/best/hot-key-software)
- [Building Custom Automations with n8n](https://ones.com/blog/ones-solutions/building-custom-automations-with-n8n-a-hands-on-walkthrough-5/?primary_category=ones-solutions)
