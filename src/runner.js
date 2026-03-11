const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { killProcessTree } = require('./utils/processTree');
const CodexAdapter = require('./adapters/codex');

/** 适配器注册表 */
const ADAPTERS = {
  codex: new CodexAdapter(),
};

/**
 * 进程管理器
 * 负责 spawn CLI 子进程、监控超时、捕获输出、终止进程
 */
class Runner {
  /**
   * @param {import('./taskStore')} store - 任务存储
   * @param {object} [options]
   * @param {number} [options.defaultTimeout=300] - 总超时秒数
   * @param {number} [options.silentTimeout=120] - 静默超时秒数
   * @param {function} [options.onOutput] - 输出回调 (taskId, line)
   * @param {function} [options.onStatusChange] - 状态变更回调 (taskId, status)
   */
  constructor(store, options = {}) {
    this.store = store;
    this.defaultTimeout = options.defaultTimeout || 300;
    this.silentTimeout = options.silentTimeout || 120;
    this.onOutput = options.onOutput || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});

    /** @type {Map<string, { process: import('child_process').ChildProcess, timer: NodeJS.Timeout, silentTimer: NodeJS.Timeout, completionTimer: NodeJS.Timeout|null, finished: boolean }>} */
    this.running = new Map();
  }

  /**
   * 启动一个任务
   * @param {object} task - 任务记录（来自 TaskStore）
   */
  start(task) {
    const taskId = task.id;
    const adapter = ADAPTERS[task.cli];
    if (!adapter) {
      this.store.updateStatus(taskId, 'failed', { error: `未知 CLI: ${task.cli}` });
      this.onStatusChange(taskId, 'failed');
      return;
    }

    // 防止重复启动
    if (this.running.has(taskId)) {
      console.log(`[Runner] 任务 ${taskId} 已在运行中，跳过`);
      return;
    }

    console.log(`[Runner] 启动任务 ${taskId} (${task.cli})`);

    // 确保运行目录存在
    const runsDir = path.join(__dirname, '..', 'runs', taskId);
    if (!fs.existsSync(runsDir)) fs.mkdirSync(runsDir, { recursive: true });

    const resultPath = path.join(runsDir, 'result.txt');

    const { cmd, args } = adapter.buildCommand({
      promptPath: task.prompt_path,
      workdir: task.workdir,
      resultPath,
      options: task.options,
    });

    // 保存元数据
    fs.writeFileSync(path.join(runsDir, 'meta.json'), JSON.stringify({
      taskId, cli: task.cli, cmd, args, startedAt: new Date().toISOString(),
    }, null, 2));

    // 更新状态为 starting
    this.store.updateStatus(taskId, 'starting');
    this.onStatusChange(taskId, 'starting');

    // spawn 子进程（先创建日志流）
    const stdoutLog = fs.createWriteStream(path.join(runsDir, 'stdout.log'));
    const stderrLog = fs.createWriteStream(path.join(runsDir, 'stderr.log'));

    let proc;
    try {
      const quotedArgs = args.map(a => a.includes(' ') || a.includes('"') ? `"${a.replace(/"/g, '\\"')}"` : a);
      const fullCmd = `${cmd} ${quotedArgs.join(' ')}`;
      console.log(`[Runner] 完整命令: ${fullCmd.slice(0, 300)}`);

      proc = spawn(fullCmd, [], {
        cwd: task.workdir || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
      });
    } catch (err) {
      console.error(`[Runner] spawn 失败 ${taskId}:`, err.message);
      stdoutLog.end();
      stderrLog.end();
      this.store.updateStatus(taskId, 'failed', { error: `spawn 失败: ${err.message}` });
      this.onStatusChange(taskId, 'failed');
      return;
    }

    console.log(`[Runner] 进程已启动 ${taskId}, PID: ${proc.pid}`);

    // 更新状态为 running
    this.store.updateStatus(taskId, 'running');
    this.onStatusChange(taskId, 'running');

    let outputLines = 0;

    /** 结果文件就绪后的短倒计时（秒） */
    const COMPLETION_GRACE = 10;

    // 捕获 stdout
    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      stdoutLog.write(text);
      outputLines++;
      try {
        this.store.updateOutputLines(taskId, outputLines);
      } catch (e) { /* 忽略 DB 更新失败 */ }
      this.onOutput(taskId, text);
      this._resetSilentTimer(taskId);

      // 结果文件已写入 → 启动短倒计时自动完成
      const entry = this.running.get(taskId);
      if (entry && !entry.completionTimer && adapter.outputMode === 'resultFile' && fs.existsSync(resultPath)) {
        const size = fs.statSync(resultPath).size;
        if (size > 0) {
          console.log(`[Runner] ${taskId} 结果文件已就绪 (${size} bytes)，${COMPLETION_GRACE}s 后自动完成`);
          entry.completionTimer = setTimeout(() => {
            this._completeByResultFile(taskId, resultPath, stdoutLog, stderrLog);
          }, COMPLETION_GRACE * 1000);
        }
      }
    });

    // 捕获 stderr（不重置静默计时器，避免 MCP 服务器日志阻止超时）
    proc.stderr.on('data', (chunk) => {
      stderrLog.write(chunk.toString('utf-8'));
    });

    /** 统一的结束处理（防止 error + close 双触发） */
    const handleFinish = (code, errorMsg) => {
      const entry = this.running.get(taskId);
      if (!entry || entry.finished) return;
      entry.finished = true;

      stdoutLog.end();
      stderrLog.end();
      this._clearAllTimers(taskId);
      this.running.delete(taskId);

      console.log(`[Runner] 任务 ${taskId} 结束，exitCode: ${code}, error: ${errorMsg || '无'}`);

      const currentTask = this.store.get(taskId);
      if (!currentTask) return;

      // 已取消
      if (currentTask.status === 'cancel_requested') {
        this.store.updateStatus(taskId, 'cancelled');
        this.onStatusChange(taskId, 'cancelled');
        return;
      }

      // 已在终态（安全跳过）
      if (['completed', 'failed', 'timeout', 'cancelled'].includes(currentTask.status)) {
        return;
      }

      if (errorMsg) {
        this.store.updateStatus(taskId, 'failed', { exitCode: code, error: errorMsg });
        this.onStatusChange(taskId, 'failed');
        return;
      }

      // 读结果文件
      let resultFilePath = null;
      if (adapter.outputMode === 'resultFile' && fs.existsSync(resultPath)) {
        resultFilePath = resultPath;
      }

      if (code === 0) {
        this.store.updateStatus(taskId, 'completed', { exitCode: code, resultPath: resultFilePath });
        this.onStatusChange(taskId, 'completed');
      } else {
        const stderrContent = fs.existsSync(path.join(runsDir, 'stderr.log'))
          ? fs.readFileSync(path.join(runsDir, 'stderr.log'), 'utf-8').slice(-500)
          : '';
        this.store.updateStatus(taskId, 'failed', {
          exitCode: code, error: `退出码 ${code}: ${stderrContent}`,
        });
        this.onStatusChange(taskId, 'failed');
      }
    };

    // 进程退出
    proc.on('close', (code) => handleFinish(code, null));

    // 进程错误（如命令不存在）
    proc.on('error', (err) => {
      console.error(`[Runner] 进程错误 ${taskId}:`, err.message);
      handleFinish(null, `进程错误: ${err.message}`);
    });

    // 设定超时 → 标记 timeout 状态后再 kill
    const timeout = (task.options?.timeout || this.defaultTimeout) * 1000;
    const timer = setTimeout(() => {
      console.log(`[Runner] 任务 ${taskId} 总超时 (${timeout / 1000}s)`);
      this._timeoutTask(taskId, `总超时 ${timeout / 1000}s`);
    }, timeout);

    // 静默超时
    const silentTimer = setTimeout(() => {
      console.log(`[Runner] 任务 ${taskId} 静默超时 (${this.silentTimeout}s)`);
      this._timeoutTask(taskId, `静默超时 ${this.silentTimeout}s`);
    }, this.silentTimeout * 1000);

    this.running.set(taskId, { process: proc, timer, silentTimer, completionTimer: null, finished: false });
  }

  /**
   * 结果文件就绪后自动完成（不等进程退出）
   * @private
   */
  _completeByResultFile(taskId, resultPath, stdoutLog, stderrLog) {
    const entry = this.running.get(taskId);
    if (!entry || entry.finished) return;
    entry.finished = true;

    console.log(`[Runner] ${taskId} 结果文件就绪，标记完成并终止进程`);
    stdoutLog.end();
    stderrLog.end();
    this._clearAllTimers(taskId);
    this.store.updateStatus(taskId, 'completed', { exitCode: 0, resultPath });
    this.onStatusChange(taskId, 'completed');

    // 异步终止残留进程（finished 已为 true，所以用 _forceKill 绕过 finished 检查）
    const pid = entry.process?.pid;
    this.running.delete(taskId);
    if (pid) {
      killProcessTree(pid).catch(e => console.error(`[Runner] 清理残留进程失败:`, e.message));
    }
  }

  /**
   * 超时处理：先标记 timeout 状态，再 kill 进程
   * @private
   */
  _timeoutTask(taskId, reason) {
    const entry = this.running.get(taskId);
    if (!entry || entry.finished) return;

    this.store.updateStatus(taskId, 'timeout', { error: reason });
    this.onStatusChange(taskId, 'timeout');

    const pid = entry.process?.pid;
    if (pid) {
      killProcessTree(pid).catch(e => console.error(`[Runner] 终止超时进程失败:`, e.message));
    }
  }

  /** 重置静默超时计时器 */
  _resetSilentTimer(taskId) {
    const entry = this.running.get(taskId);
    if (!entry || entry.finished) return;
    clearTimeout(entry.silentTimer);
    entry.silentTimer = setTimeout(() => {
      console.log(`[Runner] 任务 ${taskId} 静默超时`);
      this._timeoutTask(taskId, `静默超时 ${this.silentTimeout}s`);
    }, this.silentTimeout * 1000);
  }

  /** 终止任务（仅未完成的） */
  async _killTask(taskId) {
    const entry = this.running.get(taskId);
    if (!entry || entry.finished) return;

    this._clearAllTimers(taskId);

    try {
      if (entry.process.pid) {
        await killProcessTree(entry.process.pid);
        console.log(`[Runner] 已终止进程树 ${taskId} (PID: ${entry.process.pid})`);
      }
    } catch (e) {
      console.error(`[Runner] 终止进程 ${taskId} 失败:`, e.message);
    }
  }

  /** 清除所有定时器（含 completionTimer） */
  _clearAllTimers(taskId) {
    const entry = this.running.get(taskId);
    if (!entry) return;
    clearTimeout(entry.timer);
    clearTimeout(entry.silentTimer);
    if (entry.completionTimer) clearTimeout(entry.completionTimer);
  }

  /**
   * 请求取消任务
   * @param {string} taskId
   */
  async cancel(taskId) {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`任务 ${taskId} 不存在`);

    if (task.status === 'queued') {
      this.store.updateStatus(taskId, 'cancelled');
      this.onStatusChange(taskId, 'cancelled');
      return;
    }

    if (['running', 'starting'].includes(task.status)) {
      this.store.updateStatus(taskId, 'cancel_requested');
      this.onStatusChange(taskId, 'cancel_requested');
      await this._killTask(taskId);
    }
  }

  /** 获取正在运行的任务数 */
  getRunningTasks() {
    return this.running.size;
  }
}

module.exports = Runner;
