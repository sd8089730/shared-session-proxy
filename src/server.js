/**
 * 共享会话中央代理 - 主服务
 */
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const config = require('./config');
const sessionStore = require('./session-store');
const authMiddleware = require('./middleware/auth');
const logMiddleware = require('./middleware/logger');
const adminRoutes = require('./admin-routes');

const app = express();

// JSON 解析（管理 API）
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

// 认证
app.use(authMiddleware);

// 管理 API
app.use(config.adminPrefix, adminRoutes);

// 日志
app.use(logMiddleware);

// 代理
const proxy = createProxyMiddleware({
  target: config.target,
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
        const cookieStr = sessionStore.getCookieString();
        if (cookieStr) proxyReq.setHeader('Cookie', cookieStr);

        const extraHeaders = sessionStore.getExtraHeaders();
        for (const [key, value] of Object.entries(extraHeaders)) {
          proxyReq.setHeader(key, value);
        }

        proxyReq.removeHeader(config.userIdHeader);
        proxyReq.removeHeader(config.userNameHeader);
        proxyReq.removeHeader(config.clientTokenHeader);

        const targetUrl = new URL(config.target);
        proxyReq.setHeader('Origin', targetUrl.origin);
        if (!proxyReq.getHeader('Referer')) {
          proxyReq.setHeader('Referer', config.target + '/');
        }
      } catch (e) {
        console.error('[proxyReq] Header error:', e.message);
      }
    },
    proxyRes: (proxyRes) => {
      const setCookie = proxyRes.headers['set-cookie'];
      if (setCookie) sessionStore.updateFromSetCookie(setCookie);
      delete proxyRes.headers['x-frame-options'];
      delete proxyRes.headers['content-security-policy'];
    },
    error: (err, req, res) => {
      console.error(`[Proxy Error] ${req.method} ${req.url}:`, err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Proxy Error', message: err.message });
      }
    },
  },
});

app.use('/', proxy);

// 启动
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║     Shared Session Central Proxy             ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Proxy:    http://0.0.0.0:${config.port}`);
  console.log(`║  Target:   ${config.target}`);
  console.log(`║  Admin:    http://localhost:${config.port}${config.adminPrefix}/health`);
  console.log('╚══════════════════════════════════════════════╝');
});

server.on('upgrade', proxy.upgrade);
server.on('error', (e) => { console.error('[Server Error]', e); });

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
