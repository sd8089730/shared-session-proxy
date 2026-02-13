## ADDED Requirements

### Requirement: Unified structured cookie storage
SessionStore SHALL store cookies exclusively as a structured `cookies` object (`{name: value}` map). The `rawCookieString` field SHALL be eliminated from the data model. All cookie inputs (Chrome extension raw string, auto-login extraction, admin API) SHALL be parsed into structured format before persistence. The `getCookieString()` method SHALL generate `Cookie` header string on-the-fly by joining `cookies` entries as `name1=value1; name2=value2`.

#### Scenario: Migration from rawCookieString on startup
- **WHEN** SessionStore loads a `session.json` containing non-empty `rawCookieString` and empty `cookies` object
- **THEN** the system SHALL parse `rawCookieString` into structured `cookies` map, persist the updated structure, and remove the `rawCookieString` field

#### Scenario: Chrome extension submits raw cookie string
- **WHEN** admin API receives `POST /__proxy_admin__/session/raw-cookie` with a raw cookie string body
- **THEN** the system SHALL parse the string into `{name: value}` pairs, merge into `cookies` object, persist, and increment `revision`

#### Scenario: Generate cookie header for proxy injection
- **WHEN** the proxy middleware needs to inject cookies into a request to 720yun
- **THEN** the system SHALL generate the `Cookie` header by joining all entries in `cookies` as `name=value` pairs separated by `; `

### Requirement: Server-side revision counter for cookie updates
SessionStore SHALL maintain a monotonically increasing integer `revision` field. Every mutation to `cookies` (regardless of source) SHALL increment `revision` by 1. The `session.json` schema SHALL be: `{ cookies: {}, headers: {}, revision: number, updatedAt: string, updatedBy: string }`.

#### Scenario: Revision increments on any cookie update
- **WHEN** cookies are updated via admin API, auto-login, or client reverse sync
- **THEN** `revision` SHALL increment by exactly 1 and `updatedAt` SHALL be set to current ISO 8601 timestamp

#### Scenario: Initial revision on fresh session
- **WHEN** SessionStore creates a new empty session (no existing session.json)
- **THEN** `revision` SHALL be initialized to 0

### Requirement: Admin API returns parsed cookies in status endpoint
`GET /__proxy_admin__/session/status` SHALL always return cookies as a structured `{name: value}` map in the `session.cookies` field. The response SHALL include `session.revision` for client staleness detection. The response format SHALL be: `{ session: { cookies: {name: value}, headers: {}, revision: number, updatedAt: string, updatedBy: string }, hasCookies: boolean, cookieCount: number }`.

#### Scenario: Status returns structured cookies
- **WHEN** client sends `GET /__proxy_admin__/session/status` with valid Bearer token
- **THEN** response SHALL contain `session.cookies` as `{name: value}` map and `session.revision` as integer

#### Scenario: Unauthorized status request
- **WHEN** client sends `GET /__proxy_admin__/session/status` without valid Bearer token
- **THEN** response SHALL be HTTP 401

### Requirement: Reverse cookie sync endpoint
The proxy SHALL expose `POST /__proxy_admin__/session/sync-cookies` accepting `{ cookies: {name: value}, source: string }` JSON body. The endpoint SHALL require Bearer ADMIN_SECRET authentication. Only cookies whose names do not start with `__Host-` or `__Secure-` prefixes that conflict with the target domain SHALL be accepted. The `source` field identifies the originating client (e.g., clientId). The server SHALL merge incoming cookies into the existing `cookies` map (last-write-wins at key level), increment `revision`, and trigger SSE broadcast to all connected clients except the originator identified by `source`.

#### Scenario: Client pushes updated cookies
- **WHEN** Electron client sends `POST /__proxy_admin__/session/sync-cookies` with `{ cookies: {"720yun_v8_session": "newValue"}, source: "client-abc123" }`
- **THEN** server SHALL merge the cookie, increment `revision`, update `updatedBy` to `client-abc123`, persist to disk, and broadcast SSE event to all clients except `client-abc123`

#### Scenario: Unauthorized sync request
- **WHEN** request lacks valid Bearer token
- **THEN** response SHALL be HTTP 401

#### Scenario: Empty cookies payload
- **WHEN** request body contains `{ cookies: {}, source: "client-abc" }`
- **THEN** server SHALL return HTTP 200 with no changes (no revision increment, no broadcast)

### Requirement: SSE endpoint for real-time cookie push
The proxy SHALL expose `GET /__proxy_admin__/session/events` as a Server-Sent Events endpoint. The endpoint SHALL require Bearer token via `Authorization` header or `token` query parameter. On connection, the server SHALL send an initial `snapshot` event containing the full current cookie state and revision. When cookies are updated, the server SHALL broadcast a `cookie-update` event to all connected clients, including `revision`, `cookies` map, `updatedBy`, and `source` fields. The server SHALL send a heartbeat comment (`:heartbeat`) every 30 seconds. Maximum concurrent SSE connections SHALL be 20.

#### Scenario: Client connects to SSE and receives snapshot
- **WHEN** Electron client opens SSE connection to `GET /__proxy_admin__/session/events?token=<ADMIN_SECRET>`
- **THEN** server SHALL immediately send `event: snapshot` with `data: { cookies: {...}, revision: N, updatedAt: "..." }`

#### Scenario: Cookie update broadcast
- **WHEN** cookies are updated by any source (auto-login, admin API, or reverse sync)
- **THEN** server SHALL send `event: cookie-update` with `data: { cookies: {...}, revision: N+1, source: "auto-login", updatedAt: "..." }` to all connected SSE clients

#### Scenario: Client receives update from self
- **WHEN** SSE client with ID `client-abc` receives a `cookie-update` event where `source` equals `client-abc`
- **THEN** client SHALL ignore the event (loop prevention)

#### Scenario: SSE heartbeat
- **WHEN** no cookie updates occur for 30 seconds
- **THEN** server SHALL send `:heartbeat\n\n` comment to keep connection alive

#### Scenario: Connection limit reached
- **WHEN** 21st client attempts SSE connection while 20 are active
- **THEN** server SHALL respond with HTTP 503

### Requirement: Electron client cookie sync from proxy
Electron client `syncCookiesFromProxy` SHALL fetch `GET /__proxy_admin__/session/status`, read `session.cookies` as `{name: value}` map, and inject each cookie into BrowserView session via `session.cookies.set()` with domain `.720yun.com` and path `/`. The client SHALL store the received `revision` and skip applying updates with revision less than or equal to the locally stored revision.

#### Scenario: Initial cookie sync on startup
- **WHEN** Electron client starts and calls `syncCookiesFromProxy`
- **THEN** client SHALL fetch cookies from proxy, inject all into BrowserView session with domain `.720yun.com`, and store the `revision` locally

#### Scenario: Stale update ignored
- **WHEN** client receives cookies with `revision: 5` but locally stored revision is already `5`
- **THEN** client SHALL skip cookie injection

### Requirement: Electron client reverse cookie sync
Electron client SHALL monitor the BrowserView session's `cookies` changed event. When cookies for domain `.720yun.com` change (cause `explicit` from Set-Cookie response), the client SHALL debounce for 2 seconds, then collect all `.720yun.com` cookies from the session and POST them to `/__proxy_admin__/session/sync-cookies` with the client's unique ID as `source`.

#### Scenario: 720yun sets new cookie via response
- **WHEN** 720yun responds with `Set-Cookie: new_cookie=abc; Domain=.720yun.com`
- **THEN** after 2-second debounce, client SHALL POST `{ cookies: {all current .720yun.com cookies}, source: "<clientId>" }` to proxy

#### Scenario: Cookie change from proxy sync (loop prevention)
- **WHEN** cookie change is triggered by `syncCookiesFromProxy` injection (not from 720yun response)
- **THEN** client SHALL NOT trigger reverse sync (the change cause will be `explicit` only for Set-Cookie, vs `overwrite` for programmatic set — client SHALL track an `isSyncing` flag to suppress reverse sync during proxy-initiated injection)

### Requirement: Electron client SSE connection
Electron client SHALL establish an SSE connection to `GET /__proxy_admin__/session/events` on startup. On receiving `cookie-update` events, the client SHALL compare `revision` against local revision, and if newer, inject the received cookies into BrowserView session (with `isSyncing` flag to suppress reverse sync). On SSE disconnection, the client SHALL reconnect after 3 seconds and perform a full `GET /session/status` fetch to resolve any missed events.

#### Scenario: Receive real-time cookie update
- **WHEN** SSE delivers `cookie-update` event with revision higher than local
- **THEN** client SHALL inject cookies into BrowserView session with `isSyncing=true` to prevent reverse sync loop

#### Scenario: SSE disconnection and recovery
- **WHEN** SSE connection drops
- **THEN** client SHALL reconnect after 3 seconds, fetch full session status, and apply if revision is newer

### Requirement: Remove Clash tunnel hard dependency
`start.js` SHALL NOT monkeypatch `https.globalAgent.createConnection` by default. When environment variable `USE_CLASH_PROXY=true` is set, the system SHALL apply the existing Clash tunnel logic. When `USE_CLASH_PROXY=true` but the Clash proxy at the configured address is unreachable, the system SHALL log an error and exit with code 1 (fail-closed).

#### Scenario: Default startup without Clash
- **WHEN** `USE_CLASH_PROXY` is not set or is `false`
- **THEN** the system SHALL start normally without HTTPS tunnel monkeypatch

#### Scenario: Clash enabled and available
- **WHEN** `USE_CLASH_PROXY=true` and Clash is reachable at `127.0.0.1:7897`
- **THEN** the system SHALL apply HTTPS tunnel monkeypatch and log "HTTPS proxy tunnel active"

#### Scenario: Clash enabled but unavailable
- **WHEN** `USE_CLASH_PROXY=true` but Clash is not reachable
- **THEN** the system SHALL log error and exit with code 1

### Requirement: Externalize secrets
`ADMIN_SECRET` and `CLIENT_TOKEN` SHALL be read exclusively from environment variables. If `ADMIN_SECRET` is not set, the server SHALL refuse to start and log: "ADMIN_SECRET environment variable is required". `CLIENT_TOKEN` SHALL default to empty string (effectively disabling client token auth if not set, allowing admin-only access).

#### Scenario: Missing ADMIN_SECRET
- **WHEN** server starts without `ADMIN_SECRET` environment variable
- **THEN** server SHALL log error "ADMIN_SECRET environment variable is required" and exit with code 1

#### Scenario: All secrets configured
- **WHEN** server starts with `ADMIN_SECRET=my-secret` and `CLIENT_TOKEN=my-token`
- **THEN** admin API SHALL accept Bearer `my-secret` and proxy client auth SHALL accept `my-token`

### Requirement: Remove auto-screenshot
Electron client SHALL NOT capture screenshots on page load. The `did-finish-load` handler that calls `capturePage()` and writes PNG files SHALL be removed.

#### Scenario: Page loads without screenshot
- **WHEN** BrowserView successfully loads a page
- **THEN** no screenshot file SHALL be created

### Requirement: Property-based testing invariants
The following invariants SHALL hold across all system states and SHALL be verified via property-based testing.

#### Scenario: Cookie map round-trip integrity
- **WHEN** any cookie map `C` is serialized via `getCookieString(C)` and parsed back
- **THEN** the result SHALL equal `C` (order-independent map equality), including edge cases: empty values, unicode names, `=` in values, whitespace

#### Scenario: Revision monotonicity
- **WHEN** any sequence of cookie mutations is applied (from any combination of sources: admin API, auto-login, reverse sync)
- **THEN** `revision` SHALL never decrease, and SHALL increment by exactly 1 per mutation operation (no double increments, no skips)

#### Scenario: Merge commutativity for disjoint keys
- **WHEN** two patches `A` and `B` with disjoint key sets are applied to the same cookie state `C`
- **THEN** `apply(apply(C, A), B)` SHALL equal `apply(apply(C, B), A)` (key values identical, revision differs only by application order)

#### Scenario: Merge idempotency on cookie state
- **WHEN** the same patch `P` is applied twice to cookie state `C`
- **THEN** the resulting `cookies` map SHALL be identical after both applications (revision increments are expected but cookie values SHALL stabilize after first application)

#### Scenario: SSE fanout correctness
- **WHEN** a cookie update with `source=S` is broadcast
- **THEN** every connected SSE client with ID != S SHALL receive the event exactly once, and client with ID == S SHALL receive zero events for that update

#### Scenario: Staleness convergence under reordering
- **WHEN** a set of SSE events is delivered to a client in arbitrary order (including duplicates and out-of-order)
- **THEN** the client's final cookie state SHALL be identical to applying only the highest-revision event (all stale events with revision <= localRevision are no-ops)

#### Scenario: Loop prevention completeness
- **WHEN** `isSyncing=true` is set during proxy-initiated cookie injection
- **THEN** zero reverse sync POST requests SHALL be emitted until `isSyncing` is cleared, regardless of how many cookie-changed events fire during injection

#### Scenario: SSE connection bound
- **WHEN** N simultaneous SSE connections are attempted where N > 20
- **THEN** exactly 20 connections SHALL be active and all excess connections SHALL receive HTTP 503
