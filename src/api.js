const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { validatePromptPath, validateWorkdir, validateToken, validateCli } = require('./utils/security');

/**
 * 创建 Express 路由
 * @param {import('./taskStore')} store
 * @param {import('./sessionManager')} sessionManager
 * @param {import('socket.io').Server} io
 * @returns {express.Router}
 */
function createRouter(store, sessionManager, io) {
  const router = express.Router();

  // ============ 标准 RESTful 接口 ============

  /** POST /tasks - 创建任务（通过 ACP session 执行） */
  router.post('/tasks', express.json(), async (req, res) => {
    try {
      const { taskId, name, cli, prompt, promptRef, workdir, options } = req.body;
      const taskName = name || taskId || null;

      // 校验 CLI
      const cliCheck = validateCli(cli);
      if (!cliCheck.valid) return res.status(400).json({ error: cliCheck.reason });

      // 处理 prompt：直接传文本或引用文件
      let promptText;
      let promptPath;
      if (prompt) {
        promptText = prompt;
        const promptDir = path.resolve(require('../config.json').promptDir);
        if (!fs.existsSync(promptDir)) fs.mkdirSync(promptDir, { recursive: true });
        const fileId = crypto.randomUUID();
        promptPath = path.join(promptDir, `${fileId}.txt`);
        fs.writeFileSync(promptPath, prompt, 'utf-8');
      } else if (promptRef) {
        const pathCheck = validatePromptPath(promptRef);
        if (!pathCheck.valid) return res.status(400).json({ error: pathCheck.reason });
        promptPath = path.resolve(promptRef);
        promptText = fs.readFileSync(promptPath, 'utf-8');
      } else {
        return res.status(400).json({ error: '需要 prompt 或 promptRef' });
      }

      // 校验工作目录
      if (workdir) {
        const wdCheck = validateWorkdir(workdir);
        if (!wdCheck.valid) return res.status(400).json({ error: wdCheck.reason });
      }

      // 创建任务记录
      const task = store.create({ name: taskName, cli, promptPath, workdir, options });
      if (io) io.emit('task:status', { taskId: task.id, status: task.status, task });

      // 立即返回任务 ID（后台异步执行）
      res.json({ id: task.id, taskId: task.id, name: task.name, status: task.status, createdAt: task.created_at });

      // 后台通过 ACP 执行任务
      const cliTimeout = require('../config.json').defaults.cliTimeout?.[cli];
      const timeout = options?.timeout || cliTimeout || require('../config.json').defaults.timeout;
      sessionManager.submitTask(task, promptText, {
        timeout,
        onStatusChange: (tid, status) => {
          console.log(`[Task] ${tid} → ${status}`);
          const t = store.get(tid);
          if (io) io.emit('task:status', { taskId: tid, status, task: t });
        },
        onOutput: (tid, text) => {
          if (io) io.emit('task:output', { taskId: tid, data: text });
        },
      }).catch(err => {
        console.error(`[Task] ${task.id} 执行失败:`, err.message);
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** GET /tasks - 列出所有任务 */
  router.get('/tasks', (req, res) => {
    res.json({ tasks: store.list() });
  });

  /** GET /tasks/:id - 查询任务状态 */
  router.get('/tasks/:id', (req, res) => {
    const task = store.get(req.params.id);
    if (!task) return res.status(404).json({ error: `任务 ${req.params.id} 不存在` });

    let elapsed = 0;
    if (task.started_at) {
      const end = task.completed_at ? new Date(task.completed_at + 'Z') : new Date();
      elapsed = Math.round((end - new Date(task.started_at + 'Z')) / 1000);
    }

    res.json({
      taskId: task.id,
      cli: task.cli,
      status: task.status,
      elapsed,
      outputLines: task.output_lines,
      workdir: task.workdir || '-',
      options: task.options || {},
      createdAt: task.created_at,
      startedAt: task.started_at,
      completedAt: task.completed_at,
      error: task.error,
    });
  });

  /** GET /tasks/:id/result - 获取审查结果 */
  router.get('/tasks/:id/result', (req, res) => {
    const task = store.get(req.params.id);
    if (!task) return res.status(404).json({ error: `任务 ${req.params.id} 不存在` });

    let result = '';
    if (task.result_path && fs.existsSync(task.result_path)) {
      result = fs.readFileSync(task.result_path, 'utf-8');
    } else {
      const stdoutPath = path.join(__dirname, '..', 'runs', task.id, 'stdout.log');
      if (fs.existsSync(stdoutPath)) {
        result = fs.readFileSync(stdoutPath, 'utf-8');
      }
    }

    res.json({ taskId: task.id, status: task.status, result });
  });

  /** GET /tasks/:id/logs - 拉取增量日志 */
  router.get('/tasks/:id/logs', (req, res) => {
    const task = store.get(req.params.id);
    if (!task) return res.status(404).json({ error: `任务 ${req.params.id} 不存在` });

    const stdoutPath = path.join(__dirname, '..', 'runs', task.id, 'stdout.log');
    if (!fs.existsSync(stdoutPath)) {
      return res.json({ taskId: task.id, logs: '', cursor: 0 });
    }

    const cursor = parseInt(req.query.cursor) || 0;
    const content = fs.readFileSync(stdoutPath, 'utf-8');
    const newContent = content.slice(cursor);

    res.json({ taskId: task.id, logs: newContent, cursor: content.length });
  });

  /** POST /tasks/:id/cancel - 取消任务 */
  router.post('/tasks/:id/cancel', async (req, res) => {
    try {
      await sessionManager.cancelTask(req.params.id);
      res.json({ taskId: req.params.id, status: 'cancel_requested' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ============ 多轮对话 Session 接口 ============

  /** POST /sessions - 创建会话 */
  router.post('/sessions', express.json(), async (req, res) => {
    try {
      const { cli, workdir, name, options } = req.body;
      const cliCheck = validateCli(cli);
      if (!cliCheck.valid) return res.status(400).json({ error: cliCheck.reason });
      if (workdir) {
        const wdCheck = validateWorkdir(workdir);
        if (!wdCheck.valid) return res.status(400).json({ error: wdCheck.reason });
      }
      const session = await sessionManager.createSession({ cli, workdir, name, options });
      res.json({ id: session.id, name: session.name, cli: session.cli, status: session.status });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** POST /sessions/:id/messages - 发送消息/追问 */
  router.post('/sessions/:id/messages', express.json(), async (req, res) => {
    try {
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: '缺少 message' });
      const result = await sessionManager.sendMessage(req.params.id, message);
      if (io) io.emit('session:message', { sessionId: req.params.id, role: 'assistant', content: result.reply });
      res.json({ messageId: result.messageId, reply: result.reply, stopReason: result.stopReason });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** GET /sessions/:id - 获取会话详情 + 对话历史 */
  router.get('/sessions/:id', (req, res) => {
    try {
      const detail = sessionManager.getSessionDetail(req.params.id);
      res.json(detail);
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  /** GET /sessions - 列出所有会话 */
  router.get('/sessions', (req, res) => {
    const sessions = store.listSessions();
    res.json({ sessions, activeSessions: sessionManager.getActiveCount() });
  });

  /** POST /sessions/:id/close - 关闭会话 */
  router.post('/sessions/:id/close', async (req, res) => {
    try {
      const session = await sessionManager.closeSession(req.params.id);
      res.json({ id: session.id, status: session.status });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ============ Antigravity 兼容层（GET 提交） ============

  /** GET /compat/submit - 通过 GET 提交任务（兼容旧接口） */
  router.get('/compat/submit', async (req, res) => {
    try {
      const { taskId, cli, prompt, promptFile, workdir, sandbox, timeout } = req.query;
      const taskName = taskId || null;

      const cliCheck = validateCli(cli);
      if (!cliCheck.valid) return res.status(400).json({ error: cliCheck.reason });

      let promptText;
      let promptPath;
      if (prompt) {
        promptText = prompt;
        const promptDir = path.resolve(require('../config.json').promptDir);
        if (!fs.existsSync(promptDir)) fs.mkdirSync(promptDir, { recursive: true });
        const fileId = crypto.randomUUID();
        promptPath = path.join(promptDir, `${fileId}.txt`);
        fs.writeFileSync(promptPath, prompt, 'utf-8');
      } else if (promptFile) {
        const pathCheck = validatePromptPath(promptFile);
        if (!pathCheck.valid) return res.status(400).json({ error: pathCheck.reason });
        promptPath = path.resolve(promptFile);
        promptText = fs.readFileSync(promptPath, 'utf-8');
      } else {
        return res.status(400).json({ error: '需要 prompt 或 promptFile' });
      }

      if (workdir) {
        const wdCheck = validateWorkdir(workdir);
        if (!wdCheck.valid) return res.status(400).json({ error: wdCheck.reason });
      }

      const options = {};
      if (sandbox) options.sandbox = sandbox;
      if (timeout) options.timeout = parseInt(timeout);

      const task = store.create({
        name: taskName,
        cli,
        promptPath,
        workdir: workdir || undefined,
        options: Object.keys(options).length > 0 ? options : undefined,
      });

      res.json({ id: task.id, taskId: task.id, name: task.name, status: task.status, createdAt: task.created_at });

      // 后台执行
      sessionManager.submitTask(task, promptText, {
        timeout: options.timeout || require('../config.json').defaults.timeout,
        onStatusChange: (tid, status) => {
          console.log(`[Task] ${tid} → ${status}`);
          const t = store.get(tid);
          if (io) io.emit('task:status', { taskId: tid, status, task: t });
        },
      }).catch(err => {
        console.error(`[Task] ${task.id} 执行失败:`, err.message);
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** GET /compat/cancel/:id - 通过 GET 取消任务 */
  router.get('/compat/cancel/:id', async (req, res) => {
    try {
      await sessionManager.cancelTask(req.params.id);
      res.json({ taskId: req.params.id, status: 'cancel_requested' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ============ 系统接口 ============

  /** GET /health - 健康检查 */
  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      runningTasks: sessionManager.getRunningTasks(),
      activeSessions: sessionManager.getActiveCount(),
    });
  });

  /** GET /capabilities - 能力声明 */
  router.get('/capabilities', (req, res) => {
    res.json({
      supportedClis: ['codex', 'gemini', 'claude'],
      protocol: 'ACP',
      sessions: require('../config.json').sessions,
    });
  });

  return router;
}

module.exports = createRouter;
