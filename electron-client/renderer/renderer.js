(async () => {
  const config = await window.electronAPI.getConfig();

  const webview = document.getElementById('webview');
  const urlBar = document.getElementById('url-bar');
  const usernameInput = document.getElementById('username');
  const statusProxy = document.getElementById('status-proxy');
  const statusUser = document.getElementById('status-user');

  // Init username
  usernameInput.value = config.userName;
  statusUser.textContent = `用户: ${config.userName} (${config.userId.slice(0, 8)})`;
  statusProxy.textContent = `代理: ${config.proxyUrl}`;

  usernameInput.addEventListener('change', () => {
    const name = usernameInput.value.trim();
    if (name) {
      window.electronAPI.setUsername(name);
      statusUser.textContent = `用户: ${name} (${config.userId.slice(0, 8)})`;
    }
  });

  // Navigation
  document.getElementById('btn-back').onclick = () => webview.goBack();
  document.getElementById('btn-forward').onclick = () => webview.goForward();
  document.getElementById('btn-reload').onclick = () => webview.reload();
  document.getElementById('btn-go').onclick = () => {
    let url = urlBar.value.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    webview.loadURL(url);
  };
  urlBar.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-go').click();
  });

  // Sync URL bar
  webview.addEventListener('did-navigate', (e) => { urlBar.value = e.url; });
  webview.addEventListener('did-navigate-in-page', (e) => { urlBar.value = e.url; });

  // Intercept new-window: navigate in same webview
  webview.addEventListener('new-window', (e) => {
    e.preventDefault();
    webview.loadURL(e.url);
  });

  // Proxy status check
  webview.addEventListener('did-finish-load', () => {
    statusProxy.textContent = `代理: ${config.proxyUrl} ✓`;
    statusProxy.style.color = 'green';
  });
  webview.addEventListener('did-fail-load', (e) => {
    if (e.errorCode !== -3) { // -3 is aborted, ignore
      statusProxy.textContent = `代理: ${config.proxyUrl} ✗ (${e.errorDescription})`;
      statusProxy.style.color = 'red';
    }
  });
})();
