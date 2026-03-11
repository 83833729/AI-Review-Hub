#!/usr/bin/env node
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

/** AI Review Hub HTTP 基地址 */
const BASE_URL = 'http://127.0.0.1:3080';

/**
 * 封装 HTTP 请求
 * @param {string} path - 请求路径
 * @param {'GET'|'POST'} method - 请求方法
 * @param {object} [body] - POST 请求体
 * @returns {Promise<object>} JSON 响应
 */
async function hubRequest(path, method = 'GET', body) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) options.body = JSON.stringify(body);

  const resp = await fetch(`${BASE_URL}${path}`, options);
  return resp.json();
}

/**
 * 将 JSON 数据格式化为 MCP 文本响应
 * @param {object} data - 响应数据
 * @returns {{ content: Array<{ type: string, text: string }> }}
 */
function textResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

// ============ 创建 MCP Server ============

const server = new McpServer({
  name: 'ai-review-hub',
  version: '1.0.0',
});

// ---- submit_review：提交审查任务 ----
server.tool(
  'submit_review',
  '提交一个 AI 代码审查任务。支持直接传入 prompt 文本，无需写文件。',
  {
    taskId: z.string().describe('任务唯一 ID'),
    cli: z.enum(['codex', 'claude', 'gemini']).describe('AI CLI 工具名'),
    prompt: z.string().describe('审查指令文本'),
    workdir: z.string().optional().describe('代码工作目录的绝对路径'),
    sandbox: z.enum(['workspace-write', 'danger-full-access']).default('workspace-write').describe('沙箱模式：workspace-write（默认）/ danger-full-access'),
    timeout: z.number().optional().describe('超时秒数，默认 300'),
  },
  async ({ taskId, cli, prompt, workdir, sandbox, timeout }) => {
    const body = { taskId, cli, prompt };
    if (workdir) body.workdir = workdir;
    const options = {};
    if (sandbox) options.sandbox = sandbox;
    if (timeout) options.timeout = timeout;
    if (Object.keys(options).length > 0) body.options = options;

    const data = await hubRequest('/tasks', 'POST', body);
    return textResult(data);
  }
);

// ---- check_status：查询任务状态 ----
server.tool(
  'check_status',
  '查询指定任务的当前状态、耗时和基本信息。',
  {
    taskId: z.string().describe('任务 ID'),
  },
  async ({ taskId }) => {
    const data = await hubRequest(`/tasks/${encodeURIComponent(taskId)}`);
    return textResult(data);
  }
);

// ---- get_result：获取审查结果 ----
server.tool(
  'get_result',
  '获取已完成任务的审查结果文本。',
  {
    taskId: z.string().describe('任务 ID'),
  },
  async ({ taskId }) => {
    const data = await hubRequest(`/tasks/${encodeURIComponent(taskId)}/result`);
    return textResult(data);
  }
);

// ---- list_tasks：列出所有任务 ----
server.tool(
  'list_tasks',
  '列出所有审查任务（最近 100 条）。',
  {},
  async () => {
    const data = await hubRequest('/tasks');
    return textResult(data);
  }
);

// ---- cancel_task：取消任务 ----
server.tool(
  'cancel_task',
  '取消一个排队中或运行中的任务。',
  {
    taskId: z.string().describe('任务 ID'),
  },
  async ({ taskId }) => {
    const data = await hubRequest(`/tasks/${encodeURIComponent(taskId)}/cancel`, 'POST');
    return textResult(data);
  }
);

// ============ 启动 ============

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP] AI Review Hub MCP Server 已启动 (stdio)');
}

main().catch((err) => {
  console.error('[MCP] 启动失败:', err);
  process.exit(1);
});
