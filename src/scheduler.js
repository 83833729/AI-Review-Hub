const config = require('../config.json');

/**
 * 调度器
 * 管理任务排队、并发控制和资源锁
 */
class Scheduler {
  /**
   * @param {import('./taskStore')} store - 任务存储
   * @param {import('./runner')} runner - 进程管理器
   */
  constructor(store, runner) {
    this.store = store;
    this.runner = runner;
    this.interval = null;
  }

  /** 启动调度循环（每 2 秒检查一次） */
  start() {
    if (this.interval) return; // 幂等保护
    this.interval = setInterval(() => this.tick(), 2000);
    console.log('[Scheduler] 调度器已启动，每 2 秒检查队列');
  }

  /** 停止调度 */
  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  /** 调度循环：检查队列，启动可运行的任务 */
  tick() {
    const queued = this.store.getQueued();
    if (queued.length === 0) return;

    for (const task of queued) {
      if (this._canRun(task.cli)) {
        console.log(`[Scheduler] 启动任务 ${task.id} (${task.cli})`);
        try {
          this.runner.start(task);
        } catch (err) {
          console.error(`[Scheduler] 启动任务 ${task.id} 失败:`, err.message);
          // 标记为失败，防止永久卡在 queued
          try { this.store.updateStatus(task.id, 'failed', { error: `调度启动失败: ${err.message}` }); } catch (e2) {}
        }
      }
    }
  }

  /**
   * 检查指定 CLI 是否允许启动新任务
   * @param {string} cli - CLI 名称
   * @returns {boolean}
   */
  _canRun(cli) {
    const limit = config.cliConcurrency[cli] || config.cliConcurrency._default || 1;
    const running = this.store.getRunningCount(cli);
    return running < limit;
  }
}

module.exports = Scheduler;
