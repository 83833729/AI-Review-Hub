const express = require('express');
const fs = require('fs');
const path = require('path');
const { validatePromptPath, validateWorkdir, validateToken, validateCli } = require('./utils/security');

/**
 * 创建 Express 路由
 * @param {import('./taskStore')} store
 * @param {import('./runner')} runner
 * @returns {express.Router}
 */
function createRouter(store, runner, io) {
  const router = express.Router();

  // ============ 标准 RESTful 接口 ============

  /** POST /tasks - 创建任务 */
  router.post('/tasks', express.json(), (req, res) => {
    try {
      const { taskId, cli, prompt, promptRef, workdir, options } = req.body;

      if (!taskId) return res.status(400).json({ error: '缺少 taskId' });

      // 校验 CLI
      const cliCheck = validateCli(cli);
      if (!cliCheck.valid) return res.status(400).json({ error: cliCheck.reason });

      // 处理 prompt：直接传文本或引用文件
      let promptPath;
      if (prompt) {
        // 直接传文本 → 写入文件
        const promptDir = path.resolve(require('../config.json').promptDir);
        if (!fs.existsSync(promptDir)) fs.mkdirSync(promptDir, { recursive: true });
        promptPath = path.join(promptDir, `${taskId}.txt`);
        fs.writeFileSync(promptPath, prompt, 'utf-8');
      } else if (promptRef) {
        const pathCheck = validatePromptPath(promptRef);
        if (!pathCheck.valid) return res.status(400).json({ error: pathCheck.reason });
        promptPath = path.resolve(promptRef);
      } else {
        return res.status(400).json({ error: '需要 prompt 或 promptRef' });
      }

      // 校验工作目录
      if (workdir) {
        const wdCheck = validateWorkdir(workdir);
        if (!wdCheck.valid) return res.status(400).json({ error: wdCheck.reason });
      }

      const task = store.create({ id: taskId, cli, promptPath, workdir, options });
      // WS 推送新任务
      if (io) io.emit('task:status', { taskId: task.id, status: task.status, task });
      res.json({ taskId: task.id, status: task.status, createdAt: task.created_at });
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

    // 计算已运行时间（SQLite datetime('now') 返回 UTC，需加 Z 后缀）
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
      // 尝试从 stdout.log 读取
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
      await runner.cancel(req.params.id);
      res.json({ taskId: req.params.id, status: 'cancel_requested' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ============ Antigravity 兼容层（GET 提交） ============

  /** GET /compat/submit - 通过 GET 提交任务（Antigravity read_url_content 专用） */
  router.get('/compat/submit', (req, res) => {
    try {
      const { taskId, cli, promptFile, workdir, sandbox, timeout } = req.query;

      if (!taskId) return res.status(400).json({ error: '缺少 taskId' });

      const cliCheck = validateCli(cli);
      if (!cliCheck.valid) return res.status(400).json({ error: cliCheck.reason });

      const pathCheck = validatePromptPath(promptFile);
      if (!pathCheck.valid) return res.status(400).json({ error: pathCheck.reason });

      if (workdir) {
        const wdCheck = validateWorkdir(workdir);
        if (!wdCheck.valid) return res.status(400).json({ error: wdCheck.reason });
      }

      const options = {};
      if (sandbox) options.sandbox = sandbox;
      if (timeout) options.timeout = parseInt(timeout);

      const task = store.create({
        id: taskId,
        cli,
        promptPath: path.resolve(promptFile),
        workdir: workdir || undefined,
        options: Object.keys(options).length > 0 ? options : undefined,
      });

      res.json({ taskId: task.id, status: task.status, createdAt: task.created_at });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** GET /compat/cancel/:id - 通过 GET 取消任务 */
  router.get('/compat/cancel/:id', async (req, res) => {
    try {
      await runner.cancel(req.params.id);
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
      runningTasks: runner.getRunningTasks(),
    });
  });

  /** GET /capabilities - 能力声明 */
  router.get('/capabilities', (req, res) => {
    const config = require('../config.json');
    res.json({
      supportedClis: ['codex', 'claude', 'gemini'],
      concurrency: config.cliConcurrency,
      defaults: config.defaults,
    });
  });

  return router;
}

module.exports = createRouter;
