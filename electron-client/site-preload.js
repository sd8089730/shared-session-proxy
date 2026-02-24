const { ipcRenderer } = require('electron');

const data = ipcRenderer.sendSync('get-site-localStorage');
if (data && typeof data === 'object') {
  const keys = Object.keys(data);
  for (const [key, value] of Object.entries(data)) {
    try { localStorage.setItem(key, value); } catch (_) {}
  }
  if (keys.length > 0) {
    console.log('[site-preload] injected', keys.length, 'localStorage keys:', keys.join(', '));
    ipcRenderer.send('preload-localStorage-injected', keys.length);
  }
}

// 清理 Node.js 全局变量，防止泄漏给页面 JS
delete window.require;
delete window.module;
delete window.exports;
delete window.global;
