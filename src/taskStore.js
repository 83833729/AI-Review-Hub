const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

/** 合法状态流转映射 */
const STATE_TRANSITIONS = {
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

class TaskStore {
  /** @param {string} dbPath - SQLite 数据库文件路径 */
  constructor(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this._initTable();
  }

  /** 初始化数据库表 */
  _initTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id            TEXT PRIMARY KEY,
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
    // 索引（避免全表扫描）
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_cli_status ON tasks(cli, status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at)`);
  }

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

  /**
   * 创建新任务
   * @param {{ id: string, cli: string, promptPath: string, workdir?: string, options?: object }} task
   * @returns {object} 创建的任务记录
   */
  create(task) {
    const existing = this.get(task.id);
    if (existing) throw new Error(`任务 ${task.id} 已存在`);

    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, cli, prompt_path, workdir, options)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(task.id, task.cli, task.promptPath, task.workdir || null,
      task.options ? JSON.stringify(task.options) : null);
    return this.get(task.id);
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
      'SELECT id, cli, status, created_at, started_at, completed_at, output_lines FROM tasks ORDER BY created_at DESC LIMIT 100'
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

    const allowed = STATE_TRANSITIONS[task.status];
    if (!allowed || !allowed.includes(newStatus)) {
      // 终态忽略，非终态警告
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

  /**
   * 服务重启时将中断的任务标记为失败
   */
  markInterrupted() {
    const result = this.db.prepare(
      "UPDATE tasks SET status = 'failed', error = '服务重启导致中断', completed_at = datetime('now') WHERE status IN ('starting', 'running', 'cancel_requested')"
    ).run();
    if (result.changes > 0) {
      console.log(`[TaskStore] 标记 ${result.changes} 个中断任务为失败`);
    }
  }

  /**
   * 删除任务（用于清理测试数据）
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

  /** 关闭数据库连接 */
  close() {
    this.db.close();
  }
}

module.exports = TaskStore;
