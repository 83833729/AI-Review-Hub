const path = require('path');
const logger = require('../logger');

/**
 * 沙箱模式枚举
 * @type {Object<string, string>}
 */
const SANDBOX_MODES = {
  READ_ONLY: 'read-only',
  WORKSPACE_WRITE: 'workspace-write',
  FULL_ACCESS: 'danger-full-access',
};

/**
 * 工具操作类型
 * @type {Object<string, string>}
 */
const OP_TYPES = {
  READ: 'read',
  WRITE: 'write',
  SHELL: 'shell',
  OTHER: 'other',
};

/**
 * 从 ACP toolCall 参数推断操作类型
 * @param {object} params - requestPermission 的 params
 * @returns {{ op: string, targetPath: string|null }}
 */
function classifyToolCall(params) {
  const title = (params.toolCall?.title || '').toLowerCase();
  const desc = (params.description || '').toLowerCase();
  const combined = `${title} ${desc}`;

  /** 提取路径（从 toolCall 参数或描述中） */
  const targetPath = params.toolCall?.arguments?.path
    || params.toolCall?.arguments?.filePath
    || null;

  /** Shell / 命令执行类 */
  if (/shell|exec|command|terminal|bash|run/.test(combined)) {
    return { op: OP_TYPES.SHELL, targetPath };
  }
  /** 写操作类 */
  if (/write|create|delete|remove|modify|rename|move|mkdir|patch|edit|overwrite/.test(combined)) {
    return { op: OP_TYPES.WRITE, targetPath };
  }
  /** 读操作类 */
  if (/read|list|view|get|search|find|cat|head|tail|grep|stat/.test(combined)) {
    return { op: OP_TYPES.READ, targetPath };
  }

  return { op: OP_TYPES.OTHER, targetPath };
}

/**
 * 权限检查器
 *
 * 根据 sandbox 模式和 workdir 判断工具调用是否被允许。
 *
 * | 模式               | 读   | 写(workdir内) | 写(外) | Shell |
 * |--------------------|------|---------------|--------|-------|
 * | read-only          | ✅   | ❌            | ❌     | ❌    |
 * | workspace-write    | ✅   | ✅            | ❌     | ⚠️    |
 * | danger-full-access | ✅   | ✅            | ✅     | ✅    |
 */
class PermissionChecker {
  /**
   * @param {object} options
   * @param {string} options.sandbox - 沙箱模式
   * @param {string|null} options.workdir - 工作目录（绝对路径）
   * @param {string[]} [options.allowedWorkdirs] - 允许的工作目录列表
   */
  constructor({ sandbox, workdir, allowedWorkdirs } = {}) {
    this.sandbox = sandbox || SANDBOX_MODES.WORKSPACE_WRITE;
    this.workdir = workdir ? path.resolve(workdir) : null;
    this.allowedWorkdirs = (allowedWorkdirs || []).map(d => path.resolve(d));
  }

  /**
   * 检查工具调用权限
   * @param {object} params - ACP requestPermission 的 params
   * @returns {{ approved: boolean, reason: string }}
   */
  check(params) {
    const { op, targetPath } = classifyToolCall(params);
    const toolName = params.toolCall?.title || 'unknown';

    /** danger-full-access: 放行一切 */
    if (this.sandbox === SANDBOX_MODES.FULL_ACCESS) {
      this._log('APPROVED', toolName, op, targetPath, 'full-access 模式');
      return { approved: true, reason: 'full-access 模式' };
    }

    /** read-only: 只允许读 */
    if (this.sandbox === SANDBOX_MODES.READ_ONLY) {
      if (op === OP_TYPES.READ) {
        this._log('APPROVED', toolName, op, targetPath, 'read-only 允许读');
        return { approved: true, reason: 'read-only 模式允许读操作' };
      }
      this._log('DENIED', toolName, op, targetPath, 'read-only 禁止非读操作');
      return { approved: false, reason: `read-only 模式禁止 ${op} 操作` };
    }

    /** workspace-write: 读允许，写/shell 需检查路径 */
    if (op === OP_TYPES.READ) {
      this._log('APPROVED', toolName, op, targetPath, 'workspace-write 允许读');
      return { approved: true, reason: '允许读操作' };
    }

    if (op === OP_TYPES.SHELL) {
      this._log('APPROVED', toolName, op, targetPath, 'workspace-write 允许 shell（应用层无法精确拦截）');
      return { approved: true, reason: 'workspace-write 允许 shell（由 CLI 自身 sandbox 限制）' };
    }

    if (op === OP_TYPES.WRITE && targetPath) {
      const resolved = path.resolve(targetPath);
      if (this.workdir && resolved.startsWith(this.workdir)) {
        this._log('APPROVED', toolName, op, targetPath, 'workdir 内写入');
        return { approved: true, reason: '路径在 workdir 范围内' };
      }
      /** 检查 allowedWorkdirs */
      const inAllowed = this.allowedWorkdirs.some(d => resolved.startsWith(d));
      if (inAllowed) {
        this._log('APPROVED', toolName, op, targetPath, 'allowedWorkdirs 内写入');
        return { approved: true, reason: '路径在允许目录范围内' };
      }
      this._log('DENIED', toolName, op, targetPath, '路径超出 workdir 范围');
      return { approved: false, reason: `写操作路径 ${resolved} 超出 workdir 范围` };
    }

    /** 写操作无路径信息 → 保守放行（无法精确判断） */
    if (op === OP_TYPES.WRITE) {
      this._log('APPROVED', toolName, op, null, 'workspace-write 写操作无路径，保守放行');
      return { approved: true, reason: '写操作无路径信息，保守放行' };
    }

    /** 其他操作 → 放行 */
    this._log('APPROVED', toolName, op, targetPath, '其他操作');
    return { approved: true, reason: '默认放行' };
  }

  /**
   * 审计日志
   * @param {'APPROVED'|'DENIED'} decision
   * @param {string} tool
   * @param {string} op
   * @param {string|null} targetPath
   * @param {string} reason
   */
  _log(decision, tool, op, targetPath, reason) {
    const msg = `[Permission] ${decision} | sandbox=${this.sandbox} | tool=${tool} | op=${op} | path=${targetPath || '-'} | ${reason}`;
    if (decision === 'DENIED') {
      logger.warn(msg);
    } else {
      logger.info(msg);
    }
  }
}

module.exports = { PermissionChecker, SANDBOX_MODES, OP_TYPES };
