const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = path.resolve('./data/sessions');

function parseCookieString(str) {
  if (!str || typeof str !== 'string') return {};
  let s = str.trim();
  if (s.toLowerCase().startsWith('cookie:')) s = s.slice(7).trim();
  const cookies = {};
  for (const part of s.split(';')) {
    const t = part.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq === -1) { cookies[t] = { value: '' }; continue; }
    const name = t.slice(0, eq).trim();
    if (name) cookies[name] = { value: t.slice(eq + 1).trim() };
  }
  return cookies;
}

class SessionStore {
  constructor(siteId, storePath) {
    this.siteId = siteId;
    this.storePath = storePath;
    this._listeners = new Set();
    this.data = { cookies: {}, headers: {}, localStorage: {}, revision: 0, updatedAt: null, updatedBy: null };
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.storePath)) {
        console.log(`[SessionStore:${this.siteId}] 无历史数据，初始化空 session`);
        return this._save();
      }
      const loaded = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
      const d = { ...this.data, ...loaded };

      // 迁移 rawCookieString → 结构化 cookies
      if (typeof loaded.rawCookieString === 'string' && loaded.rawCookieString) {
        const existing = (loaded.cookies && typeof loaded.cookies === 'object') ? loaded.cookies : {};
        if (Object.keys(existing).length === 0) {
          d.cookies = parseCookieString(loaded.rawCookieString);
        }
      }
      delete d.rawCookieString;

      if (!d.cookies || typeof d.cookies !== 'object') d.cookies = {};
      for (const [k, v] of Object.entries(d.cookies)) {
        if (typeof v === 'string') d.cookies[k] = { value: v };
      }
      if (!d.headers || typeof d.headers !== 'object') d.headers = {};
      if (!d.localStorage || typeof d.localStorage !== 'object') d.localStorage = {};
      if (!Number.isInteger(d.revision) || d.revision < 0) d.revision = 0;

      this.data = d;
      console.log(`[SessionStore:${this.siteId}] 已加载 (rev ${d.revision}, ${Object.keys(d.cookies).length} cookies)`);
      if (loaded.rawCookieString) this._save();
    } catch (e) {
      console.error(`[SessionStore:${this.siteId}] 加载失败:`, e.message);
    }
  }

  _save() {
    const tmp = `${this.storePath}.tmp.${process.pid}`;
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tmp, this.storePath);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      console.error(`[SessionStore:${this.siteId}] 保存失败:`, e.message);
    }
  }

  _mutate(updatedBy, source) {
    this.data.revision += 1;
    this.data.updatedAt = new Date().toISOString();
    this.data.updatedBy = updatedBy;
    this._save();
    const payload = {
      siteId: this.siteId,
      cookies: { ...this.data.cookies },
      localStorage: { ...this.data.localStorage },
      revision: this.data.revision,
      updatedBy, source,
    };
    for (const cb of this._listeners) {
      try { cb(payload); } catch (e) { console.error(`[SessionStore:${this.siteId}] Listener error:`, e.message); }
    }
  }

  onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  getCookieString() {
    return Object.entries(this.data.cookies).map(([k, v]) => {
      const val = (v && typeof v === 'object') ? v.value : v;
      return `${k}=${val}`;
    }).join('; ');
  }

  getExtraHeaders() { return { ...this.data.headers }; }

  updateCookies(cookies, updatedBy = 'system', source = 'updateCookies') {
    if (!cookies || typeof cookies !== 'object') return;
    this.data.cookies = { ...this.data.cookies, ...cookies };
    this._mutate(updatedBy, source);
  }

  replaceCookies(cookies, updatedBy = 'system', source = 'replaceCookies') {
    if (!cookies || typeof cookies !== 'object') return;
    this.data.cookies = { ...cookies };
    this._mutate(updatedBy, source);
  }

  setRawCookieString(str, updatedBy = 'system') {
    this.data.cookies = { ...this.data.cookies, ...parseCookieString(str) };
    this._mutate(updatedBy, 'setRawCookieString');
  }

  updateHeaders(headers, updatedBy = 'system') {
    if (!headers || typeof headers !== 'object') return;
    this.data.headers = { ...this.data.headers, ...headers };
    this.data.updatedAt = new Date().toISOString();
    this.data.updatedBy = updatedBy;
    this._save();
  }

  updateLocalStorage(data, updatedBy = 'system') {
    if (!data || typeof data !== 'object') return;
    this.data.localStorage = { ...this.data.localStorage, ...data };
    this._mutate(updatedBy, 'updateLocalStorage');
  }

  updateFromSetCookie(setCookieHeaders, updatedBy = 'system') {
    if (!setCookieHeaders) return;
    const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    let changed = false;
    for (const h of list) {
      const m = String(h).match(/^([^=]+)=([^;]*)/);
      if (m) {
        const name = m[1].trim();
        const value = m[2].trim();
        const existing = this.data.cookies[name];
        if (existing && typeof existing === 'object') {
          existing.value = value;
        } else {
          this.data.cookies[name] = { value };
        }
        changed = true;
      }
    }
    if (changed) this._mutate(updatedBy, 'updateFromSetCookie');
  }

  getStatus() {
    const cookieCount = Object.keys(this.data.cookies).length;
    return {
      session: {
        cookies: { ...this.data.cookies },
        headers: { ...this.data.headers },
        localStorage: { ...this.data.localStorage },
        revision: this.data.revision,
        updatedAt: this.data.updatedAt,
        updatedBy: this.data.updatedBy,
      },
      hasCookies: cookieCount > 0,
      cookieCount,
    };
  }

  clear(updatedBy = 'system') {
    this.data.cookies = {};
    this.data.headers = {};
    this.data.localStorage = {};
    this._mutate(updatedBy, 'clear');
  }

  /** 重置为空状态（targetUrl 变更时调用） */
  reset() {
    this.data = { cookies: {}, headers: {}, localStorage: {}, revision: 0, updatedAt: null, updatedBy: null };
    this._save();
  }

  /** 删除持久化文件 */
  destroy() {
    try { if (fs.existsSync(this.storePath)) fs.unlinkSync(this.storePath); } catch (_) {}
  }
}

// 工厂函数 + 实例缓存（单例保证）
const _cache = new Map();

function createSessionStore(siteId) {
  if (_cache.has(siteId)) return _cache.get(siteId);
  const filePath = path.join(SESSIONS_DIR, `${siteId}.json`);
  const store = new SessionStore(siteId, filePath);
  _cache.set(siteId, store);
  return store;
}

/** 从缓存移除并删除文件 */
function removeSessionStore(siteId) {
  const store = _cache.get(siteId);
  if (store) {
    store.destroy();
    _cache.delete(siteId);
  }
}

/** 获取所有已创建的 SessionStore 实例 */
function getAllStores() { return _cache; }

module.exports = { createSessionStore, removeSessionStore, getAllStores, SessionStore };
