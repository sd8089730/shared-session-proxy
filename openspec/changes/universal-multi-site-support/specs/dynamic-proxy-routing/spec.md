## ADDED Requirements

### Requirement: X-Proxy-Site 请求头路由
Proxy SHALL 从每个入站请求（包括 HTTP 和 WebSocket upgrade 请求）的 `X-Proxy-Site` HTTP 头读取 siteId，从 SiteRegistry 查找对应站点配置，将请求代理到该站点的 `targetUrl`。Proxy SHALL 在代理前从该站点的 SessionStore 注入存储的 cookies 和 customHeaders。Proxy SHALL 在 `onProxyReq` 钩子中删除 `X-Proxy-Site` 头，确保不转发到目标站点。

#### Scenario: 携带 X-Proxy-Site 头的请求
- **WHEN** 请求携带 `X-Proxy-Site: github` 头，且 SiteRegistry 中存在 siteId="github" 的站点（targetUrl="https://github.com"）
- **THEN** Proxy SHALL 将请求代理到 `https://github.com`，注入 github 站点的 SessionStore 中存储的 cookies 和 headers

#### Scenario: X-Proxy-Site 指向不存在的站点
- **WHEN** 请求携带 `X-Proxy-Site: nonexistent` 头，SiteRegistry 中不存在该 siteId
- **THEN** Proxy SHALL 返回 HTTP 502 错误，body 含 `{ error: "Unknown site: nonexistent", siteId: "nonexistent" }`

#### Scenario: 请求无 X-Proxy-Site 头（向后兼容）
- **WHEN** 请求不携带 `X-Proxy-Site` 头
- **THEN** Proxy SHALL 使用默认站点进行代理。默认站点确定逻辑：若设置了 `PROXY_TARGET` 环境变量则匹配 sites.json 中 targetUrl（小写化、去尾斜杠后比较）一致的站点；否则使用 sites.json 中的第一个站点；若 sites.json 为空则返回 HTTP 502

#### Scenario: WebSocket upgrade 请求路由
- **WHEN** WebSocket upgrade 请求携带 `X-Proxy-Site: github` 头
- **THEN** Proxy SHALL 以与 HTTP 请求相同的逻辑路由到 github 的 targetUrl，注入 cookies 和 customHeaders，并剥离 `X-Proxy-Site` 头

#### Scenario: Proxy 到目标站点连接失败
- **WHEN** siteId="github" 的请求代理时目标站点不可达（DNS 失败、连接拒绝、TLS 错误、超时）
- **THEN** Proxy SHALL 返回 HTTP 502 错误，body 含 `{ error: "<错误描述>", siteId: "github", targetUrl: "https://github.com" }`

### Requirement: 多站点 SessionStore 实例管理
Proxy SHALL 为每个注册站点维护独立的 SessionStore 实例。SessionStore 工厂函数 SHALL 接受 siteId 参数，数据文件路径为 `data/sessions/{siteId}.json`。工厂函数 SHALL 维护实例缓存（`Map<siteId, SessionStore>`），确保同一 siteId 复用同一实例。

#### Scenario: 首次访问站点时创建 SessionStore
- **WHEN** siteId="github" 的站点首次接收请求，且 `data/sessions/github.json` 不存在
- **THEN** 系统 SHALL 创建新的 SessionStore 实例，初始化空 session 文件 `data/sessions/github.json`

#### Scenario: SessionStore 实例缓存
- **WHEN** 多个请求同时访问 siteId="github"
- **THEN** 系统 SHALL 返回同一个 SessionStore 实例（缓存命中）

#### Scenario: 站点删除时清理 SessionStore
- **WHEN** siteId="github" 的站点被删除
- **THEN** 系统 SHALL 从缓存中移除对应 SessionStore 实例，并删除 `data/sessions/github.json` 文件

### Requirement: 动态代理 cookie 注入
Proxy 的 `onProxyReq` 钩子 SHALL 根据请求的 siteId 从对应 SessionStore 获取 cookies 和 headers 并注入：
- 调用该站点 SessionStore 的 `getCookieString()` 设置 `Cookie` 请求头
- 调用该站点 SessionStore 的 `getExtraHeaders()` 注入 customHeaders 中定义的 header

#### Scenario: 注入站点特有的 cookies 和 headers
- **WHEN** siteId="720yun" 的请求通过 Proxy，该站点 SessionStore 含 cookies `{720yun_v8_session: "abc"}` 和 headers `{App-Authorization: "token123"}`
- **THEN** Proxy SHALL 设置请求头 `Cookie: 720yun_v8_session=abc` 和 `App-Authorization: token123`

#### Scenario: 不同站点的 cookie 隔离
- **WHEN** siteId="720yun" 的请求和 siteId="github" 的请求同时通过 Proxy
- **THEN** 720yun 请求 SHALL 仅注入 720yun 的 cookies，github 请求 SHALL 仅注入 github 的 cookies，互不干扰

### Requirement: 动态代理响应 cookie 捕获
Proxy 的 `onProxyRes` 钩子 SHALL 捕获目标站点响应中的 `Set-Cookie` 头，存入对应 siteId 的 SessionStore，并触发该站点的 SSE 广播。

#### Scenario: 捕获目标站点设置的 cookie
- **WHEN** siteId="github" 的代理请求返回响应含 `Set-Cookie: _gh_sess=xyz; Domain=.github.com`
- **THEN** Proxy SHALL 将该 cookie 存入 github 的 SessionStore，触发 SSE `cookie-update` 事件（含 `siteId: "github"`）

### Requirement: 自定义 Header 动态捕获
对于站点配置中 `customHeaders` 列表内的 header 名称，Proxy SHALL 在 Electron 客户端推送 headers 时（通过 `POST /__proxy_admin__/session/headers`）按 siteId 隔离存储。请求体 SHALL 包含 `siteId` 字段。

#### Scenario: 推送站点特有的自定义 header
- **WHEN** 客户端 POST `/__proxy_admin__/session/headers` body=`{ "siteId": "720yun", "headers": { "App-Authorization": "newtoken" } }`
- **THEN** 系统 SHALL 将 header 存入 720yun 的 SessionStore，触发 SSE 广播

#### Scenario: 未指定 siteId 时使用默认站点
- **WHEN** 客户端 POST `/__proxy_admin__/session/headers` body=`{ "headers": { "App-Authorization": "token" } }`（无 siteId 字段）
- **THEN** 系统 SHALL 将 header 存入默认站点的 SessionStore（向后兼容）

### Requirement: 数据迁移
Proxy 启动时 SHALL 检测并执行旧数据格式迁移：若 `data/session.json` 存在且 `data/sessions/` 目录不存在，SHALL 创建 `data/sessions/` 目录并将 `session.json` 迁移为默认站点的 session 文件。迁移完成后 SHALL 将原 `data/session.json` 重命名为 `data/session.json.bak`。

#### Scenario: 从旧格式自动迁移
- **WHEN** Proxy 启动，发现 `data/session.json` 存在且 `data/sessions/` 不存在
- **THEN** 系统 SHALL 创建 `data/sessions/` 目录，将 `data/session.json` 复制为 `data/sessions/{defaultSiteId}.json`，将原文件重命名为 `data/session.json.bak`

#### Scenario: 已完成迁移不重复执行
- **WHEN** Proxy 启动，`data/sessions/` 目录已存在
- **THEN** 系统 SHALL 跳过迁移逻辑

### Requirement: 多站点 Session API 扩展
现有 session 管理 API 端点 SHALL 支持 `siteId` 参数以指定操作的目标站点。参数传递规则：GET 和 DELETE 请求通过 query 参数 `?siteId={siteId}`；POST 和 PUT 请求通过请求体 JSON 字段 `siteId`。当 siteId 未指定时 SHALL 回退到默认站点。当指定的 siteId 在 SiteRegistry 中不存在时 SHALL 返回 HTTP 404。
- `GET /__proxy_admin__/session/status?siteId={siteId}` 返回指定站点的 session 状态
- `POST /__proxy_admin__/session/sync-cookies` 请求体 SHALL 包含 `siteId` 字段
- `POST /__proxy_admin__/session/headers` 请求体 SHALL 包含 `siteId` 字段
- `DELETE /__proxy_admin__/session?siteId={siteId}` 清除指定站点的 session

#### Scenario: 查询特定站点的 session 状态
- **WHEN** 客户端 GET `/__proxy_admin__/session/status?siteId=github`
- **THEN** 系统 SHALL 返回 github 站点的 cookies、headers、revision 等状态

#### Scenario: siteId 参数缺失时回退默认
- **WHEN** 客户端 GET `/__proxy_admin__/session/status`（无 siteId 参数）
- **THEN** 系统 SHALL 返回默认站点的 session 状态

### Requirement: 动态路由 Property-Based Testing 不变量
以下不变量 SHALL 在动态代理路由和多站点 SessionStore 的所有状态和操作序列下始终成立，用于 property-based testing 验证。

#### Scenario: Session 跨站隔离不变量
- **WHEN** 对 siteId=A 执行任意 session 操作（sync-cookies、headers、clear）
- **THEN** siteId=B（B≠A）的 cookies、headers、revision SHALL 完全不变

#### Scenario: 路由注入隔离不变量
- **WHEN** 携带 `X-Proxy-Site: A` 的请求通过 Proxy
- **THEN** 出站请求 SHALL 仅包含 A 的 cookies 和 customHeaders，不含 B 的任何数据，且不含 `X-Proxy-Site` 头

#### Scenario: 未知 siteId 不回退不变量
- **WHEN** 请求携带不存在的 `X-Proxy-Site` 值
- **THEN** SHALL 返回 502 且不修改任何 session 状态

#### Scenario: Per-site revision 单调递增不变量
- **WHEN** 对同一站点施加任意 cookie 变更序列
- **THEN** revision SHALL 严格单调递增（每次 +1），targetUrl 变更导致的归零除外；不同站点的变更 SHALL 不影响彼此的 revision

#### Scenario: SessionStore 单例缓存不变量
- **WHEN** 并发调用 `createSessionStore(siteId)` 多次
- **THEN** SHALL 返回同一个对象实例（引用相等）

#### Scenario: Cookie 跨站操作可交换不变量
- **WHEN** 对不同站点 A 和 B 分别执行 cookie 更新
- **THEN** 以任意顺序执行后，全局状态（每站点的 cookies/headers/revision）SHALL 相同

#### Scenario: 迁移内容保持不变量
- **WHEN** `data/session.json` 存在且内容为 J，执行迁移
- **THEN** `data/sessions/{defaultSiteId}.json` 内容 SHALL 等于 J，且 `data/session.json.bak` 内容 SHALL 等于 J

#### Scenario: 迁移幂等性不变量
- **WHEN** 迁移逻辑执行两次
- **THEN** 文件系统状态 SHALL 与执行一次完全相同（`data/sessions/` 已存在时跳过）

#### Scenario: 默认站点回退确定性不变量
- **WHEN** 给定相同的 sites.json 和 PROXY_TARGET 环境变量
- **THEN** 无 `X-Proxy-Site` 头时的路由目标 SHALL 始终相同（确定性映射）

#### Scenario: Session API siteId 语义不变量
- **WHEN** 对任意 session 端点指定不存在的 siteId
- **THEN** SHALL 返回 HTTP 404 且不修改任何站点的 session 状态
