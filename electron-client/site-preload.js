const { ipcRenderer } = require('electron');

const data = ipcRenderer.sendSync('get-site-localStorage');
if (data && typeof data === 'object') {
  for (const [key, value] of Object.entries(data)) {
    try { localStorage.setItem(key, value); } catch (_) {}
  }
}
