const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

/** 日志目录 */
const LOG_DIR = path.join(__dirname, '..', 'logs');

/**
 * 统一日志格式
 * 输出示例：[2026-03-12 18:56:12] [INFO] 消息内容
 */
const baseFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message }) =>
    `[${timestamp}] [${level.toUpperCase()}] ${message}`,
  ),
);

/** 控制台输出：带颜色 */
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message }) =>
    `[${timestamp}] [${level}] ${message}`,
  ),
);

/**
 * 按天轮转文件 transport
 * - 文件名：hub-2026-03-12.log
 * - 保留 14 天
 * - 单文件上限 20MB
 */
const fileTransport = new DailyRotateFile({
  dirname: LOG_DIR,
  filename: 'hub-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxFiles: '14d',
  maxSize: '20m',
  format: baseFormat,
});

/**
 * 错误日志单独输出到 error 文件
 * - 文件名：error-2026-03-12.log
 */
const errorTransport = new DailyRotateFile({
  dirname: LOG_DIR,
  filename: 'error-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxFiles: '14d',
  maxSize: '20m',
  level: 'error',
  format: baseFormat,
});

/** Winston logger 实例 */
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    fileTransport,
    errorTransport,
  ],
});

module.exports = logger;
