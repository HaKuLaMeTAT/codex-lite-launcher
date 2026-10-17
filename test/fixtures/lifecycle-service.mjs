// 生命周期实验服务：用真实子进程验证启动、调用、状态保留和正常退出。
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const catalog = {
  tools: [{ name: 'echo', description: 'Local lifecycle probe; returns text, process ID and a per-process counter.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, waitMs: { type: 'number' } }, required: ['text'] } }],
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const record = event => fs.appendFileSync(process.argv[2], JSON.stringify({ event, pid: process.pid, time: Date.now() }) + '\n');
  let calls = 0;
  record('start');
  readline.createInterface({ input: process.stdin }).on('line', async line => {
    const request = JSON.parse(line);
    if (request.id == null) return;
    let result;
    switch (request.method) {
      case 'initialize':
        result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'lifecycle-probe', version: '1.0' } };
        break;
      case 'tools/list': result = catalog; break;
      case 'tools/call': {
        const count = ++calls;
        record('call');
        await new Promise(resolve => setTimeout(resolve, request.params.arguments.waitMs ?? 0));
        result = { content: [{ type: 'text', text: JSON.stringify({ text: request.params.arguments.text, count, pid: process.pid }) }] };
        break;
      }
      case 'ping': result = {}; break;
      default:
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
        return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  });
  process.stdin.once('end', () => record('stdin-end'));
  process.once('exit', () => record('exit'));
}
