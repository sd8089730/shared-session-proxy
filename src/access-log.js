/**
 * 操作日志 - sql.js (纯 JS SQLite，无需原生编译)
 */
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const config = require('./config');

class AccessLog {
  constructor() {
    this.dbPath = path.resolve(config.dbPath);
    this.db = null;
    this._ready = this._init();
  }

  async _init() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const SQL = await initSqlJs();

    if (fs.existsSync(this.dbPath)) {
      const buf = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buf);
    } else {
      this.db = new SQL.Database();
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        user_id TEXT,
        user_name TEXT,
        method TEXT,
        url TEXT,
        path TEXT,
        query TEXT,
        status_code INTEGER,
        response_time_ms INTEGER,
        user_agent TEXT,
        client_ip TEXT,
        request_body TEXT,
        response_size INTEGER,
        error TEXT
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_log_timestamp ON access_log(timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_log_user_id ON access_log(user_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_log_path ON access_log(path)`);

    // 定期保存到磁盘
    this._saveInterval = setInterval(() => this._save(), 10000);
  }

  _save() {
    if (!this.db) return;
    try {
      const data = this.db.export();
      fs.writeFileSync(this.dbPath, Buffer.from(data));
    } catch (e) {
      console.error('[AccessLog] Save error:', e.message);
    }
  }

  log(entry) {
    if (!this.db) return;
    try {
      this.db.run(
        `INSERT INTO access_log 
          (user_id, user_name, method, url, path, query, status_code, 
           response_time_ms, user_agent, client_ip, request_body, response_size, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.userId || null, entry.userName || null, entry.method || null,
          entry.url || null, entry.path || null, entry.query || null,
          entry.statusCode || null, entry.responseTimeMs || null,
          entry.userAgent || null, entry.clientIp || null,
          entry.requestBody || null, entry.responseSize || null, entry.error || null,
        ]
      );
    } catch (e) {
      console.error('[AccessLog] Log error:', e.message);
    }
  }

  query({ userId, startTime, endTime, path, method, limit = 100, offset = 0 } = {}) {
    if (!this.db) return [];
    let sql = 'SELECT * FROM access_log WHERE 1=1';
    const params = [];

    if (userId) { sql += ' AND user_id = ?'; params.push(userId); }
    if (startTime) { sql += ' AND timestamp >= ?'; params.push(startTime); }
    if (endTime) { sql += ' AND timestamp <= ?'; params.push(endTime); }
    if (path) { sql += ' AND path LIKE ?'; params.push(`%${path}%`); }
    if (method) { sql += ' AND method = ?'; params.push(method); }

    sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
  }

  stats({ startTime, endTime } = {}) {
    if (!this.db) return { total: 0, byUser: [], byPath: [] };
    let where = '1=1';
    const params = [];
    if (startTime) { where += ' AND timestamp >= ?'; params.push(startTime); }
    if (endTime) { where += ' AND timestamp <= ?'; params.push(endTime); }

    const total = this.db.exec(`SELECT COUNT(*) as count FROM access_log WHERE ${where}`, params);
    const totalCount = total[0]?.values[0]?.[0] || 0;

    const byUserResult = this.db.exec(
      `SELECT user_id, user_name, COUNT(*) as count, AVG(response_time_ms) as avg_ms
       FROM access_log WHERE ${where} AND user_id IS NOT NULL
       GROUP BY user_id ORDER BY count DESC`, params
    );
    const byUser = (byUserResult[0]?.values || []).map(r => ({
      user_id: r[0], user_name: r[1], count: r[2], avg_response_ms: r[3]
    }));

    const byPathResult = this.db.exec(
      `SELECT path, COUNT(*) as count FROM access_log WHERE ${where}
       GROUP BY path ORDER BY count DESC LIMIT 20`, params
    );
    const byPath = (byPathResult[0]?.values || []).map(r => ({ path: r[0], count: r[1] }));

    return { total: totalCount, byUser, byPath };
  }

  cleanup(retainDays = 30) {
    if (!this.db) return 0;
    this.db.run(
      `DELETE FROM access_log WHERE timestamp < datetime('now', '-${retainDays} days', 'localtime')`
    );
    this._save();
    return this.db.getRowsModified();
  }
}

module.exports = new AccessLog();
