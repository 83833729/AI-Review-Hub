const express = require('express');
const http = require('http');
const { Server: SocketIO } = require('socket.io');
const path = require('path');
const config = require('./config.json');
const TaskStore = require('./src/taskStore');
const Runner = require('./src/runner');
const Scheduler = require('./src/scheduler');
const createRouter = require('./src/api');

// ============ 初始化 ============

const app = express();
const httpServer = http.createServer(app);
const io = new SocketIO(httpServer, { cors: { origin: '*' } });
const dbPath = path.join(__dirname, 'hub.db');
const store = new TaskStore(dbPath);

// 服务重启 → 中断任务标记为失败
store.markInterrupted();

const runner = new Runner(store, {
  defaultTimeout: config.defaults.timeout,
  silentTimeout: config.defaults.silentTimeout,
  onOutput: (taskId, line) => {
    io.emit('task:output', { taskId, data: line });
  },
  onStatusChange: (taskId, status) => {
    console.log(`[Task] ${taskId} → ${status}`);
    const task = store.get(taskId);
    io.emit('task:status', { taskId, status, task });
  },
});

const scheduler = new Scheduler(store, runner);

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
app.use('/', createRouter(store, runner, io));

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
║         AI Review Hub v1.0.0             ║
║  http://${config.host}:${config.port}                ║
║                                          ║
║  API:  /tasks, /compat/submit            ║
║  UI:   http://${config.host}:${config.port}          ║
╚══════════════════════════════════════════╝
  `);
  scheduler.start();
});

// ============ 优雅关闭 ============

process.on('SIGINT', () => {
  console.log('\n[Server] 正在关闭...');
  scheduler.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  scheduler.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
});
