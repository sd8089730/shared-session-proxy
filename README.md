# Shared Session Proxy

多站点会话共享代理系统。支持动态添加任意网站，一台机器登录后，同网络下的其他机器无需登录即可复用认证状态。

```
                        ┌──────────────────────────────┐
                        │     Proxy Server (:7890)     │
                        │                              │
                        │  sites.json    sessions/     │
                        │  (站点注册表)   ├ site-a.json │
                        │                ├ site-b.json │
                        │                └ ...         │
                        │                              │
                        │  Admin API   SSE 广播         │
                        └──┬────────────┬──────────────┘
                           │            │
          ┌────────────────┼────────────┼────────────────┐
          │                │            │                 │
    ┌─────▼──────┐   ┌────▼─────┐   ┌──▼───────────┐    │
    │ Electron A │   │Electron B│   │ Chrome 扩展   │    │
    │ (登录端)    │   │ (免登录) │   │ (反向代理模式)│    │
    │            │   │          │   │               │    │
    │ BrowserView│   │BrowserView│  │ 流量经 Proxy  │    │
    │ 直连目标站  │   │直连目标站 │   │ 转发到目标站  │    │
    └────────────┘   └──────────┘   └───────────────┘
```

## 架构

系统由三部分组成：

| 模块 | 路径 | 职责 |
|------|------|------|
| Proxy Server | `src/` | 中央认证数据存储 + 站点管理 + SSE 广播 + 反向代理 |
| Electron Client | `electron-client/` | 内嵌浏览器，直连目标站，本地注入认证数据 |
| Chrome Extension | `chrome-extension/` | 浏览器扩展，流量经 Proxy 反向代理转发 |

### 流量模型

**Electron 客户端**：BrowserView 直连目标网站，不经过 Proxy。认证数据从 Proxy 拉取后注入本地 session，请求由客户端自己发出。

**Chrome 扩展**：所有流量经 Proxy 反向代理转发，Proxy 的 `onProxyReq` 钩子在服务端注入 cookie/header。

### 多站点路由

Proxy 通过请求头 `X-Proxy-Site: {siteId}` 识别目标站点：

```
请求 → X-Proxy-Site 头 → SiteRegistry 查找 → 对应 SessionStore → 注入认证数据 → 转发
                              ↓ (无头时)
                         默认站点回退
```

- Electron 客户端：BrowserView 的 `onBeforeSendHeaders` 自动注入 `X-Proxy-Site` 头
- Chrome 扩展：不携带此头，使用默认站点回退机制

### 数据同步

```
Client A 登录 → cookie 变更触发 → 自动推送到 Proxy
                                       ↓
                               Proxy 存储 + revision++
                                       ↓
                               SSE 广播 cookie-update (排除来源客户端)
                                       ↓
                          Client B/C 收到 → 注入本地 BrowserView session
```

防循环机制：
- `isSyncing` 标志 + 3 秒延迟释放：注入期间屏蔽本地 cookie changed 事件
- `source` 跳过：SSE 消息携带 clientId，客户端跳过自身发起的变更
- `revision` 去重：递增版本号，忽略 <= 本地版本的消息

## 快速开始

### 1. 启动 Proxy Server

```bash
npm install
npm start
```

Docker 部署：

```bash
docker build -t shared-session-proxy .

docker run -d --name session-proxy --restart unless-stopped \
  -p 7890:7890 \
  -v $(pwd)/data:/app/data \
  shared-session-proxy
```

可选环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROXY_PORT` | `7890` | 服务监听端口 |
| `PROXY_TARGET` | `https://www.720yun.com` | 初始默认站点（仅首次启动时生成） |
| `CLIENT_TOKEN` | 空 | 代理请求访问令牌（空则不校验） |
| `USE_CLASH_PROXY` | `false` | 启用 Clash HTTPS 隧道（`node start.js` 启动时） |

健康检查：`GET http://localhost:7890/__proxy_admin__/health`

### 2. 启动 Electron Client

```bash
cd electron-client
npm install
npm start
```

首次启动后在工具栏填入 Proxy 地址（如 `http://192.168.7.44:7890`），点击同步按钮。

### 3. 使用流程

1. 首页九宫格 → 点击「添加站点」→ 输入名称和 URL
2. 站点配置自动同步到 Proxy 和所有客户端
3. 点击站点卡片打开 BrowserView → 正常登录
4. 登录后 cookie 自动推送到 Proxy → SSE 广播 → 其他客户端注入认证数据
5. 其他客户端打开同一站点 → 直接进入已登录状态

## 站点管理 API

所有接口需携带 `Authorization: Bearer yunnto2wsxzaq!`。

### 站点 CRUD

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/sites` | 列出所有站点 |
| GET | `/sites/:siteId` | 获取单个站点 |
| POST | `/sites` | 添加站点（body: `{name, targetUrl, customHeaders?, startPage?}`） |
| PUT | `/sites/:siteId` | 更新站点（merge 语义，siteId/addedAt 不可变） |
| DELETE | `/sites/:siteId` | 删除站点及其 session 数据 |

路径前缀均为 `/__proxy_admin__`。

站点数据模型：

```json
{
  "siteId": "github",
  "name": "GitHub",
  "targetUrl": "https://github.com",
  "domains": [".github.com"],
  "customHeaders": [],
  "startPage": "/",
  "addedAt": "2025-01-01T00:00:00.000Z"
}
```

- `siteId`：从 targetUrl hostname 自动生成（去 www、取首段、小写化），碰撞追加 `-2`/`-3`
- `domains`：cookie domain 自动推导，也可手动指定
- `customHeaders`：需要捕获和注入的额外 header 名称（最多 10 个，禁止 host/cookie/authorization/x-proxy-site）

### Session 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/session/status?siteId=` | 站点 session 详情 |
| POST | `/session/sync-cookies` | 替换全量 cookies（body 含 `siteId`） |
| POST | `/session/cookies` | 合并更新 cookies |
| POST | `/session/headers` | 更新 headers |
| POST | `/session/raw-cookie` | 以原始字符串设置 cookie |
| DELETE | `/session?siteId=` | 清空站点 session |

`siteId` 缺失时回退到默认站点。

### SSE

连接：`GET /__proxy_admin__/session/events?token=<secret>&clientId=<id>`

| 事件 | 说明 |
|------|------|
| `snapshot` | 连接时推送：站点列表 + 各站点 session 摘要 |
| `cookie-update` | cookie 变更：含 `siteId`、`cookies`、`revision`、`source` |
| `site-added` | 新站点添加 |
| `site-updated` | 站点配置更新 |
| `site-removed` | 站点删除 |

### 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 + 各站点 session 摘要 |
| GET | `/logs` | 访问日志查询 |
| GET | `/logs/stats` | 日志统计 |
| POST | `/logs/cleanup` | 清理过期日志 |

## 项目结构

```
shared-session-proxy/
├── src/
│   ├── server.js           # 主服务：Express + 动态反向代理（http-proxy-middleware router 回调）
│   ├── config.js           # 配置项（端口、目标站、令牌等）
│   ├── site-registry.js    # 站点注册表：CRUD、siteId 生成、domain 推导、原子写入 sites.json
│   ├── session-store.js    # Session 存储工厂：createSessionStore(siteId)，按站点隔离
│   ├── admin-routes.js     # 管理 API + SSE 端点 + 站点 CRUD
│   ├── access-log.js       # SQLite 访问日志
│   └── middleware/
│       ├── auth.js         # Bearer 认证（Admin API）+ 客户端令牌校验
│       └── logger.js       # 请求日志
├── electron-client/
│   ├── main.js             # 主进程：多 BrowserView 管理、per-site cookie 同步、SSE、站点管理 IPC
│   ├── preload.js          # Context bridge：站点管理 + 导航 + 事件 API
│   ├── renderer/
│   │   └── index.html      # 九宫格首页 + 工具栏 + 添加站点对话框 + 状态栏
│   └── package.json
├── chrome-extension/       # Chrome 扩展（反向代理模式，使用默认站点）
├── data/                   # 运行时数据（git ignored）
│   ├── sites.json          # 站点注册表
│   ├── sessions/           # 按站点隔离的 session 文件
│   │   ├── 720yun.json
│   │   ├── github.json
│   │   └── ...
│   └── proxy.db            # 访问日志数据库
├── start.js                # 启动入口（可选 Clash HTTPS 隧道）
├── Dockerfile
└── package.json
```

## Electron 客户端技术细节

### 多 BrowserView 管理

每个站点创建独立 BrowserView，session partition 为 `persist:{siteId}-{clientId}`。通过 `Map<siteId, {view, viewSession, lastAccessed}>` 管理，最多缓存 5 个（LRU 淘汰最旧）。

### 请求拦截（onBeforeSendHeaders）

每个 BrowserView 的 session 注册 `webRequest.onBeforeSendHeaders`，执行：

1. 注入 `X-Proxy-Site: {siteId}` 头
2. Cookie 合并：本地 cookie jar 已有的保留，从 Proxy 同步的共享 cookie 补充缺失项
3. 共享 Header 注入：本地无值时从 Proxy 同步的 headers 填充
4. customHeaders 捕获：站点配置中指定的 header 变化时推送到 Proxy

### Cookie Domain 处理

根据站点 `targetUrl` 自动推导 cookie domain（`deriveDomains()`）：
- `https://www.example.com` → `[".example.com"]`
- `https://192.168.1.1` → `["192.168.1.1"]`
- `http://localhost` → `["localhost"]`

cookie changed 事件按站点 domains 过滤，只处理匹配当前站点的 cookie。

### 客户端配置

路径：`%APPDATA%/shared-session-browser/shared-proxy-config.json`

```json
{
  "clientId": "自动生成的 UUID",
  "userName": "User-xxxxxx",
  "proxyUrl": "http://127.0.0.1:7890"
}
```

日志：`%APPDATA%/shared-session-browser/shared-proxy-client.log`

## 构建

### Proxy Server (Docker)

```bash
docker build -t shared-session-proxy .

# 前台调试
docker run --rm -p 7890:7890 -v $(pwd)/data:/app/data shared-session-proxy

# 后台生产
docker run -d --name session-proxy --restart unless-stopped \
  -p 7890:7890 -v $(pwd)/data:/app/data shared-session-proxy
```

### Electron Client

```bash
cd electron-client
npm install
npm run dist
```

输出便携版 exe 位于 `electron-client/dist/`。
