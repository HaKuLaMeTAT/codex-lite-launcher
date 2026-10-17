// 仅供隔离实验：tools-only HTTP 入口，不是安装器可启用的通用 MCP 代理。
// 目录由调用方预先提供；生产接入还需处理目录更新、双向请求和完整取消语义。
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

export function openStdioService(command, args, options = {}) {
  const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 0, stderr = '';
  const pending = new Map();
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  child.stdin.on('error', () => {});
  const fail = error => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); } pending.clear(); };
  child.once('error', fail);
  const exited = new Promise(resolve => child.once('close', code => {
    fail(new Error(`Service closed (${code}): ${stderr}`));
    resolve(code);
  }));
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { fail(new Error('Invalid MCP JSON')); return; }
    if (message.method && message.id != null) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Server requests are outside this experiment' } }) + '\n');
      return;
    }
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id); clearTimeout(call.timer);
    message.error ? call.reject(Object.assign(new Error(message.error.message), { code: message.error.code })) : call.resolve(message.result);
  });
  return {
    pid: child.pid,
    request(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 15000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); },
    async close() {
      // 正常关闭 stdin；不使用 taskkill，也不按名称结束进程。
      child.stdin.end();
      let timer;
      try { return await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Service did not exit after stdin closed')), 5000); })]); }
      finally { clearTimeout(timer); }
    },
  };
}

export async function createLazyHost({ catalog, command, args, env, cwd, idleMs = null }) {
  const sessions = new Map(), events = [], failures = [];
  const route = `/mcp/${randomUUID()}`;
  const event = (kind, session, detail = {}) => events.push({ kind, session: session.id, time: Date.now(), ...detail });

  async function stopWorker(session) {
    clearTimeout(session.timer);
    if (!session.worker) return;
    const worker = session.worker;
    session.closing = worker.close().then(code => {
      event('worker-stop', session, { pid: worker.pid, code });
      session.worker = null;
    });
    try { await session.closing; } finally { session.closing = null; }
  }
  function scheduleIdle(session) {
    // null 表示保留进程内状态；空闲计时从最后一个调用完成后开始。
    if (idleMs == null || session.active.size || session.closed) return;
    session.timer = setTimeout(() => {
      if (!session.active.size) stopWorker(session).catch(error => failures.push(error.message));
    }, idleMs);
  }
  async function getWorker(session) {
    if (session.closing) await session.closing;
    if (session.worker) return session.worker;
    if (!session.starting) session.starting = (async () => {
      const worker = openStdioService(command, args, { env, cwd });
      event('worker-start', session, { pid: worker.pid });
      try {
        await worker.request('initialize', session.initialize);
        worker.notify('notifications/initialized', {});
        session.worker = worker;
        return worker;
      } catch (error) { await worker.close(); throw error; }
    })().finally(() => { session.starting = null; });
    return session.starting;
  }
  async function dispose(session) {
    session.closed = true;
    clearTimeout(session.timer);
    await Promise.allSettled([...session.active]);
    await stopWorker(session);
    sessions.delete(session.id);
    event('session-close', session);
  }
  const server = http.createServer((req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body == null ? '' : JSON.stringify(body)); };
    (async () => {
      if (req.url !== route || req.headers.origin) { reply(403); return; }
      const session = sessions.get(req.headers['mcp-session-id']);
      if (req.method === 'DELETE') { if (session) await dispose(session); reply(200); return; }
      if (req.method !== 'POST') { reply(405); return; }
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 4 * 1024 * 1024) { reply(413); return; } }
      const message = JSON.parse(body);
      if (message.method === 'initialize') {
        const created = { id: randomUUID(), initialize: message.params, worker: null, starting: null, closing: null, active: new Set(), timer: null, closed: false };
        sessions.set(created.id, created);
        event('session-open', created);
        res.setHeader('mcp-session-id', created.id);
        reply(200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'codex-lite-lifecycle-prototype', version: '0.1' } } });
        return;
      }
      if (!session || session.closed) { reply(404); return; }
      if (message.id == null) { reply(202); return; }
      try {
        let result;
        if (message.method === 'tools/list') result = catalog;
        else if (message.method === 'ping') result = {};
        else if (message.method === 'tools/call') {
          clearTimeout(session.timer);
          const operation = (async () => (await getWorker(session)).request('tools/call', message.params))();
          session.active.add(operation);
          try { result = await operation; }
          finally { session.active.delete(operation); scheduleIdle(session); }
        } else throw Object.assign(new Error('Unsupported method in lifecycle prototype'), { code: -32601 });
        reply(200, { jsonrpc: '2.0', id: message.id, result });
      } catch (error) { reply(200, { jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message } }); }
    })().catch(error => { failures.push(error.message); if (!res.headersSent) reply(500); else res.end(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}${route}`,
    events, failures,
    get sessionCount() { return sessions.size; },
    async close() { await Promise.all([...sessions.values()].map(dispose)); await new Promise(resolve => server.close(resolve)); },
  };
}
