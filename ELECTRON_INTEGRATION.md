# Electron 客户端集成指南 - 共享会话代理

## 架构概览

```
┌─────────────────┐     ┌─────────────────────────┐     ┌──────────────┐
│  Electron App A │────►│                         │     │              │
│  (用户: 张三)    │     │   Central Proxy Server  │────►│ Target Website│
│                 │     │   (http://proxy:7890)   │     │              │
├─────────────────┤     │                         │     │              │
│  Electron App B │────►│  · 持有共享Cookie/Token  │◄────│  Set-Cookie  │
│  (用户: 李四)    │     │  · 自动注入认证信息      │     │              │
│                 │     │  · 记录用户操作日志      │     │              │
├─────────────────┤     │  · 自动更新Cookie       │     │              │
│  Electron App C │────►│                         │     │              │
│  (用户: 王五)    │     └─────────────────────────┘     └──────────────┘
└─────────────────┘
```

## 核心思路

Electron 客户端不直接访问目标网站，而是将所有请求发给中央代理。代理自动注入共享的 Cookie/Token，目标网站只看到一个会话，不会踢人。

## 集成步骤

### 1. 配置代理地址

在 Electron 主进程的配置中添加代理服务器地址：

```javascript
// config.js 或 settings
const PROXY_CONFIG = {
  // 中央代理地址
  proxyBaseUrl: 'http://your-proxy-server:7890',
  // 客户端访问令牌（与代理服务端配置一致）
  clientToken: 'shared-proxy-token-2024',
};
```

### 2. 方案 A：使用 session.setProxy（推荐，最简单）

在 BrowserWindow 的 session 中设置代理，所有网络请求自动走代理：

```javascript
const { BrowserWindow, session } = require('electron');

async function createProxiedWindow(userId, userName) {
  // 创建独立 session（避免干扰其他窗口）
  const partition = `proxy-session-${userId}`;
  const ses = session.fromPartition(partition);

  // 设置代理
  await ses.setProxy({
    proxyRules: `http=your-proxy-server:7890;https=your-proxy-server:7890`,
  });

  // 拦截请求，注入用户身份 headers
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['x-proxy-user-id'] = userId;
    details.requestHeaders['x-proxy-user-name'] = userName;
    details.requestHeaders['x-proxy-token'] = PROXY_CONFIG.clientToken;
    callback({ requestHeaders: details.requestHeaders });
  });

  const win = new BrowserWindow({
    webPreferences: { session: ses },
  });

  // 直接加载目标网站 URL（代理会转发）
  win.loadURL('https://target-website.com/dashboard');
}
```

### 3. 方案 B：使用 fetch/axios 拦截（适合 SPA 场景）

如果你的 Electron 应用内嵌了前端页面，可以在 preload 脚本中拦截所有网络请求：

```javascript
// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('proxyFetch', async (url, options = {}) => {
  // 将目标 URL 转换为代理 URL
  const proxyUrl = url.replace(
    'https://target-website.com',
    'http://your-proxy-server:7890'
  );

  const headers = {
    ...options.headers,
    'x-proxy-user-id': await ipcRenderer.invoke('get-user-id'),
    'x-proxy-user-name': await ipcRenderer.invoke('get-user-name'),
    'x-proxy-token': 'shared-proxy-token-2024',
  };

  return fetch(proxyUrl, { ...options, headers });
});
```

### 4. 方案 C：直接替换 baseURL（适合 API 调用场景）

如果你的应用主要通过 API 与目标网站交互：

```javascript
// api-client.js
const axios = require('axios');

function createProxiedApiClient(userId, userName) {
  const client = axios.create({
    // 指向代理而非目标网站
    baseURL: 'http://your-proxy-server:7890',
    headers: {
      'x-proxy-user-id': userId,
      'x-proxy-user-name': userName,
      'x-proxy-token': 'shared-proxy-token-2024',
    },
  });

  // 响应拦截 - 处理代理错误
  client.interceptors.response.use(
    (res) => res,
    (err) => {
      if (err.response?.status === 403) {
        console.error('代理认证失败，请检查 token');
      } else if (err.response?.status === 502) {
        console.error('代理无法连接目标网站');
      }
      return Promise.reject(err);
    }
  );

  return client;
}

// 使用
const api = createProxiedApiClient('user123', '张三');
api.get('/api/projects').then(res => console.log(res.data));
```

## 首次配置会话

代理启动后，需要先设置共享的 Cookie/Token：

### 方法 1：从浏览器 DevTools 复制 Cookie

1. 用浏览器正常登录目标网站
2. F12 → Application → Cookies，复制完整 cookie 字符串
3. 调用管理 API 设置：

```bash
curl -X POST http://your-proxy-server:7890/__proxy_admin__/session/raw-cookie \
  -H "Authorization: Bearer change-me-in-production" \
  -H "Content-Type: application/json" \
  -d '{"cookie": "session_id=abc123; token=xyz789; ..."}'
```

### 方法 2：设置 Authorization Header

如果网站用 Bearer Token 认证：

```bash
curl -X POST http://your-proxy-server:7890/__proxy_admin__/session/headers \
  -H "Authorization: Bearer change-me-in-production" \
  -H "Content-Type: application/json" \
  -d '{"headers": {"Authorization": "Bearer your-jwt-token-here"}}'
```

### 方法 3：在 Electron 中实现登录捕获

可以在 Electron 里开一个隐藏窗口让管理员登录，捕获 Cookie 后自动上传到代理：

```javascript
// login-capture.js (主进程)
async function captureLogin() {
  const loginWin = new BrowserWindow({ width: 800, height: 600 });
  loginWin.loadURL('https://target-website.com/login');

  // 监听登录成功后的 Cookie
  loginWin.webContents.session.cookies.on('changed', async (event, cookie) => {
    // 获取所有 Cookie
    const cookies = await loginWin.webContents.session.cookies.get({
      url: 'https://target-website.com'
    });

    const cookieObj = {};
    cookies.forEach(c => { cookieObj[c.name] = c.value; });

    // 上传到代理
    await fetch('http://your-proxy-server:7890/__proxy_admin__/session/cookies', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer change-me-in-production',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ cookies: cookieObj }),
    });

    console.log('Session captured and uploaded!');
    loginWin.close();
  });
}
```

## 管理 API 参考

所有管理 API 需要 `Authorization: Bearer <adminSecret>` header。

| 端点 | 方法 | 说明 |
|------|------|------|
| `/__proxy_admin__/health` | GET | 健康检查，查看运行状态 |
| `/__proxy_admin__/session/status` | GET | 查看当前会话状态 |
| `/__proxy_admin__/session/cookies` | POST | 更新 Cookies（合并） |
| `/__proxy_admin__/session/raw-cookie` | POST | 设置原始 Cookie 字符串 |
| `/__proxy_admin__/session/headers` | POST | 更新额外 Headers |
| `/__proxy_admin__/session` | DELETE | 清空会话 |
| `/__proxy_admin__/logs` | GET | 查询操作日志 |
| `/__proxy_admin__/logs/stats` | GET | 日志统计 |
| `/__proxy_admin__/logs/cleanup` | POST | 清理旧日志 |

### 日志查询参数

`GET /__proxy_admin__/logs?userId=xxx&startTime=2024-01-01&path=/api&limit=50`

## 注意事项

1. **Cookie 过期**：代理会自动捕获目标网站返回的 `Set-Cookie` 更新本地存储，但如果目标网站的会话完全过期（如超长时间不操作），需要重新登录并更新 Cookie。

2. **并发安全**：多个用户同时操作不会互相踢，因为对目标网站来说只有一个会话。但要注意业务层面的数据冲突（如两人同时编辑同一个资源）。

3. **安全建议**：
   - 修改默认的 `adminSecret` 和 `clientToken`
   - 代理服务仅对内网开放，不要暴露到公网
   - 定期清理日志中可能包含的敏感数据

4. **WebSocket**：代理支持 WebSocket 升级，如果目标网站使用 WS 实时通信也能正常工作。
