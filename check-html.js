const http = require('http');
const opts = {
  hostname: '127.0.0.1',
  port: 7890,
  path: '/',
  headers: {
    'x-proxy-token': 'shared-proxy-token-2024',
    'x-proxy-user-id': 'test',
    'x-proxy-user-name': 'test'
  }
};
http.get(opts, (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    // Extract src and href attributes
    const matches = data.match(/(src|href)=["'][^"']*["']/g) || [];
    matches.slice(0, 30).forEach(m => console.log(m));
    console.log('---');
    console.log('Total matches:', matches.length);
    console.log('HTML length:', data.length);
  });
}).on('error', e => console.log('Error:', e.message));
