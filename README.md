# Shared Session Proxy

多客户端共享网站登录会话的代理系统。任意一台机器登录后，同网络下的其他机器无需登录即可访问已认证功能。

```
┌──────────┐                          ┌──────────┐
│ Client A │──push cookies/headers──►│          │──SSE broadcast──►┌──────────┐
│ (登录端)  │◄──────pull on start──────│  Proxy   │                 │ Client B │
└──────────┘                          │  Server  │◄──push on change─┤ (免登录)  │
                                      │          │──SSE broadcast──►└──────────┘
┌──────────┐                          │  :7890   │
│ Client C │◄──────pull + SSE─────────│          │
│ (免登录)  │──push on change────────►└──────────┘
└──────────┘                               │
                                    data/session.json
```

## 组成

| 模块 | 路径 | 说明 |
|-----|------|------|
| Proxy Server | `src/` | Express 代理服务，存储并分发会话数据 |
| Electron Client | `electron-client/` | 内嵌浏览器客户端，自动同步会话 |
| Chrome Extension | `chrome-extension/` | 浏览器扩展（辅助） |

## 快速开始

### 1. 启动 Proxy Server

```bash
# 安装依赖
npm install

# 启动（默认端口 7890）
npm start

# 开发模式（文件变更自动重启）
npm run dev
```

启动后可访问健康检查确认运行状态：

```
http://localhost:7890/__proxy_admin__/health
```

### 2. 启动 Electron Client

```bash
cd electron-client
npm install
npm start
```

首次启动后在顶部工具栏填入 Proxy 地址（如 `http://192.168.7.44:7890`），点击同步按钮。

### 3. 使用流程

1. **Client A** 打开后正常登录 720yun
2. 登录成功后 cookies 和 `App-Authorization` 头自动推送到 Proxy
3. **Client B** 启动 → 自动从 Proxy 拉取会话 → 直接进入已登录状态
4. 会话变更通过 SSE 实时同步到所有在线客户端

## 配置

### Proxy Server

通过环境变量或直接修改 `src/config.js`：

| 参数 | 环境变量 | 默认值 | 说明 |
|-----|---------|-------|------|
| 端口 | `PROXY_PORT` | `7890` | 代理服务监听端口 |
| 目标站 | `PROXY_TARGET` | `https://www.720yun.com` | 被代理的目标网站 |
| 客户端令牌 | `CLIENT_TOKEN` | 空（不校验） | 代理请求的访问令牌 |
| 日志保留 | — | `30` 天 | `config.log.retainDays` |
| 数据库 | — | `./data/proxy.db` | SQLite 访问日志 |
| 会话文件 | — | `./data/session.json` | Cookie/Header 持久化 |

### Electron Client

首次启动自动生成配置文件，路径：

```
%APPDATA%/720yun-shared-browser/720yun-client-config.json
```

内容：

```json
{
  "clientId": "自动生成的 UUID",
  "userName": "User-xxxxxx",
  "proxyUrl": "http://127.0.0.1:7890"
}
```

- `proxyUrl` 可在客户端工具栏直接修改
- `clientId` 用于区分不同客户端，SSE 消息据此跳过发起方

日志文件：`%APPDATA%/720yun-shared-browser/720yun-client.log`

## 管理 API

所有接口需携带 `Authorization: Bearer yunnto2wsxzaq!` 头。

| 方法 | 路径 | 说明 |
|-----|------|------|
| GET | `/__proxy_admin__/health` | 健康检查 + 会话概况 |
| GET | `/__proxy_admin__/session/status` | 当前会话详情（cookies、headers、revision） |
| POST | `/__proxy_admin__/session/cookies` | 合并更新 cookies |
| POST | `/__proxy_admin__/session/sync-cookies` | 替换全量 cookies（客户端同步用） |
| POST | `/__proxy_admin__/session/headers` | 更新 headers（如 App-Authorization） |
| POST | `/__proxy_admin__/session/raw-cookie` | 以原始字符串格式设置 cookie |
| DELETE | `/__proxy_admin__/session` | 清空会话 |
| GET | `/__proxy_admin__/session/events` | SSE 事件流（实时同步通道） |
| GET | `/__proxy_admin__/logs` | 查询访问日志 |
| GET | `/__proxy_admin__/logs/stats` | 日志统计 |
| POST | `/__proxy_admin__/logs/cleanup` | 清理过期日志 |

### SSE 事件

连接：`GET /__proxy_admin__/session/events?token=<secret>&clientId=<id>`

| 事件 | 触发时机 | 数据 |
|-----|---------|------|
| `snapshot` | 连接建立时 | 当前全量 cookies + revision |
| `cookie-update` | 任一客户端推送变更时 | 变更后的 cookies + revision + source |

## 设计原理

### 目标网站认证模型

720yun 的认证由两个独立要素组成：

| 要素 | 载体 | 来源 |
|-----|------|------|
| Session Cookie (`720yun_v8_session` 等) | HTTP Cookie | 服务端 Set-Cookie |
| App-Authorization (32字符 token) | HTTP 请求头 | 前端 JS 运行时从内存/localStorage 读取 |

服务端校验行为：
- 请求 **不含** `App-Authorization` 头 → 仅校验 cookie → 通过则 **200**
- 请求 **含** `App-Authorization` 头且值非空 → 校验 cookie + token → 通过则 **200**
- 请求 **含** `App-Authorization` 头但值为空字符串 → 直接 **401**

因此仅同步 cookie 不够，必须同时同步 `App-Authorization` 头。

### 客户端请求拦截

Electron 的 `webRequest.onBeforeSendHeaders` 拦截所有 `*720yun.com` 请求，执行两层处理：

**Cookie 合并**（填充策略）：Electron cookie jar 中已有的值保留，sharedCookieMap 中 jar 缺少的项补充。解决 `apiv4.720yun.com` 等子域请求 cookie 为空的问题。

**Auth Header 捕获/注入**：
- 前端 JS 发出的请求自带有效 token → 捕获并推送到 Proxy
- 前端 JS 发出的请求带空 token（Client B 无本地 token） → 从 sharedHeaders 注入

### Cookie 域处理

720yun 的 cookie 可能设置在 `www.720yun.com`（host-only），这些 cookie 不会随 `apiv4.720yun.com` 的请求发送。

`ensureBroadDomain()` 在注入后将 `www.720yun.com` 域的 cookie 复制到 `.720yun.com`（覆盖所有子域）。`collectFullCookies()` 在推送前做同样的域名归一化。

### SSE 防循环

客户端注入 proxy 推送的 cookie 后，Electron 异步触发 cookie `changed` 事件 → CookieMonitor 检测到变更 → 推送回 proxy → proxy 广播 → 其他客户端注入 → 无限循环。

防循环机制：
1. **`isSyncing` 标志**：注入期间设为 `true`，CookieMonitor 检测到则跳过推送
2. **延迟释放**：注入完成后延迟 3 秒释放标志，覆盖 Electron 异步事件派发 + CookieMonitor 2 秒防抖
3. **source 跳过**：SSE 消息携带 `source`（clientId），客户端跳过自己发起的变更
4. **revision 去重**：每次变更递增 revision，客户端忽略 ≤ 本地 revision 的消息

### 数据流完整路径

```
Client A 登录
  → 页面导航离开 /login
  → 2s 后收集 cookies (collectFullCookies)
  → pushCookiesToProxy() → POST /session/sync-cookies
  → Proxy 写入 data/session.json, revision++
  → SSE 广播 cookie-update (排除 Client A)
  → Client B 收到 SSE
  → handleSSEMessage() → 更新 sharedCookieMap + 注入 cookie store
  → isSyncing 延迟 3s 释放

同时:
  → Client A 的 onBeforeSendHeaders 捕获 App-Authorization
  → pushHeadersToProxy() → POST /session/headers
  → Proxy 存入 data/session.json

Client B 发起 API 请求:
  → onBeforeSendHeaders 拦截
  → Cookie: jar 值 + sharedCookieMap 填充
  → App-Authorization: 空值 → 从 sharedHeaders 注入
  → 请求携带完整认证信息 → 200
```

## 项目结构

```
shared-session-proxy/
├── src/
│   ├── server.js            # Express 主服务 + 代理转发
│   ├── config.js            # 配置项
│   ├── session-store.js     # Cookie/Header 持久化存储
│   ├── admin-routes.js      # 管理 API + SSE 端点
│   ├── access-log.js        # SQLite 访问日志
│   └── middleware/
│       ├── auth.js          # 管理 API 认证
│       └── logger.js        # 请求日志
├── electron-client/
│   ├── main.js              # 主进程：会话同步、请求拦截、SSE
│   ├── preload.js           # Context bridge
│   ├── renderer/
│   │   └── index.html       # 工具栏 + 状态栏 UI
│   └── package.json
├── chrome-extension/         # Chrome 扩展（辅助）
├── data/
│   ├── session.json         # 运行时会话数据
│   └── proxy.db             # 访问日志数据库
└── package.json
```

## 构建客户端

```bash
cd electron-client

# 构建便携版 exe
npm run dist
```

输出位于 `electron-client/dist/`。
