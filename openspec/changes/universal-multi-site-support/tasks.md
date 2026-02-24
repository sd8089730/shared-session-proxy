## 1. 数据层基础设施

- [x] 1.1 创建 `src/site-registry.js` 模块：实现站点数据模型、`data/sites.json` 读写（原子写入）、增删改查方法、变更回调机制、cookie domain 自动推导逻辑。siteId 自动生成算法：从 targetUrl hostname 提取（去 www、取首段、小写化、IP 用 `-` 替换 `.`），碰撞追加 `-2`/`-3`...后缀。siteId 格式 `[a-z0-9-]` 最长 32 字符。customHeaders 小写化、禁止 host/cookie/authorization/x-proxy-site、最多 10 个。站点上限 50 个。
- [x] 1.2 改造 `src/session-store.js`：从单实例导出改为工厂函数 `createSessionStore(siteId)`，数据文件路径改为 `data/sessions/{siteId}.json`，内部维护 `Map<siteId, SessionStore>` 实例缓存（单例保证）
- [x] 1.3 实现数据迁移逻辑：Proxy 启动时检测 `data/session.json`，若存在且 `data/sessions/` 不存在则自动迁移为默认站点的 session 文件，原文件重命名为 `.bak`。迁移幂等（已迁移时跳过）
- [x] 1.4 实现 `data/sites.json` 初始化：当文件不存在时，根据 `PROXY_TARGET` 环境变量（或默认 720yun）生成包含一个默认站点的初始注册表

## 2. Proxy 服务器 API 扩展

- [x] 2.1 在 `src/admin-routes.js` 中新增站点管理 CRUD 端点：`GET/POST/PUT/DELETE /__proxy_admin__/sites` 和 `GET /__proxy_admin__/sites/:siteId`。POST 返回 201；PUT 为 merge 语义（siteId/addedAt 不可变）；PUT 变更 targetUrl 时自动清空 SessionStore；DELETE 删除 session 文件并从缓存移除。所有端点需 Bearer 认证
- [x] 2.2 改造现有 session API 端点以支持 `siteId` 参数：GET/DELETE 通过 query 参数 `?siteId=`，POST 通过 body 字段 `siteId`。缺失时回退默认站点。不存在的 siteId 返回 404
- [x] 2.3 扩展 SSE 端点：snapshot 事件增加 `sites` 字段和各站点 session 摘要；新增 `site-added`、`site-updated`、`site-removed` 事件类型；`cookie-update` 事件增加 `siteId` 字段。SSE 认证支持 Bearer header 和 `?token=` query 参数

## 3. Proxy 动态代理路由

- [x] 3.1 改造 `src/server.js` 代理中间件：使用 http-proxy-middleware 的 `router` 回调，从请求头 `X-Proxy-Site` 读取 siteId，查找 SiteRegistry 获取 targetUrl 动态路由（含 HTTP 和 WebSocket upgrade）；siteId 不存在时返回 502（含 `{ error, siteId }`）
- [x] 3.2 改造 `onProxyReq` 钩子：根据请求的 siteId 从对应 SessionStore 获取 cookies 和 customHeaders 进行注入，删除 `X-Proxy-Site` 头（不发送给目标站点）
- [x] 3.3 改造 `onProxyRes` 钩子：根据请求的 siteId 将捕获的 Set-Cookie 存入对应站点的 SessionStore
- [x] 3.4 实现默认站点回退逻辑：无 `X-Proxy-Site` 头时查找默认站点（PROXY_TARGET 小写化去尾斜杠匹配 → sites.json 首个 → 502）
- [x] 3.5 Proxy 到目标站点连接失败时返回 502 含 `{ error, siteId, targetUrl }`

## 4. Proxy 启动流程整合

- [x] 4.1 修改 `src/server.js` 启动流程：初始化 SiteRegistry → 执行数据迁移 → 为已有站点创建 SessionStore 实例 → 启动代理服务
- [x] 4.2 修改 `src/config.js`：移除硬编码 `PROXY_TARGET` 默认值的直接使用，target 从 SiteRegistry 动态获取
- [x] 4.3 更新 `/__proxy_admin__/health` 端点：返回站点数量、各站点连接状态和 session 摘要

## 5. Electron 客户端 — 首页 UI

- [x] 5.1 在 `electron-client/renderer/index.html` 中新增首页 HTML 结构：`#home-view` 容器、站点卡片网格（可滚动，支持超过 3x3）、"添加站点"按钮、添加站点对话框（覆盖层）
- [x] 5.2 在 `electron-client/renderer/index.html` 中实现首页 CSS 样式：九宫格网格布局（`display: grid`，3 列自适应）、站点卡片样式（图标/首字母占位符、名称、URL）、已缓存站点的"关闭"按钮、添加站点按钮、对话框样式、垂直滚动
- [x] 5.3 在 `electron-client/renderer/index.html` 的 inline JS 中实现首页逻辑：加载站点列表渲染卡片、点击卡片调用 `openSite(siteId)`、点击关闭按钮调用 `closeSiteView(siteId)`、点击添加按钮弹出对话框、对话框表单验证（URL 格式校验）和提交、首页/浏览器视图切换

## 6. Electron 客户端 — 多站点 BrowserView 管理

- [x] 6.1 在 `electron-client/preload.js` 中新增 IPC 方法：`getSites`、`addSite`、`removeSite`、`openSite`、`goHome`、`closeSiteView`
- [x] 6.2 在 `electron-client/main.js` 中实现多站点 BrowserView 管理：每个站点创建独立 BrowserView 实例（session partition `persist:{siteId}-{clientId}`），维护 `Map<siteId, BrowserView>` 管理活跃视图，最多缓存 5 个（LRU 淘汰最旧）
- [x] 6.3 在每个站点 BrowserView 的 `session.webRequest.onBeforeSendHeaders` 中注入 `X-Proxy-Site: {siteId}` 头
- [x] 6.4 实现首页↔浏览器视图切换的 IPC handler：`openSite` 隐藏首页显示 BrowserView（复用缓存或新建）；`goHome` 隐藏 BrowserView 显示首页（BrowserView 保留在缓存中）；`closeSiteView` 销毁 BrowserView 并清除 session partition cookies

## 7. Electron 客户端 — 多站点 Cookie 同步

- [x] 7.1 改造 `syncCookiesFromProxy` 函数：接受 siteId 参数，API 请求携带 `siteId`，cookie domain 从站点配置的 domains[0] 获取（替代硬编码 `.720yun.com`），revision 按 siteId 隔离存储
- [x] 7.2 改造 `pushCookiesToProxy` 函数：请求体增加 siteId 字段，cookie 收集基于站点 domains 过滤
- [x] 7.3 改造 cookie 变更监听：每个活跃站点的 BrowserView session 独立监听 `cookies` changed 事件，debounce 和 `isSyncing` 标志按 siteId 隔离
- [x] 7.4 改造 SSE 消息处理：`cookie-update` 事件按 `siteId` 路由到对应站点的 cookie 注入逻辑（非活跃站点缓存到内存，不持久化）；`site-added`/`site-updated`/`site-removed` 事件更新本地站点列表并刷新首页；`site-removed` 触发 BrowserView 清理
- [x] 7.5 改造 header 捕获和推送：按站点 siteId 隔离 customHeaders 的捕获和 POST 推送

## 8. Electron 客户端 — 站点管理 IPC 实现

- [x] 8.1 在 main.js 中实现 `getSites` handler：通过 HTTP 调用 Proxy `GET /__proxy_admin__/sites` 返回站点列表
- [x] 8.2 在 main.js 中实现 `addSite` handler：通过 HTTP 调用 Proxy `POST /__proxy_admin__/sites`，成功后刷新本地站点列表
- [x] 8.3 在 main.js 中实现 `removeSite` handler：通过 HTTP 调用 Proxy `DELETE /__proxy_admin__/sites/:siteId`，清理对应 BrowserView 实例和 session partition

## 9. 清理与兼容

- [x] 9.1 移除 `electron-client/main.js` 中所有硬编码的 720yun 引用：TARGET_URL、START_URL、cookie domain 过滤条件、session partition 名称，替换为从站点配置动态获取
- [x] 9.2 移除 `src/server.js` 和 `src/config.js` 中硬编码的 `PROXY_TARGET` 默认值对单一站点的依赖
- [x] 9.3 为所有新增和改造的代码添加必要的中文注释
- [x] 9.4 验证 Chrome 扩展（不携带 X-Proxy-Site 头）在默认站点回退机制下仍能正常工作
