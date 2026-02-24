const fs = require('fs');
const path = require('path');

const SITES_PATH = path.resolve('./data/sites.json');
const MAX_SITES = 50;
// 禁止作为 customHeaders 的 header 名称
const FORBIDDEN_HEADERS = new Set(['host', 'cookie', 'authorization', 'x-proxy-site']);

/**
 * 从 targetUrl 提取 siteId
 * 规则：去 www → 取首段 → 小写化 → IP 用 - 替换 .
 */
function deriveSiteId(targetUrl) {
  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return 'unknown'; }

  if (hostname === 'localhost') return 'localhost';

  // IP 地址
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return hostname.replace(/\./g, '-').slice(0, 32);
  }

  // 去 www 前缀
  if (hostname.startsWith('www.')) hostname = hostname.slice(4);

  // 取第一个 . 前的部分
  const dot = hostname.indexOf('.');
  const base = dot > 0 ? hostname.slice(0, dot) : hostname;
  return base.replace(/[^a-z0-9-]/g, '').slice(0, 32) || 'site';
}

/**
 * 从 targetUrl 推导 cookie domain
 */
function deriveDomains(targetUrl) {
  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return []; }

  if (hostname === 'localhost') return ['localhost'];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return [hostname];

  if (hostname.startsWith('www.')) hostname = hostname.slice(4);
  return [`.${hostname}`];
}

/**
 * 校验 customHeaders 合法性，返回 { valid, normalized, forbidden }
 */
function validateCustomHeaders(headers) {
  if (!Array.isArray(headers)) return { valid: false, error: 'customHeaders must be an array' };
  if (headers.length > 10) return { valid: false, error: 'customHeaders exceeds maximum of 10' };

  const normalized = [];
  const forbidden = [];
  for (const h of headers) {
    const name = String(h).trim().toLowerCase();
    if (!name) continue;
    if (FORBIDDEN_HEADERS.has(name)) { forbidden.push(name); continue; }
    normalized.push(name);
  }
  if (forbidden.length > 0) {
    return { valid: false, error: `Forbidden header names: ${forbidden.join(', ')}` };
  }
  return { valid: true, normalized };
}

class SiteRegistry {
  constructor() {
    this._sites = [];
    this._listeners = new Set();
  }

  /** 初始化：加载或创建默认 sites.json */
  init(defaultTargetUrl) {
    if (fs.existsSync(SITES_PATH)) {
      try {
        const data = JSON.parse(fs.readFileSync(SITES_PATH, 'utf-8'));
        this._sites = Array.isArray(data.sites) ? data.sites : [];
        console.log(`[SiteRegistry] 已加载 ${this._sites.length} 个站点`);
      } catch (e) {
        console.error('[SiteRegistry] 加载失败:', e.message);
        this._sites = [];
      }
    } else {
      // 初始化默认站点
      const url = defaultTargetUrl || 'https://www.720yun.com';
      const site = this._buildSite({ name: this._nameFromUrl(url), targetUrl: url, startPage: '/my/720vr/tour' });
      this._sites = [site];
      this._save();
      console.log(`[SiteRegistry] 已创建默认站点: ${site.siteId} → ${url}`);
    }
  }

  /** 注册变更回调 */
  onChange(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  _emit(event, data) {
    for (const cb of this._listeners) {
      try { cb(event, data); } catch (e) { console.error('[SiteRegistry] Listener error:', e.message); }
    }
  }

  /** 获取所有站点 */
  getAll() { return [...this._sites]; }

  /** 按 siteId 获取 */
  get(siteId) { return this._sites.find(s => s.siteId === siteId) || null; }

  /** 获取默认站点 */
  getDefault(proxyTarget) {
    if (proxyTarget && this._sites.length > 0) {
      const normalized = proxyTarget.toLowerCase().replace(/\/+$/, '');
      const match = this._sites.find(s => s.targetUrl.toLowerCase().replace(/\/+$/, '') === normalized);
      if (match) return match;
    }
    return this._sites[0] || null;
  }

  /** 创建站点 */
  add(input) {
    if (this._sites.length >= MAX_SITES) {
      return { error: 'Maximum 50 sites reached' };
    }

    const { name, targetUrl } = input;
    if (!name || !targetUrl) return { error: 'name and targetUrl are required' };
    if (!/^https?:\/\//i.test(targetUrl)) return { error: 'targetUrl must start with http:// or https://' };

    // customHeaders 校验
    const rawHeaders = input.customHeaders || [];
    const hv = validateCustomHeaders(rawHeaders);
    if (!hv.valid) return { error: hv.error };

    // startPage 校验
    const startPage = input.startPage || '/';
    if (!startPage.startsWith('/')) return { error: 'startPage must start with /' };

    const site = this._buildSite({ ...input, customHeaders: hv.normalized, startPage });
    this._sites.push(site);
    this._save();
    this._emit('site-added', site);
    return { site };
  }

  /** 更新站点（merge 语义） */
  update(siteId, fields) {
    const idx = this._sites.findIndex(s => s.siteId === siteId);
    if (idx === -1) return { error: 'Site not found', status: 404 };

    const site = this._sites[idx];
    const targetUrlChanged = fields.targetUrl && fields.targetUrl !== site.targetUrl;

    // customHeaders 校验
    if (fields.customHeaders) {
      const hv = validateCustomHeaders(fields.customHeaders);
      if (!hv.valid) return { error: hv.error };
      fields.customHeaders = hv.normalized;
    }

    if (fields.startPage && !fields.startPage.startsWith('/')) {
      return { error: 'startPage must start with /' };
    }

    // siteId 和 addedAt 不可变
    const { siteId: _, addedAt: __, ...mutable } = fields;
    Object.assign(site, mutable);

    // targetUrl 变更时重新推导 domains（除非用户指定了 domains）
    if (targetUrlChanged && !fields.domains) {
      site.domains = deriveDomains(site.targetUrl);
    }

    this._save();
    this._emit('site-updated', { site, targetUrlChanged });
    return { site, targetUrlChanged };
  }

  /** 删除站点 */
  remove(siteId) {
    const idx = this._sites.findIndex(s => s.siteId === siteId);
    if (idx === -1) return { error: 'Site not found', status: 404 };

    this._sites.splice(idx, 1);
    this._save();
    this._emit('site-removed', { siteId });
    return { ok: true };
  }

  /** 构建完整站点对象 */
  _buildSite(input) {
    const siteId = this._uniqueId(deriveSiteId(input.targetUrl));
    return {
      siteId,
      name: input.name,
      targetUrl: input.targetUrl,
      icon: input.icon || '',
      domains: input.domains || deriveDomains(input.targetUrl),
      customHeaders: input.customHeaders || [],
      startPage: input.startPage || '/',
      addedAt: new Date().toISOString(),
    };
  }

  /** 确保 siteId 唯一，碰撞时追加 -2, -3... */
  _uniqueId(base) {
    if (!this._sites.some(s => s.siteId === base) && base.length <= 32) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base}-${i}`.slice(0, 32);
      if (!this._sites.some(s => s.siteId === candidate)) return candidate;
    }
    return `${base}-${Date.now()}`.slice(0, 32);
  }

  /** 从 URL 推导显示名称 */
  _nameFromUrl(url) {
    try {
      const h = new URL(url).hostname;
      return h.startsWith('www.') ? h.slice(4) : h;
    } catch { return url; }
  }

  /** 原子写入 sites.json */
  _save() {
    const tmp = `${SITES_PATH}.tmp.${process.pid}`;
    try {
      const dir = path.dirname(SITES_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ sites: this._sites }, null, 2), 'utf-8');
      fs.renameSync(tmp, SITES_PATH);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      console.error('[SiteRegistry] 保存失败:', e.message);
    }
  }
}

module.exports = new SiteRegistry();
