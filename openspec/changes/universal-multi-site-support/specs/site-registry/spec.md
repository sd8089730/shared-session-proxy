## ADDED Requirements

### Requirement: 站点数据模型
SiteRegistry SHALL 管理站点注册表，每个站点包含以下字段：`siteId`（唯一标识，仅含 `[a-z0-9-]`，最长 32 字符）、`name`（显示名称）、`targetUrl`（目标站点完整 URL，须以 http:// 或 https:// 开头）、`icon`（站点图标 URL，可为空）、`domains`（cookie 域名列表，用于 cookie 过滤和域名匹配）、`customHeaders`（需要额外捕获和注入的自定义 header 名称数组，最多 10 个，须小写化，禁止包含 `host`、`cookie`、`authorization`、`x-proxy-site`）、`startPage`（站点进入后的默认路径，必须以 `/` 开头，不含 query 或 hash，默认 `/`）、`addedAt`（ISO 8601 创建时间戳）。`siteId` 和 `addedAt` 在创建后不可变。站点注册表总数上限为 50 个。

#### Scenario: siteId 自动生成算法
- **WHEN** 用户提供 targetUrl="https://www.720yun.com" 创建站点
- **THEN** 系统 SHALL 从 targetUrl 的 hostname 提取 siteId：去掉 `www.` 前缀 → 取第一个 `.` 前的部分 → 小写化 → 结果为 `720yun`。若 hostname 为 IP 地址（如 `192.168.1.100`），则将 `.` 替换为 `-`（`192-168-1-100`）。若 hostname 为 `localhost`，siteId 为 `localhost`。

#### Scenario: siteId 碰撞自动追加后缀
- **WHEN** 自动生成 siteId="github" 但已存在同名站点
- **THEN** 系统 SHALL 依次尝试 `github-2`、`github-3`...直到唯一

#### Scenario: 创建完整站点配置
- **WHEN** 用户提供 name="百度"、targetUrl="https://www.baidu.com" 创建站点
- **THEN** 系统 SHALL 自动生成 siteId="baidu"、自动推导 domains 为 `[".baidu.com"]`、设置 customHeaders 为空数组、设置 startPage 为 "/"、记录 addedAt 为当前时间戳

#### Scenario: 站点数量上限
- **WHEN** 已注册 50 个站点，尝试创建第 51 个
- **THEN** 系统 SHALL 返回 HTTP 400 错误，body 含 `{ error: "Maximum 50 sites reached" }`

#### Scenario: customHeaders 校验
- **WHEN** 创建站点时 customHeaders 包含 `["Cookie", "X-Proxy-Site"]`
- **THEN** 系统 SHALL 返回 HTTP 400 错误，body 含 `{ error: "Forbidden header names: cookie, x-proxy-site" }`

### Requirement: 站点注册表持久化
SiteRegistry SHALL 将站点列表持久化到 `data/sites.json` 文件。每次站点增删改操作 SHALL 使用原子写入（写入临时文件后 rename）。启动时 SHALL 从 `data/sites.json` 加载已有站点列表。

#### Scenario: 服务器重启后站点列表恢复
- **WHEN** Proxy 服务器重启
- **THEN** 系统 SHALL 从 `data/sites.json` 加载所有已注册站点，站点数量和配置与重启前一致

#### Scenario: sites.json 不存在时的初始化
- **WHEN** Proxy 启动且 `data/sites.json` 文件不存在
- **THEN** 系统 SHALL 创建 `data/sites.json`，内含一个默认站点（根据 `PROXY_TARGET` 环境变量或默认 `https://www.720yun.com` 生成）

### Requirement: 站点管理 REST API
Proxy SHALL 提供站点管理 CRUD 端点，所有端点 SHALL 要求 Bearer ADMIN_SECRET 认证：
- `GET /__proxy_admin__/sites` 返回所有站点列表
- `POST /__proxy_admin__/sites` 创建新站点（请求体：`{ name, targetUrl, icon?, customHeaders?, startPage?, domains? }`）
- `PUT /__proxy_admin__/sites/:siteId` 部分更新站点配置（merge 语义，仅更新请求体中包含的字段）。`siteId` 和 `addedAt` 不可变，若请求体包含这两个字段 SHALL 忽略。当 `targetUrl` 发生变更时 SHALL 自动清空该站点的 SessionStore（cookies/headers/revision 归零）。
- `DELETE /__proxy_admin__/sites/:siteId` 删除站点及其关联 session 数据
- `GET /__proxy_admin__/sites/:siteId` 获取单个站点详情

#### Scenario: 创建新站点
- **WHEN** 客户端 POST `/__proxy_admin__/sites` body=`{ "name": "GitHub", "targetUrl": "https://github.com" }`
- **THEN** 系统 SHALL 创建站点、生成 siteId、自动推导 domains、持久化到 sites.json、广播 SSE `site-added` 事件、返回 HTTP 201 含完整站点对象

#### Scenario: 删除站点
- **WHEN** 客户端 DELETE `/__proxy_admin__/sites/github`
- **THEN** 系统 SHALL 从注册表移除该站点、删除 `data/sessions/github.json`、广播 SSE `site-removed` 事件、返回 HTTP 200

#### Scenario: 更新 targetUrl 时清空 session
- **WHEN** 客户端 PUT `/__proxy_admin__/sites/720yun` body=`{ "targetUrl": "https://www.baidu.com" }`
- **THEN** 系统 SHALL 更新 targetUrl、重新推导 domains、清空该站点 SessionStore（cookies={}, headers={}, revision=0）、持久化、广播 SSE `site-updated` 事件

#### Scenario: 删除不存在的站点
- **WHEN** 客户端 DELETE `/__proxy_admin__/sites/nonexistent`
- **THEN** 系统 SHALL 返回 HTTP 404

#### Scenario: 未认证请求
- **WHEN** 请求不携带有效 Bearer token
- **THEN** 系统 SHALL 返回 HTTP 401

### Requirement: 站点变更 SSE 广播
当站点注册表发生变更时，SiteRegistry SHALL 通过现有 SSE 端点 `/__proxy_admin__/session/events` 广播事件：
- 新增站点：`event: site-added`，data 含完整站点对象
- 更新站点：`event: site-updated`，data 含更新后的站点对象
- 删除站点：`event: site-removed`，data 含 `{ siteId }`

#### Scenario: 客户端 A 添加站点后客户端 B 收到通知
- **WHEN** 客户端 A 通过 POST API 创建新站点 "GitHub"
- **THEN** 所有已连接 SSE 的客户端 SHALL 收到 `event: site-added` 事件，data 含 GitHub 站点的完整配置

#### Scenario: SSE 连接后接收站点快照
- **WHEN** 客户端建立 SSE 连接
- **THEN** 初始 `snapshot` 事件 SHALL 包含 `sites` 字段（完整站点列表）

### Requirement: Cookie 域名自动推导
SiteRegistry SHALL 在创建站点时自动从 targetUrl 推导 cookie domains。规则：解析 targetUrl 的 hostname，去掉 `www.` 前缀（如有），在剩余 hostname 前添加 `.` 前缀作为默认 cookie domain。对于 IP 地址（如 `192.168.1.100`）或 `localhost`，SHALL 使用原始 hostname 作为 domain（不添加 `.` 前缀）。用户提供的 `domains` 字段 SHALL 覆盖自动推导结果。Electron 客户端在注入 cookie 时 SHALL 使用 domains 数组的第一个元素作为 cookie domain。

#### Scenario: 从 www 子域名推导
- **WHEN** 创建站点 targetUrl="https://www.example.com"
- **THEN** 自动推导 domains SHALL 为 `[".example.com"]`

#### Scenario: 从非 www 子域名推导
- **WHEN** 创建站点 targetUrl="https://app.example.com"
- **THEN** 自动推导 domains SHALL 为 `[".example.com"]`

#### Scenario: IP 地址作为 targetUrl
- **WHEN** 创建站点 targetUrl="http://192.168.1.100:3000"
- **THEN** 自动推导 domains SHALL 为 `["192.168.1.100"]`（不添加 `.` 前缀）

#### Scenario: localhost 作为 targetUrl
- **WHEN** 创建站点 targetUrl="http://localhost:8080"
- **THEN** 自动推导 domains SHALL 为 `["localhost"]`

#### Scenario: 用户显式指定 domains
- **WHEN** 创建站点 targetUrl="https://www.example.com" 且提供 domains=[".example.com", ".api.example.com"]
- **THEN** 系统 SHALL 使用用户提供的 domains，不使用自动推导结果

### Requirement: SiteRegistry Property-Based Testing 不变量
以下不变量 SHALL 在 SiteRegistry 的所有状态和操作序列下始终成立，用于 property-based testing 验证。

#### Scenario: 站点数量上限不变量
- **WHEN** 任意 CRUD 操作序列（创建、删除交替）施加于 SiteRegistry
- **THEN** `|sites| ≤ 50` 始终成立；第 51 次创建 SHALL 失败且不改变状态

#### Scenario: siteId 格式不变量
- **WHEN** 任意 targetUrl（含 www 前缀、IP 地址、localhost、超长 hostname）创建站点
- **THEN** 所有成功持久化的 siteId SHALL 匹配 `^[a-z0-9-]{1,32}$`；碰撞后缀追加后仍 SHALL 不超过 32 字符（超过时创建失败）

#### Scenario: siteId/addedAt 不可变不变量
- **WHEN** 任意 PUT 更新请求（含试图修改 siteId 或 addedAt 的 body）
- **THEN** 更新后读取的 siteId 和 addedAt SHALL 与创建时完全一致

#### Scenario: 创建→读取 round-trip
- **WHEN** 以任意合法参数 POST 创建站点后 GET 读取
- **THEN** 读取结果 SHALL 与创建返回值完全一致；用户未提供的可选字段 SHALL 有正确的默认值（customHeaders=[], startPage="/", domains=自动推导结果）

#### Scenario: 持久化 round-trip
- **WHEN** 任意 CRUD 序列后从 `data/sites.json` 重新加载 SiteRegistry
- **THEN** 加载后的站点集合（作为集合比较，忽略顺序）SHALL 与写入前完全一致

#### Scenario: customHeaders 边界不变量
- **WHEN** 创建或更新站点时提供 0-20 个 customHeaders
- **THEN** 超过 10 个时 SHALL 返回 400；含禁止名称（host/cookie/authorization/x-proxy-site，大小写不敏感）时 SHALL 返回 400 并列出禁止名称；合法输入 SHALL 小写化后存储

#### Scenario: 站点创建顺序无关性
- **WHEN** 同一组创建请求以不同顺序施加于空 SiteRegistry
- **THEN** 最终站点集合（投影去除 siteId 和 addedAt 后）SHALL 相等
