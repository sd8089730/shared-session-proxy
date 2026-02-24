## Context

shared-session-proxy 当前是一个 720yun.com 专用的会话共享代理工具。核心组件：
- **代理服务器**（`src/server.js`）：Express + http-proxy-middleware，固定代理到 `https://www.720yun.com`
- **会话存储**（`src/session-store.js`）：单实例，持久化到 `data/session.json`，存储 cookies 和 headers（如 App-Authorization）
- **管理 API**（`src/admin-routes.js`）：8 个端点在 `/__proxy_admin__` 下，包含 SSE 实时推送
- **Electron 客户端**（`electron-client/main.js`）：BrowserView 架构，通过 SSE + HTTP 同步 cookie

720yun.com 的硬编码分布在 12+ 处：target URL、cookie domain 过滤（`.720yun.com`）、session partition 命名（`persist:720yun-{clientId}`）、起始页（`/my/720vr/tour`）等。

Chrome 扩展（`chrome-extension/`）本次不改造。

## Goals / Non-Goals

**Goals:**
- Proxy 服务器能同时代理多个不同目标站点的请求，每个站点拥有独立的 cookie/header 存储
- Electron 客户端提供九宫格首页，用户可动态添加/管理目标站点
- 站点配置在所有客户端间实时同步
- 每个站点可配置需要额外捕获的自定义 header（如 720yun 的 App-Authorization）
- 向后兼容：720yun 作为默认站点，无 `X-Proxy-Site` 头时回退到默认行为

**Non-Goals:**
- Chrome 扩展的多站点改造（保持现状）
- 站点登录流程自动化（仍需用户手动登录）
- 站点认证方式自动检测（用户需手动配置 customHeaders）
- HTTPS 代理（Proxy 到客户端仍为 HTTP）
- 用户权限管理（所有客户端共享同一管理密钥，与当前一致）

## Decisions

### D1: 多目标路由方案 — 请求头 `X-Proxy-Site` 路由

**选择**：Electron 在 BrowserView 的 `session.webRequest.onBeforeSendHeaders` 中为每个请求注入 `X-Proxy-Site: {siteId}` 头，Proxy 读取此头动态确定代理目标。

**备选方案**：
- ~~路径前缀 `/s/{siteId}/*`~~：需要改写页面内所有绝对路径资源引用（`<script src="/js/app.js">`），复杂且脆弱
- ~~多端口（每站点一个端口）~~：端口管理复杂，防火墙配置繁琐，不利于动态扩展
- ~~子域名路由（`720yun.localhost:7890`）~~：需要 DNS 配置或 hosts 文件，部署门槛高

**理由**：Electron 已有 `onBeforeSendHeaders` 机制用于注入 cookie 和 proxy 认证头，复用此机制注入 `X-Proxy-Site` 成本最低。请求头路由避免了路径改写问题——BrowserView 直接加载 `http://localhost:7890/原始路径`，站点页面内的相对/绝对路径引用自然生效。

### D2: SessionStore 多实例化 — 工厂函数 + 实例缓存

**选择**：将 `session-store.js` 从导出单个实例改为导出工厂函数 `createSessionStore(siteId)`，内部维护 `Map<siteId, SessionStore>` 缓存。每个实例的数据文件为 `data/sessions/{siteId}.json`。

**备选方案**：
- ~~单个 session.json 内嵌 siteId 命名空间~~：文件过大，并发写入冲突风险高
- ~~SQLite 替代 JSON 文件~~：引入 schema 管理复杂度，当前 JSON 方案已满足需求

**理由**：每站点独立文件，读写互不干扰。工厂函数 + Map 缓存确保同一 siteId 复用实例，避免重复加载。数据目录结构清晰（`data/sessions/`），便于备份和调试。

### D3: 站点注册表存储 — JSON 文件 `data/sites.json`

**选择**：新增 `src/site-registry.js` 模块，管理 `data/sites.json` 文件。数据结构：

```json
{
  "sites": [
    {
      "siteId": "720yun",
      "name": "720云",
      "targetUrl": "https://www.720yun.com",
      "icon": "",
      "domains": [".720yun.com"],
      "customHeaders": ["App-Authorization"],
      "startPage": "/my/720vr/tour",
      "addedAt": "2024-01-01T00:00:00Z"
    }
  ]
}
```

**理由**：与现有 `session.json` 的 JSON 文件模式一致。站点数量预期很小（几个到几十个），JSON 文件完全胜任。

### D4: SSE 事件扩展 — 在现有 SSE 通道内新增事件类型

**选择**：复用现有 `/__proxy_admin__/session/events` SSE 端点，新增事件类型：
- `site-added`: 新站点注册
- `site-updated`: 站点配置变更
- `site-removed`: 站点删除
- 现有 `cookie-update` 事件增加 `siteId` 字段

**备选方案**：
- ~~独立的站点 SSE 端点~~：增加连接数，占用更多资源

**理由**：单连接多事件类型，节约资源。客户端按 `event` 字段路由处理逻辑。

### D5: Electron 首页实现 — 同一 HTML 文件内视图切换

**选择**：在 `electron-client/renderer/index.html` 中新增首页 section（`#home-view`），通过 CSS `display` 切换首页和浏览器视图（`#browser-view`）。保持 plain HTML/CSS/JS 风格。

**备选方案**：
- ~~新增独立窗口~~：多窗口管理复杂
- ~~引入 React/Vue~~：过度工程化，与现有代码风格不一致

**理由**：当前 Electron 客户端全部为 plain HTML + inline JS，保持一致。视图切换逻辑简单，不需要框架。

### D6: Cookie 域名自动推导

**选择**：从站点的 `targetUrl` 自动推导 cookie domain。规则：`https://www.example.com` → `.example.com`（去掉 `www` 前缀，添加 `.` 前缀）。如果 `targetUrl` 的 hostname 无 `www` 前缀（如 `https://app.example.com`），则使用 `.example.com`（提取注册域名级别）。站点配置的 `domains` 字段允许用户覆盖自动推导结果。

**理由**：大多数网站的 cookie domain 遵循此规则。`domains` 覆盖机制处理特殊情况。

### D7: 向后兼容 — 默认站点回退

**选择**：当请求不携带 `X-Proxy-Site` 头时，Proxy 使用默认站点。默认站点确定逻辑：
1. 如果设置了 `PROXY_TARGET` 环境变量，从 sites.json 中查找 `targetUrl` 匹配的站点
2. 否则使用 sites.json 中的第一个站点
3. 如果 sites.json 为空，返回 HTTP 502 错误

**理由**：确保 Chrome 扩展（不发送 `X-Proxy-Site`）和旧版客户端继续工作。

### D8: 数据迁移 — 启动时自动迁移

**选择**：Proxy 启动时检测旧数据格式并自动迁移：
1. 如果 `data/session.json` 存在且 `data/sessions/` 目录不存在 → 创建 `data/sessions/` 并将 `session.json` 移动为 `data/sessions/{defaultSiteId}.json`
2. 如果 `data/sites.json` 不存在 → 根据 `PROXY_TARGET` 环境变量（或默认 `https://www.720yun.com`）创建初始站点注册表

**理由**：零手动迁移成本，升级即用。

## Risks / Trade-offs

- **[风险] X-Proxy-Site 头未发送** → 回退到默认站点。Chrome 扩展和旧客户端不受影响。但如果用户直接通过浏览器访问代理且未配置 Electron，所有请求将代理到默认站点。→ 缓解：在 `/health` 端点和日志中显示当前默认站点，方便排查。

- **[风险] 站点间 cookie 泄漏** → 每个站点独立 SessionStore 实例和独立 session partition（Electron 侧 `persist:{siteId}-{clientId}`），物理隔离 cookie 存储。→ Proxy 侧按 siteId 加载对应 SessionStore，不会交叉注入。

- **[风险] 动态 proxy target 创建开销** → http-proxy-middleware 需要为每个不同的 target 创建代理实例。→ 缓解：使用 `router` 回调函数动态返回 target URL，http-proxy-middleware 支持此模式，避免创建多个中间件实例。

- **[取舍] 所有客户端共享站点列表** → 任何客户端添加的站点对所有人可见。这是设计目标（共享工具），但意味着无法个性化站点列表。→ 可接受：与当前所有客户端共享同一个 720yun 会话的设计哲学一致。

- **[取舍] 自定义 Header 需手动配置** → 不自动检测站点需要哪些特殊 header。→ 可接受：大多数站点仅需 cookie，特殊 header 场景（如 720yun 的 App-Authorization）可在添加站点时指定。

- **[风险] 并发站点修改冲突** → 两个客户端同时添加/删除站点可能导致 sites.json 写入冲突。→ 缓解：使用与 session.json 相同的原子写入模式（tmp + rename），且站点操作频率极低。
