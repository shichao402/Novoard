# ADR-0009: Hub 管理控制台采用 Ant Design Pro

- 状态：Accepted
- 日期：2026-10-15
- 讨论来源：用户、角色、PAT 与首访初始化计划

## Context

旧 Dashboard 由 `src/dashboard.mjs` 直接拼接单页 HTML、手写 CSS 和 DOM。它适合早期只读面板，但用户、角色、PAT、Agent 凭据与企微配置会带来表格、表单、权限路由、异步状态和可访问性需求。继续扩展模板字符串会重复实现成熟后台组件，也难以进行类型检查和真实浏览器测试。

Hub 后端仍应保持原生 `node:http`，并由同一容器在根路径提供 API 与静态页面；本决策不引入独立前端服务或 Node Web 框架。

## Decision

管理控制台使用：

- React 19 + TypeScript；
- Ant Design 6 与支持 Ant Design 6 的 `@ant-design/pro-components` 3；
- Vite 7 负责构建，React Router 7 负责 browser history 与根路径路由，页面通过 `React.lazy` 按路由拆包；
- TanStack Query 负责服务端状态、mutation 和缓存失效；
- Biome、Vitest + Testing Library + MSW、Playwright 分别负责静态检查、组件测试与真实浏览器闭环。

页面优先使用 `ProLayout`、`ProTable`、`ProForm`、`ModalForm`、`Result`、`Alert` 等成熟组件，只保留布局级 CSS，不建立 Novoard 私有组件库或视觉系统。

生产地址以 `https://novoard.firoyang.com/` 为唯一根路径。Docker 多阶段构建 `web/dist`，Hub 在 API/隧道路由之后提供静态文件与 SPA fallback：内容哈希资源长缓存，`index.html` 不缓存，未知 API 保持 JSON 404。CSP 禁止外部与内联脚本，仅为 Ant Design CSS-in-JS 放行同源运行时样式。

授权采用双层防线：前端根据 `/api/me` 隐藏无权菜单和操作；服务端始终重新执行身份、权限和 target 范围裁决。

## Consequences

- 收益：后台交互使用成熟组件；页面按路由拆分；类型、组件和浏览器验收成为 CI 门禁；首访初始化与日常管理使用同一正式产品界面。
- 代价：仓库增加前端依赖、构建阶段和静态产物；Ant Design CSS-in-JS 要求 CSP 允许同源内联样式。
- 未采用 Umi Max：实现期依赖审计发现其未使用的插件/构建链带入 82 个漏洞项（含 1 个 critical）；改用职责更小的 Vite + React Router 后生产与开发依赖审计为 0 项。
- 被取代：ADR-0006 中“沿用 issue-handler 单页直出 Dashboard”的前端留白由本 ADR 关闭；后端 `node:http`、JSONL/文件存储与 agent 技术栈决定不变。
