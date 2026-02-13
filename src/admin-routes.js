const express = require('express');
const sessionStore = require('./session-store');
const accessLog = require('./access-log');
const config = require('./config');

const router = express.Router();

router.use((req, res, next) => {
  if (!req.path.includes('/events')) {
    console.log(`[Admin] ${req.method} ${req.path}`);
  }
  next();
});

// ============ SSE client management ============
const sseClients = new Map(); // connId → { res, clientId }
const MAX_SSE = 20;
let sseConnCounter = 0;

sessionStore.onChange((payload) => {
  const data = JSON.stringify({
    cookies: payload.cookies,
    revision: payload.revision,
    updatedBy: payload.updatedBy,
    source: payload.source,
    updatedAt: new Date().toISOString(),
  });
  for (const [, client] of sseClients) {
    if (client.clientId === payload.source) continue; // exclude originator
    try { client.res.write(`event: cookie-update\ndata: ${data}\n\n`); } catch (_) {}
  }
});

setInterval(() => {
  for (const [, client] of sseClients) {
    try { client.res.write(':heartbeat\n\n'); } catch (_) {}
  }
}, 30000);

// ============ Session management ============

router.get('/session/status', (req, res) => {
  res.json({ ok: true, ...sessionStore.getStatus() });
});

router.post('/session/cookies', (req, res) => {
  const { cookies } = req.body;
  if (!cookies || typeof cookies !== 'object') return res.status(400).json({ error: 'cookies object required' });
  sessionStore.updateCookies(cookies, 'admin');
  res.json({ ok: true, ...sessionStore.getStatus() });
});

router.post('/session/raw-cookie', (req, res) => {
  const { cookie } = req.body;
  if (!cookie || typeof cookie !== 'string') return res.status(400).json({ error: 'cookie string required' });
  sessionStore.setRawCookieString(cookie, 'admin');
  res.json({ ok: true, ...sessionStore.getStatus() });
});

router.post('/session/sync-cookies', (req, res) => {
  const { cookies, source } = req.body;
  if (!cookies || typeof cookies !== 'object') return res.status(400).json({ error: 'cookies object required' });
  if (Object.keys(cookies).length === 0) return res.json({ ok: true, ...sessionStore.getStatus() });
  sessionStore.replaceCookies(cookies, source || 'client', source || 'unknown');
  res.json({ ok: true, ...sessionStore.getStatus() });
});

router.post('/session/headers', (req, res) => {
  const { headers } = req.body;
  if (!headers || typeof headers !== 'object') return res.status(400).json({ error: 'headers object required' });
  sessionStore.updateHeaders(headers, 'admin');
  res.json({ ok: true, ...sessionStore.getStatus() });
});

router.delete('/session', (req, res) => {
  sessionStore.clear('admin');
  res.json({ ok: true, message: 'Session cleared' });
});

// ============ SSE endpoint ============

router.get('/session/events', (req, res) => {
  if (sseClients.size >= MAX_SSE) return res.status(503).json({ error: 'too many SSE connections' });

  const clientId = req.query.clientId || `sse-${Date.now()}`;
  const connId = ++sseConnCounter;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const status = sessionStore.getStatus();
  const snapshot = JSON.stringify({
    cookies: status.session.cookies,
    revision: status.session.revision,
    updatedAt: status.session.updatedAt,
  });
  res.write(`event: snapshot\ndata: ${snapshot}\n\n`);

  sseClients.set(connId, { res, clientId });
  req.on('close', () => sseClients.delete(connId));
});

// ============ Log queries ============

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

// ============ Health ============

router.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), target: config.target, ...sessionStore.getStatus() });
});

module.exports = router;
