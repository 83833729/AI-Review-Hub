const AcpAdapter = require('./adapters/acpAdapter');

/**
 * Session 管理器（单进程多会话模式）
 *
 * 按 CLI 类型维护一个共享的 AcpAdapter 连接，多个 session 复用同一进程。
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
   */
  constructor(store, options = {}) {
    this.store = store;
    this.idleTimeout = (options.idleTimeout || 1800) * 1000;
    this.promptTimeout = (options.promptTimeout || 600) * 1000;
    this.maxSessions = options.maxSessions || 5;
    this.onMessage = options.onMessage || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});

    /**
     * 按 CLI 类型共享的 ACP 连接
     * @type {Map<string, AcpAdapter>}
     */
    this.connections = new Map();

    /**
     * session → { cli, acpSessionId } 映射
     * @type {Map<string, { cli: string, acpSessionId: string }>}
     */
    this.sessions = new Map();

    /** @type {NodeJS.Timeout|null} */
    this._idleTimer = null;
  }

  /**
   * 预热 ACP 连接（服务启动时调用，后台非阻塞）
   * @param {string[]} [cliList=['gemini']] - 要预热的 CLI 类型列表
   */
  warmup(cliList = ['gemini']) {
    for (const cli of cliList) {
      console.log(`[SessionManager] 预热 ${cli} ACP 连接...`);
      this._getConnection(cli).then(() => {
        console.log(`[SessionManager] ${cli} ACP 连接预热完成 ✓`);
      }).catch(err => {
        console.error(`[SessionManager] ${cli} 预热失败: ${err.message}`);
      });
    }
  }

  /**
   * 获取或创建指定 CLI 的共享连接
   * @param {string} cli
   * @param {string} [workdir]
   * @returns {Promise<AcpAdapter>}
   */
  async _getConnection(cli, workdir) {
    let adapter = this.connections.get(cli);
    if (adapter && !adapter.closed && adapter.initialized) {
      return adapter;
    }

    // 清理旧的已关闭连接
    if (adapter) {
      this.connections.delete(cli);
    }

    // 创建新连接
    adapter = new AcpAdapter(cli);
    adapter.on('close', () => this._handleConnectionClose(cli));
    await adapter.start(workdir);
    this.connections.set(cli, adapter);
    return adapter;
  }

  /**
   * 创建新会话
   * @param {{ cli: string, workdir?: string, name?: string, options?: object }} params
   * @returns {Promise<object>} 会话记录
   */
  async createSession(params) {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`已达最大并发会话数 ${this.maxSessions}，请先关闭其他会话`);
    }

    // 1. 创建数据库记录
    const session = this.store.createSession({
      name: params.name || null,
      cli: params.cli,
      workdir: params.workdir || null,
      options: params.options || null,
    });

    try {
      // 2. 获取共享连接（首次会自动 initialize）
      const adapter = await this._getConnection(params.cli, params.workdir);

      // 3. 在共享连接上创建 ACP session
      const acpSessionId = await adapter.createSession(params.workdir);

      // 4. 记录映射
      this.sessions.set(session.id, { cli: params.cli, acpSessionId });

      // 5. 更新状态
      this.store.updateSessionStatus(session.id, 'active');
      this.store.updateSessionStatus(session.id, 'ready');
      this.onStatusChange(session.id, 'ready');
      this._ensureIdleCheck();

      return this.store.getSession(session.id);
    } catch (err) {
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

    const adapter = this.connections.get(mapping.cli);
    if (!adapter || adapter.closed) throw new Error('ACP 连接已断开');

    // 记录用户消息
    this.store.addMessage({ sessionId, role: 'user', content: message });
    this.onMessage(sessionId, 'user', message);

    // active
    this.store.updateSessionStatus(sessionId, 'active');
    this.onStatusChange(sessionId, 'active');

    try {
      const result = await this._promptWithTimeout(adapter, mapping.acpSessionId, message);

      // 记录回复
      const assistantMsg = this.store.addMessage({ sessionId, role: 'assistant', content: result.content });
      this.onMessage(sessionId, 'assistant', result.content);

      // ready
      this.store.updateSessionStatus(sessionId, 'ready');
      this.onStatusChange(sessionId, 'ready');

      return { messageId: assistantMsg.id, reply: result.content, stopReason: result.stopReason };
    } catch (err) {
      const errMsg = err.message || String(err);
      this.store.addMessage({ sessionId, role: 'assistant', content: `[错误] ${errMsg}` });

      if (errMsg.includes('超时')) {
        try { await adapter.cancel(mapping.acpSessionId); } catch (_) {}
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

    this.sessions.delete(sessionId);

    if (!['closed'].includes(session.status)) {
      this.store.updateSessionStatus(sessionId, 'closed');
      this.onStatusChange(sessionId, 'closed');
    }

    // 如果该 CLI 没有活跃 session 了，关闭共享进程释放资源
    const cli = session.cli;
    const hasActive = [...this.sessions.values()].some(m => m.cli === cli);
    if (!hasActive) {
      const adapter = this.connections.get(cli);
      if (adapter) {
        console.log(`[SessionManager] ${cli} 无活跃 session，关闭共享进程`);
        await adapter.close();
        this.connections.delete(cli);
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
    let chunkListener = null;

    // 提前注册映射，解决取消竞态（cancelTask 在任何阶段都能找到映射）
    this._runningTasks.set(taskId, { cli: task.cli, acpSessionId: null, cancelled: false });

    try {
      // 1. queued → starting
      this.store.updateStatus(taskId, 'starting');
      if (options.onStatusChange) options.onStatusChange(taskId, 'starting');

      // 2. 检查是否已被取消
      if (this._runningTasks.get(taskId)?.cancelled) {
        this.store.updateStatus(taskId, 'cancelled');
        if (options.onStatusChange) options.onStatusChange(taskId, 'cancelled');
        return;
      }

      // 3. 获取 ACP 连接
      adapter = await this._getConnection(task.cli, task.workdir);

      // 4. 创建临时 session
      acpSessionId = await adapter.createSession(task.workdir);

      // 5. 更新映射中的 acpSessionId（cancelTask 需要用来 cancel prompt）
      const mapping = this._runningTasks.get(taskId);
      if (mapping) mapping.acpSessionId = acpSessionId;

      // 6. 再次检查取消标记
      if (mapping?.cancelled) {
        this.store.updateStatus(taskId, 'cancelled');
        if (options.onStatusChange) options.onStatusChange(taskId, 'cancelled');
        return;
      }

      // 7. 监听流式 chunk，实时推送给调用方
      if (options.onOutput) {
        chunkListener = (data) => {
          if (!data.sessionId || data.sessionId === acpSessionId) {
            options.onOutput(taskId, data.text);
          }
        };
        adapter.on('chunk', chunkListener);
      }

      // 8. starting → running
      this.store.updateStatus(taskId, 'running');
      if (options.onStatusChange) options.onStatusChange(taskId, 'running');

      // 9. 带超时的 prompt
      const result = await this._promptWithTimeout(adapter, acpSessionId, prompt, timeoutMs);

      // 10. 保存结果到 stdout.log
      const fs = require('fs');
      const path = require('path');
      const runsDir = path.join(__dirname, '..', 'runs', taskId);
      if (!fs.existsSync(runsDir)) fs.mkdirSync(runsDir, { recursive: true });
      fs.writeFileSync(path.join(runsDir, 'stdout.log'), result.content, 'utf-8');

      // 11. completed
      this.store.updateStatus(taskId, 'completed', { exitCode: 0 });
      if (options.onStatusChange) options.onStatusChange(taskId, 'completed');

      return result;
    } catch (err) {
      const errMsg = err.message || String(err);
      const status = errMsg.includes('超时') ? 'timeout' : 'failed';

      // 超时时主动 cancel 底层 prompt
      if (status === 'timeout' && adapter && acpSessionId) {
        try { await adapter.cancel(acpSessionId); } catch (_) {}
      }

      this.store.updateStatus(taskId, status, { error: errMsg });
      if (options.onStatusChange) options.onStatusChange(taskId, status);
      throw err;
    } finally {
      // 移除 chunk 监听器
      if (chunkListener && adapter) {
        adapter.removeListener('chunk', chunkListener);
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
          const adapter = this.connections.get(mapping.cli);
          if (adapter && !adapter.closed) {
            try { await adapter.cancel(mapping.acpSessionId); } catch (_) {}
          }
        }
      }
      this.store.updateStatus(taskId, 'cancel_requested');
    }
  }

  /** 获取正在运行的任务数 */
  getRunningTasks() { return this._runningTasks.size; }

  // ==================== 内部方法 ====================

  /** 带超时的 prompt */
  _promptWithTimeout(adapter, acpSessionId, message, timeoutMs) {
    const ms = timeoutMs || this.promptTimeout;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`prompt 超时 (${ms / 1000}s)`)), ms);
      adapter.prompt(acpSessionId, message)
        .then(r => { clearTimeout(timer); resolve(r); })
        .catch(e => { clearTimeout(timer); reject(e); });
    });
  }

  /** 共享连接崩溃处理：标记该 CLI 所有 session 为错误 */
  _handleConnectionClose(cli) {
    this.connections.delete(cli);
    for (const [sessionId, mapping] of this.sessions.entries()) {
      if (mapping.cli === cli) {
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
      console.log(`[SessionManager] 会话 ${s.id} 空闲超时，关闭`);
      try { await this.closeSession(s.id); } catch (_) {}
    }
    if (this.sessions.size === 0 && this._idleTimer) {
      clearInterval(this._idleTimer); this._idleTimer = null;
    }
  }

  /** 关闭所有（服务退出时） */
  async closeAll() {
    if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = null; }
    for (const id of [...this.sessions.keys()]) {
      try { await this.closeSession(id); } catch (_) {}
    }
    for (const [, adapter] of this.connections) {
      try { await adapter.close(); } catch (_) {}
    }
    this.connections.clear();
  }
}

module.exports = SessionManager;
