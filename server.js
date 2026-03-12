const express = require('express');
const http = require('http');
const { Server: SocketIO } = require('socket.io');
const path = require('path');
const config = require('./config.json');
const TaskStore = require('./src/taskStore');
const SessionManager = require('./src/sessionManager');
const createRouter = require('./src/api');

// ============ 初始化 ============

const app = express();
const httpServer = http.createServer(app);
const io = new SocketIO(httpServer, { cors: { origin: '*' } });
const dbPath = path.join(__dirname, 'hub.db');
const store = new TaskStore(dbPath);

// 服务重启 → 中断的任务和会话标记为失败/错误
store.markInterrupted();
store.markSessionsInterrupted();

const sessionConfig = config.sessions || {};
const sessionManager = new SessionManager(store, {
  idleTimeout: sessionConfig.idleTimeout || 1800,
  promptTimeout: sessionConfig.promptTimeout || 600,
  maxSessions: sessionConfig.maxSessions || 5,
  onMessage: (sessionId, role, content) => {
    io.emit('session:message', { sessionId, role, content });
  },
  onStatusChange: (sessionId, status) => {
    console.log(`[Session] ${sessionId} → ${status}`);
    io.emit('session:status', { sessionId, status });
  },
});

// ============ 中间件 ============

/** 静态文件（Web UI）—— 必须在 CORS 之前 */
app.use(express.static(path.join(__dirname, 'public')));

/** CORS + JSON 默认头（仅 API 路由生效） */
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token');
  res.header('Content-Type', 'application/json; charset=utf-8');
  next();
});

/** API 路由 */
app.use('/', createRouter(store, sessionManager, io));

/** WebSocket 连接 */
io.on('connection', (socket) => {
  console.log(`[WS] 客户端连接: ${socket.id}`);
  socket.emit('tasks:sync', { tasks: store.list() });
  socket.on('disconnect', () => console.log(`[WS] 客户端断开: ${socket.id}`));
});

// ============ 启动 ============

const server = httpServer.listen(config.port, config.host, () => {
  console.log(`
╔══════════════════════════════════════════╗
║         AI Review Hub v2.0.0             ║
║  http://${config.host}:${config.port}                ║
║                                          ║
║  通信协议: ACP (统一)                    ║
║  支持 CLI: codex / gemini / claude       ║
╚══════════════════════════════════════════╝
  `);

  // 后台预热 ACP 连接
  sessionManager.warmup(['gemini', 'codex']);
});

// ============ 优雅关闭 ============

process.on('SIGINT', () => {
  console.log('\n[Server] 正在关闭...');
  sessionManager.closeAll().then(() => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
});

process.on('SIGTERM', () => {
  sessionManager.closeAll().then(() => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
});
