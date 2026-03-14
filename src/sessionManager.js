const path = require('path');
const AcpAdapter = require('./adapters/acpAdapter');
const logger = require('./logger');

/**
 * Session 管理器（单进程多会话模式）
 *
 * 按 CLI + workdir 复合 key 维护共享 AcpAdapter 连接，同 CLI 不同 workdir 使用独立进程。
 * 进程崩溃时自动标记所有相关 session 为错误并清理连接，下次创建时重新初始化。
 */
class SessionManager {
  /**
   * @param {import('./taskStore')} store - 数据存储
   * @param {object} options
   * @param {number} [options.idleTimeout=1800] - 空闲超时秒数
   * @param {number} [options.promptTimeout=600] - 单轮 prompt 超时秒数
   * @param {number} [options.maxSessions=5] - 最大并发会话数
   * @param {Function} [options.onMessage] - 消息回调
   * @param {Function} [options.onStatusChange] - 状态变更回调
   * @param {Function} [options.onThought] - 思考过程回调 (targetId, targetType, text) => void
   */
  constructor(store, options = {}) {
    this.store = store;
    this.idleTimeout = (options.idleTimeout || 1800) * 1000;
    this.promptTimeout = (options.promptTimeout || 600) * 1000;
    this.maxSessions = options.maxSessions || 5;
    this.onMessage = options.onMessage || (() => { });
    this.onStatusChange = options.onStatusChange || (() => { });
    this.onThought = options.onThought || null;

    /**
     * 按 cli:workdir:sandbox 复合 key 共享的 ACP 连接
     * @type {Map<string, AcpAdapter>}
     */
    this.connections = new Map();

    /**
     * 并发初始化保护：connKey → 进行中的连接 Promise
     * @type {Map<string, Promise<AcpAdapter>>}
     */
    this._pendingConnections = new Map();

    /**
     * session → { cli, workdir, sandbox, acpSessionId } 映射
     * @type {Map<string, { cli: string, workdir: string|null, sandbox: string|null, acpSessionId: string }>}
     */
    this.sessions = new Map();

    /**
     * 带 skills 的专用连接池
     *
     * key = cli:workdir:sandbox（同一 key 最多一个 entry，fingerprint 用于判断失效重建）
     * @type {Map<string, import('./utils/skillsLinker').SkillPoolEntry>}
     */
    this.skillConnections = new Map();

    /**
     * 并发初始化保护：poolKey → 进行中的 skill 连接初始化 Promise
     * @type {Map<string, Promise>}
     */
    this._pendingSkillConnections = new Map();

    /** @type {NodeJS.Timeout|null} */
    this._idleTimer = null;
  }

  /**
   * 生成连接池 key（cli + 规范化 workdir + sandbox）
   * @param {string} cli - CLI 类型
   * @param {string} [workdir] - 工作目录
   * @param {string} [sandbox] - 沙箱模式
   * @returns {string} 复合 key
   */
  _connKey(cli, workdir, sandbox) {
    return `${cli}:${path.resolve(workdir || process.cwd())}:${sandbox || 'workspace-write'}`;
  }

  /**
   * 预热 ACP 连接（服务启动时调用，后台非阻塞）
   * @param {string[]} [cliList=['gemini']] - 要预热的 CLI 类型列表
   */
  warmup(cliList = ['gemini']) {
    for (const cli of cliList) {
      logger.info(`[SessionManager] 预热 ${cli} ACP 连接...`);
      this._getConnection(cli).then(() => {
        logger.info(`[SessionManager] ${cli} ACP 连接预热完成 ✓`);
      }).catch(err => {
        logger.error(`[SessionManager] ${cli} 预热失败: ${err.message}`);
      });
    }
  }

  /**
   * 获取或创建指定 CLI + workdir + sandbox 的共享连接
   *
   * 含并发保护：多个并发请求同时触发时，复用同一个初始化 Promise，
   * 避免重复 spawn 子进程。
   * @param {string} cli
   * @param {string} [workdir]
   * @param {string} [sandbox] - 沙箱模式
   * @returns {Promise<AcpAdapter>}
   */
  async _getConnection(cli, workdir, sandbox) {
    const key = this._connKey(cli, workdir, sandbox);
    let adapter = this.connections.get(key);
    if (adapter && !adapter.closed && adapter.initialized) {
      return adapter;
    }

    // 清理旧的已关闭连接
    if (adapter) {
      this.connections.delete(key);
    }

    // 并发保护：复用进行中的初始化 Promise
    if (this._pendingConnections.has(key)) {
      return this._pendingConnections.get(key);
    }

    const initPromise = this._initConnection(cli, workdir, sandbox, key);
    this._pendingConnections.set(key, initPromise);

    try {
      return await initPromise;
    } finally {
      this._pendingConnections.delete(key);
    }
  }

  /**
   * 内部：初始化新连接（仅由 _getConnection 调用）
   * @param {string} cli
   * @param {string} [workdir]
   * @param {string} [sandbox]
   * @param {string} key - 连接池 key
   * @returns {Promise<AcpAdapter>}
   */
  async _initConnection(cli, workdir, sandbox, key) {
    const adapter = new AcpAdapter(cli, { sandbox, workdir });
    adapter.on('close', () => this._handleConnectionClose(key));
    await adapter.start(workdir);
    this.connections.set(key, adapter);
    logger.info(`[SessionManager] 新建连接: ${key}`);
    return adapter;
  }

  // ==================== Skills 连接池 ====================

  /**
   * 生成 skills 池 key（比普通连接多一个 resolvedSkillsDir 维度）
   * @param {string} cli
   * @param {string} workdir
   * @param {string} sandbox
   * @param {string} resolvedSkillsDir
   * @returns {string}
   */
  _skillPoolKey(cli, workdir, sandbox, resolvedSkillsDir) {
    return `${this._connKey(cli, workdir, sandbox)}:${resolvedSkillsDir}`;
  }

  /**
   * 获取或创建带 skills 的专用连接
   *
   * poolKey = cli:workdir:sandbox:resolvedSkillsDir（同一 poolKey 最多一个 entry）。
   * fingerprint 作为版本号：匹配则复用，不匹配则等旧 entry lease 归零后重建。
   *
   * @param {string} cli
   * @param {string} workdir
   * @param {string} sandbox
   * @param {string} skillsDir - 外部技能目录
   * @param {string} leaseId - 租约 ID（sessionId 或 taskId）
   * @returns {Promise<{ adapter: AcpAdapter, poolKey: string }>}
   */
  async _getSkillConnection(cli, workdir, sandbox, skillsDir, leaseId) {
    const { scanSkills, cleanupSkills } = require('./utils/skillsLinker');
    const { fingerprint, skills } = scanSkills(skillsDir);
    const resolvedSkillsDir = path.resolve(skillsDir);

    // 空 skills → 不走池，回退到普通连接
    if (skills.length === 0) {
      logger.debug(`[SessionManager] skillsDir ${skillsDir} 无有效技能，走普通连接`);
      const adapter = await this._getConnection(cli, workdir, sandbox);
      return { adapter, poolKey: null };
    }

    const poolKey = this._skillPoolKey(cli, workdir, sandbox, resolvedSkillsDir);

    // 1. 检查现有 entry
    const existing = this.skillConnections.get(poolKey);
    if (existing && existing.state === 'ready' && existing.adapter && !existing.adapter.closed) {
      if (existing.fingerprint === fingerprint) {
        // 命中：直接复用
        existing.leases.add(leaseId);
        existing.lastUsedAt = Date.now();
        logger.info(`[SessionManager] Skills 池命中: ${poolKey} (lease: ${leaseId})`);
        return { adapter: existing.adapter, poolKey };
      }
      // fingerprint 不同：有活跃 lease → 拒绝（不能打断正在使用的连接）
      if (existing.leases.size > 0) {
        throw new Error(`Skills 连接 ${poolKey} 正有 ${existing.leases.size} 个活跃 lease，指纹已变但无法热替换，请稍后重试`);
      }
      // 无 lease → 安全淘汰
      logger.info(`[SessionManager] Skills 指纹变化，淘汰旧 entry: ${poolKey}`);
      existing.state = 'closing';
      try { await existing.adapter.close(); } catch (_) { /* ignore */ }
      await cleanupSkills(existing.skillsHandle);
      this.skillConnections.delete(poolKey);
    } else if (existing && existing.state === 'starting') {
      // 正在初始化中：同指纹 → 等 pending；不同指纹 → 拒绝
      if (existing.fingerprint === fingerprint) {
        const pendingKey = `${poolKey}:${fingerprint}`;
        if (this._pendingSkillConnections.has(pendingKey)) {
          const result = await this._pendingSkillConnections.get(pendingKey);
          result.entry.leases.add(leaseId);
          result.entry.lastUsedAt = Date.now();
          return { adapter: result.entry.adapter, poolKey };
        }
      }
      throw new Error(`Skills 连接 ${poolKey} 正在初始化中（指纹: ${existing.fingerprint.slice(-12)}），无法创建不同版本的连接`);
    } else if (existing) {
      // adapter 已崩溃或状态异常，清理残留
      await cleanupSkills(existing.skillsHandle);
      this.skillConnections.delete(poolKey);
    }

    // 2. 并发保护：pending key 含 fingerprint，不同版本不共享
    const pendingKey = `${poolKey}:${fingerprint}`;
    if (this._pendingSkillConnections.has(pendingKey)) {
      const result = await this._pendingSkillConnections.get(pendingKey);
      result.entry.leases.add(leaseId);
      result.entry.lastUsedAt = Date.now();
      return { adapter: result.entry.adapter, poolKey };
    }

    // 3. 创建新 entry
    const initPromise = this._initSkillConnection(cli, workdir, sandbox, skillsDir, poolKey, fingerprint, leaseId);
    this._pendingSkillConnections.set(pendingKey, initPromise);

    try {
      return await initPromise;
    } finally {
      this._pendingSkillConnections.delete(pendingKey);
    }
  }

  /**
   * 内部：初始化新 skills 连接（仅由 _getSkillConnection 调用）
   * @param {string} cli
   * @param {string} workdir
   * @param {string} sandbox
   * @param {string} skillsDir
   * @param {string} poolKey
   * @param {string} fingerprint
   * @param {string} leaseId
   * @returns {Promise<{ adapter: AcpAdapter, poolKey: string, entry: object }>}
   */
  async _initSkillConnection(cli, workdir, sandbox, skillsDir, poolKey, fingerprint, leaseId) {
    const { setupSkills, cleanupSkills, scanSkills } = require('./utils/skillsLinker');
    const ownerKey = `pool-entry:${poolKey}`;

    /** @type {import('./utils/skillsLinker').SkillPoolEntry} */
    const entry = {
      adapter: null,
      skillsHandle: null,
      fingerprint,
      resolvedSkillsDir: path.resolve(skillsDir),
      ownerKey,
      state: 'starting',
      leases: new Set([leaseId]),
      lastUsedAt: Date.now(),
    };

    // 提前占位：以 starting 状态写入池，让并发请求能检测到
    this.skillConnections.set(poolKey, entry);

    try {
      // 注入 skills
      entry.skillsHandle = await setupSkills(cli, workdir, skillsDir, ownerKey);

      // 启动 ACP 进程
      entry.adapter = new AcpAdapter(cli, { sandbox, workdir });
      entry.adapter.on('close', () => this._handleSkillConnectionClose(poolKey));
      await entry.adapter.start(workdir);

      // TOCTOU 校验：启动后再扫一次，确保 fingerprint 没变
      const recheck = scanSkills(skillsDir);
      if (recheck.fingerprint !== fingerprint) {
        logger.warn(`[SessionManager] Skills 指纹在启动期间发生变化，使用新指纹`);
        entry.fingerprint = recheck.fingerprint;
      }

      entry.state = 'ready';
      logger.info(`[SessionManager] Skills 连接创建: ${poolKey} (fingerprint: ${entry.fingerprint.slice(-12)})`);

      return { adapter: entry.adapter, poolKey, entry };
    } catch (err) {
      // 启动失败回滚
      await cleanupSkills(entry.skillsHandle);
      if (entry.adapter) {
        try { await entry.adapter.close(); } catch (_) { /* ignore */ }
      }
      this.skillConnections.delete(poolKey);
      throw err;
    }
  }

  /**
   * 释放 skills 连接的一个租约（不关进程，仅减引用）
   * @param {string|null} poolKey - 池 key（null 时不做任何操作）
   * @param {string} leaseId - 租约 ID
   */
  _releaseSkillConnection(poolKey, leaseId) {
    if (!poolKey) return;
    const entry = this.skillConnections.get(poolKey);
    if (!entry) return;
    entry.leases.delete(leaseId);
    entry.lastUsedAt = Date.now();
    logger.debug(`[SessionManager] Skills lease 释放: ${poolKey} (lease: ${leaseId}, 剩余: ${entry.leases.size})`);
  }

  /**
   * Skills 连接崩溃/关闭处理（adapter close 事件触发）
   *
   * 区分预期关闭（state='closing'）和意外崩溃：
   * - closing：由主动淘汰/回收触发，不再重复清理
   * - 非 closing：意外崩溃，需清理 skills 并标记 session/task 为 error
   *
   * @param {string} poolKey - 池 key
   */
  _handleSkillConnectionClose(poolKey) {
    const entry = this.skillConnections.get(poolKey);
    if (!entry) return;

    // 预期关闭：主动淘汰/回收已处理清理，不重复
    if (entry.state === 'closing') {
      return;
    }

    logger.warn(`[SessionManager] Skills 连接崩溃: ${poolKey}`);

    // 意外崩溃：清理 skills 并标记关联 session 为 error
    const { cleanupSkills } = require('./utils/skillsLinker');
    for (const leaseId of entry.leases) {
      const sessionMapping = this.sessions.get(leaseId);
      if (sessionMapping) {
        this.sessions.delete(leaseId);
        const s = this.store.getSession(leaseId);
        if (s && !['closed', 'error'].includes(s.status)) {
          this.store.updateSessionStatus(leaseId, 'error', { error: 'Skills ACP 进程崩溃' });
          this.onStatusChange(leaseId, 'error');
        }
      }
    }

    cleanupSkills(entry.skillsHandle).catch(() => { });
    this.skillConnections.delete(poolKey);
  }

  /**
   * 回收空闲 skills 连接（由 _checkIdle 调用）
   */
  async _evictIdleSkillConnections() {
    const { cleanupSkills } = require('./utils/skillsLinker');
    for (const [key, entry] of this.skillConnections) {
      if (entry.leases.size === 0 && Date.now() - entry.lastUsedAt > this.idleTimeout) {
        entry.state = 'closing';
        logger.info(`[SessionManager] 回收空闲 Skills 连接: ${key}`);
        try { await entry.adapter.close(); } catch (_) { /* ignore */ }
        await cleanupSkills(entry.skillsHandle);
        this.skillConnections.delete(key);
      }
    }
  }

  /**
   * 创建新会话
   * @param {{ cli: string, workdir?: string, name?: string, sandbox?: string, skillsDir?: string, options?: object }} params
   * @returns {Promise<object>} 会话记录
   */
  async createSession(params) {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`已达最大并发会话数 ${this.maxSessions}，请先关闭其他会话`);
    }

    const { cleanupSkills } = require('./utils/skillsLinker');

    // 1. 创建数据库记录
    const session = this.store.createSession({
      name: params.name || null,
      cli: params.cli,
      workdir: params.workdir || null,
      options: params.options || null,
    });

    /** @type {AcpAdapter|null} ACP 连接实例 */
    let adapter = null;
    /** @type {string|null} skills 池 key（有值表示走连接池） */
    let skillPoolKey = null;

    try {
      // 2. 获取 ACP 连接
      const sandbox = params.sandbox || params.options?.sandbox || 'workspace-write';
      if (params.skillsDir) {
        // 有 skillsDir → 走 skills 连接池
        const poolResult = await this._getSkillConnection(params.cli, params.workdir, sandbox, params.skillsDir, session.id);
        adapter = poolResult.adapter;
        skillPoolKey = poolResult.poolKey;
        logger.info(`[SessionManager] 会话 ${session.id} 从 Skills 池获取连接 (key: ${skillPoolKey})`);
      } else {
        // 无 skillsDir → 复用共享连接
        adapter = await this._getConnection(params.cli, params.workdir, sandbox);
      }

      // 3. 在连接上创建 ACP session
      const acpSessionId = await adapter.createSession(params.workdir);

      // 4. 记录映射
      this.sessions.set(session.id, {
        cli: params.cli,
        workdir: params.workdir || null,
        sandbox,
        acpSessionId,
        skillPoolKey,
      });

      // 5. 更新状态
      this.store.updateSessionStatus(session.id, 'active');
      this.store.updateSessionStatus(session.id, 'ready');
      this.onStatusChange(session.id, 'ready');
      this._ensureIdleCheck();

      return this.store.getSession(session.id);
    } catch (err) {
      // 失败时释放 lease（如已获取）
      if (skillPoolKey) {
        this._releaseSkillConnection(skillPoolKey, session.id);
      }
      this.store.updateSessionStatus(session.id, 'error', { error: err.message });
      this.onStatusChange(session.id, 'error');
      throw new Error(`ACP 会话创建失败: ${err.message}`);
    }
  }

  /**
   * 发送消息
   * @param {string} sessionId
   * @param {string} message
   * @returns {Promise<{ messageId: string, reply: string, stopReason: string }>}
   */
  async sendMessage(sessionId, message) {
  const session = this.store.getSession(sessionId);
  if (!session) throw new Error(`会话 ${sessionId} 不存在`);
  if (session.status === 'closed') throw new Error('会话已关闭');
  if (session.status === 'error') throw new Error('会话处于错误状态');
  if (session.status === 'active') throw new Error('会话正在处理中');

  const mapping = this.sessions.get(sessionId);
  if (!mapping) throw new Error('会话连接不存在，可能已过期');

  // skills 池连接或共享连接
  const connKey = this._connKey(mapping.cli, mapping.workdir, mapping.sandbox);
  const adapter = mapping.skillPoolKey
    ? this.skillConnections.get(mapping.skillPoolKey)?.adapter
    : this.connections.get(connKey);
  if (!adapter || adapter.closed) throw new Error('ACP 连接已断开');

  // 记录用户消息
  this.store.addMessage({ sessionId, role: 'user', content: message });
  this.onMessage(sessionId, 'user', message);

  // active
  this.store.updateSessionStatus(sessionId, 'active');
  this.onStatusChange(sessionId, 'active');

  /** @type {string|null} 思考记录 ID */
  let thoughtId = null;

  try {
    const result = await this._executePrompt({
      adapter, acpSessionId: mapping.acpSessionId, message,
      onThought: (text) => {
        if (!thoughtId) thoughtId = this.store.createThought('session', sessionId);
        this.store.appendThought(thoughtId, text);
        this.onThought?.(sessionId, 'session', text);
      },
    });

    // 终结思考记录
    if (thoughtId) this.store.finalizeThought(thoughtId, 'completed');

    // 记录回复
    const assistantMsg = this.store.addMessage({ sessionId, role: 'assistant', content: result.content });
    this.onMessage(sessionId, 'assistant', result.content);

    // ready
    this.store.updateSessionStatus(sessionId, 'ready');
    this.onStatusChange(sessionId, 'ready');

    return { messageId: assistantMsg.id, reply: result.content, stopReason: result.stopReason };
  } catch (err) {
    const errMsg = err.message || String(err);

    // 终结思考记录（中断）
    if (thoughtId) this.store.finalizeThought(thoughtId, 'interrupted', errMsg);

    this.store.addMessage({ sessionId, role: 'assistant', content: `[错误] ${errMsg}` });

    if (errMsg.includes('超时')) {
      try { await adapter.cancel(mapping.acpSessionId); } catch (_) { }
    }

    if (adapter.closed) {
      this.store.updateSessionStatus(sessionId, 'error', { error: errMsg });
      this.onStatusChange(sessionId, 'error');
      this.sessions.delete(sessionId);
    } else {
      this.store.updateSessionStatus(sessionId, 'ready');
      this.onStatusChange(sessionId, 'ready');
    }
    throw new Error(`prompt 失败: ${errMsg}`);
  }
}

  /**
   * 关闭会话（不关闭共享进程）
   * @param {string} sessionId
   */
  async closeSession(sessionId) {
  const session = this.store.getSession(sessionId);
  if (!session) throw new Error(`会话 ${sessionId} 不存在`);

  const mapping = this.sessions.get(sessionId);
  this.sessions.delete(sessionId);

  if (!['closed'].includes(session.status)) {
    this.store.updateSessionStatus(sessionId, 'closed');
    this.onStatusChange(sessionId, 'closed');
  }

  if (mapping?.skillPoolKey) {
    // Skills 池连接：仅释放 lease
    this._releaseSkillConnection(mapping.skillPoolKey, sessionId);
  } else {
    // 共享连接：如果该 connKey 没有活跃 session 了，关闭共享进程
    const sessionSandbox = mapping?.sandbox || session.options?.sandbox || 'workspace-write';
    const connKey = this._connKey(session.cli, session.workdir, sessionSandbox);
    const hasActive = [...this.sessions.values()].some(m =>
      this._connKey(m.cli, m.workdir, m.sandbox) === connKey
    );
    if (!hasActive) {
      const adapter = this.connections.get(connKey);
      if (adapter) {
        logger.info(`[SessionManager] ${connKey} 无活跃 session，关闭共享进程`);
        await adapter.close();
        this.connections.delete(connKey);
      }
    }
  }

  return this.store.getSession(sessionId);
}

/**
 * 获取会话详情
 * @param {string} sessionId
 */
getSessionDetail(sessionId) {
  const session = this.store.getSession(sessionId);
  if (!session) throw new Error(`会话 ${sessionId} 不存在`);
  return { session, messages: this.store.getMessages(sessionId) };
}

/** 活跃会话数 */
getActiveCount() { return this.sessions.size; }

  // ==================== 一次性任务（替代 Runner） ====================

  /**
   * 正在运行的任务 → 临时 session 映射
   * @type {Map<string, { cli: string, acpSessionId: string, cancelled: boolean }>}
   */
  get _runningTasks() {
  if (!this.__runningTasks) this.__runningTasks = new Map();
  return this.__runningTasks;
}

  /**
   * 提交一次性审查任务（通过 ACP session 执行）
   *
   * 流程：注册映射 → 创建临时 session → prompt → 保存结果 → 关闭 session
   * @param {object} task - TaskStore 中的 task 记录
   * @param {string} prompt - 审查指令文本
   * @param {object} [options]
   * @param {number} [options.timeout] - 超时秒数
   * @param {Function} [options.onStatusChange] - 状态变更回调
   */
  async submitTask(task, prompt, options = {}) {
  const taskId = task.id;
  const config = require('../config.json');
  // CLI 级别超时 > 调用方指定 > 全局默认
  const cliTimeoutSec = config.defaults.cliTimeout?.[task.cli];
  const timeoutMs = (options.timeout || cliTimeoutSec || this.promptTimeout / 1000) * 1000;
  let acpSessionId = null;
  let adapter = null;
  /** @type {string|null} 思考记录 ID（必须在 try/catch 外层，catch 中需要访问） */
  let thoughtId = null;
  /** @type {string|null} skills 池 key（有值表示走连接池，finally 中释放 lease） */
  let skillPoolKey = null;

  // 提前注册映射，解决取消竞态（cancelTask 在任何阶段都能找到映射）
  this._runningTasks.set(taskId, { cli: task.cli, acpSessionId: null, adapter: null, cancelled: false });

  try {
    // 1. queued → starting
    this.store.updateStatus(taskId, 'starting');
    if (options.onStatusChange) options.onStatusChange(taskId, 'starting');

    // 2. 检查是否已被取消
    if (this._runningTasks.get(taskId)?.cancelled) {
      if (thoughtId) this.store.finalizeThought(thoughtId, 'interrupted', '用户取消');
      this.store.updateStatus(taskId, 'cancelled');
      if (options.onStatusChange) options.onStatusChange(taskId, 'cancelled');
      return;
    }

    // 3. 获取 ACP 连接
    const sandbox = task.options?.sandbox || 'workspace-write';
    if (task.skillsDir) {
      // 有 skillsDir → 走 skills 连接池
      const poolResult = await this._getSkillConnection(task.cli, task.workdir, sandbox, task.skillsDir, taskId);
      adapter = poolResult.adapter;
      skillPoolKey = poolResult.poolKey;
      logger.info(`[SessionManager] 任务 ${taskId} 从 Skills 池获取连接 (key: ${skillPoolKey})`);
    } else {
      // 无 skillsDir → 复用共享连接
      adapter = await this._getConnection(task.cli, task.workdir, sandbox);
    }

    // 5. 创建临时 session
    acpSessionId = await adapter.createSession(task.workdir);

    // 6. 更新映射中的 acpSessionId 和 adapter（cancelTask 需要用来 cancel prompt）
    const mapping = this._runningTasks.get(taskId);
    if (mapping) {
      mapping.acpSessionId = acpSessionId;
      mapping.adapter = adapter;
      mapping.skillPoolKey = skillPoolKey;
    }

    // 7. 再次检查取消标记
    if (mapping?.cancelled) {
      if (thoughtId) this.store.finalizeThought(thoughtId, 'interrupted', '用户取消');
      this.store.updateStatus(taskId, 'cancelled');
      if (options.onStatusChange) options.onStatusChange(taskId, 'cancelled');
      return;
    }

    // 8. starting → running
    this.store.updateStatus(taskId, 'running');
    if (options.onStatusChange) options.onStatusChange(taskId, 'running');

    // 9. 执行 prompt（流式 chunk + thought + 超时包裹）
    const result = await this._executePrompt({
      adapter,
      acpSessionId,
      message: prompt,
      timeoutMs,
      onChunk: options.onOutput
        ? (text) => options.onOutput(taskId, text)
        : undefined,
      onThought: (text) => {
        if (!thoughtId) thoughtId = this.store.createThought('task', taskId);
        this.store.appendThought(thoughtId, text);
        options.onThought?.(taskId, text);
      },
    });

    // 10. 保存结果到 stdout.log
    const fs = require('fs');
    const path = require('path');
    const runsDir = path.join(__dirname, '..', 'runs', taskId);
    if (!fs.existsSync(runsDir)) fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, 'stdout.log'), result.content, 'utf-8');

    // 11. 终结思考记录
    if (thoughtId) this.store.finalizeThought(thoughtId, 'completed');

    // 12. completed
    this.store.updateStatus(taskId, 'completed', { exitCode: 0 });
    if (options.onStatusChange) options.onStatusChange(taskId, 'completed');

    return result;
  } catch (err) {
    const errMsg = err.message || String(err);

    // 判断是否为用户取消（而非普通失败/超时）
    const mapping = this._runningTasks.get(taskId);
    if (mapping?.cancelled) {
      if (thoughtId) this.store.finalizeThought(thoughtId, 'interrupted', '用户取消');
      this.store.updateStatus(taskId, 'cancelled');
      if (options.onStatusChange) options.onStatusChange(taskId, 'cancelled');
      return;
    }

    // 终结思考记录（中断）
    if (thoughtId) this.store.finalizeThought(thoughtId, 'interrupted', errMsg);

    const status = errMsg.includes('超时') ? 'timeout' : 'failed';

    // 超时时主动 cancel 底层 prompt
    if (status === 'timeout' && adapter && acpSessionId) {
      try { await adapter.cancel(acpSessionId); } catch (_) { }
    }

    this.store.updateStatus(taskId, status, { error: errMsg });
    if (options.onStatusChange) options.onStatusChange(taskId, status);
    throw err;
  } finally {
    // 释放 skills 连接池 lease（如有）
    if (skillPoolKey) {
      this._releaseSkillConnection(skillPoolKey, taskId);
    }
    // 清理映射
    this._runningTasks.delete(taskId);
  }
}

  /**
   * 取消正在运行的任务
   *
   * 语义：设置 cancelled 标记 + 尝试 cancel ACP prompt
   * 实际状态流转由 submitTask 的检查点完成
   * @param {string} taskId
   */
  async cancelTask(taskId) {
  const task = this.store.get(taskId);
  if (!task) throw new Error(`任务 ${taskId} 不存在`);

  if (task.status === 'queued') {
    this.store.updateStatus(taskId, 'cancelled');
    return;
  }

  if (['starting', 'running'].includes(task.status)) {
    // 设置取消标记（submitTask 会在检查点读取）
    const mapping = this._runningTasks.get(taskId);
    if (mapping) {
      mapping.cancelled = true;
      // 如果已有 acpSessionId，尝试 cancel 底层 prompt
      if (mapping.acpSessionId) {
        // 优先用 mapping.adapter，回退到共享池或 skills 池
        const sandbox = task.options?.sandbox || 'workspace-write';
        const adpt = mapping.adapter
          || this.connections.get(this._connKey(mapping.cli, task.workdir, sandbox))
          || (mapping.skillPoolKey ? this.skillConnections.get(mapping.skillPoolKey)?.adapter : null);
        if (adpt && !adpt.closed) {
          try { await adpt.cancel(mapping.acpSessionId); } catch (_) { }
        }
      }
    }
    this.store.updateStatus(taskId, 'cancel_requested');
  }
}

/** 获取正在运行的任务数 */
getRunningTasks() { return this._runningTasks.size; }

  // ==================== 临时 Session（供编排层使用） ====================

  /**
   * 创建临时 ACP session（不纳入长会话池 `this.sessions` 计数）
   *
   * 由 MultiAgentOrchestrator 调用，用于讨论/群聊中的逐个 CLI 执行。
   * 调用方负责在完成后手动清理（不影响 maxSessions 限制）。
   *
   * @param {string} cli - CLI 类型
   * @param {string} [workdir] - 工作目录
   * @param {string} [sandbox] - 沙箱模式
   * @returns {Promise<{ adapter: AcpAdapter, acpSessionId: string, connKey: string }>}
   */
  async createTempSession(cli, workdir, sandbox) {
  const resolvedSandbox = sandbox || 'workspace-write';
  const adapter = await this._getConnection(cli, workdir, resolvedSandbox);
  const acpSessionId = await adapter.createSession(workdir);
  const connKey = this._connKey(cli, workdir, resolvedSandbox);
  logger.info(`[SessionManager] 临时 session 创建: ${cli} → ${acpSessionId}`);
  return { adapter, acpSessionId, connKey };
}

  /**
   * 暴露 _executePrompt 供编排层使用
   *
   * 在内部 prompt 执行内核上包装一层，自动收集 thinking chunks。
   *
   * @param {object} params - 同 _executePrompt 参数
   * @returns {Promise<{ content: string, stopReason: string, thinking: string|null }>}
   */
  async executePrompt(params) {
  const thinkingChunks = [];

  /** 自动注入 onThought 回调，收集思考片段 */
  const originalOnThought = params.onThought;
  params.onThought = (text) => {
    thinkingChunks.push(text);
    if (originalOnThought) originalOnThought(text);
  };

  const result = await this._executePrompt(params);
  return {
    ...result,
    thinking: thinkingChunks.length > 0 ? thinkingChunks.join('') : null,
  };
}

// ==================== 内部方法 ====================

/**
 * 统一 prompt 执行内核
 *
 * 负责：chunk/thought 监听注册/清理、adapter.prompt() + 超时包裹、结果返回。
 * 上层（sendMessage / submitTask）各自处理状态机和持久化。
 *
 * @param {object} params
 * @param {AcpAdapter} params.adapter - ACP 适配器实例
 * @param {string} params.acpSessionId - ACP session ID
 * @param {string} params.message - 消息文本
 * @param {number} [params.timeoutMs] - 超时毫秒数（缺省用全局 promptTimeout）
 * @param {Function} [params.onChunk] - 流式 chunk 回调 (text) => void
 * @param {Function} [params.onThought] - 思考 chunk 回调 (text) => void
 * @returns {Promise<{ content: string, stopReason: string }>}
 */
_executePrompt({ adapter, acpSessionId, message, timeoutMs, onChunk, onThought }) {
  const ms = timeoutMs || this.promptTimeout;
  let chunkListener = null;
  let thoughtListener = null;

  /** 注册 chunk 监听 */
  if (onChunk) {
    chunkListener = (data) => {
      if (!data.sessionId || data.sessionId === acpSessionId) {
        try { onChunk(data.text); } catch (_) { /* 隔离回调异常 */ }
      }
    };
    adapter.on('chunk', chunkListener);
  }

  /** 注册 thought 监听 */
  if (onThought) {
    thoughtListener = (data) => {
      if (!data.sessionId || data.sessionId === acpSessionId) {
        try { onThought(data.text); } catch (_) { /* 隔离回调异常 */ }
      }
    };
    adapter.on('thought', thoughtListener);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`prompt 超时 (${ms / 1000}s)`)),
      ms,
    );
    adapter.prompt(acpSessionId, message)
      .then(r => { clearTimeout(timer); resolve(r); })
      .catch(e => { clearTimeout(timer); reject(e); });
  }).finally(() => {
    if (chunkListener) adapter.removeListener('chunk', chunkListener);
    if (thoughtListener) adapter.removeListener('thought', thoughtListener);
  });
}

/**
 * 共享连接崩溃处理：标记该 connKey 关联的所有 session 为错误
 * @param {string} connKey - cli:workdir 复合 key
 */
_handleConnectionClose(connKey) {
  const { cleanupSkills } = require('./utils/skillsLinker');
  this.connections.delete(connKey);
  for (const [sessionId, mapping] of this.sessions.entries()) {
    if (this._connKey(mapping.cli, mapping.workdir, mapping.sandbox) === connKey) {
      this.sessions.delete(sessionId);
      const s = this.store.getSession(sessionId);
      if (s && !['closed', 'error'].includes(s.status)) {
        this.store.updateSessionStatus(sessionId, 'error', { error: 'ACP 进程退出' });
        this.onStatusChange(sessionId, 'error');
      }
    }
  }
}

/** 启动空闲检查 */
_ensureIdleCheck() {
  if (this._idleTimer) return;
  this._idleTimer = setInterval(() => this._checkIdle(), 60000);
}

  /** 空闲回收 */
  async _checkIdle() {
  const idleSessions = this.store.getIdleSessions(this.idleTimeout / 1000);
  for (const s of idleSessions) {
    logger.info(`[SessionManager] 会话 ${s.id} 空闲超时，关闭`);
    try { await this.closeSession(s.id); } catch (_) { }
  }
  // 回收空闲 skills 连接
  await this._evictIdleSkillConnections();
  if (this.sessions.size === 0 && this.skillConnections.size === 0 && this._idleTimer) {
    clearInterval(this._idleTimer); this._idleTimer = null;
  }
}

  /** 关闭所有（服务退出时） */
  async closeAll() {
  if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = null; }
  for (const id of [...this.sessions.keys()]) {
    try { await this.closeSession(id); } catch (_) { }
  }
  // 关闭所有共享连接
  for (const [, adapter] of this.connections) {
    try { await adapter.close(); } catch (_) { }
  }
  this.connections.clear();
  // 关闭所有 skills 连接池
  const { cleanupSkills } = require('./utils/skillsLinker');
  for (const [key, entry] of this.skillConnections) {
    entry.state = 'closing';
    try { await entry.adapter.close(); } catch (_) { }
    await cleanupSkills(entry.skillsHandle);
    logger.info(`[SessionManager] closeAll 清理 Skills 连接: ${key}`);
  }
  this.skillConnections.clear();
}
}

module.exports = SessionManager;
