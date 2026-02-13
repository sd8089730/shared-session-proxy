## Why

720yun 共享会话系统的核心功能——多 Electron 客户端共享同一个 720yun 账号的 Cookie——当前完全无法工作。`electron-client/main.js:44` 从代理服务器的 `session.cookies`（空对象 `{}`）读取 Cookie，但实际 Cookie 数据存储在 `session.rawCookieString` 字段中，导致注入了 0 个 Cookie。同时缺少反向同步（客户端 → 代理）和跨客户端实时推送机制，无法实现多人共享的目标。

## What Changes

- **BREAKING** 修复 Cookie 同步链路：代理服务器 `GET /__proxy_admin__/session/status` 接口在 `cookies` 为空时，自动从 `rawCookieString` 解析并返回结构化 cookies
- **BREAKING** 移除 `start.js` 中对 Clash 代理（127.0.0.1:7897）的 HTTPS 隧道 monkeypatch 硬依赖，改为可选配置
- Electron 客户端 `syncCookiesFromProxy` 函数改为同时支持解析 `rawCookieString` 和结构化 `cookies` 两种格式
- 新增反向 Cookie 同步：Electron 客户端监听 720yun 响应中的 `Set-Cookie`，通过代理 Admin API 回写更新
- 新增跨客户端 Cookie 推送：代理服务器提供 SSE 端点，当 Cookie 更新时通知所有已连接客户端
- Electron 客户端用户名持久化到本地文件，重启后恢复
- 移除 Electron 客户端自动截图功能（`electron-client/main.js:152-162`）
- 密钥配置外部化：`ADMIN_SECRET`、`CLIENT_TOKEN` 强制从环境变量读取，移除硬编码默认值

## Capabilities

### New Capabilities
- `cookie-bidirectional-sync`: 双向 Cookie 同步机制——代理 → 客户端（拉取/SSE 推送）+ 客户端 → 代理（反向回写），确保多个 Electron 客户端共享同一份最新的 720yun 认证 Cookie
- `client-identity`: Electron 客户端用户标识持久化——用户输入用户名保存到本地文件，重启后自动恢复，用于代理访问日志记录

### Modified Capabilities

## Impact

- **代理服务器** (`D:\AI\shared-session-proxy\src/`):
  - `src/admin-routes.js`: 修改 `/session/status` 响应格式；新增 SSE 端点 `/__proxy_admin__/session/events`；新增反向同步接口
  - `src/session-store.js`: 新增 `getParsedCookies()` 方法，从 `rawCookieString` 解析返回结构化 cookies；新增变更通知回调
  - `src/config.js`: 移除硬编码默认密钥，强制要求环境变量
  - `start.js`: Clash 隧道改为可选（通过 `USE_CLASH_PROXY` 环境变量控制）
- **Electron 客户端** (`D:\AI\shared-session-proxy\electron-client/`):
  - `main.js`: 重写 `syncCookiesFromProxy` 支持双格式；新增 `Set-Cookie` 监听和反向同步；新增 SSE 客户端；移除自动截图；用户名持久化
- **API 变更**:
  - `GET /__proxy_admin__/session/status` 响应中 `session.cookies` 字段将始终返回解析后的 Cookie 键值对（即使底层是 `rawCookieString` 存储）
  - 新增 `GET /__proxy_admin__/session/events` SSE 端点
  - 新增 `POST /__proxy_admin__/session/sync-cookies` 接收客户端回写的 Cookie
- **依赖**: 无新增 npm 依赖（SSE 使用原生 HTTP 实现，Cookie 解析使用已有的 `cookie` 库）
