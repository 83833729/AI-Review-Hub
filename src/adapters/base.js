/**
 * CLI 适配器基类
 * 每个 CLI 工具实现此接口
 */
class BaseAdapter {
  /** @type {string} CLI 名称 */
  name = 'base';

  /** @type {'stdin'|'file'|'arg'} 输入模式 */
  inputMode = 'file';

  /** @type {'stdout'|'resultFile'|'mixed'} 输出模式 */
  outputMode = 'stdout';

  /** @type {{ type: 'serial' } | { type: 'parallel', limit: number }} 并发策略 */
  concurrency = { type: 'serial' };

  /**
   * 构建 CLI 命令
   * @param {{ promptPath: string, workdir: string, resultPath: string, options?: object }} task
   * @returns {{ cmd: string, args: string[], env?: Record<string, string> }}
   */
  buildCommand(task) {
    throw new Error('子类必须实现 buildCommand');
  }

  /**
   * 判断是否完成
   * @param {number} exitCode
   * @param {string} resultPath
   * @returns {boolean}
   */
  detectCompletion(exitCode, resultPath) {
    return exitCode === 0;
  }
}

module.exports = BaseAdapter;
