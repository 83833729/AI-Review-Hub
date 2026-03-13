const path = require('path');
const fs = require('fs');
const config = require('../../config.json');

/**
 * 校验 prompt 文件路径是否在白名单目录内
 * @param {string} filePath - 待校验的文件路径
 * @returns {{ valid: boolean, reason?: string }}
 */
function validatePromptPath(filePath) {
  if (!filePath) return { valid: false, reason: '缺少 promptFile 参数' };

  const resolved = path.resolve(filePath);
  const promptDir = path.resolve(config.promptDir);

  if (resolved !== promptDir && !resolved.startsWith(promptDir + path.sep)) {
    return { valid: false, reason: `路径不在白名单目录 (${config.promptDir}) 内` };
  }
  if (!fs.existsSync(resolved)) {
    return { valid: false, reason: `文件不存在: ${resolved}` };
  }
  return { valid: true };
}

/**
 * 校验工作目录是否在白名单内
 * @param {string} workdir - 待校验的工作目录
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateWorkdir(workdir) {
  if (!workdir) return { valid: true }; // 可选参数

  const resolved = path.resolve(workdir);
  const allowed = config.allowedWorkdirs.some(dir => {
    const base = path.resolve(dir);
    return resolved === base || resolved.startsWith(base + path.sep);
  });

  if (!allowed) {
    return { valid: false, reason: `工作目录不在白名单内: ${resolved}` };
  }
  if (!fs.existsSync(resolved)) {
    return { valid: false, reason: `工作目录不存在: ${resolved}` };
  }
  return { valid: true };
}

/**
 * 校验请求 token
 * @param {import('express').Request} req - Express 请求对象
 * @returns {boolean}
 */
function validateToken(req) {
  const token = req.headers['x-auth-token'] || req.query.token;
  return token === config.authToken;
}

/**
 * 校验 CLI 名称是否合法
 * @param {string} cli - CLI 工具名
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateCli(cli) {
  const allowed = ['codex', 'claude', 'gemini'];
  if (!cli) return { valid: false, reason: '缺少 cli 参数' };
  if (!allowed.includes(cli)) {
    return { valid: false, reason: `不支持的 CLI: ${cli}（支持: ${allowed.join(', ')}）` };
  }
  return { valid: true };
}

/**
 * 校验技能目录是否在白名单内
 * @param {string} skillsDir - 待校验的技能目录绝对路径
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateSkillsDir(skillsDir) {
  if (!skillsDir) return { valid: true }; // 可选参数

  const resolved = path.resolve(skillsDir);
  if (!path.isAbsolute(skillsDir)) {
    return { valid: false, reason: `skillsDir 必须是绝对路径: ${skillsDir}` };
  }

  const allowed = config.allowedWorkdirs.some(dir => {
    const base = path.resolve(dir);
    return resolved === base || resolved.startsWith(base + path.sep);
  });
  if (!allowed) {
    return { valid: false, reason: `skillsDir 不在白名单内: ${resolved}` };
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { valid: false, reason: `skillsDir 不存在或不是目录: ${resolved}` };
  }
  return { valid: true };
}

module.exports = { validatePromptPath, validateWorkdir, validateToken, validateCli, validateSkillsDir };
