## 1. SessionStore 改造（代理服务器）

- [x] 1.1 重构 `src/session-store.js`：废弃 `rawCookieString`，统一为 `cookies` 结构化存储，新增 `revision` 字段，启动时自动迁移旧格式
- [x] 1.2 新增 `getCookieString()` 方法从 `cookies` map 实时生成 Cookie 头字符串
- [x] 1.3 新增变更通知回调机制（`onChange` listener），供 SSE 广播使用

## 2. Config 与启动改造（代理服务器）

- [x] 2.1 修改 `src/config.js`：移除 `ADMIN_SECRET` 和 `CLIENT_TOKEN` 的硬编码默认值，缺少 `ADMIN_SECRET` 时启动失败
- [x] 2.2 修改 `start.js`：Clash 隧道改为可选（`USE_CLASH_PROXY` 环境变量控制），不设置时正常启动

## 3. Admin API 改造（代理服务器）

- [x] 3.1 修改 `src/admin-routes.js` 的 `/session/status`：响应始终返回结构化 `cookies` map 和 `revision`
- [x] 3.2 修改 `POST /session/raw-cookie`：解析 raw string 为结构化 cookies 写入，递增 revision
- [x] 3.3 新增 `POST /__proxy_admin__/session/sync-cookies` 端点：接收客户端反向同步的 cookies，合并、递增 revision、触发 SSE 广播（排除 source）
- [x] 3.4 新增 `GET /__proxy_admin__/session/events` SSE 端点：连接时发送 snapshot，cookie 更新时广播 cookie-update 事件，30s 心跳，最大 20 连接

## 4. Proxy 中间件适配（代理服务器）

- [x] 4.1 修改 `src/server.js` 中的 proxy middleware：Cookie 注入改为调用 `sessionStore.getCookieString()`

## 5. Electron 客户端改造

- [x] 5.1 重写 `syncCookiesFromProxy`：从 `/session/status` 读取结构化 `cookies` + `revision`，注入 BrowserView session，记录 localRevision
- [x] 5.2 新增反向 Cookie 同步：监听 BrowserView session 的 cookies changed 事件，debounce 2s，POST 到 `/session/sync-cookies`，含 `isSyncing` 循环防护
- [x] 5.3 新增 SSE 客户端：启动时连接 `/session/events`，处理 snapshot 和 cookie-update 事件，revision 比较 + 循环防护，断线 3s 重连 + 全量拉取
- [x] 5.4 用户标识持久化：读写 `<userData>/720yun-client-config.json`，存储 `userName` 和 `clientId`（UUID v4），跨重启保持
- [x] 5.5 清理：移除自动截图逻辑、移除硬编码 Bearer token，从环境变量或配置文件读取 `PROXY_URL` 和 `ADMIN_SECRET`

## 6. Review 修复

- [x] 6.1 修复 `src/middleware/auth.js`：支持 SSE 的 `?token=` query 参数认证 + 空 clientToken 跳过验证
- [x] 6.2 修复 SSE 广播排除 source 客户端 + 使用唯一连接 ID
- [x] 6.3 修复 `setRawCookieString` 改为合并而非替换
- [x] 6.4 修复 Clash 隧道 fail-closed（移除 direct fallback）
