const BaseAdapter = require('./base');

/**
 * Codex CLI 适配器
 * 使用 `codex exec` 命令执行代码审查
 */
class CodexAdapter extends BaseAdapter {
  name = 'codex';
  inputMode = 'file';
  outputMode = 'resultFile';
  concurrency = { type: 'serial' };

  /**
   * 构建 codex exec 命令
   * @param {{ promptPath: string, workdir: string, resultPath: string, options?: object }} task
   * @returns {{ cmd: string, args: string[] }}
   */
  buildCommand(task) {
    const sandbox = task.options?.sandbox || 'workspace-write';
    const prompt = `Read the file "${task.promptPath.replace(/\\/g, '/')}" for your complete instructions. Follow them exactly.`;

    const args = [
      'exec', prompt,
      '--full-auto',
      '--skip-git-repo-check',
      '--sandbox', sandbox,
    ];

    if (task.workdir) {
      args.push('-C', task.workdir);
    }
    if (task.resultPath) {
      args.push('-o', task.resultPath);
    }

    return { cmd: 'codex', args };
  }

  /**
   * Codex 完成判定：退出码为 0 且结果文件存在
   */
  detectCompletion(exitCode, resultPath) {
    const fs = require('fs');
    if (exitCode !== 0) return false;
    if (resultPath && fs.existsSync(resultPath)) return true;
    return exitCode === 0;
  }
}

module.exports = CodexAdapter;
