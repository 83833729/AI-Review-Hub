const fs = require('fs');
const BaseAdapter = require('./base');

/**
 * Gemini CLI 适配器
 * 使用 `gemini -p` 命令执行代码审查（headless 模式）
 *
 * Gemini CLI 关键参数：
 * - `-p prompt`：非交互 headless 模式，直接传入 prompt 文本
 * - `--approval-mode yolo`：全自动，无需确认
 * - `-o text`：纯文本输出到 stdout
 */
class GeminiAdapter extends BaseAdapter {
  name = 'gemini';
  /** Gemini 通过 stdout 输出结果 */
  inputMode = 'file';
  outputMode = 'stdout';
  concurrency = { type: 'serial' };
  /** Gemini 审查任务有长思考阶段，需要更长的静默等待 */
  silentTimeoutOverride = 300;

  /**
   * 构建 gemini 命令
   * 直接读取 prompt 文件内容传给 -p，避免 Gemini 沙箱无法访问工作区外的文件
   * @param {{ promptPath: string, workdir: string, options?: object }} task
   * @returns {{ cmd: string, args: string[] }}
   */
  buildCommand(task) {
    // 直接读取 prompt 文件内容作为 -p 参数
    const promptText = fs.readFileSync(task.promptPath, 'utf-8');

    const args = [
      '-p', promptText,
      '--approval-mode', 'yolo',
      '-o', 'text',
    ];

    return { cmd: 'gemini', args };
  }

  /**
   * Gemini 完成判定：退出码为 0 即视为完成
   * @param {number} exitCode - 进程退出码
   * @returns {boolean}
   */
  detectCompletion(exitCode) {
    return exitCode === 0;
  }
}

module.exports = GeminiAdapter;
