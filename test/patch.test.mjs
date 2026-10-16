import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transform, transformCheckout, buildPatch, readArchive, sha256, VERSION, BACKUP_SUFFIX, install, restore, inspect, sourceForCopy } from '../patch.mjs';
import { executableIntegrity, headerHash, updateExecutable } from '../exe-integrity.mjs';
import { createCopy, inspectSource, verifyCopy, hashFile, MANIFEST } from '../copy.mjs';

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
browser.setOnBrowserStateChanged(()=>{menu.refreshApplicationMenu(),sync()});`;
const checkout = `// CheckoutPricingWebviewHost
function pricing(active){const warm=enabled&&get(\`use_embedded_checkout\`,false)?create('pricing-prewarm'):null;return active?create('pricing-explicit'):warm}
function credit(active){if(!active&&(blocked()||!get(\`use_embedded_credit_checkout\`,false)))return null;return create(active?'credit-explicit':'credit-prewarm')}`;

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

function fixture(version = VERSION) {
  const files = new Map([
    ['package.json', JSON.stringify({ name: 'openai-codex-electron', version })],
    ['.vite/build/main-renamed.js', main], ['webview/assets/webview-page-renamed.js', checkout],
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

test('real ASAR: both transformed modules parse, all packed files and external metadata verify', {
  skip: !process.env.CODEX_TEST_ASAR,
}, () => {
  const source = sourceForCopy(process.env.CODEX_TEST_ASAR);
  const original = fs.readFileSync(source.asarInput), result = buildPatch(original);
  verifyContents(original, result.bytes, result.report.modules);
  const originalExe = fs.readFileSync(source.exeInput);
  const resource = executableIntegrity(originalExe), patchedExe = updateExecutable(originalExe, original, result.bytes).bytes;
  assert.equal(executableIntegrity(patchedExe).hash, headerHash(result.bytes));
  assert.ok(originalExe.subarray(0, resource.start).equals(patchedExe.subarray(0, resource.start)));
  assert.ok(originalExe.subarray(resource.start + 64).equals(patchedExe.subarray(resource.start + 64)));
  assert.throws(() => buildPatch(result.bytes), /已包含/);
});
