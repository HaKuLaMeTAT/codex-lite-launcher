import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { executableIntegrity, headerHash, updateExecutable } from './exe-integrity.mjs';
import { transformRuntime } from './runtime-patches.mjs';

const acorn = createRequire(import.meta.url)('./vendor/acorn.cjs');
export const VERSION = '26.928.20755';
export const MARKER = '/*codex-windows-perf:v2*/';
export const BACKUP_SUFFIX = '.before-perf-v3';
export const UPGRADE_BACKUP_SUFFIX = '.before-lite-v5';
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function check(condition, message) { if (!condition) throw new Error(message); }
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(item => walk(item, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}
function parse(source, type) { return acorn.parse(source, { ecmaVersion: 'latest', sourceType: type }); }
function only(items, name) {
  check(items.length === 1, `${name}：应唯一匹配，实际匹配 ${items.length} 处。此包暂不支持。`);
  return items[0];
}
function applyEdits(source, edits, type) {
  edits.sort((a, b) => a.start - b.start);
  for (let i = 1; i < edits.length; i++) check(edits[i].start >= edits[i - 1].end, '补丁修改范围重叠。');
  let result = source;
  for (const e of [...edits].reverse()) result = result.slice(0, e.start) + e.text + result.slice(e.end);
  parse(result, type);
  return { bytes: Buffer.from(result), edits };
}

// 改编自 Codex++ 固定提交：仅匹配预加载入口及菜单刷新调用。
export function transform(source) {
  check(!source.includes(MARKER), '此主模块已包含 v2 补丁。');
  const matches = { avatar: [], hotkey: [], detached: [], menu: [] };
  walk(parse(source, 'script'), node => {
    if (node.type === 'MethodDefinition' && node.key.type === 'Identifier') {
      const fn = node.value, body = source.slice(fn.body.start, fn.body.end);
      if (node.key.name === 'prewarm' && fn.async && fn.params.length === 1 &&
          body.includes('this.openingWindowPromise') && body.includes('this.ensureWindow(')) matches.avatar.push(fn);
      if (node.key.name === 'prewarm' && fn.async && fn.params.length === 0 &&
          body.includes('this.ensureHomeWindow()') && body.includes('this.ensureThreadWindow()')) matches.hotkey.push(fn);
      if (node.key.name === 'scheduleFill' && fn.params.length === 0 &&
          body.includes('this.fillTimer') && body.includes('this.slot.prewarm()')) matches.detached.push(fn);
    }
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' ||
        node.callee.property.name !== 'setOnBrowserStateChanged' || node.arguments.length !== 1) return;
    const fn = node.arguments[0];
    if (fn.type !== 'ArrowFunctionExpression' || fn.params.length !== 0) return;
    const calls = [];
    walk(fn.body, inner => {
      if (inner.type === 'CallExpression' && inner.arguments.length === 0 &&
          inner.callee.type === 'MemberExpression' && inner.callee.property.name === 'refreshApplicationMenu') calls.push(inner);
    });
    if (calls.length === 1) matches.menu.push(calls[0]);
  });
  const edits = [];
  for (const name of ['avatar', 'hotkey', 'detached']) {
    const fn = only(matches[name], name);
    edits.push({ name, start: fn.body.start + 1, end: fn.body.end - 1, text: `${MARKER}return;` });
  }
  const call = only(matches.menu, 'menu');
  // 首次立即刷新，连续变化约每 250ms 合并一次；会话同步仍每次执行。
  const text = `${MARKER}(globalThis.__codexWindowsPerfMenuV2??=(()=>{let timer=0,pending=null;` +
    `const tick=()=>{const run=pending;pending=null;if(run){run();timer=setTimeout(tick,250)}else timer=0};` +
    `return run=>{if(timer){pending=run;return}run();timer=setTimeout(tick,250)}})())` +
    `(()=>${source.slice(call.start, call.end)})`;
  edits.push({ name: 'menu', start: call.start, end: call.end, text });
  return applyEdits(source, edits, 'script');
}

export function transformCheckout(source) {
  check(!source.includes(MARKER), '此购买模块已包含 v2 补丁。');
  const pricing = [], credit = [];
  walk(parse(source, 'module'), node => {
    if (node.type === 'ConditionalExpression' && node.alternate.type === 'Literal' && node.alternate.value === null &&
        source.slice(node.test.start, node.test.end).includes('`use_embedded_checkout`')) pricing.push(node);
    if (node.type === 'LogicalExpression' && node.operator === '&&' && node.left.type === 'UnaryExpression' && node.left.operator === '!' &&
        node.right.type === 'LogicalExpression' && node.right.operator === '||' &&
        source.slice(node.right.start, node.right.end).includes('`use_embedded_credit_checkout`')) credit.push(node);
  });
  const p = only(pricing, 'checkout-pricing'), c = only(credit, 'checkout-credit');
  // 只关闭预热条件，保留显式购买和充值路由。
  return applyEdits(source, [
    { name: 'checkout-pricing', start: p.test.start, end: p.test.end, text: `${MARKER}(!1&&(${source.slice(p.test.start, p.test.end)}))` },
    { name: 'checkout-credit', start: c.right.start, end: c.right.end, text: `${MARKER}(!0||(${source.slice(c.right.start, c.right.end)}))` },
  ], 'module');
}

export function readArchive(bytes) {
  check(bytes.length >= 16 && bytes.readUInt32LE(0) === 4, '不是有效的 ASAR 文件。');
  const dataStart = 8 + bytes.readUInt32LE(4), jsonLength = bytes.readUInt32LE(12);
  check(16 + jsonLength <= dataStart && dataStart <= bytes.length, 'ASAR 头部长度无效。');
  const header = JSON.parse(bytes.subarray(16, 16 + jsonLength)), entries = new Map();
  function collect(directory, prefix = '') {
    for (const [name, item] of Object.entries(directory.files)) {
      const key = prefix + name;
      if (item.files) collect(item, key + '/'); else entries.set(key, item);
    }
  }
  collect(header);
  function entry(name) {
    const item = entries.get(name);
    check(item && !item.unpacked && !item.link, `找不到包内文件：${name}`);
    const start = dataStart + Number(item.offset);
    check(Number.isSafeInteger(start) && start >= dataStart && start + item.size <= bytes.length, `文件范围无效：${name}`);
    return { item, start, bytes: bytes.subarray(start, start + item.size) };
  }
  return { header, entries, dataStart, entry };
}
function integrity(bytes, blockSize) {
  check(Number.isSafeInteger(blockSize) && blockSize > 0, '完整性分块大小无效。');
  const blocks = [];
  for (let i = 0; i < bytes.length; i += blockSize) blocks.push(sha256(bytes.subarray(i, i + blockSize)));
  return { algorithm: 'SHA256', hash: sha256(bytes), blockSize, blocks };
}

// 保留未修改文件和 unpacked 元数据，重建长度变化所需的偏移及 Pickle 头部。
export function rewriteArchive(original, replacements) {
  const a = readArchive(original), ranges = [];
  for (const [name, bytes] of replacements) {
    const e = a.entry(name), old = e.item.integrity;
    const expected = old && integrity(e.bytes, old.blockSize);
    check(old?.algorithm === 'SHA256' && old.hash === expected.hash &&
      JSON.stringify(old.blocks) === JSON.stringify(expected.blocks), `原文件摘要校验失败：${name}`);
    ranges.push({ name, start: Number(e.item.offset), end: Number(e.item.offset) + e.item.size, bytes });
    e.item.size = bytes.length; e.item.integrity = integrity(bytes, old.blockSize);
  }
  ranges.sort((x, y) => x.start - y.start);
  for (let i = 1; i < ranges.length; i++) check(ranges[i].start >= ranges[i - 1].end, 'ASAR 修改文件重叠。');
  for (const [name, item] of a.entries) {
    if (item.offset === undefined) continue;
    const oldOffset = Number(item.offset);
    let delta = 0;
    for (const r of ranges) {
      check(!(oldOffset > r.start && oldOffset < r.end), `ASAR 文件重叠：${name}`);
      if (oldOffset >= r.end) delta += r.bytes.length - (r.end - r.start);
    }
    item.offset = String(oldOffset + delta);
  }
  const json = Buffer.from(JSON.stringify(a.header)), payloadLength = Math.ceil((4 + json.length) / 4) * 4;
  const header = Buffer.alloc(12 + payloadLength);
  header.writeUInt32LE(4, 0); header.writeUInt32LE(payloadLength + 4, 4);
  header.writeUInt32LE(payloadLength, 8); header.writeUInt32LE(json.length, 12); json.copy(header, 16);
  const parts = [header];
  let cursor = a.dataStart;
  for (const r of ranges) {
    parts.push(original.subarray(cursor, a.dataStart + r.start), r.bytes);
    cursor = a.dataStart + r.end;
  }
  parts.push(original.subarray(cursor));
  return Buffer.concat(parts);
}
function modules(original) {
  const a = readArchive(original), pkg = JSON.parse(a.entry('package.json').bytes);
  check(pkg.name === 'openai-codex-electron', '所选安装包不是 Codex 桌面应用。');
  // 通用定位不等于跨版本验证；新增版本必须先审计再加入支持范围。
  check(pkg.version === VERSION, `暂不支持版本 ${pkg.version}；当前已适配 ${VERSION}。未修改文件。`);
  const main = only([...a.entries.keys()].filter(n => /^\.vite\/build\/main-[^/]+\.js$/.test(n)), '主模块');
  const checkout = only([...a.entries.keys()].filter(n => /^webview\/assets\/webview-page-[^/]+\.js$/.test(n) &&
    a.entry(n).bytes.includes(Buffer.from('CheckoutPricingWebviewHost'))), '购买模块');
  return { a, pkg, main, checkout };
}
function buildArchive(original, runtime) {
  const { a, pkg, main, checkout } = modules(original);
  const m = transform(a.entry(main).bytes.toString()), c = transformCheckout(a.entry(checkout).bytes.toString());
  const replacements = new Map([[main, m.bytes], [checkout, c.bytes]]), changes = [...m.edits, ...c.edits];
  if (runtime) {
    for (const kind of ['main', 'initial', 'shared']) {
      const name = kind === 'main' ? main : only([...a.entries.keys()].filter(n =>
        new RegExp(`^webview/assets/app-${kind}-[^/]+\\.js$`).test(n)), `${kind} 模块`);
      const source = (replacements.get(name) ?? a.entry(name).bytes).toString();
      const result = transformRuntime(source, kind);
      replacements.set(name, result.bytes); changes.push(...result.edits);
    }
  }
  const bytes = rewriteArchive(original, replacements);
  const verified = readArchive(bytes);
  for (const name of replacements.keys()) {
    const e = verified.entry(name);
    check(sha256(e.bytes) === e.item.integrity.hash, `候选摘要验证失败：${name}`);
  }
  return { bytes, report: { status: 'ready', patchVersion: runtime ? 5 : 2, version: pkg.version,
    sourceSha256: sha256(original), candidateSha256: sha256(bytes), archiveSize: bytes.length,
    modules: [...replacements.keys()], changes: changes.map(e => e.name) } };
}
// 原位安装/恢复保留旧算法，确保已安装 v0.3 的配套哈希仍可验证。
export function buildPatch(original) { return buildArchive(original, false); }
export function buildOptimizedPatch(original) { return buildArchive(original, true); }
export function buildOptimizedInstallation(original, originalExe) {
  const candidate = buildOptimizedPatch(original), executable = updateExecutable(originalExe, original, candidate.bytes);
  return { asar: candidate.bytes, exe: executable.bytes, report: { ...candidate.report,
    sourceExeSha256: sha256(originalExe), candidateExeSha256: sha256(executable.bytes),
    headerBeforeSha256: executable.before, headerAfterSha256: executable.after } };
}
function executablePath(target) { return path.join(path.dirname(path.dirname(target)), 'ChatGPT.exe'); }
export function buildInstallation(original, originalExe) {
  const candidate = buildPatch(original), executable = updateExecutable(originalExe, original, candidate.bytes);
  return { asar: candidate.bytes, exe: executable.bytes, report: { ...candidate.report, patchVersion: 3,
    sourceExeSha256: sha256(originalExe), candidateExeSha256: sha256(executable.bytes),
    headerBeforeSha256: executable.before, headerAfterSha256: executable.after } };
}
function savedPair(target) {
  const exe = executablePath(target), backup = target + BACKUP_SUFFIX, exeBackup = exe + BACKUP_SUFFIX;
  check(fs.existsSync(backup) && fs.existsSync(exeBackup), '缺少 EXE/ASAR 配套备份，不能恢复。');
  const original = fs.readFileSync(backup), originalExe = fs.readFileSync(exeBackup);
  return { exe, backup, exeBackup, original, originalExe, candidate: buildInstallation(original, originalExe) };
}
function pairState(target, pair) {
  const report = pair.candidate.report, asarHash = sha256(fs.readFileSync(target)), exeHash = sha256(fs.readFileSync(pair.exe));
  check([report.sourceSha256, report.candidateSha256].includes(asarHash) &&
    [report.sourceExeSha256, report.candidateExeSha256].includes(exeHash), '安装文件已有后续修改，拒绝覆盖；请核对更新或其他补丁。');
  if (asarHash === report.sourceSha256 && exeHash === report.sourceExeSha256) return 'ready';
  if (asarHash === report.candidateSha256 && exeHash === report.candidateExeSha256) return 'patched';
  return 'partial';
}
export function inspect(target) {
  const exe = executablePath(target);
  if (fs.existsSync(target + BACKUP_SUFFIX) && fs.existsSync(exe + BACKUP_SUFFIX)) {
    const pair = savedPair(target);
    return { ...pair.candidate.report, status: pairState(target, pair), backup: pair.backup, exeBackup: pair.exeBackup };
  }
  const original = fs.readFileSync(target), originalExe = fs.readFileSync(exe);
  check(executableIntegrity(originalExe).hash === headerHash(original), 'EXE 与 ASAR 校验不匹配。若安装过旧版补丁，请先恢复原 ASAR。');
  return buildInstallation(original, originalExe).report;
}
// 两种交付形式共用同一候选。升级前备份只作回滚，不覆盖 v0.3 原始备份。
export function resolveUpgrade(target) {
  target = fs.realpathSync(target);
  check(path.basename(target) === 'app.asar' && path.basename(path.dirname(target)) === 'resources', '请选择 resources/app.asar。');
  const exe = executablePath(target), backup = target + UPGRADE_BACKUP_SUFFIX, exeBackup = exe + UPGRADE_BACKUP_SUFFIX;
  check(!fs.existsSync(path.join(path.dirname(exe), 'codex-optimized-copy.json')), '请选择来源安装，不要原位修改带清单的优化副本。');
  const oldAsar = fs.existsSync(target + BACKUP_SUFFIX), oldExe = fs.existsSync(exe + BACKUP_SUFFIX);
  check(oldAsar === oldExe, '旧版 EXE/ASAR 备份不完整，请先核对旧版恢复材料。');
  for (const file of [exe, backup, exeBackup, target + BACKUP_SUFFIX, exe + BACKUP_SUFFIX])
    check(!fs.existsSync(file) || !fs.lstatSync(file).isSymbolicLink(), `不支持链接文件：${file}`);
  const currentAsar = fs.readFileSync(target), currentExe = fs.readFileSync(exe);
  const beforeAsar = fs.existsSync(backup) ? fs.readFileSync(backup) : currentAsar;
  const beforeExe = fs.existsSync(exeBackup) ? fs.readFileSync(exeBackup) : currentExe;
  const asarInput = oldAsar ? target + BACKUP_SUFFIX : fs.existsSync(backup) ? backup : target;
  const exeInput = oldExe ? exe + BACKUP_SUFFIX : fs.existsSync(exeBackup) ? exeBackup : exe;
  const original = fs.readFileSync(asarInput), originalExe = fs.readFileSync(exeInput);
  let beforeState = 'ready';
  if (oldAsar) {
    const legacy = buildInstallation(original, originalExe);
    const originalPair = sha256(beforeAsar) === legacy.report.sourceSha256 && sha256(beforeExe) === legacy.report.sourceExeSha256;
    const legacyPair = sha256(beforeAsar) === legacy.report.candidateSha256 && sha256(beforeExe) === legacy.report.candidateExeSha256;
    check(originalPair || legacyPair, '升级前文件不是完整原版或 v0.3 配套版本，拒绝覆盖。');
    beforeState = legacyPair ? 'patched' : 'ready';
  }
  const candidate = buildOptimizedInstallation(original, originalExe);
  const beforeHashes = [sha256(beforeAsar), sha256(beforeExe)], currentHashes = [sha256(currentAsar), sha256(currentExe)];
  const afterHashes = [candidate.report.candidateSha256, candidate.report.candidateExeSha256];
  check(currentHashes.every((hash, i) => hash === beforeHashes[i] || hash === afterHashes[i]), '安装文件已有未知后续修改，拒绝覆盖；请核对应用更新或其他补丁。');
  const state = currentHashes.every((hash, i) => hash === beforeHashes[i]) ? beforeState :
    currentHashes.every((hash, i) => hash === afterHashes[i]) ? 'upgraded' : 'partial';
  const backupsComplete = fs.existsSync(backup) && fs.existsSync(exeBackup);
  check(state !== 'partial' || backupsComplete, '安装处于半完成状态且缺少配套回滚备份。');
  return { target, exe, backup, exeBackup, candidate, asarInput, exeInput, beforeAsar, beforeExe,
    beforeHashes, currentHashes, afterHashes, state, beforeState, backupsComplete };
}
export function sourceForCopy(target) {
  const result = resolveUpgrade(target);
  check(result.state !== 'partial', '来源安装处于半完成状态，请先执行原位回滚后再生成副本。');
  return result;
}
export function requireStopped() {
  check(process.platform === 'win32', '安装和恢复仅支持 Windows。');
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$p = @(Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue); if ($p.Count -gt 0) { Write-Output "RUNNING" }'],
  { encoding: 'utf8', windowsHide: true }).trim();
  check(result === '', 'Codex 或 Codex CLI 仍在运行。请完全退出后，从补丁窗口重试。');
}
export function install(target, requireIdle = requireStopped) {
  requireIdle();
  const exe = executablePath(target), original = fs.readFileSync(target), originalExe = fs.readFileSync(exe);
  const candidate = buildInstallation(original, originalExe);
  const files = [[target, original, candidate.asar], [exe, originalExe, candidate.exe]];
  for (const [file, before] of files) {
    check(!fs.existsSync(file + '.perf-v3.tmp'), `遗留临时文件，请先检查或恢复：${file}.perf-v3.tmp`);
    const backup = file + BACKUP_SUFFIX;
    if (fs.existsSync(backup)) check(sha256(fs.readFileSync(backup)) === sha256(before), `已有不同备份，请先妥善保存：${backup}`);
  }
  // 两份备份和候选全部写入并校验后，才开始替换任何安装文件。
  for (const [file, before, after] of files) {
    const backup = file + BACKUP_SUFFIX;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    check(sha256(fs.readFileSync(backup)) === sha256(before), `备份校验失败：${file}`);
    fs.writeFileSync(file + '.perf-v3.tmp', after, { flag: 'wx' });
    check(sha256(fs.readFileSync(file + '.perf-v3.tmp')) === sha256(after), `候选写入校验失败：${file}`);
  }
  requireIdle();
  for (const [file, before] of files) check(sha256(fs.readFileSync(file)) === sha256(before), '准备期间安装文件发生变化，已停止。');
  // 两文件无法单次原子替换；中断状态可由 inspect 识别，并用配套备份恢复。
  for (const [file] of files) fs.renameSync(file + '.perf-v3.tmp', file);
  for (const [file, , after] of files) check(sha256(fs.readFileSync(file)) === sha256(after), `安装后校验失败：${file}`);
  return { ...candidate.report, status: 'patched', backup: target + BACKUP_SUFFIX, exeBackup: exe + BACKUP_SUFFIX };
}
export function restore(target, requireIdle = requireStopped) {
  requireIdle();
  const pair = savedPair(target);
  pairState(target, pair);
  const files = [[target, pair.original, pair.candidate.asar], [pair.exe, pair.originalExe, pair.candidate.exe]];
  for (const [file, before, after] of files) {
    const temp = file + '.perf-v3.tmp';
    // 只允许复用内容恰为本次候选或原文件的遗留临时文件。
    if (fs.existsSync(temp)) check([sha256(before), sha256(after)].includes(sha256(fs.readFileSync(temp))), `未知临时文件，拒绝覆盖：${temp}`);
    fs.writeFileSync(temp, before);
    check(sha256(fs.readFileSync(temp)) === sha256(before), `恢复文件校验失败：${file}`);
  }
  requireIdle();
  pairState(target, pair);
  for (const [file] of files) fs.renameSync(file + '.perf-v3.tmp', file);
  for (const [file, before] of files) check(sha256(fs.readFileSync(file)) === sha256(before), `恢复后校验失败：${file}`);
  return { status: 'restored', restoredSha256: sha256(pair.original), backupRetained: pair.backup, exeBackup: pair.exeBackup };
}
function main(args) {
  const [command, input, output] = args;
  check(['inspect', 'build', 'apply', 'restore'].includes(command) && input && args.length === (command === 'build' ? 3 : 2),
    '用法：node patch.mjs inspect|apply|restore <app.asar> 或 build <app.asar> <新候选目录>');
  const target = path.resolve(input);
  let result;
  if (command === 'apply') result = install(target);
  else if (command === 'restore') result = restore(target);
  else if (command === 'inspect') result = inspect(target);
  else {
    const candidate = buildInstallation(fs.readFileSync(target), fs.readFileSync(executablePath(target)));
    check(!fs.existsSync(output), '候选目录必须不存在。');
    fs.mkdirSync(output); fs.mkdirSync(path.join(output, 'resources'));
    fs.writeFileSync(path.join(output, 'resources', 'app.asar'), candidate.asar, { flag: 'wx' });
    fs.writeFileSync(path.join(output, 'ChatGPT.exe'), candidate.exe, { flag: 'wx' });
    check(sha256(fs.readFileSync(path.join(output, 'resources', 'app.asar'))) === candidate.report.candidateSha256 &&
      sha256(fs.readFileSync(path.join(output, 'ChatGPT.exe'))) === candidate.report.candidateExeSha256, '候选输出校验失败。');
    result = candidate.report;
  }
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}
