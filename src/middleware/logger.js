/**
 * 日志中间件 - 记录每个代理请求
 */
const accessLog = require('../access-log');
const config = require('../config');

module.exports = function logMiddleware(req, res, next) {
  // 跳过管理 API 的日志
  if (req.path.startsWith(config.adminPrefix)) return next();

  const startTime = Date.now();

  // 捕获请求体（如果配置了）
  let requestBody = null;
  if (config.log.logRequestBody && req.body) {
    requestBody = typeof req.body === 'string' 
      ? req.body.slice(0, config.log.maxBodyLength)
      : JSON.stringify(req.body).slice(0, config.log.maxBodyLength);
  }

  // 拦截响应完成
  const originalEnd = res.end;
  let responseSize = 0;

  res.on('pipe', (src) => {
    src.on('data', (chunk) => { responseSize += chunk.length; });
  });

  res.end = function (...args) {
    const responseTimeMs = Date.now() - startTime;
    if (args[0] && Buffer.isBuffer(args[0])) {
      responseSize += args[0].length;
    }

    accessLog.log({
      userId: req.proxyUserId,
      userName: req.proxyUserName,
      method: req.method,
      url: req.originalUrl || req.url,
      path: req.path,
      query: req.query ? JSON.stringify(req.query) : null,
      statusCode: res.statusCode,
      responseTimeMs,
      userAgent: req.headers['user-agent'],
      clientIp: req.ip || req.connection?.remoteAddress,
      requestBody,
      responseSize,
    });

    originalEnd.apply(res, args);
  };

  next();
};
