const http = require('http');
const options = {
  hostname: 'localhost', port: 7890, path: '/',
  headers: { 'x-proxy-token': 'shared-proxy-token-2024', 'x-proxy-user-id': 'test', 'x-proxy-user-name': 'test' }
};
http.get(options, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const re = /(href|src)=["']?(https?:\/\/[^"'\s>]+)/gi;
    let m;
    const domains = new Set();
    while ((m = re.exec(d)) !== null) {
      try {
        const u = new URL(m[2]);
        domains.add(u.hostname);
      } catch {}
    }
    console.log('External domains referenced by 720yun homepage:');
    domains.forEach(d => console.log(' ', d));
  });
});
