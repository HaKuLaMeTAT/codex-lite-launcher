// 手动集成实验：node test/mcp-lifecycle-probe.mjs <codex.exe>
// 使用独立 CODEX_HOME、本地假模型地址和真实 app-server；不发送模型回合。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { createSharedAppToolsHost } from '../app-tools-host.mjs';
import { catalog } from './fixtures/lifecycle-service.mjs';
import { createLazyHost, openStdioService } from './fixtures/lazy-mcp-host.mjs';

const exe = process.argv[2];
assert(exe && path.isAbsolute(exe) && fs.existsSync(exe), 'Pass the absolute path to the bundled codex.exe');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lite-mcp-probe-'));
const fixture = fileURLToPath(new URL('./fixtures/lifecycle-service.mjs', import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readEvents = file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
async function until(check, message, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await wait(50); }
  throw new Error(message);
}
const report = { version: execFileSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(), cases: [] };
function passed(name, observations) { report.cases.push({ name, ...observations }); console.log(JSON.stringify({ passed: name, ...observations })); }
const environmentKeys = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA']);
const isolatedEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => environmentKeys.has(key.toUpperCase())));

async function withBackend(name, mcp, run, plugin = false) {
  const home = path.join(root, name);
  fs.mkdirSync(home);
  const events = path.join(home, 'service.jsonl');
  fs.writeFileSync(events, '');
  const config = `cli_auth_credentials_store = "file"\nmodel = "probe"\nmodel_provider = "probe"\n[model_providers.probe]\nname = "Local lifecycle probe"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\n[features]\napps = false\nplugins = ${plugin}\nremote_plugin = false\nbrowser_use = false\ncomputer_use = false\ncode_mode_host = false\nworkspace_dependencies = false\nshell_snapshot = false\n`;
  fs.writeFileSync(path.join(home, 'config.toml'), config + (typeof mcp === 'function' ? mcp({ home, events }) : mcp));
  const child = spawn(exe, ['app-server', '--stdio'], { cwd: home, windowsHide: true,
    env: { ...isolatedEnvironment, CODEX_HOME: home, RUST_LOG: 'warn', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 0, stderr = '';
  const pending = new Map();
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-6000); });
  const exited = new Promise(resolve => child.once('close', resolve));
  child.once('error', error => { for (const p of pending.values()) p.reject(error); });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.id == null) return;
    if (message.method) { child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'No external actions in lifecycle probe' } }) + '\n'); return; }
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id); clearTimeout(p.timer);
    message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result);
  });
  function rpc(method, params) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}\n${stderr}`)); }, 20000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  try {
    await rpc('initialize', { clientInfo: { name: 'codex_lite_lifecycle_probe', version: '0.1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const api = {
      rpc, home, events,
      start: async (config = {}) => (await rpc('thread/start', { cwd: home, ephemeral: true, model: 'probe', modelProvider: 'probe', approvalPolicy: 'never', sandbox: 'read-only', config })).thread.id,
      inventory: threadId => rpc('mcpServerStatus/list', { threadId, serverName: 'probe', detail: 'toolsAndAuthOnly' }),
      call: (threadId, text, waitMs = 0) => rpc('mcpServer/tool/call', { threadId, server: 'probe', tool: 'echo', arguments: { text, waitMs } }).then(result => JSON.parse(result.content[0].text)),
    };
    await run(api);
  } finally {
    child.stdin.end();
    let timer;
    try { assert.equal(await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Isolated backend did not exit')), 7000); })]), 0); }
    finally { clearTimeout(timer); for (const p of pending.values()) clearTimeout(p.timer); }
    fs.writeFileSync(path.join(home, 'stderr.log'), stderr);
    for (const pid of new Set(readEvents(events).map(e => e.pid))) await until(() => !alive(pid), `Probe process ${pid} survived backend shutdown`);
  }
}

function stdioConfig(events, extra = '') {
  return `[mcp_servers.probe]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([fixture, events])}\n${extra}`;
}

try {
  if (!process.argv.includes('--shared-only')) {
  await withBackend('native-enabled', ({ events }) => stdioConfig(events), async api => {
    const id = await api.start();
    assert((await api.inventory(id)).data[0].tools.echo);
    assert.equal(readEvents(api.events).filter(e => e.event === 'start').length, 1);
    await api.inventory(id);
    assert.equal(readEvents(api.events).filter(e => e.event === 'start').length, 1);
    await api.rpc('mcpServerStatus/list', { threadId: id, detail: 'toolsAndAuthOnly' });
    assert.equal(readEvents(api.events).filter(e => e.event === 'start').length, 2);
    passed('native-start-and-inventory', { beforeAnyCall: 1, afterNamedInventory: 1, afterFullInventory: 2 });
  });
  await withBackend('native-disabled', ({ events }) => stdioConfig(events), async api => {
    const id = await api.start({ 'mcp_servers.probe.enabled': false });
    assert.equal((await api.inventory(id)).data[0].runtimeStatus, 'disabled');
    await assert.rejects(api.call(id, 'disabled'), /unknown MCP server/);
    assert.equal(readEvents(api.events).length, 0);
    passed('disabled-before-start', { starts: 0, onDemandRestart: false });
  });
  await withBackend('native-hidden', ({ events }) => stdioConfig(events, 'disabled_tools = ["echo"]\n'), async api => {
    const id = await api.start();
    assert.deepEqual((await api.inventory(id)).data[0].tools, {});
    assert.equal(readEvents(api.events).filter(e => e.event === 'start').length, 1);
    await assert.rejects(api.call(id, 'hidden'), /disabled/);
    passed('hidden-tool-still-starts', { starts: 1 });
  });
  await withBackend('native-plugin', ({ home, events }) => {
    const market = path.join(home, 'marketplace'), plugin = path.join(market, 'plugins', 'probe');
    fs.mkdirSync(path.join(plugin, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(market, '.agents', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'probe', version: '1.0', description: 'Local lifecycle probe', mcpServers: './.mcp.json' }));
    fs.writeFileSync(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: [fixture, events], enabled: true } } }));
    fs.writeFileSync(path.join(market, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'lifecycle-probe', plugins: [{ name: 'probe', source: { source: 'local', path: './plugins/probe' }, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' } }] }));
    return `[marketplaces.lifecycle-probe]\nsource_type = "local"\nsource = ${JSON.stringify(market)}\n`;
  }, async api => {
    await api.rpc('plugin/install', { marketplacePath: path.join(api.home, 'marketplace', '.agents', 'plugins', 'marketplace.json'), pluginName: 'probe' });
    const id = await api.start();
    await api.inventory(id);
    const first = await api.call(id, 'before');
    await api.rpc('thread/settings/update', { threadId: id, disabledPluginIds: ['probe@lifecycle-probe'] });
    const second = await api.call(id, 'after');
    assert.equal(first.pid, second.pid);
    assert.equal(second.count, 2);
    const disabled = await api.start({ 'plugins.probe@lifecycle-probe.mcp_servers.probe.enabled': false });
    assert.equal((await api.inventory(disabled)).data[0].runtimeStatus, 'disabled');
    await assert.rejects(api.call(disabled, 'off'), /unknown MCP server/);
    assert.equal(readEvents(api.events).filter(e => e.event === 'start').length, 1);
    passed('plugin-selection-vs-startup', { selectionReleasesWorker: false, preStartConfigBlocksWorker: true });
  }, true);

  for (const stateful of [false, true]) {
    const name = stateful ? 'lazy-stateful' : 'lazy-stateless';
    const events = path.join(root, name + '.jsonl'); fs.writeFileSync(events, '');
    const host = await createLazyHost({ catalog, command: process.execPath, args: [fixture, events], env: isolatedEnvironment, idleMs: stateful ? null : 300 });
    try {
      await withBackend(name, `[mcp_servers.probe]\nurl = ${JSON.stringify(host.url)}\n`, async api => {
        const id = await api.start();
        assert((await api.inventory(id)).data[0].tools.echo);
        await api.rpc('mcpServerStatus/list', { threadId: id, detail: 'toolsAndAuthOnly' });
        assert.equal(readEvents(events).length, 0, 'Directory reads must not launch a service');
        const [first, concurrent] = await Promise.all([api.call(id, 'first', 100), api.call(id, 'concurrent', 100)]);
        assert.equal(first.pid, concurrent.pid);
        assert.deepEqual([first.count, concurrent.count].sort(), [1, 2]);
        if (!stateful) {
          await until(() => !alive(first.pid), 'Stateless worker was not reclaimed');
          const second = await api.call(id, 'restart');
          assert.notEqual(second.pid, first.pid);
          const longCall = api.call(id, 'long', 1000);
          await until(() => readEvents(events).filter(e => e.event === 'call').length === 4, 'Long call never started');
          await wait(600);
          assert(alive(second.pid), 'Idle reclamation interrupted an in-flight call');
          assert.equal((await longCall).pid, second.pid);
          await until(() => !alive(second.pid), 'Worker did not exit after long call completed');
          passed(name, { startsBeforeUse: 0, concurrentFirstCallWorkers: 1, restartWorks: true, longCallProtected: true, idleMs: 300 });
        } else {
          await wait(700);
          const retained = await api.call(id, 'retained');
          assert.equal(retained.pid, first.pid); assert.equal(retained.count, 3);
          const otherId = await api.start();
          await api.inventory(otherId);
          const other = await api.call(otherId, 'other session');
          assert.notEqual(other.pid, first.pid); assert.equal(other.count, 1);
          const unsubscribedAt = Date.now();
          await api.rpc('thread/unsubscribe', { threadId: id });
          console.log('Waiting for native idle-thread cleanup (usually about 60 seconds on the tested backend).');
          await until(() => !alive(first.pid), 'Unsubscribed stateful session was not reclaimed within 75 seconds', 75000);
          assert(alive(other.pid), 'Unsubscribing one session affected another');
          assert.equal((await api.call(otherId, 'still active')).count, 2);
          passed(name, { startsBeforeUse: 0, stateRetained: true, sessionsIsolated: true, unsubscribeCleanupMs: Date.now() - unsubscribedAt });
        }
      });
      await until(() => host.sessionCount === 0, 'Backend shutdown did not delete HTTP sessions');
      assert.deepEqual(host.failures, []);
      assert(host.events.filter(e => e.kind === 'worker-stop').every(e => e.code === 0));
      fs.writeFileSync(path.join(root, name + '-host.json'), JSON.stringify(host.events, null, 2));
    } finally { await host.close(); }
    for (const pid of new Set(readEvents(events).map(e => e.pid))) assert(!alive(pid), `Prototype process ${pid} was not cleaned up`);
  }

  // 可选真实服务仅读取目录和项目清单；不调用任何写入工具。
  if (process.env.CODEX_TEST_APP_TOOLS) {
    assert(process.env.CODEX_APP_TOOLS_PIPE_PATH, 'Real app-tools probe requires the app-provided pipe environment');
    const target = process.env.CODEX_TEST_APP_TOOLS;
    const worker = openStdioService(process.execPath, [target], { env: process.env, cwd: path.dirname(target) });
    let actualCatalog;
    try {
      await worker.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'codex-lite-probe', version: '0.1' } });
      worker.notify('notifications/initialized', {});
      actualCatalog = await worker.request('tools/list', {});
      assert(actualCatalog.tools.length > 0);
      passed('real-app-tools-catalog', { tools: actualCatalog.tools.length });
    } finally { assert.equal(await worker.close(), 0); }
    if (process.env.CODEX_THREAD_ID) {
      assert(actualCatalog.tools.some(tool => tool.name === 'list_projects'));
      const host = await createLazyHost({ catalog: actualCatalog, command: process.execPath, args: [target], env: process.env, cwd: path.dirname(target), idleMs: 300 });
      try {
        await withBackend('real-app-tools-lazy', `[mcp_servers.probe]\nurl = ${JSON.stringify(host.url)}\n`, async api => {
          const id = await api.start();
          assert((await api.inventory(id)).data[0].tools.list_projects);
          assert.equal(host.events.filter(e => e.kind === 'worker-start').length, 0);
          for (let i = 0; i < 2; i++) {
            const result = await api.rpc('mcpServer/tool/call', { threadId: id, server: 'probe', tool: 'list_projects', arguments: {}, _meta: { 'openai/threadId': process.env.CODEX_THREAD_ID } });
            assert(!result.isError, 'Read-only app-tools call failed');
            assert(result.content.length > 0);
            await until(() => host.events.filter(e => e.kind === 'worker-stop').length === i + 1, 'Real app-tools worker was not reclaimed');
          }
          assert.equal(host.events.filter(e => e.kind === 'worker-start').length, 2);
          assert(host.events.filter(e => e.kind === 'worker-stop').every(e => e.code === 0));
          passed('real-app-tools-lazy-call', { startsBeforeUse: 0, readOnlyCalls: 2, gracefulExits: 2, restartWorks: true });
        });
        assert.deepEqual(host.failures, []);
      } finally { await host.close(); }
    }
  }
  }
  // 生产共享通道通过真实后端调用；此路径不启动任何 stdio 工具适配进程。
  const sharedCalls = [];
  const shared = await createSharedAppToolsHost({listTools:async()=>catalog.tools.map(tool=>({...tool,namespace:'codex_app'})),
    callTool:async request=>{sharedCalls.push(request.params);return {success:true,contentItems:[{type:'inputText',text:JSON.stringify(request.params)}]}}},{http,crypto});
  const httpConfig = host => `[mcp_servers.probe]\nurl = ${JSON.stringify(host.url)}\n[mcp_servers.probe.http_headers]\nAuthorization = ${JSON.stringify(host.httpHeaders.Authorization)}\n`;
  try {
    await withBackend('shared-native',httpConfig(shared),async api=>{
      const a=await api.start(),b=await api.start();
      assert((await api.inventory(a)).data[0].tools.echo);
      assert((await api.inventory(b)).data[0].tools.echo);
      assert.equal(sharedCalls.length,0);
      const result=await Promise.all([api.call(a,'first'),api.call(b,'second')]);
      assert.deepEqual(result.map(r=>r.threadId),[a,b]);
      assert.deepEqual(result.map(r=>r.arguments.text),['first','second']);
      passed('shared-native-metadata',{threads:2,readOnlyCalls:2,stdioWorkers:0});
    });
  } finally {await shared.close()}
  if (process.env.CODEX_TEST_APP_PIPE === '1') {
    assert(process.env.CODEX_APP_TOOLS_PIPE_PATH && process.env.CODEX_THREAD_ID,'Requires current desktop pipe and thread metadata');
    // 测试专用桥接：直接访问既有桌面管道，避免启动原 Node/CMD 适配器。
    async function desktop(method,params,signal) {
      return new Promise((resolve,reject)=>{
        const socket=net.createConnection(process.env.CODEX_APP_TOOLS_PIPE_PATH);
        let data=Buffer.alloc(0),settled=false;
        const frame=message=>{const body=Buffer.from(JSON.stringify(message));const bytes=Buffer.alloc(4+body.length);bytes.writeUInt32LE(body.length);body.copy(bytes,4);return bytes};
        const finish=(error,result)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',cancel);socket.destroy();error?reject(error):resolve(result)};
        const cancel=()=>{if(!socket.destroyed)socket.write(frame({id:1,jsonrpc:'2.0',method:'tools/cancel'}));finish(signal.reason)};
        signal?.addEventListener('abort',cancel,{once:true});
        socket.setTimeout(20000,()=>finish(new Error('Desktop pipe timeout')));
        socket.on('error',error=>finish(error));socket.on('close',()=>{if(!settled)finish(new Error('Desktop pipe closed'))});
        socket.on('connect',()=>socket.write(frame({id:1,jsonrpc:'2.0',method,params})));
        socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);if(data.length<4)return;const length=data.readUInt32LE();if(length>8*1024*1024)return finish(new Error('Oversized desktop response'));if(data.length<length+4)return;try{const response=JSON.parse(data.subarray(4,length+4));finish(response.error?new Error(response.error.message):null,response.result)}catch(error){finish(error)}});
      });
    }
    assert((await desktop('tools/list',{threadStartKind:'all'})).tools.some(tool=>tool.name==='list_projects'));
    let directorySize=0;
    const actual=await createSharedAppToolsHost({callerHostId:process.env.CODEX_APP_TOOLS_CALLER_HOST_ID,
      listTools:async()=>{const result=await desktop('tools/list',{threadStartKind:'all'});directorySize=result.tools.length;return result.tools},
      callTool:({params,callerSource,hostId},signal)=>desktop('tools/call',{...params,callerSource,hostId},signal)},{http,crypto});
    try {
      await withBackend('shared-desktop',httpConfig(actual),async api=>{
        const id=await api.start();
        assert((await api.inventory(id)).data[0].tools.list_projects);
        for(let i=0;i<2;i++){
          const result=await api.rpc('mcpServer/tool/call',{threadId:id,server:'probe',tool:'list_projects',arguments:{},_meta:{'openai/threadId':process.env.CODEX_THREAD_ID}});
          assert(!result.isError && result.content.length>0,'Desktop read-only call failed');
        }
        passed('shared-real-desktop',{tools:directorySize,readOnlyCalls:2,stdioWorkers:0});
      });
    } finally {await actual.close()}
  }
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
  console.error(error.stack);
} finally {
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Report: ${path.join(root, 'report.json')}`);
}
