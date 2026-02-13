const config = require('../config');

module.exports = function authMiddleware(req, res, next) {
  // Admin API: support Bearer header or ?token= query param (for SSE)
  if (req.path.startsWith(config.adminPrefix)) {
    const authHeader = req.headers['authorization'];
    const token = req.query.token || (authHeader ? authHeader.replace(/^Bearer\s+/i, '') : '');
    if (!token || token !== config.adminSecret) {
      return res.status(401).json({ error: 'Unauthorized: invalid admin secret' });
    }
    return next();
  }

  // Proxy requests: skip clientToken check if not configured
  if (config.clientToken) {
    const clientToken = req.headers[config.clientTokenHeader];
    if (!clientToken || clientToken !== config.clientToken) {
      return res.status(403).json({ error: 'Forbidden: invalid client token' });
    }
  }

  req.proxyUserId = req.headers[config.userIdHeader] || 'anonymous';
  req.proxyUserName = req.headers[config.userNameHeader] || 'Unknown';
  next();
};
