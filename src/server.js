/**
 * 共享会话中央代理 - 主服务（多站点动态路由）
 */
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const config = require('./config');
const siteRegistry = require('./site-registry');
const { createSessionStore } = require('./session-store');
const authMiddleware = require('./middleware/auth');
const logMiddleware = require('./middleware/logger');
const { router: adminRoutes, initBroadcast } = require('./admin-routes');

// ============ 启动流程 ============

siteRegistry.init(config.target);

// 为所有已注册站点创建 SessionStore 实例
for (const site of siteRegistry.getAll()) {
  createSessionStore(site.siteId);
}

// 4. 初始化 SSE 广播
initBroadcast();

// ============ Express 应用 ============

const app = express();

app.use(config.adminPrefix, express.json());

// CORS
app.use((req, res, next) => {
  const origin = config.allowedOrigins === '*' ? (req.headers.origin || '*') : config.allowedOrigins;
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', [
    'Content-Type', 'Authorization',
    config.userIdHeader, config.userNameHeader, config.clientTokenHeader,
  ].join(', '));
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(authMiddleware);
app.use(config.adminPrefix, adminRoutes);
app.use(logMiddleware);

// ============ 站点路由解析 ============

function resolveSite(req) {
  const siteId = req.headers['x-proxy-site'];
  if (siteId) return siteRegistry.get(siteId);
  return siteRegistry.getDefault(config.target);
}

// HTTP 请求：解析站点，未知站点返回 502
app.use((req, res, next) => {
  if (req.path.startsWith(config.adminPrefix)) return next();
  const site = resolveSite(req);
  if (!site) {
    const siteId = req.headers['x-proxy-site'];
    return res.status(502).json({
      error: siteId ? `Unknown site: ${siteId}` : 'No default site configured',
      siteId: siteId || undefined,
    });
  }
  req._proxySite = site;
  next();
});

// ============ 动态代理 ============

const proxy = createProxyMiddleware({
  router: (req) => {
    // HTTP 请求已由中间件解析；WebSocket upgrade 在此解析
    if (req._proxySite) return req._proxySite.targetUrl;
    const site = resolveSite(req);
    if (site) { req._proxySite = site; return site.targetUrl; }
    throw new Error('Unknown site');
  },
  changeOrigin: true,
  secure: false,
  proxyTimeout: config.requestTimeout,
  timeout: config.requestTimeout,
  ws: true,
  agent: require('https').globalAgent,
  on: {
    proxyReq: (proxyReq, req) => {
      if (proxyReq.headersSent) return;
      try {
        const site = req._proxySite;
        const store = createSessionStore(site.siteId);

        // 注入站点 cookies
        const cookieStr = store.getCookieString();
        if (cookieStr) proxyReq.setHeader('Cookie', cookieStr);

        // 注入站点 customHeaders
        const extraHeaders = store.getExtraHeaders();
        for (const [key, value] of Object.entries(extraHeaders)) {
          proxyReq.setHeader(key, value);
        }

        // 剥离内部 header
        proxyReq.removeHeader('x-proxy-site');
        proxyReq.removeHeader(config.userIdHeader);
        proxyReq.removeHeader(config.userNameHeader);
        proxyReq.removeHeader(config.clientTokenHeader);

        // 设置 Origin/Referer
        const targetUrl = new URL(site.targetUrl);
        proxyReq.setHeader('Origin', targetUrl.origin);
        if (!proxyReq.getHeader('Referer')) {
          proxyReq.setHeader('Referer', site.targetUrl + '/');
        }
      } catch (e) {
        console.error('[proxyReq] Header error:', e.message);
      }
    },
    proxyRes: (proxyRes, req) => {
      // 捕获响应 Set-Cookie 存入对应站点的 SessionStore
      const site = req._proxySite;
      const setCookie = proxyRes.headers['set-cookie'];
      if (setCookie && site) {
        createSessionStore(site.siteId).updateFromSetCookie(setCookie);
      }
      delete proxyRes.headers['x-frame-options'];
      delete proxyRes.headers['content-security-policy'];
    },
    error: (err, req, res) => {
      const site = req._proxySite;
      console.error(`[Proxy Error] ${req.method} ${req.url}:`, err.message);
      if (!res.headersSent) {
        res.status(502).json({
          error: err.message,
          siteId: site?.siteId,
          targetUrl: site?.targetUrl,
        });
      }
    },
  },
});

app.use('/', proxy);

// ============ 启动 ============

const server = app.listen(config.port, '0.0.0.0', () => {
  const sites = siteRegistry.getAll();
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║     Shared Session Central Proxy             ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Proxy:    http://0.0.0.0:${config.port}`);
  console.log(`║  Sites:    ${sites.length} registered`);
  for (const s of sites) {
    console.log(`║    ${s.siteId} → ${s.targetUrl}`);
  }
  console.log(`║  Admin:    http://localhost:${config.port}${config.adminPrefix}/health`);
  console.log('╚══════════════════════════════════════════════╝');
});

server.on('upgrade', proxy.upgrade);
server.on('error', (e) => { console.error('[Server Error]', e); });

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
