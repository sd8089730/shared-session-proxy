/**
 * 共享会话中央代理 - 配置文件
 */
module.exports = {
  // 代理服务端口
  port: process.env.PROXY_PORT || 7890,

  // 管理后台端口（同一个服务，通过路由区分）
  // 管理 API 前缀
  adminPrefix: '/__proxy_admin__',

  // 目标网站（要代理的网站地址）
  target: process.env.PROXY_TARGET || 'https://www.720yun.com',

  adminSecret: '4110ba59-46e2-478a-b44f-e8e20413e842',

  // Electron 客户端认证 header
  userIdHeader: 'x-proxy-user-id',
  userNameHeader: 'x-proxy-user-name',
  clientTokenHeader: 'x-proxy-token',

  // 客户端访问令牌
  clientToken: process.env.CLIENT_TOKEN || '',

  // 日志配置
  log: {
    dir: './logs',
    // 日志保留天数
    retainDays: 30,
    // 是否记录请求体（谨慎开启，可能包含敏感数据）
    logRequestBody: false,
    // 是否记录响应体
    logResponseBody: false,
    // 最大 body 记录长度
    maxBodyLength: 4096,
  },

  // 数据库路径（SQLite）
  dbPath: './data/proxy.db',

  // 请求超时（毫秒）
  requestTimeout: 30000,

  // 需要排除代理的路径（正则）
  excludePaths: [],

  // 允许的源（CORS），'*' 表示全部
  allowedOrigins: '*',
};
