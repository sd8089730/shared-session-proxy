const express = require('express');
const { createSessionStore, removeSessionStore } = require('./session-store');
const siteRegistry = require('./site-registry');
const accessLog = require('./access-log');
const config = require('./config');

const router = express.Router();

router.use((req, res, next) => {
  if (!req.path.includes('/events')) {
    console.log(`[Admin] ${req.method} ${req.path}`);
  }
  next();
});

// ============ SSE 客户端管理 ============
const sseClients = new Map();
const onlineClients = new Map(); // clientId → { clientId, userName, activeSiteId, connectedAt }
const MAX_SSE = 20;
let sseConnCounter = 0;

function broadcast(event, data, excludeClientId) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [, client] of sseClients) {
    if (excludeClientId && client.clientId === excludeClientId) continue;
    try { client.res.write(msg); } catch (_) {}
  }
}

// 按 siteId 跟踪已绑定监听的 SessionStore
const _listenedStores = new Set();

function attachStoreListener(siteId) {
  if (_listenedStores.has(siteId)) return;
  _listenedStores.add(siteId);
  createSessionStore(siteId).onChange((payload) => {
    broadcast('cookie-update', {
      siteId: payload.siteId,
      cookies: payload.cookies,
      localStorage: payload.localStorage,
      revision: payload.revision,
      updatedBy: payload.updatedBy,
      source: payload.source,
      updatedAt: new Date().toISOString(),
    }, payload.source);
  });
}

/** 初始化 SSE 广播：为所有站点绑定 SessionStore 变更监听 + SiteRegistry 变更监听 */
function initBroadcast() {
  for (const site of siteRegistry.getAll()) {
    attachStoreListener(site.siteId);
  }
  siteRegistry.onChange((event, data) => {
    broadcast(event, data);
    if (event === 'site-added' && data.siteId) attachStoreListener(data.siteId);
    if (event === 'site-removed' && data.siteId) _listenedStores.delete(data.siteId);
  });
}

setInterval(() => {
  for (const [, client] of sseClients) {
    try { client.res.write(':heartbeat\n\n'); } catch (_) {}
  }
}, 30000);

// ============ Helper: 从请求解析 siteId → SessionStore ============

function resolveStoreFromReq(req) {
  const siteId = req.query.siteId || req.body?.siteId;
  const site = siteId ? siteRegistry.get(siteId) : siteRegistry.getDefault(config.target);
  if (!site) return { error: siteId ? 'Site not found' : 'No default site', status: siteId ? 404 : 502 };
  const store = createSessionStore(site.siteId);
  attachStoreListener(site.siteId);
  return { site, store };
}

// ============ 站点管理 CRUD ============

router.get('/sites', (req, res) => {
  res.json({ ok: true, sites: siteRegistry.getAll() });
});

router.get('/sites/:siteId', (req, res) => {
  const site = siteRegistry.get(req.params.siteId);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  res.json({ ok: true, site });
});

router.post('/sites', (req, res) => {
  const result = siteRegistry.add(req.body);
  if (result.error) return res.status(400).json(result);
  res.status(201).json({ ok: true, site: result.site });
});

router.put('/sites/:siteId', (req, res) => {
  const result = siteRegistry.update(req.params.siteId, req.body);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  if (result.targetUrlChanged) createSessionStore(req.params.siteId).reset();
  res.json({ ok: true, site: result.site });
});

router.delete('/sites/:siteId', (req, res) => {
  const result = siteRegistry.remove(req.params.siteId);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  removeSessionStore(req.params.siteId);
  _listenedStores.delete(req.params.siteId);
  res.json({ ok: true });
});

// ============ Session 管理（支持 siteId 参数） ============

router.get('/session/status', (req, res) => {
  const r = resolveStoreFromReq(req);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ ok: true, siteId: r.site.siteId, ...r.store.getStatus() });
});

router.post('/session/cookies', (req, res) => {
  const r = resolveStoreFromReq(req);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const { cookies } = req.body;
  if (!cookies || typeof cookies !== 'object') return res.status(400).json({ error: 'cookies object required' });
  r.store.updateCookies(cookies, 'admin');
  res.json({ ok: true, siteId: r.site.siteId, ...r.store.getStatus() });
});

router.post('/session/raw-cookie', (req, res) => {
  const r = resolveStoreFromReq(req);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const { cookie } = req.body;
  if (!cookie || typeof cookie !== 'string') return res.status(400).json({ error: 'cookie string required' });
  r.store.setRawCookieString(cookie, 'admin');
  res.json({ ok: true, siteId: r.site.siteId, ...r.store.getStatus() });
});

router.post('/session/sync-cookies', (req, res) => {
  const r = resolveStoreFromReq(req);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const { cookies, localStorage, source } = req.body;
  if (!cookies || typeof cookies !== 'object') return res.status(400).json({ error: 'cookies object required' });
  if (Object.keys(cookies).length === 0 && !localStorage) return res.json({ ok: true, siteId: r.site.siteId, ...r.store.getStatus() });
  if (Object.keys(cookies).length > 0) r.store.replaceCookies(cookies, source || 'client', source || 'unknown');
  if (localStorage && typeof localStorage === 'object' && Object.keys(localStorage).length > 0) {
    r.store.updateLocalStorage(localStorage, source || 'client');
  }
  res.json({ ok: true, siteId: r.site.siteId, ...r.store.getStatus() });
});

router.post('/session/headers', (req, res) => {
  const r = resolveStoreFromReq(req);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const { headers } = req.body;
  if (!headers || typeof headers !== 'object') return res.status(400).json({ error: 'headers object required' });
  r.store.updateHeaders(headers, 'admin');
  res.json({ ok: true, siteId: r.site.siteId, ...r.store.getStatus() });
});

router.delete('/session', (req, res) => {
  const r = resolveStoreFromReq(req);
  if (r.error) return res.status(r.status).json({ error: r.error });
  r.store.clear('admin');
  res.json({ ok: true, message: 'Session cleared', siteId: r.site.siteId });
});

// ============ SSE 端点 ============

router.get('/session/events', (req, res) => {
  if (sseClients.size >= MAX_SSE) return res.status(503).json({ error: 'too many SSE connections' });

  const clientId = req.query.clientId || `sse-${Date.now()}`;
  const userName = req.query.userName || clientId;
  const connId = ++sseConnCounter;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // snapshot：含站点列表 + 各站点 session 摘要 + 在线客户端
  const sites = siteRegistry.getAll();
  const sessions = {};
  for (const site of sites) {
    const status = createSessionStore(site.siteId).getStatus();
    sessions[site.siteId] = {
      cookieCount: status.cookieCount,
      revision: status.session.revision,
      updatedAt: status.session.updatedAt,
    };
  }
  const clientInfo = { clientId, userName, activeSiteId: null, connectedAt: new Date().toISOString() };
  onlineClients.set(clientId, clientInfo);
  const clients = Array.from(onlineClients.values());
  res.write(`event: snapshot\ndata: ${JSON.stringify({ sites, sessions, clients })}\n\n`);

  sseClients.set(connId, { res, clientId });
  broadcast('client-online', clientInfo, clientId);

  req.on('close', () => {
    sseClients.delete(connId);
    const removed = onlineClients.get(clientId);
    onlineClients.delete(clientId);
    if (removed) broadcast('client-offline', { clientId });
  });
});

// ============ 客户端活动上报 ============

router.post('/clients/activity', (req, res) => {
  const { clientId, siteId } = req.body || {};
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const info = onlineClients.get(clientId);
  if (!info) return res.status(404).json({ error: 'client not online' });
  info.activeSiteId = siteId || null;
  broadcast('client-activity', { clientId, activeSiteId: info.activeSiteId });
  res.json({ ok: true });
});

// ============ 日志查询 ============

router.get('/logs', (req, res) => {
  const { userId, startTime, endTime, path, method, limit, offset } = req.query;
  const logs = accessLog.query({
    userId, startTime, endTime, path, method,
    limit: parseInt(limit) || 100,
    offset: parseInt(offset) || 0,
  });
  res.json({ ok: true, count: logs.length, logs });
});

router.get('/logs/stats', (req, res) => {
  const { startTime, endTime } = req.query;
  const stats = accessLog.stats({ startTime, endTime });
  res.json({ ok: true, stats });
});

router.post('/logs/cleanup', (req, res) => {
  const days = req.body?.retainDays || config.log.retainDays;
  const deleted = accessLog.cleanup(days);
  res.json({ ok: true, deleted, message: `Cleaned up logs older than ${days} days` });
});

// ============ Health（含多站点摘要） ============

router.get('/health', (req, res) => {
  const sites = siteRegistry.getAll().map(s => {
    const status = createSessionStore(s.siteId).getStatus();
    return { siteId: s.siteId, name: s.name, targetUrl: s.targetUrl, cookieCount: status.cookieCount, revision: status.session.revision };
  });
  res.json({ ok: true, uptime: process.uptime(), siteCount: sites.length, sites });
});

module.exports = { router, initBroadcast };
