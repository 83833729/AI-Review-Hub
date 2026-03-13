const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { validatePromptPath, validateWorkdir, validateToken, validateCli, validateSkillsDir } = require('./utils/security');
const logger = require('./logger');

/**
 * 创建 Express 路由
 * @param {import('./taskStore')} store
 * @param {import('./sessionManager')} sessionManager
 * @param {import('socket.io').Server} io
 * @param {import('./multiAgentOrchestrator')} [orchestrator] - 多智能体编排器
 * @returns {express.Router}
 */
function createRouter(store, sessionManager, io, orchestrator) {
  const router = express.Router();

  // ============ 标准 RESTful 接口 ============

  /** POST /tasks - 创建任务（通过 ACP session 执行） */
  router.post('/tasks', express.json(), async (req, res) => {
    try {
      const { taskId, name, cli, prompt, promptRef, workdir, options, skillsDir } = req.body;
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

      // 校验技能目录
      if (skillsDir) {
        const sdCheck = validateSkillsDir(skillsDir);
        if (!sdCheck.valid) return res.status(400).json({ error: sdCheck.reason });
      }

      // 创建任务记录
      const task = store.create({ name: taskName, cli, promptPath, workdir, skillsDir, options });
      if (io) io.emit('task:status', { taskId: task.id, status: task.status, task });

      // 立即返回任务 ID（后台异步执行）
      res.json({ id: task.id, taskId: task.id, name: task.name, status: task.status, createdAt: task.created_at });

      // 后台通过 ACP 执行任务
      const cliTimeout = require('../config.json').defaults.cliTimeout?.[cli];
      const timeout = options?.timeout || cliTimeout || require('../config.json').defaults.timeout;
      sessionManager.submitTask(task, promptText, {
        timeout,
        onStatusChange: (tid, status) => {
          logger.info(`[Task] ${tid} → ${status}`);
          const t = store.get(tid);
          if (io) io.emit('task:status', { taskId: tid, status, task: t });
        },
        onOutput: (tid, text) => {
          if (io) io.emit('task:output', { taskId: tid, data: text });
        },
        onThought: (tid, text) => {
          if (io) io.emit('task:thought', { taskId: tid, data: text });
        },
      }).catch(err => {
        logger.error(`[Task] ${task.id} 执行失败: ${err.message}`);
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

  /** GET /tasks/:id/thought - 获取任务的思考记录 */
  router.get('/tasks/:id/thought', (req, res) => {
    const thought = store.getThought('task', req.params.id);
    if (!thought) return res.json({ thought: null });

    /** 计算思考耗时（秒） */
    let duration = 0;
    if (thought.started_at) {
      const end = thought.ended_at ? new Date(thought.ended_at + 'Z') : new Date();
      duration = Math.round((end - new Date(thought.started_at + 'Z')) / 1000);
    }

    res.json({ thought: { ...thought, duration } });
  });

  /** GET /sessions/:id/thought - 获取会话的思考记录 */
  router.get('/sessions/:id/thought', (req, res) => {
    const thought = store.getThought('session', req.params.id);
    if (!thought) return res.json({ thought: null });

    let duration = 0;
    if (thought.started_at) {
      const end = thought.ended_at ? new Date(thought.ended_at + 'Z') : new Date();
      duration = Math.round((end - new Date(thought.started_at + 'Z')) / 1000);
    }

    res.json({ thought: { ...thought, duration } });
  });

  // ============ 多轮对话 Session 接口 ============

  /** POST /sessions - 创建会话 */
  router.post('/sessions', express.json(), async (req, res) => {
    try {
      const { cli, workdir, name, sandbox, options, skillsDir } = req.body;
      const cliCheck = validateCli(cli);
      if (!cliCheck.valid) return res.status(400).json({ error: cliCheck.reason });
      if (workdir) {
        const wdCheck = validateWorkdir(workdir);
        if (!wdCheck.valid) return res.status(400).json({ error: wdCheck.reason });
      }
      if (skillsDir) {
        const sdCheck = validateSkillsDir(skillsDir);
        if (!sdCheck.valid) return res.status(400).json({ error: sdCheck.reason });
      }
      const session = await sessionManager.createSession({ cli, workdir, name, sandbox, skillsDir, options });
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

  // ============ 多 CLI 会话（讨论 / 群聊）接口 ============

  /** POST /conversations - 创建讨论或群聊 */
  router.post('/conversations', express.json(), async (req, res) => {
    try {
      if (!orchestrator) return res.status(501).json({ error: '编排器未初始化' });

      const { type, question, clis, name, workdir, sandbox } = req.body;
      if (!type || !['discussion', 'group_chat'].includes(type)) {
        return res.status(400).json({ error: "type 必须为 'discussion' 或 'group_chat'" });
      }
      if (!question) return res.status(400).json({ error: '缺少 question' });
      if (!Array.isArray(clis) || clis.length < 2) {
        return res.status(400).json({ error: 'clis 必须为至少 2 个 CLI 的数组' });
      }

      for (const cli of clis) {
        const check = validateCli(cli);
        if (!check.valid) return res.status(400).json({ error: `CLI ${cli}: ${check.reason}` });
      }

      if (workdir) {
        const wdCheck = validateWorkdir(workdir);
        if (!wdCheck.valid) return res.status(400).json({ error: wdCheck.reason });
      }

      // 先同步创建记录，拿到确定 ID
      const conv = store.createConversation({ type, name, question, clis, workdir, sandbox });

      /** WebSocket 回调 */
      const callbacks = {
        onMessage: (convId, cli, role, content, seq) => {
          if (io) io.emit('conversation:message', { conversationId: convId, cli, role, content, seq });
        },
        onParticipant: (convId, cli, status) => {
          if (io) io.emit('conversation:participant', { conversationId: convId, cli, status });
        },
        onStatus: (convId, status, convType) => {
          if (io) io.emit('conversation:status', { conversationId: convId, status, type: convType });
        },
      };

      // 后台异步执行（传入已创建的 ID）
      const method = type === 'discussion' ? 'runDiscussion' : 'runGroupChat';
      orchestrator[method](conv.id, callbacks)
        .catch(err => logger.error(`[Conversation] ${type} ${conv.id} 失败: ${err.message}`));

      res.json({
        id: conv.id,
        type,
        name: conv.name,
        status: conv.status,
        createdAt: conv.created_at,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** GET /conversations - 列出所有讨论/群聊 */
  router.get('/conversations', (req, res) => {
    const type = req.query.type || undefined;
    const conversations = store.listConversations(type);
    res.json({ conversations });
  });

  /** GET /conversations/:id - 获取详情（含参与者 + 消息 + trace 标记） */
  router.get('/conversations/:id', (req, res) => {
    const conv = store.getConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: `会话 ${req.params.id} 不存在` });

    const participants = store.getParticipants(conv.id);
    const messages = store.getConversationMessages(conv.id);

    // 批量获取 trace 标记（懒加载，不返回大字段）
    const msgIds = messages.filter(m => m.role === 'assistant').map(m => m.id);
    const traceFlags = store.getTraceFlags(msgIds);

    const enrichedMessages = messages.map(m => ({
      ...m,
      has_thinking: traceFlags.get(m.id)?.has_thinking || false,
      has_prompt_input: traceFlags.get(m.id)?.has_prompt_input || false,
    }));

    res.json({ conversation: conv, participants, messages: enrichedMessages });
  });

  /** GET /conversations/:convId/messages/:msgId/trace - 获取消息追踪记录（思考+输入） */
  router.get('/conversations/:convId/messages/:msgId/trace', (req, res) => {
    const trace = store.getTrace(req.params.msgId);
    if (!trace) return res.status(404).json({ error: '该消息无追踪记录' });
    res.json(trace);
  });

  /** POST /conversations/:id/cancel - 取消 */
  router.post('/conversations/:id/cancel', async (req, res) => {
    try {
      if (!orchestrator) return res.status(501).json({ error: '编排器未初始化' });
      await orchestrator.cancelConversation(req.params.id);
      res.json({ id: req.params.id, status: 'cancelled' });
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
          logger.info(`[Task] ${tid} → ${status}`);
          const t = store.get(tid);
          if (io) io.emit('task:status', { taskId: tid, status, task: t });
        },
      }).catch(err => {
        logger.error(`[Task] ${task.id} 执行失败: ${err.message}`);
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
