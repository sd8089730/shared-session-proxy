const config = require('./src/config');

// Optional Clash HTTPS tunnel
if (process.env.USE_CLASH_PROXY === 'true') {
  const http = require('http');
  const https = require('https');
  const tls = require('tls');
  const net = require('net');

  const PROXY_HOST = process.env.CLASH_HOST || '127.0.0.1';
  const PROXY_PORT = parseInt(process.env.CLASH_PORT || '7897', 10);

  // Verify Clash is reachable before patching
  const probe = net.connect(PROXY_PORT, PROXY_HOST);
  probe.setTimeout(3000);
  probe.on('connect', () => {
    probe.destroy();
    const origCreateConnection = https.globalAgent.createConnection.bind(https.globalAgent);
    https.globalAgent.createConnection = function(options, callback) {
      const host = options.host || options.hostname || options.servername;
      const port = options.port || 443;
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
        return origCreateConnection(options, callback);
      }
      const req = http.request({ host: PROXY_HOST, port: PROXY_PORT, method: 'CONNECT', path: `${host}:${port}` });
      req.on('connect', (res, socket) => {
        if (res.statusCode !== 200) return callback(new Error(`CONNECT failed: ${res.statusCode}`));
        const tlsSocket = tls.connect({ host, socket, servername: host, rejectUnauthorized: false }, () => callback(null, tlsSocket));
        tlsSocket.on('error', callback);
      });
      req.on('error', (err) => {
        callback(new Error(`Clash CONNECT failed: ${err.message}`));
      });
      req.end();
    };
    console.log(`[Start] HTTPS proxy tunnel active → ${PROXY_HOST}:${PROXY_PORT}`);
    require('./src/server');
  });
  probe.on('error', () => {
    console.error(`[Start] Clash proxy unreachable at ${PROXY_HOST}:${PROXY_PORT}`);
    process.exit(1);
  });
  probe.on('timeout', () => {
    probe.destroy();
    console.error(`[Start] Clash proxy timeout at ${PROXY_HOST}:${PROXY_PORT}`);
    process.exit(1);
  });
} else {
  require('./src/server');
}

process.on('uncaughtException', (e) => console.error('UNCAUGHT:', e));
process.on('unhandledRejection', (e) => console.error('UNHANDLED REJECTION:', e));
