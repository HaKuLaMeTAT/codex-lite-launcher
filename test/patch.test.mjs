import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transform, transformCheckout, buildPatch, buildOptimizedPatch, readArchive, sha256, VERSION, BACKUP_SUFFIX, install, restore, inspect, sourceForCopy } from '../patch.mjs';
import { transformRuntime, transformInactiveThreads } from '../runtime-patches.mjs';
import { inspectUpgrade, applyUpgrade, restoreUpgrade } from '../inplace.mjs';
import { UPGRADE_BACKUP_SUFFIX, rewriteArchive } from '../patch.mjs';
import { executableIntegrity, headerHash, updateExecutable } from '../exe-integrity.mjs';
import { createCopy, inspectSource, verifyCopy, hashFile, MANIFEST } from '../copy.mjs';
import { OPTIONS, normalizeOptions, parseOptionsArgument } from '../options.mjs';
import { SELECTION_FILE, UNRECORDED_OPTIONS } from '../patch.mjs';
import acorn from '../vendor/acorn.cjs';

function exeFixture(asar) {
  const exe = Buffer.alloc(0x800);
  exe.write('MZ'); exe.writeUInt32LE(0x80, 60); exe.writeUInt32LE(0x4550, 0x80);
  exe.writeUInt16LE(1, 0x86); exe.writeUInt16LE(240, 0x94); exe.writeUInt16LE(0x20b, 0x98);
  exe.writeUInt32LE(0x1000, 0x98 + 112 + 16); exe.writeUInt32LE(0x600, 0x98 + 112 + 20);
  const section = 0x98 + 240;
  exe.writeUInt32LE(0x1000, section + 12); exe.writeUInt32LE(0x600, section + 16); exe.writeUInt32LE(0x200, section + 20);
  const base = 0x200;
  for (const [directory, name, child] of [[0, 128, 32], [32, 160, 64]]) {
    exe.writeUInt16LE(1, base + directory + 12);
    exe.writeUInt32LE(0x80000000 + name, base + directory + 16);
    exe.writeUInt32LE(0x80000000 + child, base + directory + 20);
  }
  exe.writeUInt16LE(1, base + 64 + 14); exe.writeUInt32LE(1033, base + 80); exe.writeUInt32LE(96, base + 84);
  for (const [position, name] of [[128, 'INTEGRITY'], [160, 'ELECTRONASAR']]) {
    exe.writeUInt16LE(name.length, base + position); exe.write(name, base + position + 2, 'utf16le');
  }
  const json = JSON.stringify([{ file: 'resources\\app.asar', alg: 'SHA256', value: headerHash(asar) }]);
  exe.writeUInt32LE(0x1100, base + 96); exe.writeUInt32LE(Buffer.byteLength(json), base + 100);
  exe.write(json, base + 256);
  return exe;
}

const main = `// 中文：检查字符处理
class Avatar {
 async prewarm(e){if(this.openingWindowPromise)return;await this.ensureWindow(e)}
 async open(e){return this.ensureWindow(e)}
}
class Hotkey {
 async prewarm(){await this.ensureHomeWindow();await this.ensureThreadWindow()}
 async showHome(){return this.ensureHomeWindow()}
 async showThread(){return this.ensureThreadWindow()}
}
class Detached {
 scheduleFill(){this.fillTimer=setTimeout(()=>this.slot.prewarm(),2000)}
 take(){return this.slot.takeReady()??this.createWindow()}
}
browser.setOnBrowserStateChanged(()=>{menu.refreshApplicationMenu(),sync()});
class Terminal {
 callbacks(){return {onData:e=>{if(!this.ready){this.buffer=(this.buffer+e).slice(-16e3);return}this.appendOutput(e)},onExit:e=>this.destroySession(e)}}
}`;
const checkout = `// CheckoutPricingWebviewHost
function pricing(active){const warm=enabled&&get(\`use_embedded_checkout\`,false)?create('pricing-prewarm'):null;return active?create('pricing-explicit'):warm}
function credit(active){if(!active&&(blocked()||!get(\`use_embedded_credit_checkout\`,false)))return null;return create(active?'credit-explicit':'credit-prewarm')}`;
const initial = `
function words({fadeText,fadeSegmentStartIndex,fadeSegmentTimeline,keys,segments}){return fadeText?segments.map((s,i)=>element(\`span\`,s,keys?.[i]??i)):segments}
function subscribe(manager,scope,host){manager.subscribe({listener:event=>{switch(event.method){
case\`mcpServer/startupStatus/updated\`:event.params.status===\`ready\`&&event.params.threadId!=null&&refetch(scope.queryClient,{queryKey:[\`mcp\`,host,\`toolsAndAuthOnly\`],exact:!0},{cancelRefetch:!1});notify(event);break;
case\`account/updated\`:account();break;
case\`item/completed\`:manager.getConversationCwd(event.params.threadId);break;
}}})}`;
const shared = `
class Output {
 applyOutputDeltas(batch){let byConversation=new Map;for(let d of batch){let group=byConversation.get(d.conversationId);group?group.push(d):byConversation.set(d.conversationId,[d])}
 for(let [id,deltas] of byConversation){let conversation=this.threadStore.conversations.get(id);if(!conversation)continue;
 this.threadStore.updateConversationState(id,state=>{for(let d of deltas){let turn=Object.values(state.turnHistory.history.entitiesByKey).find(t=>t.items.some(i=>i.id===d.itemId&&i.type===\`commandExecution\`));let item=turn?.items.find(i=>i.id===d.itemId);if(item)item.aggregatedOutput=(item.aggregatedOutput??'')+d.delta}}, {broadcastPatchesToFollowers:!1,acceptedTranscriptText:{changes:deltas}})}}
}
function highlightView(state,module,set){const task=()=>{let code=state.latestContent,language=state.latestLanguage;set(module.highlightCode(code,language))};const cleanup=()=>{state.disposed=!0,state.timeoutHandle!=null&&(clearTimeout(state.timeoutHandle),state.timeoutHandle=null)};return {task,cleanup}}`;

test('three prewarms stop; normal open paths still create; menu coalesces without throttling sync', async () => {
  const timers = [], calls = [];
  let callback, syncs = 0;
  const menu = { refreshApplicationMenu() { assert.equal(this, menu); calls.push('menu'); } };
  const context = { browser: { setOnBrowserStateChanged(fn) { callback = fn; } }, menu,
    sync: () => syncs++, setTimeout: (fn, delay) => { assert.equal(delay, 250); timers.push(fn); return timers.length; } };
  const { Avatar, Hotkey, Detached } = vm.runInNewContext(transform(main).bytes.toString() + ';({Avatar,Hotkey,Detached})', context);
  const opened = [];
  const a = new Avatar(); a.ensureWindow = async () => { opened.push('avatar'); return 'avatar'; };
  await a.prewarm(); assert.equal(await a.open(), 'avatar');
  const h = new Hotkey();
  h.ensureHomeWindow = async () => { opened.push('home'); return 'home'; };
  h.ensureThreadWindow = async () => { opened.push('thread'); return 'thread'; };
  await h.prewarm(); assert.equal(await h.showHome(), 'home'); assert.equal(await h.showThread(), 'thread');
  const d = new Detached(); d.slot = { prewarm: () => assert.fail('prewarm'), takeReady: () => null };
  d.createWindow = () => 'detached'; d.scheduleFill(); assert.equal(d.take(), 'detached');
  assert.deepEqual(opened, ['avatar', 'home', 'thread']);
  callback(); callback(); callback();
  assert.equal(calls.length, 1); assert.equal(syncs, 3);
  timers[0](); assert.equal(calls.length, 2);
  callback(); callback(); assert.equal(syncs, 5); assert.equal(calls.length, 2);
  timers[1](); assert.equal(calls.length, 3);
  timers[2](); callback(); assert.equal(calls.length, 4); assert.equal(syncs, 6);
});

test('pricing and credit skip prewarm but preserve explicit checkout entry points', () => {
  for (const source of [checkout, transformCheckout(checkout).bytes.toString()]) {
    const created = [];
    const api = vm.runInNewContext(source + ';({pricing,credit})', {
      enabled: true, get: () => true, blocked: () => false, create: kind => { created.push(kind); return kind; },
    });
    const patched = source !== checkout;
    assert.equal(api.pricing(false), patched ? null : 'pricing-prewarm');
    assert.equal(api.credit(false), patched ? null : 'credit-prewarm');
    assert.equal(api.pricing(true), 'pricing-explicit');
    assert.equal(api.credit(true), 'credit-explicit');
    if (patched) assert.deepEqual(created, ['pricing-explicit', 'credit-explicit']);
  }
});

test('missing, duplicate and already patched structures are rejected', () => {
  assert.throws(() => transform('class A {}'), /唯一匹配/);
  assert.throws(() => transform(main + main.replaceAll('class ', 'class Extra')), /唯一匹配/);
  assert.throws(() => transform(transform(main).bytes.toString()), /已包含/);
  assert.throws(() => transformCheckout('const x = null'), /唯一匹配/);
  assert.throws(() => transformCheckout(transformCheckout(checkout).bytes.toString()), /已包含/);
  assert.throws(() => readArchive(Buffer.alloc(16)), /ASAR/);
});

// 缩小的会话选择边界样例；真实应用管理器另由 CODEX_TEST_ASAR 只读验证。
const lifecycle = `var retention=108e5;
class Lifecycle {
 constructor(){this.entries=new Map;this.active=new Set;this.followers=new Set;this.pinned=new Set;this.owned=new Set}
 hasActiveConversationView(id){return this.active.has(id)}
 hasOwnedStreamFollowers(id){return this.followers.has(id)}
 shouldKeepConversationLoaded(id){return this.pinned.has(id)}
 ownsConversationHistoryStream(id){return this.owned.has(id)}
 getNextCheckAtMs(){let next=null;for(const [id,since] of this.entries){if(this.hasActiveConversationView(id)||this.hasOwnedStreamFollowers(id)||this.shouldKeepConversationLoaded(id)||!this.ownsConversationHistoryStream(id))continue;const deadline=since+retention;next=next===null?deadline:Math.min(next,deadline)}return next}
 getInactiveOwnerConversationIdsToUnsubscribe(now){const result=[];for(const [id,since] of this.entries){if(this.hasActiveConversationView(id)||this.hasOwnedStreamFollowers(id)||this.shouldKeepConversationLoaded(id)||!this.ownsConversationHistoryStream(id))continue;if(now-since>=retention)result.push(id)}this.diagnostics={ttlMs:retention};return result}
 unsubscribeInactiveConversation(id){this.resumeState='needs_resume';return this.sendRequest('thread/unsubscribe',{threadId:id})}
}`;

function fixture(version = VERSION) {
  const files = new Map([
    ['package.json', JSON.stringify({ name: 'openai-codex-electron', version })],
    ['.vite/build/main-renamed.js', main], ['webview/assets/webview-page-renamed.js', checkout],
    ['webview/assets/app-initial-renamed.js', initial], ['webview/assets/app-shared-renamed.js', shared + lifecycle],
    ['.vite/build/bootstrap-renamed.js', lifecycle],
    ['unrelated.txt', 'preserve custom screenshot patch and settings'],
  ]);
  const header = { files: {} }, data = [];
  let offset = 0;
  for (const [name, source] of files) {
    const bytes = Buffer.from(source), parts = name.split('/');
    let directory = header;
    for (const part of parts.slice(0, -1)) directory = directory.files[part] ??= { files: {} };
    const blocks = [];
    for (let i = 0; i < bytes.length; i += 64) blocks.push(sha256(bytes.subarray(i, i + 64)));
    directory.files[parts.at(-1)] = { size: bytes.length, offset: String(offset),
      integrity: { algorithm: 'SHA256', hash: sha256(bytes), blockSize: 64, blocks } };
    data.push(bytes); offset += bytes.length;
  }
  header.files['native.node'] = { unpacked: true, size: 123, executable: true };
  header.files.alias = { link: 'unrelated.txt' };
  const json = Buffer.from(JSON.stringify(header)), headerSize = 8 + Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(8 + headerSize);
  prefix.writeUInt32LE(4); prefix.writeUInt32LE(headerSize, 4);
  prefix.writeUInt32LE(headerSize - 4, 8); prefix.writeUInt32LE(json.length, 12); json.copy(prefix, 16);
  return Buffer.concat([prefix, ...data]);
}

function verifyContents(original, candidate, changed) {
  const before = readArchive(original), after = readArchive(candidate);
  assert.deepEqual([...before.entries.keys()], [...after.entries.keys()]);
  for (const [name, old] of before.entries) {
    const next = after.entries.get(name);
    if (old.unpacked || old.link) { assert.deepEqual(next, old); continue; }
    const bytes = after.entry(name).bytes;
    assert.equal(sha256(bytes), next.integrity.hash, name);
    if (!changed.includes(name)) {
      assert.ok(before.entry(name).bytes.equals(bytes), name);
      assert.deepEqual({ ...next, offset: old.offset }, old, name);
    }
  }
}

test('renamed modules and non-baseline package work; all other data and unpacked metadata survive', () => {
  const original = fixture(), result = buildPatch(original);
  assert.equal(result.report.changes.length, 6);
  verifyContents(original, result.bytes, result.report.modules);
  assert.throws(() => buildPatch(fixture('99.0.0')), /暂不支持版本/);
  const corrupted = Buffer.from(original);
  corrupted[readArchive(original).entry('.vite/build/main-renamed.js').start + 3] ^= 1;
  assert.throws(() => buildPatch(corrupted), /摘要校验失败/);
});

test('install, inspect, later-change protection, restore and reapply preserve the backup', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-perf-test-'));
  fs.mkdirSync(path.join(directory, 'resources'));
  const target = path.join(directory, 'resources', 'app.asar'), original = fixture();
  const exe = path.join(directory, 'ChatGPT.exe'), originalExe = exeFixture(original);
  try {
    fs.writeFileSync(target, original);
    fs.writeFileSync(exe, originalExe);
    assert.throws(() => install(target, () => { throw Error('running'); }), /running/);
    assert.equal(fs.existsSync(target + BACKUP_SUFFIX), false);
    assert.equal(inspect(target).status, 'ready');
    install(target, () => {});
    assert.equal(inspect(target).status, 'patched');
    assert.equal(executableIntegrity(fs.readFileSync(exe)).hash, headerHash(fs.readFileSync(target)));
    assert.throws(() => install(target, () => {}), /已包含/);
    const patched = fs.readFileSync(target), corrupt = Buffer.from(patched);
    corrupt[corrupt.length - 1] ^= 1; fs.writeFileSync(target, corrupt);
    assert.throws(() => restore(target, () => {}), /拒绝覆盖/);
    fs.writeFileSync(target, patched);
    restore(target, () => {});
    assert.ok(fs.readFileSync(target).equals(original));
    assert.ok(fs.readFileSync(exe).equals(originalExe));
    install(target, () => {}); restore(target, () => {});
    assert.ok(fs.readFileSync(target + BACKUP_SUFFIX).equals(original));
    assert.ok(fs.readFileSync(exe + BACKUP_SUFFIX).equals(originalExe));
    // 模拟第二次替换失败：现场能识别为 partial，并可从两份备份恢复。
    const rename = fs.renameSync;
    try {
      fs.renameSync = (from, to) => { if (to === exe) throw Error('injected EXE replace failure'); return rename(from, to); };
      assert.throws(() => install(target, () => {}), /injected/);
    } finally { fs.renameSync = rename; }
    assert.equal(inspect(target).status, 'partial');
    restore(target, () => {});
    assert.ok(fs.readFileSync(target).equals(original));
    assert.ok(fs.readFileSync(exe).equals(originalExe));
  } finally {
    const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(directory));
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('codex-perf-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('EXE resource update changes only its hash and rejects mismatched original pair', () => {
  const original = fixture(), candidate = buildPatch(original).bytes, exe = exeFixture(original);
  const resource = executableIntegrity(exe), updated = updateExecutable(exe, original, candidate).bytes;
  assert.equal(executableIntegrity(updated).hash, headerHash(candidate));
  assert.ok(exe.subarray(0, resource.start).equals(updated.subarray(0, resource.start)));
  assert.ok(exe.subarray(resource.start + 64).equals(updated.subarray(resource.start + 64)));
  assert.throws(() => updateExecutable(exe, candidate, original), /校验不匹配/);
  assert.throws(() => executableIntegrity(Buffer.alloc(64)), /EXE/);
});

test('independent copy uses original or verified backups, preserves source and rejects unsafe destinations', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-perf-test-'));
  const source = path.join(directory, 'source'), target = path.join(source, 'resources', 'app.asar');
  fs.mkdirSync(path.join(source, 'resources', 'app.asar.unpacked'), { recursive: true });
  fs.mkdirSync(path.join(source, 'locales'));
  const original = fixture(), exe = path.join(source, 'ChatGPT.exe');
  fs.writeFileSync(target, original); fs.writeFileSync(exe, exeFixture(original));
  fs.writeFileSync(path.join(source, 'chrome.dll'), 'runtime DLL fixture');
  fs.writeFileSync(path.join(source, 'locales', 'zh-CN.pak'), 'locale fixture');
  fs.writeFileSync(path.join(source, 'resources', 'app.asar.unpacked', 'native.node'), 'native runtime fixture');
  try {
    assert.equal(inspectSource(target).sourceState, 'ready');
    const plainOutput = path.join(directory, 'plain-copy');
    const plain = createCopy(target, plainOutput);
    assert.equal(plain.status, 'copy-created');
    assert.equal(verifyCopy(plainOutput).status, 'copy-verified');
    assert.ok(fs.readFileSync(target).equals(original));
    assert.throws(() => createCopy(target, source), /互相包含/);
    assert.throws(() => createCopy(target, path.join(source, 'nested')), /互相包含/);
    assert.throws(() => createCopy(target, directory), /互相包含/);
    assert.throws(() => createCopy(target, plainOutput), /已存在/);
    assert.throws(() => inspectSource(path.join(plainOutput, 'resources', 'app.asar')), /已经是优化副本/);
    install(target, () => {});
    const installed = { exe: hashFile(exe), asar: hashFile(target) };
    assert.equal(inspectSource(target).useVerifiedBackups, true);
    const patchedOutput = path.join(directory, 'copy from patched');
    createCopy(target, patchedOutput);
    assert.equal(hashFile(exe), installed.exe); assert.equal(hashFile(target), installed.asar);
    assert.equal(hashFile(path.join(patchedOutput, 'ChatGPT.exe')), hashFile(path.join(plainOutput, 'ChatGPT.exe')));
    assert.equal(hashFile(path.join(patchedOutput, 'resources', 'app.asar')), hashFile(path.join(plainOutput, 'resources', 'app.asar')));
    assert.equal(fs.existsSync(path.join(patchedOutput, 'resources', 'app.asar' + BACKUP_SUFFIX)), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(patchedOutput, MANIFEST)));
    assert.equal(manifest.sourceState, 'patched');
    assert.deepEqual(manifest.launchArguments, ['--disable-features=NonBlockingOsClipboardReads']);
    assert.ok(manifest.files.some(item => item.path === 'resources/app.asar.unpacked/native.node'));
    fs.appendFileSync(path.join(patchedOutput, 'chrome.dll'), 'changed');
    assert.throws(() => verifyCopy(patchedOutput), /已变化/);
    fs.mkdirSync(path.join(directory, 'unfinished.building'));
    assert.throws(() => createCopy(target, path.join(directory, 'unfinished')), /已存在/);
  } finally {
    const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(directory));
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('codex-perf-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('real ASAR: five modules, lifecycle scheduling, packed files and external metadata verify', {
  skip: !process.env.CODEX_TEST_ASAR,
}, () => {
  const source = sourceForCopy(process.env.CODEX_TEST_ASAR);
  const original = fs.readFileSync(source.asarInput), result = { bytes: source.candidate.asar, report: source.candidate.report };
  assert.equal(result.report.patchVersion, 5);
  assert.equal(result.report.modules.length, 5);
  assert.equal(result.report.changes.length, 14);
  verifyContents(original, result.bytes, result.report.modules);
  const originalExe = fs.readFileSync(source.exeInput);
  const resource = executableIntegrity(originalExe), patchedExe = updateExecutable(originalExe, original, result.bytes).bytes;
  assert.equal(executableIntegrity(patchedExe).hash, headerHash(result.bytes));
  assert.ok(originalExe.subarray(0, resource.start).equals(patchedExe.subarray(0, resource.start)));
  assert.ok(originalExe.subarray(resource.start + 64).equals(patchedExe.subarray(resource.start + 64)));
  assert.throws(() => buildPatch(result.bytes), /已包含/);
  const archive = readArchive(original), output = readArchive(result.bytes);
  for (const name of result.report.modules.filter(n => /bootstrap-|app-shared-/.test(n))) {
    const input = archive.entry(name).bytes.toString();
    const patched = transformInactiveThreads(input, 'test').bytes.toString();
    assert.equal(patched.replace('/*codex-lite-inactive:v1*/300000', '108e5'), input);
    assert.ok(output.entry(name).bytes.includes(Buffer.from('/*codex-lite-inactive:v1*/300000')));
    verifyRealLifecycle(patched);
  }
});

// 在 VM 中运行真实包的候选选择/定时方法；不向正在运行的后端发送任何请求。
function verifyRealLifecycle(source) {
  let owner, ttl, capacity, ephemeral;
  function visit(node, fields = false) {
    if (!node || typeof node !== 'object') return;
    if (['ClassExpression', 'ClassDeclaration'].includes(node.type) && node.body.body.some(n => n.key?.name === 'getInactiveOwnerConversationIdsToUnsubscribe')) owner = node;
    if (fields && node.type === 'Property' && node.key.name === 'ttlMs' && node.value.type === 'Identifier') ttl = node.value.name;
    if (fields && node.type === 'Property' && node.key.name === 'maxInactiveOwnerThreads' && node.value.type === 'Identifier') capacity = node.value.name;
    if (fields && node.type === 'Property' && node.key.name === 'isEphemeralSideConversation' && node.value.type === 'CallExpression') ephemeral = node.value.callee.name;
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(n => visit(n, fields)); else if (value && typeof value === 'object') visit(value, fields);
  }
  visit(acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));
  // 只取目标类的词法依赖，避免同模块其他 ttlMs 日志字段覆盖名称。
  assert.ok(owner); visit(owner, true);
  assert.ok(owner && ttl && capacity && ephemeral);
  const Manager = vm.runInNewContext('(' + source.slice(owner.start, owner.end) + ')', { [ttl]: 300000, [capacity]: 10, [ephemeral]: c => c.ephemeral === true });
  const manager = Object.create(Manager.prototype), states = new Map();
  manager.inactiveOwnerConversationSinceById = new Map(); manager.inactiveOwnerConversationRetryAtById = new Map();
  manager.unsubscribingConversationIds = new Set();
  manager.params = { logger: { debug() {} }, threadStore: { getConversation: id => states.get(id), isConversationActive: id => states.get(id).visible },
    streamState: { ownsConversationHistoryStream: id => states.get(id).owned, getStreamRole: () => ({ role: 'owner' }), hasFollowersOrPendingFollowerReconnect: id => states.get(id).followers } };
  manager.shouldKeepConversationLoaded = state => state.keep;
  for (const id of ['idle', 'visible', 'followers', 'keep', 'unowned', 'resuming', 'retry', 'unsubscribing']) {
    states.set(id, { resumeState: 'resumed', owned: true }); manager.inactiveOwnerConversationSinceById.set(id, 1000);
  }
  states.get('visible').visible = true; states.get('followers').followers = true; states.get('keep').keep = true;
  states.get('unowned').owned = false; states.get('resuming').resumeState = 'resuming';
  manager.inactiveOwnerConversationRetryAtById.set('retry', 601000); manager.unsubscribingConversationIds.add('unsubscribing');
  assert.equal(manager.getNextCheckAtMs(300999), 301000);
  assert.deepEqual(Array.from(manager.getInactiveOwnerConversationIdsToUnsubscribe(300999)), []);
  assert.deepEqual(Array.from(manager.getInactiveOwnerConversationIdsToUnsubscribe(301000)), ['idle']);
  states.get('idle').visible = true;
  assert.deepEqual(Array.from(manager.getInactiveOwnerConversationIdsToUnsubscribe(301000)), []);
  assert.equal(manager.getNextCheckAtMs(301000), 601000);
}

test('in-place upgrade and rollback preserve original/legacy pairs and support copied delivery', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-perf-test-'));
  try {
    for (const legacy of [false, true]) {
      const root = path.join(directory, String(legacy)), target = path.join(root, 'resources', 'app.asar'), exe = path.join(root, 'ChatGPT.exe');
      fs.mkdirSync(path.join(root, 'resources', 'app.asar.unpacked'), { recursive: true });
      fs.mkdirSync(path.join(root, 'locales')); fs.writeFileSync(path.join(root, 'chrome.dll'), 'fixture');
      const original = fixture(); fs.writeFileSync(target, original); fs.writeFileSync(exe, exeFixture(original));
      if (legacy) install(target, () => {});
      const before = [target, exe].map(hashFile);
      assert.throws(() => applyUpgrade(target, () => { throw Error('running'); }), /running/);
      assert.equal(fs.existsSync(target + UPGRADE_BACKUP_SUFFIX), false);
      // 模拟只完成第一份备份即中断，再次升级应补齐另一份。
      fs.copyFileSync(target, target + UPGRADE_BACKUP_SUFFIX);
      assert.equal(applyUpgrade(target, () => {}).state, 'upgraded');
      assert.equal(inspectUpgrade(target).state, 'upgraded');
      assert.equal(applyUpgrade(target, () => {}).state, 'upgraded');
      assert.deepEqual([target, exe].map(f => hashFile(f + UPGRADE_BACKUP_SUFFIX)), before);
      if (legacy) {
        assert.ok(fs.readFileSync(target + BACKUP_SUFFIX).equals(original));
        fs.unlinkSync(target + BACKUP_SUFFIX); fs.unlinkSync(exe + BACKUP_SUFFIX);
        assert.equal(inspectUpgrade(target).state, 'upgraded');
        assert.equal(inspectUpgrade(target).canRestore, true);
      }
      const output = path.join(directory, 'copy-' + legacy);
      createCopy(target, output);
      assert.equal(hashFile(path.join(output, 'resources', 'app.asar')), hashFile(target));
      assert.equal(hashFile(path.join(output, 'ChatGPT.exe')), hashFile(exe));
      assert.equal(fs.existsSync(path.join(output, 'ChatGPT.exe' + UPGRADE_BACKUP_SUFFIX)), false);
      restoreUpgrade(target, () => {});
      assert.deepEqual([target, exe].map(hashFile), before);
      applyUpgrade(target, () => {});
      fs.appendFileSync(exe, 'unknown');
      assert.throws(() => restoreUpgrade(target, () => {}), /未知后续修改/);
    }
  } finally {
    const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(directory));
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('codex-perf-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('in-place interrupted replacement can roll back and preflight failures never replace files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-perf-test-'));
  const target = path.join(directory, 'resources', 'app.asar'), exe = path.join(directory, 'ChatGPT.exe');
  const rename = fs.renameSync, statfs = fs.statfsSync;
  try {
    fs.mkdirSync(path.dirname(target)); const original = fixture();
    fs.writeFileSync(target, original); fs.writeFileSync(exe, exeFixture(original));
    install(target, () => {});
    fs.unlinkSync(target + BACKUP_SUFFIX); fs.unlinkSync(exe + BACKUP_SUFFIX);
    const before = [target, exe].map(hashFile);
    fs.statfsSync = () => ({ bavail: 0, bsize: 4096 });
    assert.throws(() => applyUpgrade(target, () => {}), /磁盘空间不足/);
    fs.statfsSync = statfs;
    assert.equal(fs.existsSync(target + UPGRADE_BACKUP_SUFFIX), false);
    let checks = 0;
    assert.throws(() => applyUpgrade(target, () => { if (++checks === 2) throw Error('running again'); }), /running again/);
    assert.deepEqual([target, exe].map(hashFile), before);
    fs.renameSync = (from, to) => { if (to === exe) throw Error('injected'); return rename(from, to); };
    assert.throws(() => applyUpgrade(target, () => {}), /替换未完成.*injected/);
    fs.renameSync = rename;
    assert.equal(inspectUpgrade(target).state, 'partial');
    assert.throws(() => applyUpgrade(target, () => {}), /半完成/);
    restoreUpgrade(target, () => {});
    assert.deepEqual([target, exe].map(hashFile), before);
    fs.writeFileSync(exe + '.lite-v5.tmp', 'unknown');
    assert.throws(() => applyUpgrade(target, () => {}), /临时文件内容未知/);
    assert.deepEqual([target, exe].map(hashFile), before);
  } finally {
    fs.renameSync = rename; fs.statfsSync = statfs;
    const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(directory));
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('codex-perf-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('incremental legacy upgrade matches clean build and rejects damaged legacy structures', () => {
  const original = fixture(), legacy = buildPatch(original).bytes;
  assert.ok(buildOptimizedPatch(legacy).bytes.equals(buildOptimizedPatch(original).bytes));
  const archive = readArchive(legacy);
  const mainName = [...archive.entries.keys()].find(name => name.startsWith('.vite/build/main-'));
  const checkoutName = [...archive.entries.keys()].find(name => name.startsWith('webview/assets/webview-page-'));
  for (const [name, from, to] of [[mainName, 'setTimeout(tick,250)', 'setTimeout(tick,999)'],
    [mainName, 'return;', 'return 1;'], [checkoutName, '(!1&&(', '(!0&&(']]) {
    const source = archive.entry(name).bytes.toString(); assert.ok(source.includes(from));
    const damaged = rewriteArchive(legacy, new Map([[name, Buffer.from(source.replace(from, to))]]));
    assert.throws(() => buildOptimizedPatch(damaged), /旧补丁/);
  }
});

test('selectable optimizations cover individual choices, disabled matchers and grouped cleanup', () => {
  const original = fixture();
  assert.ok(buildOptimizedPatch(original).bytes.equals(buildOptimizedPatch(original, OPTIONS.map(o => o.id)).bytes));
  assert.ok(buildOptimizedPatch(original, []).bytes.equals(original));
  for (const option of OPTIONS) {
    const result = buildOptimizedPatch(original, [option.id]);
    assert.deepEqual(result.report.selectedOptions, [option.id]);
    assert.deepEqual([...result.report.changes].sort(), [...option.edits].sort());
    verifyContents(original, result.bytes, result.report.modules);
  }
  const archive = readArchive(original), initialName = [...archive.entries.keys()].find(n => n.startsWith('webview/assets/app-initial-'));
  const changed = rewriteArchive(original, new Map([[initialName, Buffer.from('invalid syntax !')]]));
  assert.deepEqual(buildOptimizedPatch(changed, ['menu']).report.changes, ['menu']);
  assert.throws(() => buildOptimizedPatch(changed, ['settled-stream-text']));
  assert.throws(() => buildOptimizedPatch(buildPatch(original).bytes, ['menu']), /不能取消/);
  assert.throws(() => buildOptimizedPatch(fixture('99.0.0'), ['menu']), /暂不支持版本/);
  assert.throws(() => normalizeOptions(['unknown']), /未知/);
  assert.throws(() => normalizeOptions(['menu', 'menu']), /重复/);
  assert.deepEqual(parseOptionsArgument('--options=none'), []);
  assert.throws(() => parseOptionsArgument('--options='), /未知/);
});

test('selected installation records survive restart, partial replacement and option-independent rollback', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-perf-test-'));
  const root = path.join(directory, 'source'), target = path.join(root, 'resources', 'app.asar'), exe = path.join(root, 'ChatGPT.exe');
  const rename = fs.renameSync;
  try {
    fs.mkdirSync(path.join(root, 'resources', 'app.asar.unpacked'), { recursive: true });
    fs.mkdirSync(path.join(root, 'locales')); fs.writeFileSync(path.join(root, 'chrome.dll'), 'fixture');
    const original = fixture(); fs.writeFileSync(target, original); fs.writeFileSync(exe, exeFixture(original));
    const before = [target, exe].map(hashFile);
    applyUpgrade(target, () => {}, []);
    assert.equal(fs.existsSync(target + UPGRADE_BACKUP_SUFFIX), false);
    const selected = ['menu', 'cached-highlight-language'];
    applyUpgrade(target, () => {}, selected);
    assert.equal(inspectUpgrade(target, selected).matchesSelection, true);
    assert.equal(inspectUpgrade(target).matchesSelection, false);
    assert.equal(applyUpgrade(target, () => {}, selected).state, 'upgraded');
    const record = JSON.parse(fs.readFileSync(path.join(root, SELECTION_FILE)));
    assert.deepEqual(record.options, selected);
    const output = path.join(directory, 'copy'); createCopy(target, output, ['menu']);
    const manifest = JSON.parse(fs.readFileSync(path.join(output, MANIFEST)));
    assert.deepEqual(manifest.selectedOptions, ['menu']);
    assert.equal(fs.existsSync(path.join(output, SELECTION_FILE)), false);
    assert.ok(fs.readFileSync(path.join(output, 'resources', 'app.asar')).equals(buildOptimizedPatch(original, ['menu']).bytes));
    restoreUpgrade(target, () => {});
    assert.deepEqual([target, exe].map(hashFile), before);
    // 无需重新勾选安装时的组合，记录能识别部分替换并恢复。
    fs.renameSync = (from, to) => { if (to === exe) throw Error('injected'); return rename(from, to); };
    assert.throws(() => applyUpgrade(target, () => {}, ['menu']), /injected/);
    fs.renameSync = rename;
    assert.equal(inspectUpgrade(target).state, 'partial');
    restoreUpgrade(target, () => {});
    assert.deepEqual([target, exe].map(hashFile), before);
    applyUpgrade(target, () => {}, ['batched-pty-output']);
    fs.unlinkSync(path.join(root, SELECTION_FILE));
    assert.throws(() => inspectUpgrade(target), /选项记录缺失/);
  } finally {
    fs.renameSync = rename;
    const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(directory));
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('codex-perf-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function testClock() {
  let now = 0, next = 0;
  const tasks = new Map();
  return { tasks, setTimeout(fn, ms) { const id = ++next; tasks.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) { const entry = [...tasks].sort((a, b) => a[1].at - b[1].at)[0]; if (!entry || entry[1].at > end) break;
        now = entry[1].at; tasks.delete(entry[0]); entry[1].fn(); }
      now = end;
    } };
}
function runtimeApi(source, kind, expression, context = {}) {
  return vm.runInNewContext(transformRuntime(source, kind).bytes.toString() + ';(' + expression + ')', context);
}

test('PTY batches preserve Unicode/ANSI bytes, startup buffering and output-before-exit', () => {
  const clock = testClock(), received = [], lifecycle = [];
  const Terminal = runtimeApi(main, 'main', 'Terminal', { ...clock, browser: { setOnBrowserStateChanged() {} } });
  const terminal = new Terminal(); terminal.ready = false; terminal.buffer = '';
  terminal.appendOutput = chunk => { received.push(chunk); lifecycle.push('data'); };
  terminal.destroySession = code => lifecycle.push('exit:' + code);
  const callbacks = terminal.callbacks();
  callbacks.onData('startup'); assert.equal(terminal.buffer, 'startup'); clock.advance(16);
  terminal.ready = true;
  const chunks = ['typing', '\u001b[31m', '\ud83d', '\ude80', '中文\r\n', 'x'.repeat(65536), 'tail'];
  callbacks.onData(chunks[0]); assert.equal(received.join(''), 'typing');
  for (const chunk of chunks.slice(1)) callbacks.onData(chunk);
  callbacks.onExit(7);
  assert.equal(received.join(''), chunks.join(''));
  assert.equal(lifecycle.at(-1), 'exit:7');
  assert.equal(clock.tasks.size, 0);
  clock.advance(100); assert.equal(received.join(''), chunks.join(''));
});

test('settled stream text preserves text/decorations and only active segments remain elements', () => {
  const render = (tag, content, key) => ({ tag, content, key });
  const words = runtimeApi(initial, 'initial', 'words', { element: render });
  const baseline = vm.runInNewContext(initial + ';words', { element: render });
  const decoration = { link: 'example' }, segments = ['你', '好', decoration, ' world', '🚀'];
  const args = { fadeText: true, fadeSegmentStartIndex: 0, segments, keys: [1, 2, 3, 4, 5], fadeSegmentTimeline: { settledKeys: new Set([1, 2, 3, 4]) } };
  const normalize = items => items.map(item => item?.tag === 'span' ? item.content : item);
  const original = baseline(args), patched = words(args);
  assert.deepEqual(JSON.parse(JSON.stringify(normalize(patched))), ['你好', decoration, ' world', '🚀']);
  assert.equal(normalize(patched).map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(''), normalize(original).map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(''));
  assert.equal(patched.filter(x => x?.tag === 'span').length, 2);
  assert.equal(words({ ...args, fadeText: false }), segments);
  assert.equal(words({ ...args, keys: undefined }).length, segments.length);
});

test('command output matches original data while narrowing only complete latest-turn batches', () => {
  const base = { turnHistory: { kind: 'canonical', history: { islands: [{ newerBoundary: { status: 'exhausted' }, entries: [{ value: 'old' }, { value: 'latest' }] }],
    entitiesByKey: { old: { turnId: 't0', items: [{ id: 'o', type: 'commandExecution', aggregatedOutput: '' }] },
      latest: { turnId: 't1', items: [{ id: 'a', type: 'commandExecution', aggregatedOutput: '' }, { id: 'b', type: 'commandExecution', aggregatedOutput: '' }] } } } } };
  const scenarios = [
    { changes: [{ itemId: 'a', turnId: 't1', delta: 'A' }, { itemId: 'b', delta: 'B' }, { itemId: 'a', delta: '🚀' }], narrowed: true },
    { changes: [{ itemId: 'o', turnId: 't0', delta: 'old' }], narrowed: false },
    { changes: [{ itemId: 'missing', delta: '?' }], narrowed: false },
    { changes: [{ itemId: 'a', delta: 'partial' }], narrowed: false, mutate: c => c.turnHistory.history.islands[0].newerBoundary.status = 'unknown' },
    { changes: [{ itemId: 'a', delta: 'receipt' }], narrowed: false, mutate: c => c.unconfirmedTurnSubmissions = [{ terminal: true }] },
  ];
  for (const scenario of scenarios) {
    const run = patched => {
      const state = structuredClone(base); scenario.mutate?.(state); let options;
      const Output = patched ? runtimeApi(shared, 'shared', 'Output') : vm.runInNewContext(shared + ';Output');
      const engine = new Output(); engine.threadStore = { conversations: new Map([['c', state]]), updateConversationState(id, update, opt) { update(state); options = opt; } };
      engine.applyOutputDeltas(scenario.changes.map(d => ({ ...d, conversationId: 'c' })));
      return { state, options: JSON.parse(JSON.stringify(options)) };
    };
    const before = run(false), after = run(true);
    assert.deepEqual(after.state, before.state);
    assert.deepEqual(after.options.acceptedTranscriptText, before.options.acceptedTranscriptText);
    assert.equal(after.options.broadcastPatchesToFollowers, false);
    assert.equal(Boolean(after.options.knownChangedItems), scenario.narrowed);
    if (scenario.narrowed) assert.deepEqual(after.options.knownChangedItems, [{ entityKey: 'latest', itemId: 'a' }, { entityKey: 'latest', itemId: 'b' }]);
  }
});

test('automatic highlight reuses language, settles accurately and cancels on explicit language/unmount', () => {
  const clock = testClock(), languages = [], rendered = [];
  const module = { highlightCode(code, language) { languages.push(language); return { language: language || (code.includes('SELECT') ? 'sql' : 'text'), value: code }; } };
  const state = { disposed: false, latestContent: 'aaaa', latestLanguage: undefined, timeoutHandle: null };
  const view = runtimeApi(shared, 'shared', 'highlightView', clock)(state, module, result => rendered.push(result));
  view.task(); assert.equal(languages.at(-1), undefined);
  state.latestContent = 'aaaa X'; view.task(); assert.equal(languages.at(-1), 'text');
  clock.advance(1000); assert.equal(languages.at(-1), undefined); assert.equal(rendered.at(-1).value, state.latestContent);
  state.latestContent = 'SELECT 1'; view.task(); assert.equal(languages.at(-1), undefined); assert.equal(rendered.at(-1).language, 'sql');
  state.latestContent = 'SELECT 12'; view.task(); assert.equal(clock.tasks.size, 1);
  state.latestLanguage = 'javascript'; view.task(); assert.equal(languages.at(-1), 'javascript'); assert.equal(clock.tasks.size, 0);
  state.latestLanguage = undefined; view.task(); state.latestContent += '3'; view.task(); assert.equal(clock.tasks.size, 1);
  view.cleanup(); const count = rendered.length; clock.advance(2000);
  assert.equal(rendered.length, count); assert.equal(clock.tasks.size, 0); assert.equal(state.__clAuto, null);
});

test('MCP bursts keep immediate/trailing refresh and isolate clients, hosts and non-ready events', () => {
  const clock = testClock(), requests = [], notifications = []; let accounts = 0;
  const subscribe = runtimeApi(initial, 'initial', 'subscribe', { ...clock,
    refetch: (client, options) => requests.push([client, options.queryKey[1]]), notify: e => notifications.push(e.params.status), account: () => accounts++ });
  const a = {}, b = {};
  const listen = (client, host) => { let listener; subscribe({ subscribe(options) { listener = options.listener; }, getConversationCwd() {} }, { queryClient: client }, host); return listener; };
  const one = listen(a, 'local'), two = listen(b, 'local'), remote = listen(a, 'remote');
  const ready = { method: 'mcpServer/startupStatus/updated', params: { status: 'ready', threadId: 'thread' } };
  one(ready); assert.equal(requests.length, 1);
  one(ready); one(ready); clock.advance(199); assert.equal(requests.length, 1);
  two(ready); remote(ready); assert.equal(requests.length, 3);
  one({ ...ready, params: { status: 'failed', threadId: 'thread' } });
  one({ ...ready, params: { status: 'ready', threadId: null } });
  one({ method: 'account/updated' }); assert.equal(accounts, 1);
  clock.advance(1); assert.equal(requests.length, 4); assert.equal(requests.at(-1)[0], a);
  assert.equal(notifications.length, 7); assert.ok(notifications.includes('failed'));
  clock.advance(200); assert.equal(clock.tasks.size, 0);
  one(ready); assert.equal(requests.length, 5);
});

test('runtime transforms reject incomplete, duplicate and already patched modules', () => {
  for (const [kind, source] of [['main', main], ['initial', initial], ['shared', shared]]) {
    assert.throws(() => transformRuntime('', kind), /唯一匹配/);
    assert.throws(() => transformRuntime(transformRuntime(source, kind).bytes.toString(), kind), /已包含/);
    assert.throws(() => transformRuntime(source + '\n{' + source + '\n}', kind), /唯一匹配/);
  }
  const original = fixture(), result = buildOptimizedPatch(original);
  assert.equal(result.report.modules.length, 5); assert.equal(result.report.changes.length, 14);
  verifyContents(original, result.bytes, result.report.modules);
});

test('inactive thread retention changes only TTL and preserves eligible-thread boundaries', () => {
  for (const source of [lifecycle, lifecycle.replace('var retention=108e5;', 'var retention;retention=108e5;')]) {
    const result = transformInactiveThreads(source, 'main').bytes.toString();
    assert.equal(result.replace('/*codex-lite-inactive:v1*/300000', '108e5'), source);
    const Manager = vm.runInNewContext(result + ';Lifecycle'), manager = new Manager();
    for (const id of ['idle', 'visible', 'follower', 'running', 'unowned']) manager.entries.set(id, 1000);
    manager.owned = new Set(['idle', 'visible', 'follower', 'running']);
    manager.active.add('visible'); manager.followers.add('follower'); manager.pinned.add('running');
    assert.equal(manager.getNextCheckAtMs(), 301000);
    assert.deepEqual(Array.from(manager.getInactiveOwnerConversationIdsToUnsubscribe(300999)), []);
    assert.deepEqual(Array.from(manager.getInactiveOwnerConversationIdsToUnsubscribe(301000)), ['idle']);
    manager.active.add('idle');
    assert.deepEqual(Array.from(manager.getInactiveOwnerConversationIdsToUnsubscribe(600000)), []);
    assert.equal(manager.getNextCheckAtMs(), null);
    assert.throws(() => transformInactiveThreads(result, 'main'), /已包含/);
  }
  assert.throws(() => transformInactiveThreads('', 'main'), /唯一匹配/);
  assert.throws(() => transformInactiveThreads(lifecycle.replace('108e5', '3600000'), 'main'), /3 小时/);
  assert.throws(() => transformInactiveThreads(lifecycle + '{' + lifecycle + '}', 'main'), /唯一匹配/);
  assert.throws(() => transformInactiveThreads(lifecycle.replaceAll('hasActiveConversationView', 'changedGuard'), 'main'), /唯一匹配/);
});

test('older full-selection installs keep their original option set for inspection and rollback', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-perf-test-'));
  const target = path.join(directory, 'resources', 'app.asar'), exe = path.join(directory, 'ChatGPT.exe');
  try {
    fs.mkdirSync(path.dirname(target));
    const original = fixture(); fs.writeFileSync(target, original); fs.writeFileSync(exe, exeFixture(original));
    const before = [target, exe].map(hashFile);
    for (const withRecord of [true, false]) {
      applyUpgrade(target, () => {}, UNRECORDED_OPTIONS);
      if (!withRecord) fs.unlinkSync(path.join(directory, SELECTION_FILE));
      const info = inspectUpgrade(target);
      assert.equal(info.state, 'upgraded'); assert.equal(info.matchesSelection, false);
      assert.deepEqual(info.installedOptions, UNRECORDED_OPTIONS);
      restoreUpgrade(target, () => {});
      assert.deepEqual([target, exe].map(hashFile), before);
    }
  } finally {
    const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(directory));
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('codex-perf-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('successive upgrades reuse one baseline and recover interrupted old-to-new replacement', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-perf-test-'));
  const target = path.join(directory, 'resources', 'app.asar'), exe = path.join(directory, 'ChatGPT.exe');
  const rename = fs.renameSync;
  try {
    fs.mkdirSync(path.dirname(target));
    const original = fixture(); fs.writeFileSync(target, original); fs.writeFileSync(exe, exeFixture(original));
    const baseline = [target, exe].map(hashFile);
    applyUpgrade(target, () => {}, UNRECORDED_OPTIONS);
    const backupPaths = [target, exe].map(file => file + UPGRADE_BACKUP_SUFFIX);
    const backupTimes = backupPaths.map(file => fs.statSync(file).mtimeMs);
    for (const selected of [undefined, ['menu'], [], UNRECORDED_OPTIONS]) {
      applyUpgrade(target, () => {}, selected);
      assert.equal(inspectUpgrade(target, selected).matchesSelection, true);
      assert.deepEqual(backupPaths.map(hashFile), baseline);
      assert.deepEqual(backupPaths.map(file => fs.statSync(file).mtimeMs), backupTimes);
      assert.equal(fs.readdirSync(directory).filter(n => n.includes('.before-')).length, 1);
      assert.equal(fs.readdirSync(path.dirname(target)).filter(n => n.includes('.before-')).length, 1);
    }
    for (const failingTarget of [target, exe]) {
      fs.renameSync = (from, to) => { if (to === failingTarget) throw Error('upgrade interrupted'); return rename(from, to); };
      assert.throws(() => applyUpgrade(target, () => {}), /upgrade interrupted/);
      fs.renameSync = rename;
      assert.equal(inspectUpgrade(target).state, 'partial');
      assert.throws(() => applyUpgrade(target, () => {}), /半完成/);
      restoreUpgrade(target, () => {});
      assert.deepEqual([target, exe].map(hashFile), baseline);
      assert.deepEqual(backupPaths.map(file => fs.statSync(file).mtimeMs), backupTimes);
      applyUpgrade(target, () => {}, UNRECORDED_OPTIONS);
    }
  } finally {
    fs.renameSync = rename;
    const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(directory));
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative) && relative.startsWith('codex-perf-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
