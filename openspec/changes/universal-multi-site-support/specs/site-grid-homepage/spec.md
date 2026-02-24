## ADDED Requirements

### Requirement: 九宫格首页视图
Electron 客户端 SHALL 在启动时显示九宫格首页视图（`#home-view`），展示所有已注册站点的卡片网格。首页视图和浏览器视图（`#browser-view`）SHALL 通过 CSS display 属性切换，同一时间仅显示其中一个。

#### Scenario: 启动时显示首页
- **WHEN** Electron 客户端启动
- **THEN** SHALL 显示九宫格首页视图，BrowserView SHALL 隐藏

#### Scenario: 首页包含所有已注册站点
- **WHEN** Proxy 中注册了 3 个站点（720云、百度、GitHub）
- **THEN** 首页 SHALL 显示 3 个站点卡片加 1 个"添加站点"按钮，共 4 个网格项。已缓存的站点卡片上 SHALL 额外显示"关闭"按钮。

#### Scenario: 站点数超过单屏显示
- **WHEN** 注册站点数加"添加站点"按钮超过 9 个（3x3 网格）
- **THEN** 首页网格 SHALL 支持垂直滚动，所有站点卡片均可通过滚动访问

### Requirement: 站点卡片展示
每个站点卡片 SHALL 显示站点图标（或首字母占位符）、站点名称、站点 URL。卡片 SHALL 支持点击操作。

#### Scenario: 有图标的站点卡片
- **WHEN** 站点配置含非空 icon URL
- **THEN** 卡片 SHALL 显示该图标图片

#### Scenario: 无图标的站点卡片
- **WHEN** 站点配置 icon 为空
- **THEN** 卡片 SHALL 显示站点名称的首个字符作为占位符

### Requirement: 点击站点卡片打开代理浏览器
用户点击站点卡片后，Electron SHALL 隐藏首页视图、显示浏览器视图（toolbar + BrowserView + statusbar），创建以该站点 siteId 为标识的 BrowserView 实例，使用 session partition `persist:{siteId}-{clientId}`，并在该 session 的 `webRequest.onBeforeSendHeaders` 中为所有请求注入 `X-Proxy-Site: {siteId}` 头。BrowserView SHALL 加载 `http://{proxyUrl}/{startPage}` 。若该 siteId 已有缓存的 BrowserView 实例，SHALL 直接复用而非重新创建。

#### Scenario: 打开 720yun 站点
- **WHEN** 用户点击 siteId="720yun" 的站点卡片，proxyUrl 为 "127.0.0.1:7890"
- **THEN** 系统 SHALL 创建 BrowserView（session partition "persist:720yun-{clientId}"），注入 `X-Proxy-Site: 720yun` 头到所有请求，加载 `http://127.0.0.1:7890/my/720vr/tour`

#### Scenario: 复用已缓存的 BrowserView
- **WHEN** 用户返回首页后再次点击 siteId="720yun"，且该 BrowserView 仍在缓存中
- **THEN** 系统 SHALL 直接显示缓存的 BrowserView，不重新创建或加载

#### Scenario: 从浏览器视图返回首页
- **WHEN** 用户在浏览器视图中点击"返回首页"按钮
- **THEN** 系统 SHALL 隐藏浏览器视图中的 BrowserView（保留在内存缓存中）、显示首页视图。BrowserView 保持后台运行。

### Requirement: BrowserView 生命周期管理
Electron SHALL 维护 `Map<siteId, BrowserView>` 缓存已打开的站点视图。最多同时缓存 5 个 BrowserView 实例。当缓存已满且用户打开新站点时，SHALL 销毁最早打开（LRU）的 BrowserView。首页站点卡片上 SHALL 显示"关闭"按钮（仅对已缓存的站点），点击后 SHALL 销毁该 BrowserView 并从缓存移除。

#### Scenario: 缓存已满时淘汰最旧视图
- **WHEN** 已缓存 5 个 BrowserView，用户打开第 6 个站点
- **THEN** 系统 SHALL 销毁最早打开的 BrowserView，释放其资源，然后创建新站点的 BrowserView

#### Scenario: 手动关闭缓存的 BrowserView
- **WHEN** 用户在首页点击某站点卡片上的"关闭"按钮
- **THEN** 系统 SHALL 销毁该 BrowserView、从缓存 Map 中移除、清除对应 session partition 的 cookies

#### Scenario: 站点被删除时清理
- **WHEN** SSE 收到 `site-removed` 事件，该站点有缓存的 BrowserView
- **THEN** 系统 SHALL 销毁 BrowserView、从缓存移除、清除 session partition cookies、从九宫格移除卡片；如用户正在浏览该站点 SHALL 返回首页并提示"站点已被移除"

### Requirement: 添加站点对话框
首页九宫格末尾 SHALL 有"添加站点"按钮。点击后 SHALL 弹出对话框，包含以下输入字段：
- 站点名称（必填）
- 目标 URL（必填，需以 http:// 或 https:// 开头）
- 自定义 Header 列表（可选，逗号分隔的 header 名称）

用户确认后 SHALL 调用 Proxy API `POST /__proxy_admin__/sites` 创建站点。

#### Scenario: 成功添加站点
- **WHEN** 用户填入 name="GitHub"、targetUrl="https://github.com"、customHeaders="" 并点击确认
- **THEN** 系统 SHALL 调用 POST API 创建站点、关闭对话框、在九宫格中显示新站点卡片

#### Scenario: URL 格式校验
- **WHEN** 用户输入的 targetUrl 不以 http:// 或 https:// 开头
- **THEN** 系统 SHALL 显示校验错误提示，不发送创建请求

#### Scenario: 创建失败处理
- **WHEN** POST API 返回错误（如重复 siteId）
- **THEN** 系统 SHALL 在对话框中显示错误信息，保留用户输入

### Requirement: 站点列表从 Proxy API 加载
Electron 客户端启动时 SHALL 通过 `GET /__proxy_admin__/sites` 从 Proxy 拉取站点列表并渲染九宫格。

#### Scenario: 启动时加载站点列表
- **WHEN** Electron 客户端启动并连接到 Proxy
- **THEN** 系统 SHALL 调用 GET API 获取站点列表，渲染到九宫格

#### Scenario: Proxy 不可达时的降级
- **WHEN** 启动时 Proxy 不可达
- **THEN** 系统 SHALL 显示"代理连接失败"提示，九宫格显示空状态（仅"添加站点"按钮和重试提示）

### Requirement: 站点列表 SSE 实时同步
Electron 客户端 SHALL 监听 SSE 中的 `site-added`、`site-updated`、`site-removed` 事件，实时更新九宫格显示。

#### Scenario: 其他客户端添加站点
- **WHEN** SSE 收到 `site-added` 事件，data 含新站点对象
- **THEN** 系统 SHALL 在九宫格中添加新站点卡片（插入在"添加站点"按钮之前）

#### Scenario: 站点被删除
- **WHEN** SSE 收到 `site-removed` 事件，data 含 `{ siteId: "github" }`
- **THEN** 系统 SHALL 从九宫格中移除对应卡片；若该站点有缓存的 BrowserView 则按 BrowserView 生命周期管理 Requirement 执行清理

### Requirement: 多站点独立 Cookie 同步
每个打开的站点 SHALL 拥有独立的 cookie 同步逻辑。cookie 推送（客户端→Proxy）和拉取（Proxy→客户端）SHALL 按 siteId 隔离，在 API 请求中携带 siteId 参数。SSE 的 `cookie-update` 事件 SHALL 携带 siteId 字段，客户端仅处理当前活跃站点的 cookie 更新。

#### Scenario: 同时浏览两个站点的 cookie 隔离
- **WHEN** 用户先打开 720yun 站点，再打开 github 站点（两个 BrowserView 实例）
- **THEN** 720yun 的 cookie 更新 SHALL 仅影响 720yun 的 BrowserView session，github 的 cookie 更新 SHALL 仅影响 github 的 BrowserView session

#### Scenario: cookie 推送携带 siteId
- **WHEN** 720yun 站点的 BrowserView 检测到 cookie 变化并推送到 Proxy
- **THEN** POST 请求体 SHALL 包含 `siteId: "720yun"`，Proxy SHALL 将 cookie 存入 720yun 的 SessionStore

### Requirement: 站点特有 preload IPC 方法
preload.js SHALL 新增以下 IPC 方法供 renderer 调用：
- `getSites()`: 获取所有站点列表
- `addSite({ name, targetUrl, customHeaders? })`: 添加新站点
- `removeSite(siteId)`: 删除站点
- `openSite(siteId)`: 打开指定站点的浏览器视图
- `goHome()`: 返回首页

#### Scenario: Renderer 调用 getSites
- **WHEN** renderer 进程调用 `window.electronAPI.getSites()`
- **THEN** SHALL 通过 IPC 从 main 进程获取站点列表并返回 Promise<Site[]>

#### Scenario: Renderer 调用 openSite
- **WHEN** renderer 进程调用 `window.electronAPI.openSite("720yun")`
- **THEN** main 进程 SHALL 创建/激活对应的 BrowserView 并切换到浏览器视图
