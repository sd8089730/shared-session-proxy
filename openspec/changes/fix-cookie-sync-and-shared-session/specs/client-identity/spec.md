## ADDED Requirements

### Requirement: Persist user name to local file
Electron client SHALL persist the user-entered username to a local JSON file at `<userData>/720yun-client-config.json` (where `<userData>` is Electron's `app.getPath('userData')`). The file schema SHALL be: `{ userName: string }`. On startup, the client SHALL read this file and use the stored `userName`. If the file does not exist, the client SHALL generate a default name `User-<first 6 chars of UUID>`. When the user changes the username via the toolbar input, the client SHALL immediately persist the new name.

#### Scenario: First launch with no config file
- **WHEN** Electron client starts and `720yun-client-config.json` does not exist
- **THEN** client SHALL generate `User-<6chars>` as default name, display it in the toolbar input, and persist to the config file

#### Scenario: Subsequent launch with existing config
- **WHEN** Electron client starts and `720yun-client-config.json` contains `{ "userName": "Alice" }`
- **THEN** client SHALL use "Alice" as the username in toolbar input and `x-proxy-user-name` header

#### Scenario: User changes name
- **WHEN** user changes the username input field to "Bob" and the field loses focus (change event)
- **THEN** client SHALL immediately write `{ "userName": "Bob" }` to the config file and update `x-proxy-user-name` header for subsequent requests

### Requirement: Stable client identity for session lifecycle
Electron client SHALL generate a unique `clientId` (UUID v4) on first launch and persist it in the same `720yun-client-config.json` file as `{ userName: string, clientId: string }`. This `clientId` SHALL be used as the `source` field in reverse cookie sync and for SSE loop prevention. The `clientId` SHALL remain stable across app restarts.

#### Scenario: First launch generates clientId
- **WHEN** Electron client starts and config file has no `clientId` field
- **THEN** client SHALL generate a UUID v4, persist it to config file, and use it as `source` in API calls

#### Scenario: Restart preserves clientId
- **WHEN** Electron client restarts and config file contains `{ "clientId": "abc-123-..." }`
- **THEN** client SHALL use the same `clientId` without regenerating
