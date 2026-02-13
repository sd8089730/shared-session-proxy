const { app, BrowserWindow, BrowserView, session, ipcMain } = require('electron');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const fs = require('fs');

const ipv4Agent = new http.Agent({ family: 4 });

// --- Config ---
const ADMIN_SECRET = 'yunnto2wsxzaq!';
const TARGET_URL = 'https://www.720yun.com';
const START_URL = 'https://www.720yun.com/my/720vr/tour';

app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('proxy-bypass-list', '<local>');

let mainWindow, contentView;
const TOOLBAR_HEIGHT = 44;
const STATUSBAR_HEIGHT = 24;

// --- File logger ---
let logPath = '';
let logStream = null;

function initLogger() {
  logPath = path.join(app.getPath('userData'), '720yun-client.log');
  try {
    logStream = fs.createWriteStream(logPath, { flags: 'w' });
    logStream.write(`=== 720yun Client Started ${new Date().toISOString()} ===\n`);
  } catch (_) {}
}

function log(tag, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  const msg = `${ts} [${tag}] ${args.join(' ')}`;
  console.log(`[${tag}]`, ...args);
  if (logStream) try { logStream.write(msg + '\n'); } catch (_) {}
}

// --- Client config persistence ---
let clientConfig = { userName: '', clientId: '', proxyUrl: 'http://127.0.0.1:7890' };
let configPath = '';

function getProxyUrl() { return clientConfig.proxyUrl; }

function loadClientConfig() {
  configPath = path.join(app.getPath('userData'), '720yun-client-config.json');
  try {
    if (fs.existsSync(configPath)) {
      clientConfig = { ...clientConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf-8')) };
    }
  } catch (e) {
    log('Config', 'Load failed:', e.message);
  }
  if (!clientConfig.clientId) clientConfig.clientId = crypto.randomUUID();
  if (!clientConfig.userName) clientConfig.userName = 'User-' + clientConfig.clientId.slice(0, 6);
  if (!clientConfig.proxyUrl) clientConfig.proxyUrl = 'http://127.0.0.1:7890';
  saveClientConfig();
  log('Config', `proxyUrl=${clientConfig.proxyUrl} clientId=${clientConfig.clientId}`);
  log('Config', `logFile=${logPath}`);
  log('Config', `configFile=${configPath}`);
}

function saveClientConfig() {
  try { fs.writeFileSync(configPath, JSON.stringify(clientConfig, null, 2)); } catch (_) {}
}

// --- Cookie & auth header helpers ---
let sharedCookieMap = {};
let sharedHeaders = {};  // e.g. { 'App-Authorization': 'Bearer xxx' }
let localRevision = 0;
let isSyncing = false;
let debounceTimer = null;
let headerPushTimer = null;

function buildCookieString(cookies) {
  return Object.entries(cookies).map(([k, v]) => {
    const val = (v && typeof v === 'object') ? v.value : v;
    return `${k}=${val}`;
  }).join('; ');
}

async function injectCookiesToStore(viewSession, cookies) {
  let ok = 0, fail = 0;
  for (const [name, info] of Object.entries(cookies)) {
    try {
      const domain = info.domain || '.720yun.com';
      const host = domain.replace(/^\./, '');
      const details = {
        url: `https://${host}${info.path || '/'}`,
        name,
        value: info.value,
        domain,
        path: info.path || '/',
        secure: !!info.secure,
        httpOnly: !!info.httpOnly,
        sameSite: info.sameSite === 'strict' ? 'strict' : 'lax',
      };
      if (info.expirationDate) details.expirationDate = info.expirationDate;
      await viewSession.cookies.set(details);
      ok++;
    } catch (e) {
      log('CookieSet', `FAIL ${name}: ${e.message}`);
      fail++;
    }
  }
  return { ok, fail };
}

// Ensure key cookies are set on .720yun.com domain so they cover apiv4.720yun.com etc.
async function ensureBroadDomain(viewSession) {
  if (!viewSession) return;
  try {
    const all = await viewSession.cookies.get({});
    const yunCookies = all.filter(c => c.domain.includes('720yun'));
    let fixed = 0;
    for (const c of yunCookies) {
      // Only fix cookies scoped to www.720yun.com (host-only) — they won't reach apiv4.720yun.com
      if (c.domain === 'www.720yun.com' || c.domain === '.www.720yun.com') {
        try {
          await viewSession.cookies.set({
            url: `https://720yun.com${c.path || '/'}`,
            name: c.name,
            value: c.value,
            domain: '.720yun.com',
            path: c.path || '/',
            secure: !!c.secure,
            httpOnly: !!c.httpOnly,
            sameSite: c.sameSite === 'strict' ? 'strict' : (c.sameSite === 'no_restriction' ? 'no_restriction' : 'lax'),
            ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}),
          });
          fixed++;
        } catch (_) {}
      }
    }
    if (fixed > 0) log('BroadDomain', `Copied ${fixed} cookies to .720yun.com`);
  } catch (e) {
    log('BroadDomain', `Error: ${e.message}`);
  }
}

function collectFullCookies(allCookies) {
  const map = {};
  for (const c of allCookies) {
    if (!c.domain.includes('720yun')) continue;
    // Normalize www-scoped domains to broad .720yun.com for cross-subdomain sharing
    let domain = c.domain;
    if (domain === 'www.720yun.com' || domain === '.www.720yun.com') {
      domain = '.720yun.com';
    }
    map[c.name] = {
      value: c.value,
      domain,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite || 'unspecified',
    };
    if (c.expirationDate) map[c.name].expirationDate = c.expirationDate;
  }
  return map;
}

// --- Sync cookies from proxy (pull) ---
function syncCookiesFromProxy() {
  return new Promise((resolve) => {
    const target = `${getProxyUrl()}/__proxy_admin__/session/status`;
    log('Sync', `Pull from ${target}`);
    const req = http.get(target, {
      agent: ipv4Agent,
      headers: { 'Authorization': `Bearer ${ADMIN_SECRET}` },
      timeout: 5000,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            log('Sync', `Pull HTTP ${res.statusCode}: ${body.substring(0, 200)}`);
            return resolve();
          }
          const json = JSON.parse(body);
          const rev = json.session?.revision ?? 0;
          const cookies = json.session?.cookies || {};
          const count = Object.keys(cookies).length;
          if (count === 0) {
            log('Sync', `Pull rev:${rev} — proxy has 0 cookies`);
            return resolve();
          }
          sharedCookieMap = cookies;
          sharedHeaders = json.session?.headers || {};
          localRevision = rev;
          log('Sync', `Pull OK rev:${rev}, ${count} cookies, ${Object.keys(sharedHeaders).length} headers`);
        } catch (e) {
          log('Sync', `Pull parse error: ${e.message}`);
        } finally {
          resolve();
        }
      });
    });
    req.on('error', (e) => { log('Sync', `Pull FAILED: ${e.message}`); resolve(); });
    req.on('timeout', () => { log('Sync', 'Pull TIMEOUT'); req.destroy(); resolve(); });
  });
}

// --- Push cookies to proxy ---
function pushCookiesToProxy(cookieMap) {
  const count = Object.keys(cookieMap).length;
  log('Sync', `Pushing ${count} cookies to proxy...`);
  const payload = JSON.stringify({ cookies: cookieMap, source: clientConfig.clientId });
  const url = new URL(`${getProxyUrl()}/__proxy_admin__/session/sync-cookies`);
  const req = http.request(url, {
    method: 'POST',
    agent: ipv4Agent,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ADMIN_SECRET}`,
      'Content-Length': Buffer.byteLength(payload),
    },
  }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      try {
        const json = JSON.parse(body);
        log('Sync', `Push OK rev=${json.session?.revision}`);
        if (json.session?.revision) localRevision = json.session.revision;
      } catch (e) {
        log('Sync', `Push parse error: ${body.substring(0, 200)}`);
      }
    });
  });
  req.on('error', (e) => log('Sync', `Push FAILED: ${e.message}`));
  req.write(payload);
  req.end();
}

// --- Push auth headers to proxy ---
function pushHeadersToProxy(headers) {
  const payload = JSON.stringify({ headers });
  const url = new URL(`${getProxyUrl()}/__proxy_admin__/session/headers`);
  const req = http.request(url, {
    method: 'POST',
    agent: ipv4Agent,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ADMIN_SECRET}`,
      'Content-Length': Buffer.byteLength(payload),
    },
  }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => log('Sync', `Header push: ${res.statusCode}`));
  });
  req.on('error', (e) => log('Sync', `Header push FAILED: ${e.message}`));
  req.write(payload);
  req.end();
}

// --- Cookie monitor: push local changes to proxy ---
function setupCookieMonitor(viewSession) {
  viewSession.cookies.on('changed', (_e, cookie, cause) => {
    if (isSyncing) return;
    if (!cookie.domain.includes('720yun')) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const currentUrl = contentView?.webContents?.getURL() || '';
      if (currentUrl.includes('/login')) return;
      try {
        const all = await viewSession.cookies.get({});
        const map = collectFullCookies(all);
        if (Object.keys(map).length > 3) {
          log('CookieMonitor', `Pushing ${Object.keys(map).length} cookies`);
          pushCookiesToProxy(map);
        }
      } catch (e) {
        log('CookieMonitor', `Error: ${e.message}`);
      }
    }, 2000);
  });
}

// --- SSE client ---
let sseReq = null;

function connectSSE() {
  if (sseReq) { try { sseReq.destroy(); } catch (_) {} sseReq = null; }
  const url = `${getProxyUrl()}/__proxy_admin__/session/events?token=${encodeURIComponent(ADMIN_SECRET)}&clientId=${encodeURIComponent(clientConfig.clientId)}`;
  log('SSE', `Connecting to ${getProxyUrl()}`);
  sseReq = http.get(url, { agent: new http.Agent({ family: 4, keepAlive: true }) }, (res) => {
    if (res.statusCode !== 200) {
      log('SSE', `Status ${res.statusCode}, retry in 10s`);
      setTimeout(() => connectSSE(), 10000);
      return;
    }
    log('SSE', 'Connected');
    let buf = '';
    let eventType = '';

    res.on('data', (chunk) => {
      buf += chunk.toString();
      const blocks = buf.split('\n\n');
      buf = blocks.pop();
      for (const block of blocks) {
        if (!block.trim() || block.trim().startsWith(':')) continue;
        eventType = '';
        let dataStr = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) eventType = line.slice(7).trim();
          else if (line.startsWith('data: ')) dataStr += line.slice(6);
          else if (line.startsWith('data:')) dataStr += line.slice(5);
        }
        if (!dataStr) continue;
        try {
          handleSSEMessage(eventType, JSON.parse(dataStr));
        } catch (e) {
          log('SSE', `Parse error: ${e.message}`);
        }
      }
    });

    res.on('end', () => {
      log('SSE', 'Disconnected, reconnect in 5s');
      setTimeout(() => connectSSE(), 5000);
    });
  });

  sseReq.on('error', (e) => {
    log('SSE', `Error: ${e.message}`);
    setTimeout(() => connectSSE(), 5000);
  });
}

function handleSSEMessage(eventType, msg) {
  // Skip own updates
  if (msg.source === clientConfig.clientId) return;
  const rev = msg.revision ?? 0;
  if (rev <= localRevision) return;

  const cookies = msg.cookies || {};
  localRevision = rev;
  log('SSE', `Received ${eventType} rev:${rev} (${Object.keys(cookies).length} cookies)`);

  // Update sharedCookieMap so onBeforeSendHeaders uses latest data
  if (Object.keys(cookies).length > 0) {
    sharedCookieMap = cookies;
  }

  // Inject into cookie store with isSyncing guard
  if (contentView && Object.keys(cookies).length > 0) {
    isSyncing = true;
    injectCookiesToStore(contentView.webContents.session, cookies)
      .then(async (r) => {
        await ensureBroadDomain(contentView.webContents.session);
        log('SSE', `Cookie store: ${r.ok} ok, ${r.fail} fail`);
        // Delay releasing guard — Electron fires cookie 'changed' events asynchronously,
        // which would trigger CookieMonitor push and create a feedback loop.
        // 3s covers the CookieMonitor debounce (2s) plus async event delivery.
        setTimeout(() => { isSyncing = false; }, 3000);
      })
      .catch(() => { setTimeout(() => { isSyncing = false; }, 3000); });
  }
}

// --- Reconnect ---
function reconnect() {
  log('Reconnect', `Proxy=${getProxyUrl()}, resetting...`);
  localRevision = 0;
  sharedCookieMap = {};
  if (sseReq) { try { sseReq.destroy(); } catch (_) {} sseReq = null; }
  syncCookiesFromProxy().then(async () => {
    log('Reconnect', `Pulled ${Object.keys(sharedCookieMap).length} cookies`);
    if (contentView && Object.keys(sharedCookieMap).length > 0) {
      const viewSess = contentView.webContents.session;
      // Clear stale local cookies before injecting
      try {
        const existing = await viewSess.cookies.get({});
        const yunCookies = existing.filter(c => c.domain.includes('720yun'));
        for (const c of yunCookies) {
          try {
            const host = c.domain.replace(/^\./, '');
            await viewSess.cookies.remove(`https://${host}${c.path || '/'}`, c.name);
          } catch (_) {}
        }
        log('Reconnect', `Cleared ${yunCookies.length} local cookies`);
      } catch (_) {}
      isSyncing = true;
      const r = await injectCookiesToStore(viewSess, sharedCookieMap);
      isSyncing = false;
      log('Reconnect', `Injected: ${r.ok} ok, ${r.fail} fail`);
    }
    await ensureBroadDomain(contentView?.webContents?.session);
    if (mainWindow) mainWindow.webContents.send('sync-status', {
      ok: Object.keys(sharedCookieMap).length > 0,
      cookies: Object.keys(sharedCookieMap).length,
      rev: localRevision,
    });
    if (contentView) contentView.webContents.loadURL(START_URL);
    connectSSE();
  });
}

// Self-test: make direct HTTPS request to apiv4 to verify session validity
function selfTestSession() {
  const cookieStr = buildCookieString(sharedCookieMap);
  if (!cookieStr.includes('720yun_v8_session')) {
    log('SelfTest', 'No session cookie in sharedCookieMap, skipping');
    return;
  }
  log('SelfTest', `Testing apiv4 with ${cookieStr.length} chars cookie from Node.js...`);
  const req = https.get('https://apiv4.720yun.com/member/my/account', {
    headers: {
      'Cookie': cookieStr,
      'Origin': 'https://www.720yun.com',
      'Referer': 'https://www.720yun.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      log('SelfTest', `HTTP ${res.statusCode}, body: ${body.substring(0, 300)}`);
      if (res.statusCode === 200 && !body.includes('登录失效')) {
        log('SelfTest', 'SESSION VALID from Node.js');
      } else {
        log('SelfTest', `SESSION INVALID from Node.js (status=${res.statusCode})`);
      }
    });
  });
  req.on('error', (e) => log('SelfTest', `Request failed: ${e.message}`));
}

// --- Main window ---
function createWindow() {
  initLogger();
  loadClientConfig();

  mainWindow = new BrowserWindow({
    width: 1280, height: 900,
    title: '720云共享浏览器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Persistent partition per client — survives restart
  const viewSession = session.fromPartition(`persist:720yun-${clientConfig.clientId}`);
  contentView = new BrowserView({
    webPreferences: { session: viewSession, contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.setBrowserView(contentView);

  function resizeView() {
    const [w, h] = mainWindow.getContentSize();
    contentView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: w, height: h - TOOLBAR_HEIGHT - STATUSBAR_HEIGHT });
  }
  resizeView();
  mainWindow.on('resize', resizeView);

  // Merge shared cookies + auth headers into all 720yun requests
  let reqCounter = 0;
  viewSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    const url = details.url;
    const isYunDomain = /https?:\/\/[^/]*720yun\.com/.test(url);
    if (!isYunDomain) return callback({ requestHeaders: headers });

    // --- Cookie merge (when proxy has shared cookies) ---
    let filled = 0;
    if (Object.keys(sharedCookieMap).length > 0) {
      const existingCookie = headers['Cookie'] || '';
      const cookieMap = {};
      if (existingCookie) {
        for (const part of existingCookie.split(';')) {
          const t = part.trim();
          const eq = t.indexOf('=');
          if (eq > 0) cookieMap[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
        }
      }
      for (const [name, info] of Object.entries(sharedCookieMap)) {
        if (!cookieMap[name]) {
          cookieMap[name] = (info && typeof info === 'object') ? info.value : info;
          filled++;
        }
      }
      headers['Cookie'] = Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    // --- Auth header capture & injection (runs for ALL 720yun requests) ---
    const appAuth = headers['App-Authorization'] ?? null;
    if (appAuth !== null && appAuth.length > 0) {
      if (sharedHeaders['App-Authorization'] !== appAuth) {
        sharedHeaders['App-Authorization'] = appAuth;
        log('AuthCapture', `App-Authorization captured (${appAuth.length} chars)`);
        clearTimeout(headerPushTimer);
        headerPushTimer = setTimeout(() => pushHeadersToProxy({ 'App-Authorization': appAuth }), 1000);
      }
    } else if (appAuth !== null && appAuth.length === 0 && sharedHeaders['App-Authorization']) {
      headers['App-Authorization'] = sharedHeaders['App-Authorization'];
      if (reqCounter <= 20) {
        log('AuthInject', `Injected App-Authorization (${sharedHeaders['App-Authorization'].length} chars)`);
      }
    }

    if (++reqCounter <= 20) {
      log('Request', `#${reqCounter} ${url.substring(0, 120)}`);
      log('Request', `  cookie=${(headers['Cookie'] || '').length} filled=${filled} auth=${(headers['App-Authorization'] || '').length}`);
    }
    callback({ requestHeaders: headers });
  });

  // Verify actual sent headers (diagnostic)
  viewSession.webRequest.onSendHeaders((details) => {
    if (/apiv4\.720yun\.com/.test(details.url) && reqCounter <= 20) {
      const hdrs = details.requestHeaders;
      const cookie = hdrs['Cookie'] || hdrs['cookie'] || '';
      const auth = hdrs['App-Authorization'] || '';
      log('Verify', `SENT ${details.url.substring(0, 60)}: cookie=${cookie.length}, auth=${auth.length}`);
    }
  });

  // Log API response status codes + capture Set-Cookie to update sharedCookieMap
  viewSession.webRequest.onHeadersReceived((details, callback) => {
    const isYunDomain = /https?:\/\/[^/]*720yun\.com/.test(details.url);
    if (isYunDomain) {
      // Log ALL Set-Cookie headers (not just ones matching sharedCookieMap)
      const setCookies = details.responseHeaders['set-cookie'] || details.responseHeaders['Set-Cookie'] || [];
      if (setCookies.length > 0 && reqCounter <= 20) {
        log('SetCookie', `${details.url.substring(0, 60)}: ${setCookies.length} headers`);
        for (const h of setCookies) {
          log('SetCookie', `  ${String(h).substring(0, 120)}`);
        }
      }
      // Update sharedCookieMap for known cookies
      for (const h of setCookies) {
        const m = String(h).match(/^([^=]+)=([^;]*)/);
        if (m) {
          const name = m[1].trim();
          const value = m[2].trim();
          if (sharedCookieMap[name]) {
            const old = (typeof sharedCookieMap[name] === 'object') ? sharedCookieMap[name].value : sharedCookieMap[name];
            if (old !== value) {
              if (typeof sharedCookieMap[name] === 'object') {
                sharedCookieMap[name].value = value;
              } else {
                sharedCookieMap[name] = value;
              }
              log('CookieRotation', `${name} old=${old.substring(0, 20)} new=${value.substring(0, 20)}`);
            }
          } else {
            log('CookieNew', `${name}=${value.substring(0, 40)} (not in sharedCookieMap)`);
          }
        }
      }
      if (/apiv4\.720yun\.com/.test(details.url) && reqCounter <= 20) {
        log('Response', `${details.statusCode} ${details.url.substring(0, 80)}`);
      }
    }
    callback({});
  });

  contentView.webContents.setWindowOpenHandler(({ url }) => {
    contentView.webContents.loadURL(url);
    return { action: 'deny' };
  });

  // Navigation tracking + login detection
  let lastUrl = '';
  function onNavigate(url) {
    const wasLogin = lastUrl.includes('/login');
    const isLogin = url.includes('/login');
    lastUrl = url;
    log('Nav', url);
    mainWindow.webContents.send('url-changed', url);
    // After successful login: push fresh cookies to proxy
    if (wasLogin && !isLogin && url.includes('720yun.com')) {
      log('LoginDetect', `Left login page → ${url}`);
      setTimeout(async () => {
        try {
          const all = await viewSession.cookies.get({});
          const map = collectFullCookies(all);
          const sessVal = map['720yun_v8_session']?.value;
          log('LoginDetect', `Collected ${Object.keys(map).length} cookies, session=${sessVal ? sessVal.substring(0, 16) + '...' : 'NONE'}`);
          if (Object.keys(map).length > 3) pushCookiesToProxy(map);
          await ensureBroadDomain(viewSession);
        } catch (e) {
          log('LoginDetect', `Error: ${e.message}`);
        }
      }, 2000);
    }
  }
  contentView.webContents.on('did-navigate', (_e, url) => onNavigate(url));
  contentView.webContents.on('did-navigate-in-page', (_e, url) => onNavigate(url));
  contentView.webContents.on('did-start-loading', () => mainWindow.webContents.send('loading', true));
  contentView.webContents.on('did-stop-loading', () => mainWindow.webContents.send('loading', false));

  let retryCount = 0;
  contentView.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log('LoadError', `${code} ${desc} - ${url}`);
    if (retryCount < 2 && (code === -102 || code === -106)) {
      retryCount++;
      setTimeout(() => contentView.webContents.loadURL(START_URL), 3000);
    }
  });
  contentView.webContents.on('did-finish-load', () => { retryCount = 0; });

  contentView.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) log('WebConsole', msg.substring(0, 200));
  });

  // --- Startup ---
  syncCookiesFromProxy().then(async () => {
    const proxySession = sharedCookieMap['720yun_v8_session']?.value;
    const proxyCookieCount = Object.keys(sharedCookieMap).length;
    log('Startup', `Proxy session: ${proxySession ? proxySession.substring(0, 20) + '...' : 'NONE'} (${proxyCookieCount} cookies)`);
    if (Object.keys(sharedHeaders).length > 0) {
      log('Startup', `Shared headers: ${Object.keys(sharedHeaders).join(', ')}`);
    }

    if (proxyCookieCount > 0) {
      // Clear all local 720yun cookies to prevent stale data conflicts
      try {
        const existing = await viewSession.cookies.get({});
        const yunCookies = existing.filter(c => c.domain.includes('720yun'));
        for (const c of yunCookies) {
          try {
            const host = c.domain.replace(/^\./, '');
            await viewSession.cookies.remove(`https://${host}${c.path || '/'}`, c.name);
          } catch (_) {}
        }
        log('Startup', `Cleared ${yunCookies.length} local 720yun cookies`);
      } catch (_) {}

      // Inject proxy cookies as source of truth
      isSyncing = true;
      const r = await injectCookiesToStore(viewSession, sharedCookieMap);
      isSyncing = false;
      log('Startup', `Injected from proxy: ${r.ok} ok, ${r.fail} fail`);
    } else {
      log('Startup', 'Proxy has no cookies — using local store as-is');
    }

    await ensureBroadDomain(viewSession);
    selfTestSession();

    contentView.webContents.loadURL(START_URL);
    setupCookieMonitor(viewSession);
    connectSSE();
  });
}

// --- IPC ---
ipcMain.handle('get-config', () => ({
  proxyUrl: getProxyUrl(),
  targetUrl: TARGET_URL,
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
  reconnect();
});

ipcMain.on('navigate', (_e, url) => {
  if (contentView) {
    if (!/^https?:\/\//i.test(url)) url = TARGET_URL + (url.startsWith('/') ? '' : '/') + url;
    contentView.webContents.loadURL(url);
  }
});

ipcMain.on('go-back', () => { if (contentView?.webContents.canGoBack()) contentView.webContents.goBack(); });
ipcMain.on('go-forward', () => { if (contentView?.webContents.canGoForward()) contentView.webContents.goForward(); });
ipcMain.on('reload', () => { if (contentView) contentView.webContents.reload(); });

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
