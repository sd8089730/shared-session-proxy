## Why

当前 shared-session-proxy 的所有模块（代理服务器 `src/server.js`、会话存储 `src/session-store.js`、Electron 客户端 `electron-client/main.js`）均硬编码绑定 720yun.com 单一站点。用户希望将此工具泛化为通用会话共享平台——支持动态添加任意需要登录的网站，一人登录后所有客户端共享认证状态。当前架构中 720yun.com 的硬编码引用散布于 12+ 处（目标 URL、cookie 域名过滤、session partition 命名、起始页地址等），无法通过简单配置扩展到其他站点。

## What Changes

- 新增站点注册表模块（`src/site-registry.js`），以 `data/sites.json` 持久化存储站点列表，每个站点包含 siteId、name、targetUrl、icon、domains、customHeaders（需要额外捕获/注入的自定义 header 名称列表）
- 新增站点管理 REST API 端点：`GET/POST/PUT/DELETE /__proxy_admin__/sites` 和 `GET /__proxy_admin__/sites/:siteId`，支持动态增删改查站点配置
- **BREAKING** 将 `src/session-store.js` 从单实例改造为多实例工厂模式：每个站点拥有独立的 SessionStore 实例，数据文件从 `data/session.json` 迁移至 `data/sessions/{siteId}.json`
- **BREAKING** 代理路由改造：`src/server.js` 中的 `http-proxy-middleware` 从固定 target 改为动态路由——读取请求头 `X-Proxy-Site` 确定目标站点，从站点注册表查找 targetUrl，选择对应 SessionStore 注入 cookies 和自定义 headers
- SSE 事件扩展：`src/admin-routes.js` 中的 SSE 端点新增 `site-added`、`site-updated`、`site-removed` 事件类型；cookie-update 事件增加 `siteId` 字段标识来源站点
- 向后兼容：当请求不携带 `X-Proxy-Site` 头时，回退到默认站点（从 `PROXY_TARGET` 环境变量或 sites.json 中的第一个站点推导）
- Electron 客户端新增九宫格首页视图（在 `electron-client/renderer/index.html` 中）：展示所有已注册站点的卡片网格，每个卡片含图标、站点名称、URL，末尾有"添加站点"按钮
- Electron 客户端新增添加站点对话框：允许用户输入站点名称、目标 URL、可选的自定义 header 列表，通过 Proxy API 创建站点并同步到所有客户端
- Electron 客户端点击站点卡片后：创建独立 BrowserView 加载对应站点，使用独立 session partition `persist:{siteId}-{clientId}`，在 `session.webRequest.onBeforeSendHeaders` 中为所有请求自动注入 `X-Proxy-Site: {siteId}` 头
- Cookie 同步逻辑按站点隔离：每个站点的 cookie 推送、拉取、SSE 订阅均基于 siteId 区分
- Cookie 域名处理通用化：根据站点 targetUrl 自动推导 cookie domain（如 `https://www.example.com` → `.example.com`），替代硬编码的 `.720yun.com`
- 自定义 Header 捕获：站点配置中的 `customHeaders` 字段指定额外需要捕获和注入的 header 名称（如 720yun 的 `App-Authorization`），代理在 proxyReq/proxyRes 钩子中按站点配置动态处理
- 所有新增和改造的代码增加必要的中文注释
- Chrome 扩展（`chrome-extension/`）保持不变，不在本次改造范围内

## Capabilities

### New Capabilities
- `site-registry`: 站点注册表管理——支持动态注册、查询、更新、删除目标站点，每个站点包含唯一标识（siteId）、名称、目标 URL、图标、域名列表、自定义 header 配置；提供 REST API 供 Electron 客户端和管理员操作；站点数据持久化到 `data/sites.json` 并通过 SSE 广播变更
- `dynamic-proxy-routing`: 动态多目标代理路由——代理服务器通过读取请求头 `X-Proxy-Site` 动态确定代理目标站点，同时支持多个不同目标站点的请求代理；每个站点拥有独立的 SessionStore 实例（`data/sessions/{siteId}.json`）用于隔离 cookie 和 header 数据；向后兼容无 `X-Proxy-Site` 头的请求
- `site-grid-homepage`: Electron 客户端九宫格首页——展示所有已注册站点的卡片网格视图，支持点击卡片打开对应站点的代理浏览器视图，支持通过对话框添加新站点；站点列表从 Proxy API 拉取并通过 SSE 实时同步更新

### Modified Capabilities
- `cookie-bidirectional-sync`: Cookie 双向同步机制需要扩展为按站点隔离——每个站点独立的 cookie 存储、SSE 推送事件中增加 siteId 字段、客户端按当前浏览站点的 siteId 区分 cookie 的推送和接收

## Impact

- **代理服务器** (`src/`):
  - `src/site-registry.js`（新增）: 站点注册表模块，管理 `data/sites.json` 的读写和变更通知
  - `src/session-store.js`: 从单实例改为工厂函数，支持按 siteId 创建独立实例，数据目录从 `data/session.json` 迁移至 `data/sessions/`
  - `src/server.js`: 代理中间件从固定 target 改为动态路由，新增 `X-Proxy-Site` 头解析逻辑
  - `src/admin-routes.js`: 新增站点管理 CRUD 端点；SSE 事件扩展站点变更事件类型和 siteId 字段
  - `src/config.js`: 移除硬编码的 `PROXY_TARGET` 默认值依赖，改为从站点注册表动态获取
- **Electron 客户端** (`electron-client/`):
  - `electron-client/main.js`: 重构为支持多站点——九宫格首页渲染、站点卡片点击处理、动态 BrowserView 创建、按站点隔离的 session partition 和 cookie 同步、`X-Proxy-Site` 头注入
  - `electron-client/renderer/index.html`: 新增首页 HTML 结构（九宫格网格、添加站点对话框）、首页与浏览器视图的切换逻辑
  - `electron-client/preload.js`: 新增站点管理相关 IPC 方法（getSites、addSite、removeSite、openSite）
- **数据目录** (`data/`):
  - `data/sites.json`（新增）: 站点注册表持久化文件
  - `data/sessions/`（新增目录）: 按站点隔离的 session 文件目录
  - `data/session.json`: 迁移至 `data/sessions/` 目录下对应站点文件（向后兼容迁移）
- **API 变更**:
  - 新增 `GET /__proxy_admin__/sites` 返回所有站点列表
  - 新增 `POST /__proxy_admin__/sites` 创建站点
  - 新增 `PUT /__proxy_admin__/sites/:siteId` 更新站点配置
  - 新增 `DELETE /__proxy_admin__/sites/:siteId` 删除站点
  - 现有 session API 端点（`/session/status`、`/session/sync-cookies`、`/session/headers`、`/session/events`）增加 `siteId` 查询参数/请求字段以支持多站点
- **依赖**: 无新增 npm 依赖
