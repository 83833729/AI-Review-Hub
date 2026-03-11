const fs = require('fs');
const BaseAdapter = require('./base');

/**
 * Codex CLI 适配器
 * 使用 `codex exec --json` 命令执行代码审查
 * 结果通过 stdout JSONL 流式输出
 */
class CodexAdapter extends BaseAdapter {
  name = 'codex';
  inputMode = 'file';
  /** 流式输出到 stdout，由 runner 捕获到 stdout.log */
  outputMode = 'stdout';
  concurrency = { type: 'serial' };
  /** Codex --json 模式下 JSONL 事件之间有长间隔（思考+读文件），需更长静默等待 */
  silentTimeoutOverride = 300;

  /**
   * 构建 codex exec 命令
   * 直接读取 prompt 文件内容传给 exec，避免 PowerShell 编码问题
   * @param {{ promptPath: string, workdir: string, options?: object }} task
   * @returns {{ cmd: string, args: string[] }}
   */
  buildCommand(task) {
    const sandbox = task.options?.sandbox || 'workspace-write';
    // 直接读取 prompt 文件内容，避免 Codex 通过 PowerShell 读文件导致中文乱码
    const promptText = fs.readFileSync(task.promptPath, 'utf-8');

    const args = [
      'exec', promptText,
      '--full-auto',
      '--skip-git-repo-check',
      '--sandbox', sandbox,
      '--json',
    ];

    if (task.workdir) {
      args.push('-C', task.workdir);
    }

    return { cmd: 'codex', args };
  }

  /**
   * 检测 JSONL 流是否结束
   * Codex 的 `--json` 模式在 turn.completed 事件后进入空闲，需主动结束
   * @param {string} line - stdout 输出的一行文本
   * @returns {boolean} 是否流已完成
   */
  isStreamComplete(line) {
    try {
      const event = JSON.parse(line.trim());
      return event.type === 'turn.completed';
    } catch {
      return false;
    }
  }

  /**
   * Codex 完成判定：退出码为 0 即完成
   * @param {number} exitCode - 进程退出码
   * @returns {boolean}
   */
  detectCompletion(exitCode) {
    return exitCode === 0;
  }
}

module.exports = CodexAdapter;
