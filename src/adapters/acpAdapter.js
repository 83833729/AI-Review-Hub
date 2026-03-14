const { spawn } = require('child_process');
const { Writable, Readable } = require('stream');
const EventEmitter = require('events');
const logger = require('../logger');
const { PermissionChecker } = require('../middleware/permission');

/**
 * CLI 类型到 ACP 启动命令的映射
 * @type {Record<string, { cmd: string, args: string[] }>}
 */
const CLI_ACP_COMMANDS = {
  codex: { cmd: 'npx', args: ['--prefer-offline', '@zed-industries/codex-acp@0.9.5'] },
  gemini: { cmd: 'gemini', args: ['--acp'] },
  claude: { cmd: 'npx', args: ['--prefer-offline', '@zed-industries/claude-agent-acp@latest'] },
};

/**
 * ACP SDK 模块级单例缓存
 * 避免每次 start() 都重复执行动态 import，首次加载后复用同一 Promise
 * @type {Promise<any>|null}
 */
let _acpSDKCache = null;
function getAcpSDK() {
  if (!_acpSDKCache) {
    _acpSDKCache = import('@agentclientprotocol/sdk').catch((err) => {
      _acpSDKCache = null; // 失败时清空缓存，允许下次重试
      throw err;
    });
  }
  return _acpSDKCache;
}

/**
 * ACP 客户端处理器
 * 实现 SDK Client 接口，处理来自 agent 的回调请求
 */
class AcpClientHandler {
  /**
   * @param {AcpAdapter} adapter - 父适配器实例
   */
  constructor(adapter) {
    this.adapter = adapter;
  }

  /**
   * 根据权限检查器决策工具调用权限
   * @param {object} params - ACP requestPermission 参数
   * @returns {Promise<object>} 权限决策结果
   */
  async requestPermission(params) {
    const toolName = params.toolCall?.title || 'unknown';
    const result = this.adapter.permissionChecker.check(params);

    if (result.approved) {
      const opt = params.options?.find(o => o.kind === 'approve') || params.options?.[0];
      return { outcome: { outcome: 'selected', optionId: opt?.optionId || '' } };
    }

    /** 拒绝：优先选 deny 选项，否则返回第一个选项 */
    logger.warn(`[ACP][Client] 工具权限拒绝: ${toolName} — ${result.reason}`);
    const denyOpt = params.options?.find(o => o.kind === 'deny')
      || params.options?.find(o => o.kind === 'reject')
      || params.options?.[0];
    return { outcome: { outcome: 'selected', optionId: denyOpt?.optionId || '' } };
  }

  /** 处理 agent 流式更新 */
  async sessionUpdate(params) {
    const u = params.update;
    if (!u) return;
    logger.debug(`[ACP][Client] sessionUpdate: type=${u.sessionUpdate}, contentType=${u.content?.type || 'N/A'}`);
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
      this.adapter.emit('chunk', { sessionId: params.sessionId, text: u.content.text });
    } else if (u.sessionUpdate === 'agent_thought_chunk' && u.content?.type === 'text') {
      this.adapter.emit('thought', { sessionId: params.sessionId, text: u.content.text });
    } else if (u.sessionUpdate === 'tool_call') {
      logger.info(`[ACP][Client] 工具调用: ${u.title} (${u.status})`);
    }
  }

  /** 处理 agent 读文件请求 */
  async readTextFile(params) {
    try {
      return { content: require('fs').readFileSync(params.path, 'utf-8') };
    } catch { return { content: '' }; }
  }

  /** 处理 agent 写文件请求 */
  async writeTextFile() { return {}; }
}

/**
 * ACP 适配器（单进程模式）
 *
 * 管理一个 CLI 类型对应的 ACP 子进程，支持在同一连接上创建多个 session。
 * - `start()`: spawn 进程 + initialize 握手（只执行一次）
 * - `createSession(cwd)`: 在已初始化的连接上创建新 session
 * - `prompt(sessionId, message)`: 在指定 session 中发送 prompt
 */
class AcpAdapter extends EventEmitter {
  /**
   * @param {'codex'|'gemini'|'claude'} cli - CLI 类型
   * @param {object} [options]
   * @param {string} [options.sandbox='workspace-write'] - 沙箱模式
   *   - `'read-only'`: 只读
   *   - `'workspace-write'`: workdir 内可写
   *   - `'danger-full-access'`: 完全放行
   * @param {string|null} [options.workdir] - 工作目录
   */
  constructor(cli, { sandbox, workdir } = {}) {
    super();
    this.cli = cli;
    /** @type {string} 沙箱模式 */
    this.sandbox = sandbox || 'workspace-write';
    /** @type {string|null} 工作目录 */
    this.workdir = workdir || null;
    /** @type {import('child_process').ChildProcess|null} */
    this.process = null;
    /** @type {any} ClientSideConnection 实例 */
    this.connection = null;
    /** @type {boolean} 是否已完成 initialize */
    this.initialized = false;
    /** @type {boolean} */
    this.closed = false;

    /** 权限检查器（由 sandbox + workdir 决定） */
    const config = require('../../config.json');
    this.permissionChecker = new PermissionChecker({
      sandbox: this.sandbox,
      workdir: this.workdir,
      allowedWorkdirs: config.allowedWorkdirs || [],
    });
  }

  /**
   * 启动 ACP 子进程并完成 initialize 握手（不创建 session）
   * @param {string} [workdir] - 初始工作目录
   * @returns {Promise<object>} initialize 响应
   */
  async start(workdir) {
    if (this.initialized) return;

    const mapping = CLI_ACP_COMMANDS[this.cli];
    if (!mapping) throw new Error(`不支持的 CLI: ${this.cli}`);

    const isWin = process.platform === 'win32';

    /** 强制子进程使用 UTF-8 编码，避免 Windows GBK 导致中文乱码 */
    const utf8Env = {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      LANG: 'en_US.UTF-8',
      ...(isWin ? { CHCP: '65001' } : {}),
    };

    /**
     * Windows 下通过 cmd /c 前缀 chcp 65001 切换控制台代码页
     * 保证 shell 命令（如 PowerShell Get-Content）输出为 UTF-8
     */
    const finalCmd = isWin ? 'cmd' : mapping.cmd;
    const finalArgs = isWin
      ? ['/c', 'chcp', '65001', '>nul', '&&', mapping.cmd, ...mapping.args]
      : mapping.args;

    /**
     * 注意：codex-acp 不支持 --sandbox 参数（会报 unexpected argument 错误）。
     * sandbox 权限控制通过 PermissionChecker 在服务端实施，无需传给 CLI 子进程。
     */

    // SDK 预加载：在 spawn 之前启动 SDK 加载，与进程启动并行
    const sdkPromise = getAcpSDK();
    // 兜底：若 spawn 先失败，避免 sdkPromise 成为未处理的 rejected Promise
    sdkPromise.catch(() => { });

    this.process = spawn(finalCmd, finalArgs, {
      cwd: workdir || undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: utf8Env,
      shell: false,
    });

    await this._waitForSpawn();

    this.process.stderr.on('data', (d) => {
      const text = d.toString().trim();
      if (text) logger.error(`[ACP][${this.cli}][stderr] ${text}`);
    });

    this.process.on('close', (code) => {
      logger.info(`[ACP] ${this.cli} 进程退出: code=${code}`);
      this.closed = true;
      this.initialized = false;
      this.connection = null;
      this.emit('close', code);
    });

    // SDK 此时可能已加载完毕（与 spawn 并行）
    const acp = await sdkPromise;
    const input = Writable.toWeb(this.process.stdin);
    const output = Readable.toWeb(this.process.stdout);
    const stream = acp.ndJsonStream(input, output);

    const clientHandler = new AcpClientHandler(this);
    this.connection = new acp.ClientSideConnection(
      (_agent) => clientHandler,
      stream,
    );

    // initialize 握手
    logger.info(`[ACP] 正在与 ${this.cli} 握手...`);
    const initResult = await this.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    this.initialized = true;
    logger.info(`[ACP] ${this.cli} 初始化完成: v${initResult.protocolVersion}`);
    return initResult;
  }

  /**
   * 在已初始化的连接上创建新 session，并根据配置切换模型
   * @param {string} cwd - 工作目录
   * @returns {Promise<string>} ACP sessionId
   */
  async createSession(cwd) {
    if (!this.initialized || !this.connection) {
      throw new Error('ACP 连接未初始化');
    }
    const result = await this.connection.newSession({
      cwd: cwd || process.cwd(),
      mcpServers: [],
    });
    logger.info(`[ACP] ${this.cli} 新 session: ${result.sessionId}`);

    // 尝试按配置切换模型
    if (result.models) {
      const current = result.models.currentModelId;
      const available = result.models.availableModels.map(m => m.modelId);
      logger.info(`[ACP] ${this.cli} 当前模型: ${current}, 可用: [${available.join(', ')}]`);

      const config = require('../../config.json');
      const preferred = config.preferredModel?.[this.cli];
      if (preferred && preferred !== current && available.includes(preferred)) {
        try {
          await this.connection.unstable_setSessionModel({
            sessionId: result.sessionId,
            modelId: preferred,
          });
          logger.info(`[ACP] ${this.cli} 模型已切换: ${current} → ${preferred}`);
        } catch (e) {
          logger.warn(`[ACP] ${this.cli} 模型切换失败: ${e.message}, 继续使用 ${current}`);
        }
      }
    }

    return result.sessionId;
  }

  /**
   * 在指定 session 中发送 prompt
   * @param {string} sessionId - ACP session ID
   * @param {string} message - 消息文本
   * @returns {Promise<{ content: string, stopReason: string }>}
   */
  async prompt(sessionId, message) {
    if (!this.connection) throw new Error('ACP 连接未建立');
    if (this.closed) throw new Error('ACP 进程已关闭');

    // 按 sessionId 过滤，只收集属于当前 session 的流式 chunk
    const chunks = [];
    const onChunk = (data) => {
      if (!data.sessionId || data.sessionId === sessionId) {
        chunks.push(data.text);
      }
    };
    this.on('chunk', onChunk);

    try {
      const result = await this.connection.prompt({
        sessionId,
        prompt: [{ type: 'text', text: message }],
      });

      // 优先用流式 chunk，fallback 到 prompt 返回体
      const content = chunks.length > 0
        ? chunks.join('')
        : this._extractContent(result);

      return { content, stopReason: result.stopReason || 'end_turn' };
    } finally {
      this.removeListener('chunk', onChunk);
    }
  }

  /**
   * 取消指定 session 当前 prompt
   * @param {string} sessionId
   */
  async cancel(sessionId) {
    if (this.connection && !this.closed) {
      try { await this.connection.cancel({ sessionId }); } catch (e) {
        logger.error(`[ACP] cancel 失败: ${e.message}`);
      }
    }
  }

  /** 从 prompt 结果提取文本 */
  _extractContent(result) {
    if (!result) return '';
    if (result.messages) {
      const texts = [];
      for (const msg of result.messages) {
        if (typeof msg.content === 'string') texts.push(msg.content);
        else if (msg.content?.type === 'text') texts.push(msg.content.text);
        else if (Array.isArray(msg.content)) {
          for (const p of msg.content) { if (p.type === 'text') texts.push(p.text); }
        }
      }
      return texts.join('\n');
    }
    if (result.content) {
      if (typeof result.content === 'string') return result.content;
      if (result.content.type === 'text') return result.content.text;
    }
    return JSON.stringify(result);
  }

  /** 等待 spawn 成功 */
  _waitForSpawn() {
    return new Promise((resolve, reject) => {
      const ok = () => { cleanup(); resolve(); };
      const fail = (err) => { cleanup(); reject(new Error(`启动 ${this.cli} ACP 失败: ${err.message}`)); };
      const cleanup = () => { this.process.removeListener('spawn', ok); this.process.removeListener('error', fail); };
      this.process.once('spawn', ok);
      this.process.once('error', fail);
    });
  }

  /** 关闭进程 */
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.initialized = false;
    try {
      if (this.process && !this.process.killed) {
        this.process.stdin.end();
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (this.process && !this.process.killed) this.process.kill('SIGTERM');
            resolve();
          }, 3000);
          if (this.process) this.process.on('close', () => { clearTimeout(timer); resolve(); });
          else { clearTimeout(timer); resolve(); }
        });
      }
    } catch (err) { logger.error(`[ACP] 关闭出错: ${err.message}`); }
    this.connection = null;
    this.process = null;
  }
}

module.exports = AcpAdapter;
