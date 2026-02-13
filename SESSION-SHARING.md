# 720yun 多客户端会话共享 — 实现总结

## 架构

```
┌──────────┐   push cookies/headers   ┌─────────────┐   SSE broadcast   ┌──────────┐
│ Client A │ ────────────────────────► │ Proxy Server │ ────────────────► │ Client B │
│ (Electron)│ ◄──────────────────────── │  (Express)   │ ◄──────────────── │ (Electron)│
└──────────┘   pull on startup         └─────────────┘   push on change   └──────────┘
                                             │
                                      data/session.json
                                      (cookies + headers)
```

**目标**：任意客户端登录后，其他客户端无需登录即可访问已认证功能。

## 认证机制分析

720yun 的认证由两部分组成，缺一不可：

| 认证要素 | 来源 | 作用域 |
|---------|------|-------|
| `720yun_v8_session` + 其他 cookies | 服务端 Set-Cookie | `.720yun.com` 全域 |
| `App-Authorization` 请求头 (32字符) | 前端 JS 运行时生成 | 仅存在于 JS 发起的 XHR/fetch 请求 |

服务端校验逻辑：
- 请求 **无** `App-Authorization` 头 → 仅校验 cookie → **200**
- 请求 **有** `App-Authorization` 头但值为空 → 认定无效认证 → **401**

## 工作流程

### 1. 启动拉取

```
Client B 启动
  → syncCookiesFromProxy()        # 从 proxy 拉取 cookies + headers
  → 清除本地所有 720yun cookies    # 防止过期 cookie 干扰
  → injectCookiesToStore()         # 注入 proxy cookies 到 Electron cookie store
  → ensureBroadDomain()            # 将 www.720yun.com 域的 cookie 复制到 .720yun.com
  → connectSSE()                   # 建立 SSE 连接接收实时更新
```

### 2. 请求拦截 (`onBeforeSendHeaders`)

每个发往 `*720yun.com` 的请求经过两层处理：

**Cookie 合并**：Electron cookie jar 中的值优先，sharedCookieMap 填充缺失项。解决了 `apiv4.720yun.com` 子域请求 cookie 为空的问题。

**Auth Header 捕获/注入**：
- 前端 JS 发出的请求自带有效 `App-Authorization` → 捕获并推送到 proxy
- 前端 JS 发出的请求带空 `App-Authorization` → 从 sharedHeaders 注入已捕获的值

### 3. 登录检测与推送

```
检测到离开 /login 页面
  → 等待 2s (确保 cookie 写入完成)
  → collectFullCookies()           # 收集所有 720yun cookies
  → pushCookiesToProxy()           # 推送到 proxy
```

### 4. 实时同步 (SSE)

Proxy 通过 SSE 广播 cookie 变更。客户端收到后更新 sharedCookieMap 并注入 cookie store。
SSE 消息会跳过发起方 (`source === clientId`)，避免自己通知自己。

## 初始实现失败的原因

按发现顺序排列，共六个问题：

### 问题 1：本地过期 cookie 未清除

```
[Startup] Local store has session: lvDze9mZo... (48 cookies)
[Startup] Using existing local session (not overwriting)
```

Client B 的 `persist:720yun-{clientId}` 分区中存有上次测试的过期 cookie。启动逻辑判断"本地已有 session"后跳过注入，导致使用了无效的旧 cookie。

**修复**：启动时无条件清除本地所有 720yun cookie，以 proxy 数据为唯一真实来源。

### 问题 2：Cookie 注入策略错误

原始逻辑：仅在请求头中 **不含** session cookie 时注入。

第一批请求（apiv4 首次访问）注入成功返回 200，但响应的 Set-Cookie 将 cookie 写入 Electron jar。第二批请求时 jar 中已有 cookie（`has_session=true`），注入被跳过，但 jar 中的 cookie 可能不完整或作用域不对。

**修复**：改为"填充缺失"策略 — jar 已有的值保留，sharedCookieMap 中 jar 缺少的项补充进去。

### 问题 3：Cookie 域作用域不匹配

`www.720yun.com` 域的 cookie 不会被发送到 `apiv4.720yun.com`。

```
[Request] #3 https://apiv4.720yun.com/member/my/account
[Request]   Cookie: 0 chars, has_session=false    ← jar 中有 cookie 但域不匹配
```

**修复**：`ensureBroadDomain()` 将 `www.720yun.com` 域的 cookie 复制一份到 `.720yun.com`，覆盖所有子域。`collectFullCookies()` 在推送前做同样的域名归一化。

### 问题 4：`App-Authorization` 头 — 根本原因

这是最关键的问题。诊断日志揭示了真相：

```
# 第一批请求 (apiv4 首次) — 前端 JS 尚未设置 auth 头
App-Authorization: (不存在)  → 服务端仅校验 cookie → 200

# 第二批请求 (前端 JS 发起) — JS 设置了空的 auth 头
App-Authorization: ""        → 服务端认定无效认证 → 401
```

720yun 前端 JS 会从 localStorage/内存中读取 token 并设置 `App-Authorization` 头。Client B 没有这个 token，JS 设置了空字符串，服务端对空值返回 401。

**修复**：在 `onBeforeSendHeaders` 中对所有 720yun 请求：
- 捕获非空的 `App-Authorization` 值，推送到 proxy 存储
- 检测到空值时，从 proxy 共享的 `sharedHeaders` 中注入

### 问题 5：Auth 捕获代码位置错误

第一版修复将 auth 捕获逻辑放在了 `if (sharedCookieMap.length > 0)` 分支内部。Client A 首次启动时 proxy 无 cookie（`sharedCookieMap` 为空），整个分支被跳过，auth 头永远无法被捕获。

```
# Client A 日志 — 无 [AuthCapture] 记录
auth=32  ← 前端有值，但代码未执行到捕获逻辑
```

**修复**：将 auth 捕获/注入逻辑移到 cookie 合并分支 **外部**，对所有 720yun 请求无条件执行。

### 问题 6：SSE 同步反馈循环

```
A 注入 cookie → Electron 触发 cookie changed 事件
  → CookieMonitor 推送到 proxy → proxy SSE 广播
  → B 收到并注入 → B 的 CookieMonitor 推送 → proxy 广播
  → A 收到 → 无限循环
```

`isSyncing` 标志在 `injectCookiesToStore` 完成后立即释放，但 Electron 的 cookie `changed` 事件是异步派发的，释放后才到达 CookieMonitor。

**修复**：注入完成后延迟 3 秒释放 `isSyncing`，覆盖 CookieMonitor 的 2 秒防抖 + 异步事件派发延迟。

## 关键代码路径

| 文件 | 函数/区域 | 职责 |
|-----|----------|------|
| `electron-client/main.js:468-516` | `onBeforeSendHeaders` | Cookie 合并 + Auth 头捕获/注入 |
| `electron-client/main.js:529-566` | `onHeadersReceived` | Set-Cookie 捕获 + 响应日志 |
| `electron-client/main.js:263-283` | `setupCookieMonitor` | 本地 cookie 变更 → 推送 proxy |
| `electron-client/main.js:336-365` | `handleSSEMessage` | SSE 更新 → 注入本地 (含防循环) |
| `electron-client/main.js:618-655` | Startup 流程 | 拉取 → 清除 → 注入 → SSE 连接 |
| `electron-client/main.js:241-260` | `pushHeadersToProxy` | Auth 头推送到 proxy 存储 |
| `src/session-store.js` | `SessionStore` | 服务端 cookie/header 持久化 |
| `src/admin-routes.js` | SSE + REST API | 客户端间同步通道 |
