## MODIFIED Requirements

### Requirement: Electron client cookie sync from proxy
Electron client `syncCookiesFromProxy` SHALL 接受 siteId 参数，fetch `GET /__proxy_admin__/session/status?siteId={siteId}`，read `session.cookies` as `{name: value}` map，并 inject each cookie into 对应站点的 BrowserView session via `session.cookies.set()`。Cookie domain SHALL 从站点配置的 `domains` 字段获取（而非硬编码 `.720yun.com`）。The client SHALL store the received `revision` per siteId and skip applying updates with revision less than or equal to the locally stored revision for that site.

#### Scenario: Initial cookie sync on startup for specific site
- **WHEN** Electron client 打开 siteId="720yun" 的站点并调用 `syncCookiesFromProxy("720yun")`
- **THEN** client SHALL fetch cookies from proxy with `siteId=720yun`，inject all into 720yun BrowserView session with domain from site config `.720yun.com`，and store the `revision` locally keyed by siteId

#### Scenario: Cookie domain from site config
- **WHEN** 同步 siteId="github" 的 cookies，该站点 domains=[".github.com"]
- **THEN** client SHALL inject cookies with domain `.github.com`（而非硬编码的 `.720yun.com`）

#### Scenario: Stale update ignored per site
- **WHEN** client receives cookies for siteId="720yun" with `revision: 5` but locally stored revision for "720yun" is already `5`
- **THEN** client SHALL skip cookie injection

### Requirement: Electron client reverse cookie sync
Electron client SHALL monitor 每个活跃站点 BrowserView session 的 `cookies` changed event。当对应站点 domains 匹配的 cookie 变化时（cause `explicit` from Set-Cookie response），client SHALL debounce for 2 seconds，then collect all matching domain cookies from the session and POST to `/__proxy_admin__/session/sync-cookies` with the client's unique ID as `source` and corresponding `siteId`.

#### Scenario: 站点响应设置新 cookie
- **WHEN** siteId="github" 站点响应含 `Set-Cookie: _gh_sess=abc; Domain=.github.com`
- **THEN** after 2-second debounce，client SHALL POST `{ siteId: "github", cookies: {all current .github.com cookies}, source: "<clientId>" }` to proxy

#### Scenario: Cookie change from proxy sync (loop prevention)
- **WHEN** cookie change is triggered by `syncCookiesFromProxy` injection (not from site response)
- **THEN** client SHALL NOT trigger reverse sync（the `isSyncing` flag per site SHALL suppress reverse sync during proxy-initiated injection）

### Requirement: SSE endpoint for real-time cookie push
The proxy SHALL expose `GET /__proxy_admin__/session/events` as a Server-Sent Events endpoint. 认证方式：通过 `Authorization: Bearer <token>` 请求头或 `?token=<token>` query 参数（SSE 场景下 Electron 的 EventSource API 无法设置自定义请求头，因此 SHALL 支持 query 参数认证）。On connection, the server SHALL send an initial `snapshot` event containing：完整站点列表（`sites` 字段）以及所有站点的当前 cookie 状态和 revision。`cookie-update` 事件的 `cookies` 字段 SHALL 为该站点的全量 cookie 快照（非增量 diff）。When cookies are updated，the server SHALL broadcast a `cookie-update` event including `siteId` field to identify which site's cookies changed，along with `revision`, `cookies` map, `updatedBy`, and `source` fields. The server SHALL send a heartbeat comment (`:heartbeat`) every 30 seconds. Maximum concurrent SSE connections SHALL be 20.

#### Scenario: Client connects to SSE and receives snapshot with sites
- **WHEN** Electron client opens SSE connection to `GET /__proxy_admin__/session/events?token=<ADMIN_SECRET>`
- **THEN** server SHALL immediately send `event: snapshot` with `data: { sites: [...], sessions: { "720yun": { cookies: {...}, revision: N }, "github": { cookies: {...}, revision: M } } }`

#### Scenario: Cookie update broadcast with siteId
- **WHEN** siteId="github" 的 cookies are updated by any source
- **THEN** server SHALL send `event: cookie-update` with `data: { siteId: "github", cookies: {...}, revision: N+1, source: "...", updatedAt: "..." }` to all connected SSE clients

#### Scenario: Client receives update for inactive site
- **WHEN** SSE client 收到 siteId="github" 的 cookie-update，但该客户端未打开 github 站点的 BrowserView
- **THEN** client SHALL 在内存中缓存该更新的 revision 和 cookies（不持久化，重启后丢失）。当用户稍后打开 github 站点时，若缓存的 revision 高于 proxy 当前 revision 则 apply cached cookies，否则从 proxy 拉取最新状态

#### Scenario: SSE heartbeat
- **WHEN** no updates occur for 30 seconds
- **THEN** server SHALL send `:heartbeat\n\n` comment to keep connection alive

#### Scenario: Connection limit reached
- **WHEN** 21st client attempts SSE connection while 20 are active
- **THEN** server SHALL respond with HTTP 503

### Requirement: Electron client SSE connection
Electron client SHALL establish a single SSE connection to `GET /__proxy_admin__/session/events` on startup. On receiving `cookie-update` events，client SHALL read `siteId` field，compare `revision` against local revision for that siteId，and if newer，inject the received cookies into the corresponding site's BrowserView session（with per-site `isSyncing` flag）. On receiving `site-added`/`site-updated`/`site-removed` events，client SHALL update the local site list and refresh the home page grid. On SSE disconnection，the client SHALL reconnect after 3 seconds.

#### Scenario: Receive real-time cookie update for specific site
- **WHEN** SSE delivers `cookie-update` event with `siteId: "github"` and revision higher than local revision for github
- **THEN** client SHALL inject cookies into github BrowserView session with `isSyncing=true` to prevent reverse sync loop

#### Scenario: SSE disconnection and recovery
- **WHEN** SSE connection drops
- **THEN** client SHALL reconnect after 3 seconds，fetch full session status for all active sites，and apply if revisions are newer
