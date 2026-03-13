const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

/** 任务状态的合法流转映射 */
const TASK_STATE_TRANSITIONS = {
  queued: ['starting', 'cancelled'],
  starting: ['running', 'failed', 'cancel_requested', 'cancelled'],
  running: ['completed', 'failed', 'timeout', 'cancel_requested'],
  cancel_requested: ['cancelled', 'failed'],
  // 终态：不允许再流转
  completed: [],
  failed: [],
  timeout: [],
  cancelled: [],
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
  idle: ['active', 'closed', 'error'],
  active: ['ready', 'error', 'closed'],
  ready: ['active', 'closed', 'error'],
  // 终态
  closed: [],
  error: ['closed'],
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
    this._initThoughtTable();
    this._initConversationTables();
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

  /**
   * 思考记录表
   * 独立于 messages 表，记录 AI 的流式思考过程
   */
  _initThoughtTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thought_logs (
        id          TEXT PRIMARY KEY,
        target_type TEXT NOT NULL,
        target_id   TEXT NOT NULL,
        content     TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'active',
        error       TEXT,
        started_at  TEXT DEFAULT (datetime('now')),
        ended_at    TEXT,
        created_at  TEXT DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_thought_target ON thought_logs(target_type, target_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_thought_created ON thought_logs(created_at)`);
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
      logger.error(`[TaskStore] 任务 ${id} 不存在，跳过状态更新`);
      return false;
    }

    const allowed = TASK_STATE_TRANSITIONS[task.status];
    if (!allowed || !allowed.includes(newStatus)) {
      if (['completed', 'failed', 'timeout', 'cancelled'].includes(task.status)) {
        logger.info(`[TaskStore] 任务 ${id} 已处于终态 ${task.status}，忽略 → ${newStatus}`);
        return false;
      }
      logger.error(`[TaskStore] 非法状态流转: ${task.status} → ${newStatus}，跳过`);
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
    logger.info(`[TaskStore] ${id}: ${task.status} → ${newStatus}`);
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
      logger.info(`[TaskStore] 标记 ${result.changes} 个中断任务为失败`);
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
      logger.error(`[TaskStore] 会话 ${id} 不存在，跳过状态更新`);
      return false;
    }

    const allowed = SESSION_STATE_TRANSITIONS[session.status];
    if (!allowed || !allowed.includes(newStatus)) {
      if (['closed'].includes(session.status)) {
        logger.info(`[TaskStore] 会话 ${id} 已关闭，忽略 → ${newStatus}`);
        return false;
      }
      logger.error(`[TaskStore] 会话非法状态流转: ${session.status} → ${newStatus}，跳过`);
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
    logger.info(`[TaskStore] 会话 ${id}: ${session.status} → ${newStatus}`);
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
      logger.info(`[TaskStore] 标记 ${result.changes} 个中断会话为错误`);
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

  // ==================== Thought CRUD ====================

  /**
   * 创建思考记录
   * @param {'task'|'session'} targetType - 关联类型
   * @param {string} targetId - 任务ID 或 会话ID
   * @returns {string} 思考记录 ID
   */
  createThought(targetType, targetId) {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO thought_logs (id, target_type, target_id)
      VALUES (?, ?, ?)
    `).run(id, targetType, targetId);
    return id;
  }

  /**
   * 追加思考内容
   * @param {string} id - 思考记录 ID
   * @param {string} text - 增量文本
   */
  appendThought(id, text) {
    this.db.prepare(
      `UPDATE thought_logs SET content = content || ? WHERE id = ?`
    ).run(text, id);
  }

  /**
   * 终结思考记录
   * @param {string} id - 思考记录 ID
   * @param {'completed'|'interrupted'} status - 终态
   * @param {string} [error] - 中断原因
   */
  finalizeThought(id, status, error) {
    const sets = [`status = ?`, `ended_at = datetime('now')`];
    const params = [status];
    if (error) {
      sets.push('error = ?');
      params.push(error);
    }
    params.push(id);
    this.db.prepare(
      `UPDATE thought_logs SET ${sets.join(', ')} WHERE id = ?`
    ).run(...params);
  }

  /**
   * 获取指定目标的思考记录
   * @param {'task'|'session'} targetType
   * @param {string} targetId
   * @returns {object|undefined}
   */
  getThought(targetType, targetId) {
    return this.db.prepare(
      `SELECT * FROM thought_logs WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(targetType, targetId);
  }

  /**
   * 服务重启时批量终结残留的 active 思考记录
   * @returns {number} 受影响行数
   */
  markThoughtsInterrupted() {
    const result = this.db.prepare(
      `UPDATE thought_logs SET status = 'interrupted', error = '服务重启导致中断', ended_at = datetime('now') WHERE status = 'active'`
    ).run();
    if (result.changes > 0) {
      logger.info(`[TaskStore] 补偿终结 ${result.changes} 条残留 active 思考记录`);
    }
    return result.changes;
  }

  /**
   * 清理超过指定天数的思考记录
   * @param {number} [days=30] - 保留天数
   * @returns {number} 删除条数
   */
  cleanupOldThoughts(days = 30) {
    const result = this.db.prepare(
      `DELETE FROM thought_logs WHERE created_at < datetime('now', ?)`
    ).run(`-${days} days`);
    if (result.changes > 0) {
      logger.info(`[TaskStore] 清理 ${result.changes} 条过期思考记录 (>${days}天)`);
    }
    return result.changes;
  }

  // ==================== Conversation 建表 ====================

  /**
   * 多 CLI 会话表（讨论 + 群聊统一模型）
   * - conversations: 主记录（type 区分 discussion / group_chat）
   * - conversation_participants: 参与者状态
   * - conversation_messages: 消息（seq 单调递增保序）
   */
  _initConversationTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id           TEXT PRIMARY KEY,
        type         TEXT NOT NULL,
        name         TEXT,
        question     TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'idle',
        workdir      TEXT,
        sandbox      TEXT DEFAULT 'workspace-write',
        summary      TEXT,
        error        TEXT,
        created_at   TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_type ON conversations(type)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_status ON conversations(status)`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_participants (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        cli             TEXT NOT NULL,
        seq             INTEGER NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        error           TEXT,
        started_at      TEXT,
        completed_at    TEXT,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cp_conv ON conversation_participants(conversation_id)`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        participant_id  TEXT,
        cli             TEXT NOT NULL,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        seq             INTEGER NOT NULL,
        created_at      TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cm_conv ON conversation_messages(conversation_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cm_seq ON conversation_messages(conversation_id, seq)`);

    // ── 消息追踪表（思考过程 + 输入提示词）──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_message_traces (
        id          TEXT PRIMARY KEY,
        message_id  TEXT NOT NULL UNIQUE,
        thinking    TEXT,
        prompt_input TEXT,
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (message_id) REFERENCES conversation_messages(id)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_traces_msg ON conversation_message_traces(message_id)`);
  }

  // ==================== Conversation CRUD ====================

  /** Conversation 状态流转 */
  static CONV_TRANSITIONS = {
    idle: ['running', 'cancelled'],
    running: ['completed', 'partial', 'failed', 'cancelled'],
    // 终态
    completed: [],
    partial: [],
    failed: [],
    cancelled: [],
  };

  /**
   * 创建多 CLI 会话
   * @param {{ type: 'discussion'|'group_chat', name?: string, question: string, clis: string[], workdir?: string, sandbox?: string }} params
   * @returns {object} 创建的会话记录
   */
  createConversation(params) {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO conversations (id, type, name, question, workdir, sandbox)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.type,
      params.name || null,
      params.question,
      params.workdir || null,
      params.sandbox || 'workspace-write',
    );

    // 批量创建参与者
    const insertPart = this.db.prepare(`
      INSERT INTO conversation_participants (id, conversation_id, cli, seq)
      VALUES (?, ?, ?, ?)
    `);
    const insertMany = this.db.transaction((clis) => {
      for (let i = 0; i < clis.length; i++) {
        insertPart.run(crypto.randomUUID(), id, clis[i], i);
      }
    });
    insertMany(params.clis);

    return this.getConversation(id);
  }

  /**
   * 查询会话
   * @param {string} id
   * @returns {object|undefined}
   */
  getConversation(id) {
    return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  }

  /**
   * 列出所有会话（近 100 条）
   * @param {string} [type] - 可选类型过滤
   * @returns {object[]}
   */
  listConversations(type) {
    if (type) {
      return this.db.prepare(
        'SELECT * FROM conversations WHERE type = ? ORDER BY created_at DESC LIMIT 100'
      ).all(type);
    }
    return this.db.prepare(
      'SELECT * FROM conversations ORDER BY created_at DESC LIMIT 100'
    ).all();
  }

  /**
   * 更新会话状态（含状态机校验）
   * @param {string} id
   * @param {string} newStatus
   * @param {object} [extra] - 额外字段（summary, error）
   * @returns {boolean}
   */
  updateConversationStatus(id, newStatus, extra = {}) {
    const conv = this.getConversation(id);
    if (!conv) {
      logger.error(`[TaskStore] 会话 ${id} 不存在`);
      return false;
    }

    const allowed = TaskStore.CONV_TRANSITIONS[conv.status];
    if (!allowed || !allowed.includes(newStatus)) {
      if (['completed', 'partial', 'failed', 'cancelled'].includes(conv.status)) {
        logger.info(`[TaskStore] 会话 ${id} 已终态 ${conv.status}，忽略 → ${newStatus}`);
        return false;
      }
      logger.error(`[TaskStore] 会话非法流转: ${conv.status} → ${newStatus}`);
      return false;
    }

    const sets = ['status = ?'];
    const params = [newStatus];

    if (['completed', 'partial', 'failed', 'cancelled'].includes(newStatus)) {
      sets.push("completed_at = datetime('now')");
    }

    for (const [key, val] of Object.entries(extra)) {
      sets.push(`${key} = ?`);
      params.push(val);
    }

    params.push(id);
    this.db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    logger.info(`[TaskStore] 会话 ${id}: ${conv.status} → ${newStatus}`);
    return true;
  }

  /**
   * 获取会话的所有参与者
   * @param {string} conversationId
   * @returns {object[]}
   */
  getParticipants(conversationId) {
    return this.db.prepare(
      'SELECT * FROM conversation_participants WHERE conversation_id = ? ORDER BY seq ASC'
    ).all(conversationId);
  }

  /**
   * 更新参与者状态
   * @param {string} participantId
   * @param {string} status - pending/running/done/error/cancelled
   * @param {object} [extra] - 额外字段（error）
   */
  updateParticipantStatus(participantId, status, extra = {}) {
    const sets = ['status = ?'];
    const params = [status];

    if (status === 'running') {
      sets.push("started_at = datetime('now')");
    }
    if (['done', 'error', 'cancelled'].includes(status)) {
      sets.push("completed_at = datetime('now')");
    }

    for (const [key, val] of Object.entries(extra)) {
      sets.push(`${key} = ?`);
      params.push(val);
    }

    params.push(participantId);
    this.db.prepare(`UPDATE conversation_participants SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  /**
   * 添加会话消息
   * @param {{ conversationId: string, participantId?: string, cli: string, role: 'user'|'assistant', content: string, seq: number }} msg
   * @returns {object} 创建的消息记录
   */
  addConversationMessage(msg) {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO conversation_messages (id, conversation_id, participant_id, cli, role, content, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, msg.conversationId, msg.participantId || null, msg.cli, msg.role, msg.content, msg.seq);
    return this.db.prepare('SELECT * FROM conversation_messages WHERE id = ?').get(id);
  }

  /**
   * 原子添加会话消息（取号 + 插入在同一事务中，防止并行 seq 重复）
   *
   * @param {{ conversationId: string, participantId?: string, cli: string, role: 'user'|'assistant', content: string }} msg
   * @returns {object} 创建的消息记录（含自动分配的 seq）
   */
  addConversationMessageAtomic(msg) {
    const id = crypto.randomUUID();
    const insertTx = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT MAX(seq) as maxSeq FROM conversation_messages WHERE conversation_id = ?'
      ).get(msg.conversationId);
      const seq = (row?.maxSeq ?? -1) + 1;
      this.db.prepare(`
        INSERT INTO conversation_messages (id, conversation_id, participant_id, cli, role, content, seq)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, msg.conversationId, msg.participantId || null, msg.cli, msg.role, msg.content, seq);
      return seq;
    });
    const seq = insertTx();
    const record = this.db.prepare('SELECT * FROM conversation_messages WHERE id = ?').get(id);
    return record;
  }

  /**
   * 获取会话的所有消息（按 seq 正序）
   * @param {string} conversationId
   * @returns {object[]}
   */
  getConversationMessages(conversationId) {
    return this.db.prepare(
      'SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY seq ASC'
    ).all(conversationId);
  }

  /**
   * 获取会话的下一个消息序号
   * @param {string} conversationId
   * @returns {number}
   */
  getNextMessageSeq(conversationId) {
    const row = this.db.prepare(
      'SELECT MAX(seq) as maxSeq FROM conversation_messages WHERE conversation_id = ?'
    ).get(conversationId);
    return (row?.maxSeq ?? -1) + 1;
  }

  // ==================== 消息追踪（Trace） ====================

  /**
   * 创建消息追踪记录（思考过程 + 输入提示词）
   * @param {string} messageId - 关联的 conversation_messages.id
   * @param {string|null} promptInput - 发给 CLI 的完整 prompt
   * @param {string|null} thinking - 聚合后的思考过程
   * @returns {object} 创建的追踪记录
   */
  createTrace(messageId, promptInput, thinking) {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO conversation_message_traces (id, message_id, thinking, prompt_input)
      VALUES (?, ?, ?, ?)
    `).run(id, messageId, thinking || null, promptInput || null);
    return this.db.prepare('SELECT * FROM conversation_message_traces WHERE id = ?').get(id);
  }

  /**
   * 获取消息的追踪记录
   * @param {string} messageId - conversation_messages.id
   * @returns {object|undefined}
   */
  getTrace(messageId) {
    return this.db.prepare(
      'SELECT * FROM conversation_message_traces WHERE message_id = ?'
    ).get(messageId);
  }

  /**
   * 批量检查消息是否有追踪记录
   * @param {string[]} messageIds
   * @returns {Map<string, { has_thinking: boolean, has_prompt_input: boolean }>}
   */
  getTraceFlags(messageIds) {
    const flags = new Map();
    if (!messageIds.length) return flags;
    const placeholders = messageIds.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT message_id, thinking, prompt_input FROM conversation_message_traces WHERE message_id IN (${placeholders})`
    ).all(...messageIds);
    for (const r of rows) {
      flags.set(r.message_id, {
        has_thinking: !!r.thinking,
        has_prompt_input: !!r.prompt_input,
      });
    }
    return flags;
  }

  /** 服务重启时标记中断的会话为失败 */
  markConversationsInterrupted() {
    const result = this.db.prepare(
      "UPDATE conversations SET status = 'failed', error = '服务重启导致中断', completed_at = datetime('now') WHERE status IN ('idle', 'running')"
    ).run();
    if (result.changes > 0) {
      logger.info(`[TaskStore] 标记 ${result.changes} 个中断会话为失败`);
    }
    // 参与者也标记
    this.db.prepare(
      "UPDATE conversation_participants SET status = 'error', error = '服务重启导致中断', completed_at = datetime('now') WHERE status IN ('pending', 'running')"
    ).run();
    return result.changes;
  }

  // ==================== 生命周期 ====================

  /** 关闭数据库连接 */
  close() {
    this.db.close();
  }
}

module.exports = TaskStore;
