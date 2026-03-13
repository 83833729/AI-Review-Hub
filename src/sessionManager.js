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

  /**
   * 创建新会话
   * @param {{ cli: string, workdir?: string, name?: string, sandbox?: string, skillsDir?: string, options?: object }} params
   * @returns {Promise<object>} 会话记录
   */
  async createSession(params) {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`已达最大并发会话数 ${this.maxSessions}，请先关闭其他会话`);
    }

    const { setupSkills, cleanupSkills } = require('./utils/skillsLinker');

    // 1. 创建数据库记录
    const session = this.store.createSession({
      name: params.name || null,
      cli: params.cli,
      workdir: params.workdir || null,
      options: params.options || null,
    });

    /** @type {{taskId: string, cli: string, workdir: string, injectedSkills: string[]}|null} skills 注入句柄 */
    let skillsHandle = null;
    /** @type {AcpAdapter|null} ACP 连接实例 */
    let adapter = null;
    /** @type {boolean} 是否使用专用 ACP 进程 */
    let dedicatedAdapter = false;

    try {
      // 2. 注入外部技能（如有 skillsDir）
      skillsHandle = await setupSkills(params.cli, params.workdir, params.skillsDir, session.id);

      // 3. 获取 ACP 连接
      const sandbox = params.sandbox || params.options?.sandbox || 'workspace-write';
      if (params.skillsDir) {
        // 有 skillsDir → 创建专用 ACP 进程（确保 CLI 重新扫描 skills）
        adapter = new AcpAdapter(params.cli, { sandbox, workdir: params.workdir });
        await adapter.start(params.workdir);
        dedicatedAdapter = true;
        logger.info(`[SessionManager] 会话 ${session.id} 使用专用 ACP 进程（skillsDir）`);
      } else {
        // 无 skillsDir → 复用共享连接
        adapter = await this._getConnection(params.cli, params.workdir, sandbox);
      }

      // 4. 在连接上创建 ACP session
      const acpSessionId = await adapter.createSession(params.workdir);

      // 5. 记录映射（含 skillsHandle + 专用连接标记）
      this.sessions.set(session.id, {
        cli: params.cli,
        workdir: params.workdir || null,
        sandbox,
        acpSessionId,
        skillsHandle,
        dedicatedAdapter,
        adapter: dedicatedAdapter ? adapter : null,
      });

      // 6. 专用连接注册崩溃监听（共享连接通过 _handleConnectionClose 处理）
      if (dedicatedAdapter) {
        const sid = session.id;
        adapter.on('close', () => {
          const m = this.sessions.get(sid);
          if (m?.skillsHandle) cleanupSkills(m.skillsHandle).catch(() => { });
          this.sessions.delete(sid);
          const s = this.store.getSession(sid);
          if (s && !['closed', 'error'].includes(s.status)) {
            this.store.updateSessionStatus(sid, 'error', { error: '专用 ACP 进程退出' });
            this.onStatusChange(sid, 'error');
          }
        });
      }

      // 7. 更新状态
      this.store.updateSessionStatus(session.id, 'active');
      this.store.updateSessionStatus(session.id, 'ready');
      this.onStatusChange(session.id, 'ready');
      this._ensureIdleCheck();

      return this.store.getSession(session.id);
    } catch (err) {
      // 失败时清理已创建的 skills 注入
      await cleanupSkills(skillsHandle);
      // 关闭专用 ACP 进程（如果已创建）
      if (dedicatedAdapter && adapter) {
        try { await adapter.close(); } catch (_) { /* ignore */ }
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

    // 专用连接从 mapping.adapter 取，共享连接从 connections 池取
    const adapter = mapping.dedicatedAdapter
      ? mapping.adapter
      : this.connections.get(this._connKey(mapping.cli, mapping.workdir, mapping.sandbox));
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

    // 清理 skills 注入
    const mapping = this.sessions.get(sessionId);
    if (mapping?.skillsHandle) {
      const { cleanupSkills } = require('./utils/skillsLinker');
      await cleanupSkills(mapping.skillsHandle);
    }

    this.sessions.delete(sessionId);

    if (!['closed'].includes(session.status)) {
      this.store.updateSessionStatus(sessionId, 'closed');
      this.onStatusChange(sessionId, 'closed');
    }

    // 如果该会话使用的是专用连接，直接关闭
    if (mapping?.dedicatedAdapter && mapping?.adapter) {
      try { await mapping.adapter.close(); } catch (_) { /* ignore */ }
      logger.info(`[SessionManager] 关闭会话 ${sessionId} 的专用 ACP 进程`);
    } else {
      // 共享连接：如果该 connKey 没有活跃 session 了，关闭共享进程释放资源
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
    const { setupSkills, cleanupSkills } = require('./utils/skillsLinker');
    // CLI 级别超时 > 调用方指定 > 全局默认
    const cliTimeoutSec = config.defaults.cliTimeout?.[task.cli];
    const timeoutMs = (options.timeout || cliTimeoutSec || this.promptTimeout / 1000) * 1000;
    let acpSessionId = null;
    let adapter = null;
    /** @type {string|null} 思考记录 ID（必须在 try/catch 外层，catch 中需要访问） */
    let thoughtId = null;
    /** @type {{taskId: string, cli: string, workdir: string, injectedSkills: string[]}|null} skills 注入句柄（用于 finally 清理） */
    let skillsHandle = null;
    /** @type {boolean} 是否使用专用 ACP 进程（有 skillsDir 时不复用共享连接） */
    let dedicatedAdapter = false;

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

      // 3. 注入外部技能（如有 skillsDir）
      skillsHandle = await setupSkills(task.cli, task.workdir, task.skillsDir, taskId);

      // 4. 获取 ACP 连接
      const sandbox = task.options?.sandbox || 'workspace-write';
      if (task.skillsDir) {
        // 有 skillsDir → 创建专用 ACP 进程（不入池，确保 CLI 重新扫描 skills）
        adapter = new AcpAdapter(task.cli, { sandbox, workdir: task.workdir });
        await adapter.start(task.workdir);
        dedicatedAdapter = true;
        logger.info(`[SessionManager] 任务 ${taskId} 使用专用 ACP 进程（skillsDir）`);
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
      // 无论成功失败，清理注入的 skills
      await cleanupSkills(skillsHandle);
      // 关闭专用 ACP 进程
      if (dedicatedAdapter && adapter) {
        try { await adapter.close(); } catch (_) { /* ignore */ }
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
          // 优先用 mapping.adapter（专用连接），回退到共享池
          const sandbox = task.options?.sandbox || 'workspace-write';
          const adpt = mapping.adapter
            || this.connections.get(this._connKey(mapping.cli, task.workdir, sandbox));
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
        // 清理崩溃会话的 skills 注入
        if (mapping.skillsHandle) cleanupSkills(mapping.skillsHandle).catch(() => { });
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
    if (this.sessions.size === 0 && this._idleTimer) {
      clearInterval(this._idleTimer); this._idleTimer = null;
    }
  }

  /** 关闭所有（服务退出时） */
  async closeAll() {
    if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = null; }
    for (const id of [...this.sessions.keys()]) {
      try { await this.closeSession(id); } catch (_) { }
    }
    for (const [, adapter] of this.connections) {
      try { await adapter.close(); } catch (_) { }
    }
    this.connections.clear();
  }
}

module.exports = SessionManager;
