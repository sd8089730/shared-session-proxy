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

  // 多站点管理
  getSites: () => ipcRenderer.invoke('get-sites'),
  addSite: (data) => ipcRenderer.invoke('add-site', data),
  removeSite: (siteId) => ipcRenderer.invoke('remove-site', siteId),
  openSite: (siteId) => ipcRenderer.send('open-site', siteId),
  goHome: () => ipcRenderer.send('go-home'),
  closeSiteView: (siteId) => ipcRenderer.send('close-site-view', siteId),

  // 事件
  onUrlChanged: (cb) => ipcRenderer.on('url-changed', (_e, url) => cb(url)),
  onLoading: (cb) => ipcRenderer.on('loading', (_e, loading) => cb(loading)),
  onSyncStatus: (cb) => ipcRenderer.on('sync-status', (_e, status) => cb(status)),
  onSitesUpdated: (cb) => ipcRenderer.on('sites-updated', (_e, sites) => cb(sites)),
  onViewChanged: (cb) => ipcRenderer.on('view-changed', (_e, data) => cb(data)),
});
