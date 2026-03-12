/**
 * 端到端测试：单进程多会话
 * 1. 创建第一个会话 → 发消息
 * 2. 创建第二个会话（应复用已初始化的连接，秒创建）→ 发消息
 * 3. 第二个会话追问（验证上下文隔离）
 */
async function test() {
  const base = 'http://127.0.0.1:3080';
  async function post(path, body) {
    return fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  }

  // 1. 创建会话 A
  console.log('=== 创建会话 A ===');
  const tA = Date.now();
  const a = await post('/sessions', { cli: 'gemini', workdir: 'C:/Users/Administrator/Desktop/AI Review Hub', name: 'session-A' });
  console.log('会话 A:', a.id || a.error, `(耗时 ${((Date.now() - tA) / 1000).toFixed(1)}s)`);
  if (a.error) { console.error('失败:', a.error); return; }

  // 2. 会话 A 发消息
  console.log('\n=== 会话 A 发消息 ===');
  const m1 = await post(`/sessions/${a.id}/messages`, { message: '你好，用一句话告诉我这个项目是做什么的' });
  console.log('A 回复:', (m1.reply || m1.error || '').substring(0, 100));

  // 3. 创建会话 B（应复用连接，快速创建）
  console.log('\n=== 创建会话 B（应秒创建）===');
  const tB = Date.now();
  const b = await post('/sessions', { cli: 'gemini', workdir: 'C:/Users/Administrator/Desktop/AI Review Hub', name: 'session-B' });
  console.log('会话 B:', b.id || b.error, `(耗时 ${((Date.now() - tB) / 1000).toFixed(1)}s)`);

  if (b.error) { console.error('创建B失败:', b.error); return; }

  // 4. 会话 B 发消息
  console.log('\n=== 会话 B 发消息 ===');
  const m2 = await post(`/sessions/${b.id}/messages`, { message: '列出当前目录下所有 .js 文件（不含 node_modules）' });
  console.log('B 回复:', (m2.reply || m2.error || '').substring(0, 200));

  // 5. 列出所有活跃会话
  console.log('\n=== 活跃会话列表 ===');
  const list = await fetch(`${base}/sessions`).then(r => r.json());
  console.log(`活跃: ${list.activeSessions}, 总数: ${list.sessions?.length}`);

  // 6. 关闭两个会话
  console.log('\n=== 关闭 ===');
  await post(`/sessions/${a.id}/close`);
  await post(`/sessions/${b.id}/close`);
  console.log('全部关闭');
}

test().catch(e => console.error('测试出错:', e));
