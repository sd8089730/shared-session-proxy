// 720云 Cookie 同步 - Chrome Extension v1.1

let cachedCookies = '';

// 加载保存的设置
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['proxyUrl', 'adminSecret'], (data) => {
    if (data.proxyUrl) document.getElementById('proxyUrl').value = data.proxyUrl;
    if (data.adminSecret) document.getElementById('adminSecret').value = data.adminSecret;
  });
});

function saveSettings() {
  chrome.storage.local.set({
    proxyUrl: document.getElementById('proxyUrl').value,
    adminSecret: document.getElementById('adminSecret').value,
  });
}

function showStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = type;
}

// ========== 方法1: chrome.cookies API ==========
async function fetchViaCookiesAPI() {
  const results = await Promise.all([
    chrome.cookies.getAll({ url: 'https://www.720yun.com' }),
    chrome.cookies.getAll({ url: 'https://720yun.com' }),
    chrome.cookies.getAll({ domain: '720yun.com' }),
    chrome.cookies.getAll({ domain: '.720yun.com' }),
  ]);
  const map = new Map();
  results.flat().forEach(c => map.set(c.name, c.value));
  return map;
}

// ========== 方法2: 注入脚本读 document.cookie ==========
async function fetchViaInjection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('720yun.com')) {
    return null; // 当前标签页不是 720yun
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => document.cookie,
  });
  if (results && results[0] && results[0].result) {
    const cookieStr = results[0].result;
    const map = new Map();
    cookieStr.split(';').forEach(pair => {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        map.set(pair.substring(0, idx).trim(), pair.substring(idx + 1).trim());
      }
    });
    return { map, raw: cookieStr };
  }
  return null;
}

// 抓取 Cookies（两种方法都试）
document.getElementById('btnFetch').addEventListener('click', async () => {
  try {
    showStatus('正在抓取...', 'info');
    
    let map = new Map();
    let method = '';
    
    // 方法1: cookies API
    try {
      const apiMap = await fetchViaCookiesAPI();
      if (apiMap.size > 0) {
        apiMap.forEach((v, k) => map.set(k, v));
        method = 'cookies API';
      }
    } catch (e) {
      console.log('cookies API failed:', e);
    }
    
    // 方法2: 注入脚本（需要当前标签页是 720yun）
    try {
      const injResult = await fetchViaInjection();
      if (injResult && injResult.map.size > 0) {
        injResult.map.forEach((v, k) => map.set(k, v));
        method = method ? method + ' + 页面注入' : '页面注入';
      }
    } catch (e) {
      console.log('injection failed:', e);
    }
    
    if (map.size === 0) {
      showStatus(
        '未找到 cookies！请确认：\n' +
        '1. 已在浏览器中登录 720yun.com\n' +
        '2. 当前标签页打开的是 720yun.com',
        'error'
      );
      return;
    }
    
    cachedCookies = Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    
    document.getElementById('cookieInfo').textContent = `找到 ${map.size} 个 cookies (via ${method})`;
    document.getElementById('cookiePreview').value = cachedCookies;
    
    showStatus(`✅ 成功抓取 ${map.size} 个 cookies (${method})`, 'success');
  } catch (err) {
    showStatus('抓取失败: ' + err.message + '\n' + err.stack, 'error');
  }
});

// 同步到代理
document.getElementById('btnSync').addEventListener('click', async () => {
  if (!cachedCookies) {
    showStatus('请先抓取 cookies', 'error');
    return;
  }
  
  saveSettings();
  const proxyUrl = document.getElementById('proxyUrl').value.replace(/\/+$/, '');
  const adminSecret = document.getElementById('adminSecret').value;
  
  try {
    showStatus('正在同步...', 'info');
    
    const res = await fetch(`${proxyUrl}/__proxy_admin__/session/raw-cookie`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminSecret}`,
      },
      body: JSON.stringify({ cookie: cachedCookies }),
    });
    
    const data = await res.json();
    
    if (data.ok) {
      showStatus('✅ 同步成功！Cookies 已注入代理', 'success');
    } else {
      showStatus('同步失败: ' + (data.error || JSON.stringify(data)), 'error');
    }
  } catch (err) {
    showStatus('连接代理失败: ' + err.message + '（确认代理已启动）', 'error');
  }
});

// 检查代理状态
document.getElementById('btnCheck').addEventListener('click', async () => {
  saveSettings();
  const proxyUrl = document.getElementById('proxyUrl').value.replace(/\/+$/, '');
  const adminSecret = document.getElementById('adminSecret').value;
  
  try {
    const res = await fetch(`${proxyUrl}/__proxy_admin__/health`, {
      headers: { 'Authorization': `Bearer ${adminSecret}` },
    });
    const data = await res.json();
    
    if (data.ok) {
      const s = data.session;
      showStatus(
        `✅ 代理运行中 | 目标: ${data.target} | ` +
        `Cookies: ${s.hasCookies ? '有' : '无'} (${s.cookieCount}个) | ` +
        `更新: ${s.updatedAt || '从未'}`,
        'success'
      );
    } else {
      showStatus('代理返回异常: ' + JSON.stringify(data), 'error');
    }
  } catch (err) {
    showStatus('无法连接代理: ' + err.message, 'error');
  }
});
