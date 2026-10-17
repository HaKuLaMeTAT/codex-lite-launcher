// 专用于已审计的 codex_app：业务仍由桌面原处理器执行，不创建转接子进程。
// 此函数会被内联进 ASAR 主模块，依赖必须通过参数传入或放在函数内部。
export async function createSharedAppToolsHost({ listTools, callTool, callerHostId }, { http, crypto }) {
  const token = crypto.randomBytes(32).toString('hex'), sessions = new Map();
  const versions = ['2025-11-25', '2025-06-18', '2025-03-26'];
  const maxBytes = 8 * 1024 * 1024; // 与原应用工具管道的单帧上限一致。
  let closing = false, address;
  const failure = (code, message) => Object.assign(new Error(message), { rpcCode: code });
  const key = id => `${typeof id}:${String(id)}`;
  const validId = id => typeof id === 'string' || typeof id === 'number' && Number.isFinite(id);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const string = value => typeof value === 'string' && value.trim() ? value : null;
  function metadataId(meta, kind, turn) {
    const names = kind === 'call' ? ['openai/toolCallId', 'openai/tool_call_id', 'codexCallId', 'codex_call_id', 'callId', 'call_id'] :
      [`openai/${kind}Id`, `openai/${kind}_id`, `codex${kind[0].toUpperCase() + kind.slice(1)}Id`, `codex_${kind}_id`, `${kind}Id`, `${kind}_id`];
    for (const name of names) {
      if (string(meta[name])) return meta[name];
    }
    return string(turn?.[`${kind}_id`]) ?? string(meta[kind]?.id);
  }
  function content(item) {
    if (item.type === 'inputText' && typeof item.text === 'string') return { type: 'text', text: item.text };
    if (item.type !== 'inputImage' && item.type !== 'inputAudio') throw failure(-32000, 'Invalid app tool response');
    const url = item.type === 'inputImage' ? item.imageUrl : item.audioUrl;
    if (typeof url !== 'string') throw failure(-32000, 'Invalid app tool response');
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    return match ? { type: item.type === 'inputImage' ? 'image' : 'audio', mimeType: match[1], data: match[2] } : { type: 'text', text: url };
  }
  function release(session) {
    sessions.delete(session.id);
    for (const controller of session.pending.values()) controller.abort();
    session.pending.clear();
  }
  async function dispatch(message, signal) {
    if (message.method === 'ping') return {};
    if (!['tools/list', 'tools/call'].includes(message.method)) throw failure(-32601, 'Method not found');
    // 每次向原桌面目录提供器读取，避免跨账户、权限或插件变化复用旧目录。
    const tools = (await listTools()).map(tool => ({ ...tool, inputSchema: object(tool.inputSchema) && !('type' in tool.inputSchema) ? { ...tool.inputSchema, type: 'object' } : tool.inputSchema }));
    signal.throwIfAborted();
    if (message.method === 'tools/list') return { tools: tools.map(({ namespace, ...tool }) => tool) };
    const params = message.params;
    if (!object(params) || typeof params.name !== 'string' || params.arguments != null && !object(params.arguments) || params._meta != null && !object(params._meta))
      throw failure(-32602, 'Invalid tools/call parameters');
    const tool = tools.find(tool => tool.name === params.name);
    if (!tool) throw failure(-32602, `Unknown Codex app tool: ${params.name}`);
    const meta = params._meta ?? {};
    let turn = meta['x-codex-turn-metadata'];
    if (typeof turn === 'string') { try { turn = JSON.parse(turn); } catch { turn = null; } }
    const threadId = metadataId(meta, 'thread', turn);
    if (!threadId) throw failure(-32602, 'Codex app tools require thread metadata from the executor.');
    const result = await callTool({ callerSource: 'codex', hostId: callerHostId, params: {
      arguments: params.arguments ?? {}, namespace: tool.namespace, tool: tool.name, threadId,
      callId: metadataId(meta, 'call') ?? `mcp-call-${crypto.randomUUID()}`,
      turnId: metadataId(meta, 'turn', turn) ?? `mcp-turn-${message.id}`,
    } }, signal);
    signal.throwIfAborted();
    if (!result || typeof result.success !== 'boolean' || !Array.isArray(result.contentItems)) throw failure(-32000, 'Invalid app tool response');
    if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw failure(-32602, 'Codex app tool response was too large');
    return { content: result.contentItems.map(content), isError: !result.success };
  }
  const server = http.createServer((req, res) => {
    const reply = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      const text = body == null ? '' : JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(text);
    };
    (async () => {
      // 仅回环地址 + 随机凭证；拒绝浏览器 Origin 和 DNS 重绑定请求。
      if (closing || req.url !== '/mcp' || req.headers.host !== address || req.headers.origin || req.headers.authorization !== `Bearer ${token}`) { reply(403); return; }
      const session = sessions.get(req.headers['mcp-session-id']);
      if (req.method === 'DELETE') { if (!session) { reply(404); return; } release(session); reply(200); return; }
      // 原 codex_app 只声明 tools，不提供服务端通知流、资源或双向请求。
      if (req.method === 'GET') { reply(405); return; }
      if (req.method !== 'POST') { reply(405); return; }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { reply(415); return; }
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > maxBytes) { reply(413); return; } chunks.push(chunk); }
      let message;
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { reply(200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
      if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || 'id' in message && !validId(message.id)) {
        reply(200, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); return;
      }
      if (message.method === 'initialize' && validId(message.id)) {
        if (req.headers['mcp-session-id']) { reply(400); return; }
        const version = message.params?.protocolVersion;
        const created = { id: crypto.randomUUID(), pending: new Map(), version: versions.includes(version) ? version : versions[0] };
        sessions.set(created.id, created); res.setHeader('mcp-session-id', created.id);
        reply(200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: created.version, capabilities: { tools: {} },
          serverInfo: { name: 'codex-app-tools', title: 'ChatGPT App Tools', version: '0.1.0' }, instructions: 'Tools provided by the Codex app.' } });
        return;
      }
      if (!session) { reply(404); return; }
      if (req.headers['mcp-protocol-version'] && req.headers['mcp-protocol-version'] !== session.version) { reply(400); return; }
      if (!('id' in message)) {
        if (message.method === 'notifications/cancelled' && validId(message.params?.requestId)) session.pending.get(key(message.params.requestId))?.abort();
        reply(202); return;
      }
      const requestKey = key(message.id);
      if (session.pending.has(requestKey)) { reply(200, { jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Duplicate request ID' } }); return; }
      const controller = new AbortController(); session.pending.set(requestKey, controller);
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', disconnected);
      try { reply(200, { jsonrpc: '2.0', id: message.id, result: await dispatch(message, controller.signal) }); }
      catch (error) { reply(200, { jsonrpc: '2.0', id: message.id, error: {
        code: controller.signal.aborted ? -32800 : error.rpcCode ?? -32000,
        message: controller.signal.aborted ? 'Request cancelled' : error.rpcCode ? error.message : 'Codex app tool request failed',
      } }); }
      finally { session.pending.delete(requestKey); res.off('close', disconnected); }
    })().catch(() => { if (!res.headersSent) reply(500); else res.destroy(); });
  });
  server.requestTimeout = 0; server.timeout = 0;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  address = `127.0.0.1:${server.address().port}`; server.unref();
  return {
    url: `http://${address}/mcp`, httpHeaders: { Authorization: `Bearer ${token}` },
    async close() {
      closing = true;
      for (const session of sessions.values()) release(session);
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}

// 只改本地缓存插件定义；执行器导出和 WSL 继续使用原 stdio 配置。
export function sharedAppToolsConfig(config, host, useWsl, platform) {
  if (platform !== 'win32' || useWsl) return config;
  const standard = ['/d', '/s', '/c', 'call', './scripts/launch_codex_app_tools_mcp.cmd', './server.mjs'];
  const cmd = config.command === 'cmd.exe' && Array.isArray(config.args) && config.args.length === standard.length && standard.every((arg, i) => config.args[i] === arg);
  const node = /(?:^|[\\/])node\.exe$/i.test(config.command ?? '') && config.args?.length === 1 && config.args[0] === './server.mjs';
  if (!cmd && !node) return config;
  if (!host) throw new Error('共享应用工具通道尚未就绪。');
  const { command, args, env, env_vars, cwd, ...policy } = config;
  return { ...policy, url: host.url, http_headers: host.httpHeaders };
}
