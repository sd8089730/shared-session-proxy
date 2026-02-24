const { app, BrowserWindow, BrowserView, session, ipcMain } = require('electron');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

const ipv4Agent = new http.Agent({ family: 4 });
const ADMIN_SECRET = 'yunnto2wsxzaq!';

app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('proxy-bypass-list', '<local>');

let mainWindow;
const TOOLBAR_HEIGHT = 44;
const STATUSBAR_HEIGHT = 24;

// 多站点状态
let sitesList = [];
const viewPool = new Map(); // siteId → { view, viewSession, lastAccessed }
let activeSiteId = null;
const MAX_CACHED_VIEWS = 5;

// 每站点同步状态
const syncStates = new Map();

function getSyncState(siteId) {
  if (!syncStates.has(siteId)) {
    syncStates.set(siteId, { revision: 0, isSyncing: false, debounceTimer: null, cookieMap: {}, headers: {}, headerPushTimer: null, injectedAwaitingAuth: false, localStorageMap: {} });
  }
  return syncStates.get(siteId);
}

// ============ Logger ============

let logPath = '';
let logStream = null;

function initLogger() {
  logPath = path.join(app.getPath('userData'), 'shared-proxy-client.log');
  try {
    logStream = fs.createWriteStream(logPath, { flags: 'w' });
    logStream.write(`=== Shared Session Client Started ${new Date().toISOString()} ===\n`);
  } catch (_) {}
}

function log(tag, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  const msg = `${ts} [${tag}] ${args.join(' ')}`;
  console.log(`[${tag}]`, ...args);
  if (logStream) try { logStream.write(msg + '\n'); } catch (_) {}
}

// ============ Config ============

let clientConfig = { userName: '', clientId: '', proxyUrl: 'http://127.0.0.1:7890' };
let configPath = '';

function getProxyUrl() { return clientConfig.proxyUrl; }

function loadClientConfig() {
  configPath = path.join(app.getPath('userData'), 'shared-proxy-config.json');
  // 迁移旧配置文件
  const oldPath = path.join(app.getPath('userData'), '720yun-client-config.json');
  if (!fs.existsSync(configPath) && fs.existsSync(oldPath)) {
    try { fs.renameSync(oldPath, configPath); } catch (_) {}
  }
  try {
    if (fs.existsSync(configPath)) {
      clientConfig = { ...clientConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf-8')) };
    }
  } catch (e) { log('Config', 'Load failed:', e.message); }
  if (!clientConfig.clientId) clientConfig.clientId = crypto.randomUUID();
  if (!clientConfig.userName) clientConfig.userName = 'User-' + clientConfig.clientId.slice(0, 6);
  if (!clientConfig.proxyUrl) clientConfig.proxyUrl = 'http://127.0.0.1:7890';
  saveClientConfig();
  log('Config', `proxyUrl=${clientConfig.proxyUrl} clientId=${clientConfig.clientId}`);
}

function saveClientConfig() {
  try { fs.writeFileSync(configPath, JSON.stringify(clientConfig, null, 2)); } catch (_) {}
}

// ============ Proxy API ============

function proxyRequest(method, apiPath, body) {
  return new Promise((resolve) => {
    const url = new URL(`${getProxyUrl()}/__proxy_admin__${apiPath}`);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(url, {
      method,
      agent: ipv4Agent,
      headers: {
        'Authorization': `Bearer ${ADMIN_SECRET}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, ...JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, raw: data }); }
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchSites() {
  const result = await proxyRequest('GET', '/sites');
  if (result.sites) {
    sitesList = result.sites;
    log('Sites', `Loaded ${sitesList.length} sites`);
  }
  return sitesList;
}

function getSite(siteId) { return sitesList.find(s => s.siteId === siteId); }

// ============ Cookie helpers ============

async function injectCookiesToSession(viewSession, cookies, domain) {
  let ok = 0, fail = 0;
  for (const [name, info] of Object.entries(cookies)) {
    try {
      const d = info.domain || domain;
      const h = d.replace(/^\./, '');
      await viewSession.cookies.set({
        url: `https://${h}${info.path || '/'}`,
        name,
        value: (info && typeof info === 'object') ? info.value : String(info),
        domain: d,
        path: info.path || '/',
        secure: !!info.secure,
        httpOnly: !!info.httpOnly,
        sameSite: ['strict', 'lax', 'no_restriction'].includes(info.sameSite) ? info.sameSite : 'unspecified',
        ...(info.expirationDate ? { expirationDate: info.expirationDate } : {}),
      });
      ok++;
    } catch (e) {
      log('CookieSet', `FAIL ${name}: ${e.message}`);
      fail++;
    }
  }
  return { ok, fail };
}

function collectCookiesForSite(allCookies, domains) {
  const map = {};
  for (const c of allCookies) {
    const match = domains.some(d => {
      if (d.startsWith('.')) return c.domain.endsWith(d) || c.domain === d.slice(1);
      return c.domain === d;
    });
    if (!match) continue;
    map[c.name] = {
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite || 'unspecified',
      ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}),
    };
  }
  return map;
}

// ============ Per-site sync ============

const LS_KEEP_PREFIXES = ['720yun_', '720_', 'TDC_', 'qiye', 'mp_uuid'];

function filterLocalStorage(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const result = {};
  for (const [k, v] of Object.entries(raw)) {
    if (LS_KEEP_PREFIXES.some(p => k.startsWith(p))) result[k] = v;
  }
  return result;
}

async function collectLocalStorage(webContents) {
  try {
    const json = await webContents.executeJavaScript('JSON.stringify(localStorage)');
    return filterLocalStorage(JSON.parse(json));
  } catch (_) { return {}; }
}

async function syncCookiesFromProxy(siteId) {
  const result = await proxyRequest('GET', `/session/status?siteId=${siteId}`);
  const state = getSyncState(siteId);
  if (result.session?.cookies) {
    state.cookieMap = result.session.cookies;
    state.headers = result.session.headers || {};
    state.localStorageMap = result.session.localStorage || {};
    state.revision = result.session.revision || 0;
    log('Sync', `[${siteId}] Pull rev:${state.revision}, ${Object.keys(state.cookieMap).length} cookies, ${Object.keys(state.localStorageMap).length} localStorage`);
    for (const [name, info] of Object.entries(state.cookieMap)) {
      log('Sync', `  ${name}: domain=${info.domain} path=${info.path} secure=${info.secure} httpOnly=${info.httpOnly} sameSite=${info.sameSite} hasExpiry=${!!info.expirationDate}`);
    }
  }
  return state;
}

function pushCookiesToProxy(siteId, cookieMap, lsData) {
  const state = getSyncState(siteId);
  const body = { cookies: cookieMap, source: clientConfig.clientId, siteId };
  if (lsData && Object.keys(lsData).length > 0) body.localStorage = lsData;
  const payload = JSON.stringify(body);
  const url = new URL(`${getProxyUrl()}/__proxy_admin__/session/sync-cookies`);
  const req = http.request(url, {
    method: 'POST', agent: ipv4Agent,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ADMIN_SECRET}`, 'Content-Length': Buffer.byteLength(payload) },
  }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      try {
        const json = JSON.parse(body);
        if (json.session?.revision) state.revision = json.session.revision;
        log('Sync', `[${siteId}] Push OK rev=${json.session?.revision}`);
      } catch (_) {}
    });
  });
  req.on('error', (e) => log('Sync', `[${siteId}] Push FAILED: ${e.message}`));
  req.write(payload);
  req.end();
}

function pushHeadersToProxy(siteId, headers) {
  const payload = JSON.stringify({ headers, siteId });
  const url = new URL(`${getProxyUrl()}/__proxy_admin__/session/headers`);
  const req = http.request(url, {
    method: 'POST', agent: ipv4Agent,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ADMIN_SECRET}`, 'Content-Length': Buffer.byteLength(payload) },
  }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => log('Sync', `[${siteId}] Header push: ${res.statusCode}`));
  });
  req.on('error', (e) => log('Sync', `[${siteId}] Header push FAILED: ${e.message}`));
  req.write(payload);
  req.end();
}

// ============ BrowserView 管理 ============

function createSiteView(site) {
  const siteId = site.siteId;
  const viewSession = session.fromPartition(`persist:${siteId}-${clientConfig.clientId}`);
  const view = new BrowserView({
    webPreferences: { session: viewSession, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'site-preload.js') },
  });

  const state = getSyncState(siteId);

  // 注入 X-Proxy-Site 头 + cookie 合并 + header 捕获/注入
  viewSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    headers['X-Proxy-Site'] = siteId;

    // Cookie 合并（补充 proxy 中的共享 cookies）
    if (Object.keys(state.cookieMap).length > 0) {
      const existing = headers['Cookie'] || '';
      const parsed = {};
      if (existing) {
        for (const part of existing.split(';')) {
          const t = part.trim();
          const eq = t.indexOf('=');
          if (eq > 0) parsed[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
        }
      }
      for (const [name, info] of Object.entries(state.cookieMap)) {
        if (!parsed[name]) parsed[name] = (info && typeof info === 'object') ? info.value : info;
      }
      headers['Cookie'] = Object.entries(parsed).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    // 注入 proxy 端存储的共享 headers
    if (state.headers) {
      for (const [key, value] of Object.entries(state.headers)) {
        if (!headers[key]) headers[key] = value;
      }
    }

    // 捕获站点配置中的 customHeaders
    if (site.customHeaders?.length > 0) {
      for (const hName of site.customHeaders) {
        const val = headers[hName] ?? null;
        if (val && val.length > 0 && state.headers[hName] !== val) {
          state.headers[hName] = val;
          clearTimeout(state.headerPushTimer);
          state.headerPushTimer = setTimeout(() => pushHeadersToProxy(siteId, { [hName]: val }), 1000);
        }
      }
    }

    callback({ requestHeaders: headers });
  });

  // Cookie 变更监听（按站点 domains 过滤）
  viewSession.cookies.on('changed', (_e, cookie) => {
    if (state.isSyncing) return;
    const domains = site.domains || [];
    const match = domains.some(d => {
      if (d.startsWith('.')) return cookie.domain.endsWith(d) || cookie.domain === d.slice(1);
      return cookie.domain === d;
    });
    if (!match) return;
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(async () => {
      try {
        // 注入的 cookie 尚未通过认证，不推送（防止覆盖有效 cookie）
        if (state.injectedAwaitingAuth) {
          log('CookieMonitor', `[${siteId}] Skip push: injected cookies awaiting auth`);
          return;
        }
        const all = await viewSession.cookies.get({});
        const map = collectCookiesForSite(all, domains);
        if (Object.keys(map).length > 0) {
          log('CookieMonitor', `[${siteId}] Pushing ${Object.keys(map).length} cookies`);
          for (const [name, info] of Object.entries(map)) {
            log('CookieMonitor', `  ${name}: domain=${info.domain} sameSite=${info.sameSite} secure=${info.secure} val=${info.value.slice(0, 12)}...`);
          }
          const lsData = await collectLocalStorage(view.webContents);
          pushCookiesToProxy(siteId, map, lsData);
        }
      } catch (e) {
        log('CookieMonitor', `[${siteId}] Error: ${e.message}`);
      }
    }, 2000);
  });

  // 导航事件
  const sendUrlChanged = (url) => {
    if (activeSiteId === siteId && mainWindow) mainWindow.webContents.send('url-changed', url);
  };
  view.webContents.on('did-navigate', (_e, url) => {
    log('Nav', `[${siteId}] ${url}`);
    sendUrlChanged(url);
    // 注入 cookie 后的认证确认（延迟检测，因为 720yun 等站点用 JS 校验后重定向）
    if (state.injectedAwaitingAuth) {
      clearTimeout(state._authConfirmTimer);
      if (/\/login\b/.test(url)) {
        // 被重定向到登录页 → 认证失败，保持 injectedAwaitingAuth
        log('Sync', `[${siteId}] Injected cookies auth failed (redirected to login)`);
      } else {
        // 非登录页，延迟 5 秒确认（等 JS 校验完成）
        state._authConfirmTimer = setTimeout(async () => {
          const currentUrl = view.webContents.getURL();
          if (/\/login\b/.test(currentUrl)) {
            log('Sync', `[${siteId}] Injected cookies auth failed (JS redirect to login)`);
            return;
          }
          state.injectedAwaitingAuth = false;
          log('Sync', `[${siteId}] Auth confirmed after injection, pushing cookies`);
          try {
            const all = await viewSession.cookies.get({});
            const map = collectCookiesForSite(all, site.domains || []);
            if (Object.keys(map).length > 0) {
              const lsData = await collectLocalStorage(view.webContents);
              pushCookiesToProxy(siteId, map, lsData);
            }
          } catch (_) {}
        }, 5000);
      }
    }
  });
  view.webContents.on('did-navigate-in-page', (_e, url) => sendUrlChanged(url));
  view.webContents.on('did-start-loading', () => { if (activeSiteId === siteId) mainWindow?.webContents.send('loading', true); });
  view.webContents.on('did-stop-loading', () => {
    if (activeSiteId === siteId) mainWindow?.webContents.send('loading', false);
  });
  view.webContents.setWindowOpenHandler(({ url }) => { view.webContents.loadURL(url); return { action: 'deny' }; });

  // 加载失败重试
  let retryCount = 0;
  view.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log('LoadError', `[${siteId}] ${code} ${desc} - ${url}`);
    if (retryCount < 2 && (code === -102 || code === -106)) {
      retryCount++;
      setTimeout(() => view.webContents.loadURL(site.targetUrl + (site.startPage || '/')), 3000);
    }
  });
  view.webContents.on('did-finish-load', () => { retryCount = 0; });

  viewPool.set(siteId, { view, viewSession, lastAccessed: Date.now() });
  return view;
}

function resizeActiveView() {
  if (!mainWindow || !activeSiteId) return;
  const entry = viewPool.get(activeSiteId);
  if (!entry) return;
  const [w, h] = mainWindow.getContentSize();
  entry.view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: w, height: h - TOOLBAR_HEIGHT - STATUSBAR_HEIGHT });
}

async function openSite(siteId) {
  const site = getSite(siteId);
  if (!site) { log('OpenSite', `Site not found: ${siteId}`); return; }

  // 隐藏当前活跃的 BrowserView
  if (activeSiteId && viewPool.has(activeSiteId)) {
    mainWindow.removeBrowserView(viewPool.get(activeSiteId).view);
  }

  let entry = viewPool.get(siteId);
  if (!entry) {
    // LRU 淘汰
    if (viewPool.size >= MAX_CACHED_VIEWS) evictOldestView(siteId);

    // 从 proxy 同步 cookies
    await syncCookiesFromProxy(siteId);
    const state = getSyncState(siteId);

    createSiteView(site);
    entry = viewPool.get(siteId);

    // 注入前清除旧 cookie（persist 分区可能残留上次运行的 cookie）
    if (Object.keys(state.cookieMap).length > 0) {
      const domain = site.domains?.[0] || '.unknown.com';
      state.isSyncing = true;
      try {
        const oldCookies = await entry.viewSession.cookies.get({});
        const siteDomains = site.domains || [];
        for (const c of oldCookies) {
          const match = siteDomains.some(d => {
            if (d.startsWith('.')) return c.domain.endsWith(d) || c.domain === d.slice(1);
            return c.domain === d;
          });
          if (match) {
            const url = `http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
            await entry.viewSession.cookies.remove(url, c.name).catch(() => {});
          }
        }
        log('Sync', `[${siteId}] Cleared old cookies before injection`);
      } catch (e) {
        log('Sync', `[${siteId}] Clear old cookies error: ${e.message}`);
      }
      await injectCookiesToSession(entry.viewSession, state.cookieMap, domain);
      state.injectedAwaitingAuth = true;
      setTimeout(() => { state.isSyncing = false; }, 3000);
    }

    entry.view.webContents.loadURL(site.targetUrl + (site.startPage || '/'));
  } else {
    entry.lastAccessed = Date.now();
  }

  activeSiteId = siteId;
  mainWindow.addBrowserView(entry.view);
  resizeActiveView();
  mainWindow.webContents.send('view-changed', { type: 'site', siteId });
}

function goHome() {
  if (activeSiteId && viewPool.has(activeSiteId)) {
    mainWindow.removeBrowserView(viewPool.get(activeSiteId).view);
  }
  activeSiteId = null;
  mainWindow.webContents.send('view-changed', { type: 'home' });
}

function closeSiteView(siteId) {
  const entry = viewPool.get(siteId);
  if (!entry) return;

  if (activeSiteId === siteId) {
    mainWindow.removeBrowserView(entry.view);
    activeSiteId = null;
    mainWindow.webContents.send('view-changed', { type: 'home' });
  }

  entry.view.webContents.close();
  entry.viewSession.clearStorageData().catch(() => {});
  viewPool.delete(siteId);
  mainWindow.webContents.send('view-changed', { type: 'closed', siteId });
}

function evictOldestView(excludeSiteId) {
  let oldest = null, oldestTime = Infinity;
  for (const [id, entry] of viewPool) {
    if (id === excludeSiteId || id === activeSiteId) continue;
    if (entry.lastAccessed < oldestTime) { oldest = id; oldestTime = entry.lastAccessed; }
  }
  if (oldest) {
    log('ViewPool', `Evicting ${oldest} (LRU)`);
    closeSiteView(oldest);
  }
}

// ============ SSE ============

let sseReq = null;

function connectSSE() {
  if (sseReq) { try { sseReq.destroy(); } catch (_) {} sseReq = null; }
  const url = `${getProxyUrl()}/__proxy_admin__/session/events?token=${encodeURIComponent(ADMIN_SECRET)}&clientId=${encodeURIComponent(clientConfig.clientId)}`;
  log('SSE', `Connecting to ${getProxyUrl()}`);

  sseReq = http.get(url, { agent: new http.Agent({ family: 4, keepAlive: true }) }, (res) => {
    if (res.statusCode !== 200) {
      log('SSE', `Status ${res.statusCode}, retry in 10s`);
      setTimeout(connectSSE, 10000);
      return;
    }
    log('SSE', 'Connected');
    let buf = '';

    res.on('data', (chunk) => {
      buf += chunk.toString();
      const blocks = buf.split('\n\n');
      buf = blocks.pop();
      for (const block of blocks) {
        if (!block.trim() || block.trim().startsWith(':')) continue;
        let eventType = '', dataStr = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) eventType = line.slice(7).trim();
          else if (line.startsWith('data: ')) dataStr += line.slice(6);
          else if (line.startsWith('data:')) dataStr += line.slice(5);
        }
        if (!dataStr) continue;
        try { handleSSEMessage(eventType, JSON.parse(dataStr)); }
        catch (e) { log('SSE', `Parse error: ${e.message}`); }
      }
    });

    res.on('end', () => { log('SSE', 'Disconnected, reconnect in 5s'); setTimeout(connectSSE, 5000); });
  });

  sseReq.on('error', (e) => { log('SSE', `Error: ${e.message}`); setTimeout(connectSSE, 5000); });
}

function handleSSEMessage(eventType, msg) {
  // 站点变更事件 → 刷新站点列表
  if (eventType === 'site-added' || eventType === 'site-updated' || eventType === 'site-removed') {
    fetchSites().then(sites => { if (mainWindow) mainWindow.webContents.send('sites-updated', sites); });
    if (eventType === 'site-removed' && msg.siteId) closeSiteView(msg.siteId);
    return;
  }

  // 初始快照
  if (eventType === 'snapshot') {
    if (msg.sites) {
      sitesList = msg.sites;
      if (mainWindow) mainWindow.webContents.send('sites-updated', sitesList);
    }
    return;
  }

  // Cookie 更新（按 siteId 路由）
  if (eventType === 'cookie-update') {
    if (msg.source === clientConfig.clientId) return;
    const siteId = msg.siteId;
    if (!siteId) return;

    const state = getSyncState(siteId);
    const rev = msg.revision ?? 0;
    if (rev <= state.revision) return;

    state.revision = rev;
    const cookies = msg.cookies || {};
    const ls = msg.localStorage || {};
    if (Object.keys(cookies).length > 0) state.cookieMap = cookies;
    if (Object.keys(ls).length > 0) state.localStorageMap = { ...state.localStorageMap, ...ls };
    log('SSE', `[${siteId}] cookie-update rev:${rev} (${Object.keys(cookies).length} cookies, ${Object.keys(ls).length} localStorage)`);

    // 注入到活跃的 BrowserView
    const entry = viewPool.get(siteId);
    if (entry && Object.keys(cookies).length > 0) {
      const site = getSite(siteId);
      const domain = site?.domains?.[0] || '.unknown.com';
      state.isSyncing = true;
      injectCookiesToSession(entry.viewSession, cookies, domain)
        .then((r) => {
          log('SSE', `[${siteId}] Injected: ${r.ok} ok, ${r.fail} fail`);
          setTimeout(() => { state.isSyncing = false; }, 3000);
        })
        .catch(() => { setTimeout(() => { state.isSyncing = false; }, 3000); });
    }
    // 注入 localStorage 到活跃的 BrowserView
    if (entry && Object.keys(ls).length > 0) {
      const script = `(function(){var d=${JSON.stringify(ls)};for(var k in d){try{localStorage.setItem(k,d[k])}catch(_){}}})()`;
      entry.view.webContents.executeJavaScript(script)
        .then(() => log('SSE', `[${siteId}] localStorage injected (${Object.keys(ls).length} keys)`))
        .catch(() => {});
    }
  }
}

// ============ Main window ============

function createWindow() {
  initLogger();
  loadClientConfig();

  mainWindow = new BrowserWindow({
    width: 1280, height: 900,
    title: '共享会话浏览器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('resize', resizeActiveView);

  fetchSites().then(() => connectSSE());
}

// ============ IPC ============

ipcMain.handle('get-config', () => ({
  proxyUrl: getProxyUrl(),
  userId: clientConfig.clientId,
  userName: clientConfig.userName,
  logPath,
}));

ipcMain.on('set-username', (_e, name) => {
  if (name) { clientConfig.userName = name; saveClientConfig(); }
});

ipcMain.on('set-proxy-url', (_e, url) => {
  if (url) {
    clientConfig.proxyUrl = url.replace(/\/+$/, '');
    saveClientConfig();
    log('Config', `Proxy URL changed to: ${clientConfig.proxyUrl}`);
  }
});

ipcMain.on('reconnect', () => {
  log('IPC', 'Reconnect requested');
  if (sseReq) { try { sseReq.destroy(); } catch (_) {} sseReq = null; }
  fetchSites().then(sites => {
    if (mainWindow) mainWindow.webContents.send('sites-updated', sites);
    connectSSE();
  });
});

ipcMain.on('navigate', (_e, url) => {
  if (!activeSiteId) return;
  const entry = viewPool.get(activeSiteId);
  if (!entry) return;
  const site = getSite(activeSiteId);
  if (!/^https?:\/\//i.test(url) && site) {
    url = site.targetUrl + (url.startsWith('/') ? '' : '/') + url;
  }
  entry.view.webContents.loadURL(url);
});

ipcMain.on('go-back', () => {
  const entry = activeSiteId && viewPool.get(activeSiteId);
  if (entry?.view.webContents.canGoBack()) entry.view.webContents.goBack();
});

ipcMain.on('go-forward', () => {
  const entry = activeSiteId && viewPool.get(activeSiteId);
  if (entry?.view.webContents.canGoForward()) entry.view.webContents.goForward();
});

ipcMain.on('reload', () => {
  const entry = activeSiteId && viewPool.get(activeSiteId);
  if (entry) entry.view.webContents.reload();
});

// 多站点管理
ipcMain.handle('get-sites', () => fetchSites());

ipcMain.handle('add-site', async (_e, { name, targetUrl }) => {
  const result = await proxyRequest('POST', '/sites', { name, targetUrl });
  if (result.ok) await fetchSites();
  return result;
});

ipcMain.handle('remove-site', async (_e, siteId) => {
  const result = await proxyRequest('DELETE', `/sites/${siteId}`);
  if (result.ok) {
    closeSiteView(siteId);
    await fetchSites();
  }
  return result;
});

ipcMain.on('open-site', (_e, siteId) => openSite(siteId));
ipcMain.on('go-home', () => goHome());
ipcMain.on('close-site-view', (_e, siteId) => closeSiteView(siteId));

// site-preload.js 通过 sendSync 获取 localStorage 数据
ipcMain.on('get-site-localStorage', (e) => {
  for (const [siteId, entry] of viewPool) {
    if (entry.view.webContents === e.sender) {
      e.returnValue = getSyncState(siteId).localStorageMap || {};
      return;
    }
  }
  e.returnValue = {};
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
