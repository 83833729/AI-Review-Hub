/**
 * CLI 适配器基类
 * 每个 CLI 工具实现此接口
 */
class BaseAdapter {
  /** @type {string} CLI 名称 */
  name = 'base';

  /** @type {'stdin'|'file'|'arg'} 输入模式 */
  inputMode = 'file';

  /** @type {'stdout'} 输出模式（统一为 stdout 流式） */
  outputMode = 'stdout';

  /** @type {{ type: 'serial' } | { type: 'parallel', limit: number }} 并发策略 */
  concurrency = { type: 'serial' };

  /** @type {number|null} 静默超时覆盖值（秒），null 表示用 Runner 全局值 */
  silentTimeoutOverride = null;

  /**
   * 构建 CLI 命令
   * @param {{ promptPath: string, workdir: string, options?: object }} task
   * @returns {{ cmd: string, args: string[] }}
   */
  buildCommand(task) {
    throw new Error('子类必须实现 buildCommand');
  }

  /**
   * 检测 stdout 流是否已完成（可主动结束任务）
   * @param {string} line - stdout 输出的一行文本
   * @returns {boolean} 默认返回 false，由子类覆写
   */
  isStreamComplete(line) {
    return false;
  }

  /**
   * 判断是否完成
   * @param {number} exitCode
   * @returns {boolean}
   */
  detectCompletion(exitCode) {
    return exitCode === 0;
  }
}

module.exports = BaseAdapter;
