const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  setUsername: (name) => ipcRenderer.send('set-username', name),
  setProxyUrl: (url) => ipcRenderer.send('set-proxy-url', url),
  reconnect: () => ipcRenderer.send('reconnect'),
  navigate: (url) => ipcRenderer.send('navigate', url),
  goBack: () => ipcRenderer.send('go-back'),
  goForward: () => ipcRenderer.send('go-forward'),
  reload: () => ipcRenderer.send('reload'),
  onUrlChanged: (cb) => ipcRenderer.on('url-changed', (_e, url) => cb(url)),
  onLoading: (cb) => ipcRenderer.on('loading', (_e, loading) => cb(loading)),
  onSyncStatus: (cb) => ipcRenderer.on('sync-status', (_e, status) => cb(status)),
});
