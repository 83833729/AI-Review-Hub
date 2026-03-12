const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

/** 任务状态的合法流转映射 */
const TASK_STATE_TRANSITIONS = {
  queued:           ['starting', 'cancelled'],
  starting:         ['running', 'failed'],
  running:          ['completed', 'failed', 'timeout', 'cancel_requested'],
  cancel_requested: ['cancelled', 'failed'],
  // 终态：不允许再流转
  completed:        [],
  failed:           [],
  timeout:          [],
  cancelled:        [],
};

/**
 * 会话状态的合法流转映射
 * - `'idle'`: 已创建，等待首次 prompt
 * - `'active'`: 正在处理 prompt
 * - `'ready'`: prompt 完成，等待下一轮
 * - `'closed'`: 用户主动关闭
 * - `'error'`: 发生错误
 */
const SESSION_STATE_TRANSITIONS = {
  idle:    ['active', 'closed', 'error'],
  active:  ['ready', 'error', 'closed'],
  ready:   ['active', 'closed', 'error'],
  // 终态
  closed:  [],
  error:   ['closed'],
};

class TaskStore {
  /** @param {string} dbPath - SQLite 数据库文件路径 */
  constructor(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this._initTables();
  }

  // ==================== 建表 ====================

  /** 初始化所有数据库表 */
  _initTables() {
    this._initTaskTable();
    this._initSessionTables();
  }

  /** 任务表（兼容旧一次性模式） */
  _initTaskTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id            TEXT PRIMARY KEY,
        name          TEXT,
        cli           TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'queued',
        prompt_path   TEXT,
        workdir       TEXT,
        result_path   TEXT,
        exit_code     INTEGER,
        error         TEXT,
        output_lines  INTEGER DEFAULT 0,
        created_at    TEXT DEFAULT (datetime('now')),
        started_at    TEXT,
        completed_at  TEXT,
        options       TEXT
      )
    `);
    // 迁移: 旧数据库可能缺少 name 列
    try { this.db.exec('ALTER TABLE tasks ADD COLUMN name TEXT'); } catch (e) { /* 列已存在 */ }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_cli_status ON tasks(cli, status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at)`);
  }

  /** 会话表 + 消息表（多轮对话模式） */
  _initSessionTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,
        name          TEXT,
        cli           TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'idle',
        workdir       TEXT,
        options       TEXT,
        error         TEXT,
        created_at    TEXT DEFAULT (datetime('now')),
        last_active   TEXT DEFAULT (datetime('now')),
        closed_at     TEXT
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_cli ON sessions(cli)`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL,
        role          TEXT NOT NULL,
        content       TEXT NOT NULL,
        created_at    TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)`);
  }

  // ==================== 通用工具 ====================

  /**
   * 解析行中的 JSON 字段
   * @param {object} row - SQLite 行数据
   * @returns {object}
   */
  _parseRow(row) {
    if (!row) return row;
    if (row.options && typeof row.options === 'string') {
      try { row.options = JSON.parse(row.options); } catch (e) { row.options = {}; }
    }
    return row;
  }

  // ==================== Task CRUD ====================

  /**
   * 创建新任务（ID 由服务端生成）
   * @param {{ name?: string, cli: string, promptPath: string, workdir?: string, options?: object }} task
   * @returns {object} 创建的任务记录（含服务端生成的 id）
   */
  create(task) {
    const id = crypto.randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, name, cli, prompt_path, workdir, options)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      task.name || null,
      task.cli,
      task.promptPath,
      task.workdir || null,
      task.options ? JSON.stringify(task.options) : null,
    );
    return this.get(id);
  }

  /**
   * 查询任务
   * @param {string} id - 任务 ID
   * @returns {object|undefined}
   */
  get(id) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return this._parseRow(row);
  }

  /**
   * 列出所有任务（近 100 条，按创建时间倒序）
   * @returns {object[]}
   */
  list() {
    return this.db.prepare(
      'SELECT id, name, cli, status, created_at, started_at, completed_at, output_lines FROM tasks ORDER BY created_at DESC LIMIT 100'
    ).all();
  }

  /**
   * 更新任务状态（含状态机校验）
   * @param {string} id - 任务 ID
   * @param {string} newStatus - 新状态
   * @param {object} [extra] - 额外更新字段
   * @returns {boolean} 是否成功更新
   */
  updateStatus(id, newStatus, extra = {}) {
    const task = this.get(id);
    if (!task) {
      console.error(`[TaskStore] 任务 ${id} 不存在，跳过状态更新`);
      return false;
    }

    const allowed = TASK_STATE_TRANSITIONS[task.status];
    if (!allowed || !allowed.includes(newStatus)) {
      if (['completed', 'failed', 'timeout', 'cancelled'].includes(task.status)) {
        console.log(`[TaskStore] 任务 ${id} 已处于终态 ${task.status}，忽略 → ${newStatus}`);
        return false;
      }
      console.error(`[TaskStore] 非法状态流转: ${task.status} → ${newStatus}，跳过`);
      return false;
    }

    const sets = ['status = ?'];
    const params = [newStatus];

    if (newStatus === 'starting') {
      sets.push("started_at = datetime('now')");
    }
    if (['completed', 'failed', 'timeout', 'cancelled'].includes(newStatus)) {
      sets.push("completed_at = datetime('now')");
    }

    for (const [key, val] of Object.entries(extra)) {
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      sets.push(`${col} = ?`);
      params.push(val);
    }

    params.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    console.log(`[TaskStore] ${id}: ${task.status} → ${newStatus}`);
    return true;
  }

  /**
   * 获取所有排队中的任务（解析 options）
   * @returns {object[]}
   */
  getQueued() {
    const rows = this.db.prepare(
      "SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at ASC"
    ).all();
    return rows.map(r => this._parseRow(r));
  }

  /**
   * 获取指定 CLI 正在运行的任务数
   * @param {string} cli - CLI 名称
   * @returns {number}
   */
  getRunningCount(cli) {
    const row = this.db.prepare(
      "SELECT COUNT(*) as count FROM tasks WHERE cli = ? AND status IN ('starting', 'running', 'cancel_requested')"
    ).get(cli);
    return row.count;
  }

  /** 服务重启时将中断的任务标记为失败 */
  markInterrupted() {
    const result = this.db.prepare(
      "UPDATE tasks SET status = 'failed', error = '服务重启导致中断', completed_at = datetime('now') WHERE status IN ('starting', 'running', 'cancel_requested')"
    ).run();
    if (result.changes > 0) {
      console.log(`[TaskStore] 标记 ${result.changes} 个中断任务为失败`);
    }
  }

  /**
   * 删除任务
   * @param {string} id
   */
  delete(id) {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  /**
   * 更新输出行数
   * @param {string} id - 任务 ID
   * @param {number} lines - 行数
   */
  updateOutputLines(id, lines) {
    this.db.prepare('UPDATE tasks SET output_lines = ? WHERE id = ?').run(lines, id);
  }

  // ==================== Session CRUD ====================

  /**
   * 创建新会话
   * @param {{ name?: string, cli: string, workdir?: string, options?: object }} params
   * @returns {object} 创建的会话记录
   */
  createSession(params) {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO sessions (id, name, cli, workdir, options)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      id,
      params.name || null,
      params.cli,
      params.workdir || null,
      params.options ? JSON.stringify(params.options) : null,
    );
    return this.getSession(id);
  }

  /**
   * 查询会话
   * @param {string} id - 会话 ID
   * @returns {object|undefined}
   */
  getSession(id) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    return this._parseRow(row);
  }

  /**
   * 列出所有会话（近 100 条）
   * @returns {object[]}
   */
  listSessions() {
    return this.db.prepare(
      'SELECT id, name, cli, status, created_at, last_active, closed_at FROM sessions ORDER BY created_at DESC LIMIT 100'
    ).all();
  }

  /**
   * 更新会话状态（含状态机校验）
   * @param {string} id - 会话 ID
   * @param {string} newStatus - 新状态
   * @param {object} [extra] - 额外更新字段（如 error）
   * @returns {boolean}
   */
  updateSessionStatus(id, newStatus, extra = {}) {
    const session = this.getSession(id);
    if (!session) {
      console.error(`[TaskStore] 会话 ${id} 不存在，跳过状态更新`);
      return false;
    }

    const allowed = SESSION_STATE_TRANSITIONS[session.status];
    if (!allowed || !allowed.includes(newStatus)) {
      if (['closed'].includes(session.status)) {
        console.log(`[TaskStore] 会话 ${id} 已关闭，忽略 → ${newStatus}`);
        return false;
      }
      console.error(`[TaskStore] 会话非法状态流转: ${session.status} → ${newStatus}，跳过`);
      return false;
    }

    const sets = ['status = ?', "last_active = datetime('now')"];
    const params = [newStatus];

    if (newStatus === 'closed') {
      sets.push("closed_at = datetime('now')");
    }

    for (const [key, val] of Object.entries(extra)) {
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      sets.push(`${col} = ?`);
      params.push(val);
    }

    params.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    console.log(`[TaskStore] 会话 ${id}: ${session.status} → ${newStatus}`);
    return true;
  }

  /** 刷新会话最后活跃时间 */
  touchSession(id) {
    this.db.prepare("UPDATE sessions SET last_active = datetime('now') WHERE id = ?").run(id);
  }

  /**
   * 获取超过指定空闲时间的活跃会话
   * @param {number} idleSeconds - 空闲秒数
   * @returns {object[]}
   */
  getIdleSessions(idleSeconds) {
    return this.db.prepare(
      "SELECT * FROM sessions WHERE status IN ('idle', 'ready') AND last_active < datetime('now', ?)"
    ).all(`-${idleSeconds} seconds`).map(r => this._parseRow(r));
  }

  /** 服务重启时将活跃会话标记为错误 */
  markSessionsInterrupted() {
    const result = this.db.prepare(
      "UPDATE sessions SET status = 'error', error = '服务重启导致中断', closed_at = datetime('now') WHERE status IN ('idle', 'active', 'ready')"
    ).run();
    if (result.changes > 0) {
      console.log(`[TaskStore] 标记 ${result.changes} 个中断会话为错误`);
    }
  }

  // ==================== Message CRUD ====================

  /**
   * 添加消息
   * @param {{ sessionId: string, role: 'user'|'assistant', content: string }} msg
   * @returns {object} 创建的消息记录
   */
  addMessage(msg) {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO messages (id, session_id, role, content)
      VALUES (?, ?, ?, ?)
    `).run(id, msg.sessionId, msg.role, msg.content);
    // 刷新会话活跃时间
    this.touchSession(msg.sessionId);
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  }

  /**
   * 获取会话的所有消息（按时间正序）
   * @param {string} sessionId - 会话 ID
   * @returns {object[]}
   */
  getMessages(sessionId) {
    return this.db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId);
  }

  // ==================== 生命周期 ====================

  /** 关闭数据库连接 */
  close() {
    this.db.close();
  }
}

module.exports = TaskStore;
