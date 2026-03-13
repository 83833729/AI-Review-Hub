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
    taskId: z.string().optional().describe('任务名称/标签（可选，服务端自动生成 UUID 作为真正 ID）'),
    cli: z.enum(['codex', 'claude', 'gemini']).describe('AI CLI 工具名'),
    prompt: z.string().describe('审查指令文本'),
    workdir: z.string().optional().describe('代码工作目录的绝对路径'),
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write').describe('沙箱模式：read-only / workspace-write（默认）/ danger-full-access'),
    timeout: z.number().optional().describe('超时秒数，默认 300'),
  },
  async ({ taskId, cli, prompt, workdir, sandbox, timeout }) => {
    const body = { cli, prompt };
    // 兼容: taskId 作为 name
    if (taskId) body.name = taskId;
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

// ============ 多轮对话 Session 工具 ============

// ---- create_session：创建会话 ----
server.tool(
  'create_session',
  '创建一个多轮对话会话。会话创建后可多次发送消息，支持追问和上下文保持。',
  {
    cli: z.enum(['codex', 'gemini', 'claude']).describe('AI CLI 工具名（仅支持 codex/gemini/claude）'),
    workdir: z.string().optional().describe('代码工作目录的绝对路径'),
    name: z.string().optional().describe('会话名称/标签（可选）'),
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional().describe('沙箱模式（可选，默认 workspace-write）'),
  },
  async ({ cli, workdir, name, sandbox }) => {
    const body = { cli };
    if (workdir) body.workdir = workdir;
    if (name) body.name = name;
    if (sandbox) body.sandbox = sandbox;
    const data = await hubRequest('/sessions', 'POST', body);
    return textResult(data);
  }
);

// ---- send_message：在会话中发送消息 ----
server.tool(
  'send_message',
  '在已有会话中发送消息或追问。会话会保持上下文，适合多轮对话场景。',
  {
    sessionId: z.string().describe('会话 ID'),
    message: z.string().describe('消息内容'),
  },
  async ({ sessionId, message }) => {
    const data = await hubRequest(`/sessions/${encodeURIComponent(sessionId)}/messages`, 'POST', { message });
    return textResult(data);
  }
);

// ---- get_session：获取会话详情 ----
server.tool(
  'get_session',
  '获取会话详情和完整对话历史。',
  {
    sessionId: z.string().describe('会话 ID'),
  },
  async ({ sessionId }) => {
    const data = await hubRequest(`/sessions/${encodeURIComponent(sessionId)}`);
    return textResult(data);
  }
);

// ---- close_session：关闭会话 ----
server.tool(
  'close_session',
  '关闭一个会话，释放资源。',
  {
    sessionId: z.string().describe('会话 ID'),
  },
  async ({ sessionId }) => {
    const data = await hubRequest(`/sessions/${encodeURIComponent(sessionId)}/close`, 'POST');
    return textResult(data);
  }
);

// ---- list_sessions：列出所有会话 ----
server.tool(
  'list_sessions',
  '列出所有会话（最近 100 条）。',
  {},
  async () => {
    const data = await hubRequest('/sessions');
    return textResult(data);
  }
);

// ============ 多 CLI 会话（讨论 / 群聊）工具 ============

// ---- create_conversation：创建讨论或群聊 ----
server.tool(
  'create_conversation',
  '创建多 CLI 讨论或群聊。讨论模式（串行）：各 CLI 依次回答，后一个能看到前面所有回答。群聊模式（并行）：各 CLI 同时独立回答。',
  {
    type: z.enum(['discussion', 'group_chat']).describe("模式：'discussion'（串行讨论）或 'group_chat'（并行群聊）"),
    question: z.string().describe('要讨论的问题'),
    clis: z.array(z.enum(['codex', 'gemini', 'claude'])).min(2).max(5).describe('参与的 CLI 列表（2-5个）'),
    name: z.string().optional().describe('会话名称（可选）'),
    workdir: z.string().optional().describe('代码工作目录的绝对路径'),
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional().describe('沙箱模式（可选，默认 workspace-write）'),
  },
  async ({ type, question, clis, name, workdir, sandbox }) => {
    const body = { type, question, clis };
    if (name) body.name = name;
    if (workdir) body.workdir = workdir;
    if (sandbox) body.sandbox = sandbox;
    const data = await hubRequest('/conversations', 'POST', body);
    return textResult(data);
  }
);

// ---- get_conversation：获取讨论/群聊结果 ----
server.tool(
  'get_conversation',
  '获取讨论/群聊的详情、参与者状态和所有消息。',
  {
    conversationId: z.string().describe('会话 ID'),
  },
  async ({ conversationId }) => {
    const data = await hubRequest(`/conversations/${encodeURIComponent(conversationId)}`);
    return textResult(data);
  }
);

// ---- cancel_conversation：取消讨论/群聊 ----
server.tool(
  'cancel_conversation',
  '取消一个进行中的讨论或群聊。',
  {
    conversationId: z.string().describe('会话 ID'),
  },
  async ({ conversationId }) => {
    const data = await hubRequest(`/conversations/${encodeURIComponent(conversationId)}/cancel`, 'POST');
    return textResult(data);
  }
);

// ---- list_conversations：列出所有讨论/群聊 ----
server.tool(
  'list_conversations',
  '列出所有讨论和群聊（最近 100 条）。可按类型过滤。',
  {
    type: z.enum(['discussion', 'group_chat']).optional().describe("可选过滤：'discussion' 或 'group_chat'"),
  },
  async ({ type }) => {
    const params = type ? `?type=${type}` : '';
    const data = await hubRequest(`/conversations${params}`);
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
