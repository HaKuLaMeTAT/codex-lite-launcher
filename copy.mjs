import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sourceForCopy, SELECTION_FILE } from './patch.mjs';
import { launchArguments, LAUNCH_METADATA, readLaunchConfig } from './launch-config.mjs';
import { parsePatchArguments } from './options.mjs';

const TOOL_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const MANIFEST = 'codex-optimized-copy.json';
const LAUNCH_FILES = ['启动优化版.cmd', 'start-optimized.ps1'];
function check(ok, message) { if (!ok) throw new Error(message); }
export function hashFile(file) {
  const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(4 * 1024 * 1024), fd = fs.openSync(file, 'r');
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
// 解析已存在的祖先，避免目录联接让副本实际落回源目录中。
function physicalDestination(destination) {
  let current = path.resolve(destination);
  const missing = [];
  while (!fs.existsSync(current)) { missing.unshift(path.basename(current)); current = path.dirname(current); }
  return path.join(fs.realpathSync(current), ...missing);
}
function sourceRoot(target) {
  const real = fs.realpathSync(target), root = path.dirname(path.dirname(real));
  check(path.basename(real).toLowerCase() === 'app.asar' && path.basename(path.dirname(real)).toLowerCase() === 'resources', '请选择安装目录 resources 下的 app.asar。');
  check(!fs.existsSync(path.join(root, MANIFEST)), '此目录已经是优化副本，请选择原安装作为来源。');
  for (const name of ['ChatGPT.exe', 'chrome.dll', 'resources/app.asar.unpacked', 'locales']) {
    check(fs.existsSync(path.join(root, name)), `缺少完整运行资源：${name}。请选择完整安装目录。`);
  }
  return { root, target: real };
}
function inventory(root) {
  const result = [], ownLaunch = readLaunchConfig(root);
  function visit(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name, full = path.join(directory, entry.name);
      if (ownLaunch && [LAUNCH_METADATA, ...LAUNCH_FILES].includes(relative)) continue;
      if ([SELECTION_FILE, SELECTION_FILE + '.tmp'].includes(relative)) continue;
      // 不把旧补丁回滚材料复制到优化版中。
      if (/^(ChatGPT\.exe|resources\/app\.asar)\.(before-perf-v\d+|perf-v\d+\.tmp|before-lite-v\d+|lite-v\d+\.tmp)$/.test(relative)) continue;
      check(!fs.lstatSync(full).isSymbolicLink(), `来源含链接，暂不支持复制：${relative}`);
      if (entry.isDirectory()) visit(full, relative + '/');
      else { check(entry.isFile(), `不支持的来源文件：${relative}`); result.push({ relative, source: full, size: fs.statSync(full).size }); }
    }
  }
  visit(root);
  for (const name of [MANIFEST, ...LAUNCH_FILES]) check(!result.some(f => f.relative === name), `来源包含保留文件名：${name}`);
  return result;
}
function prepare(target, selected, inactiveMinutes) {
  const source = sourceRoot(target), prepared = sourceForCopy(source.target, selected, inactiveMinutes), files = inventory(source.root);
  for (const file of files) {
    if (file.relative === 'ChatGPT.exe') file.source = prepared.exeInput;
    if (file.relative === 'resources/app.asar') file.source = prepared.asarInput;
  }
  return { ...source, ...prepared, files };
}
function report(source) {
  return { launchArguments: launchArguments(source.candidate.report.selectedOptions), version: source.candidate.report.version, sourceRoot: source.root, sourceState: source.state,
    useVerifiedBackups: source.asarInput !== source.target, fileCount: source.files.length,
    estimatedBytes: source.files.reduce((sum, f) => sum + f.size, 0), ...source.candidate.report, status: 'copy-ready' };
}
export function inspectSource(target, selected, inactiveMinutes) { return report(prepare(target, selected, inactiveMinutes)); }

export function createCopy(target, destination, selected, inactiveMinutes) {
  const source = prepare(target, selected, inactiveMinutes), output = physicalDestination(destination), stage = output + '.building';
  check(!inside(source.root, output) && !inside(output, source.root), '副本目录与来源目录不能相同或互相包含。');
  check(!inside(source.root, stage) && !inside(stage, source.root), '临时生成目录与来源目录重叠。');
  check(!fs.existsSync(output) && !fs.existsSync(stage), '目标或 .building 目录已存在，请选择一个新的副本目录。');
  check(hashFile(source.asarInput) === source.candidate.report.sourceSha256 && hashFile(source.exeInput) === source.candidate.report.sourceExeSha256,
    '原文件来源在检查后发生变化，请重新检查。');
  const installedBefore = { asar: hashFile(source.target), exe: hashFile(path.join(source.root, 'ChatGPT.exe')) };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(stage);
  const records = [];
  // 只写入新建的 .building 目录；完成全部文件验证后才发布为可使用的副本。
  for (const file of source.files) {
    const dest = path.join(stage, file.relative), inputHash = hashFile(file.source);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (file.relative === 'ChatGPT.exe') fs.writeFileSync(dest, source.candidate.exe, { flag: 'wx' });
    else if (file.relative === 'resources/app.asar') fs.writeFileSync(dest, source.candidate.asar, { flag: 'wx' });
    else fs.copyFileSync(file.source, dest, fs.constants.COPYFILE_EXCL);
    const expected = file.relative === 'ChatGPT.exe' ? source.candidate.report.candidateExeSha256 :
      file.relative === 'resources/app.asar' ? source.candidate.report.candidateSha256 : inputHash;
    check(hashFile(dest) === expected, `副本文件校验失败：${file.relative}`);
    records.push({ path: file.relative, size: fs.statSync(dest).size, sha256: expected, inputHash });
  }
  // 拒绝复制期间发生更新的来源，不交付混合了两个安装版本的副本。
  check(JSON.stringify(inventory(source.root).map(f => f.relative).sort()) === JSON.stringify(source.files.map(f => f.relative).sort()), '来源文件列表在生成期间发生变化，请重新生成。');
  for (let i = 0; i < source.files.length; i++) check(hashFile(source.files[i].source) === records[i].inputHash, `来源文件在生成期间发生变化：${source.files[i].relative}`);
  check(hashFile(source.target) === installedBefore.asar && hashFile(path.join(source.root, 'ChatGPT.exe')) === installedBefore.exe, '来源安装在生成期间发生变化，请重新生成。');
  check(hashFile(source.asarInput) === source.candidate.report.sourceSha256 && hashFile(source.exeInput) === source.candidate.report.sourceExeSha256,
    '配套原文件在生成期间发生变化，请重新生成。');
  for (const name of LAUNCH_FILES) {
    const from = path.join(TOOL_ROOT, 'templates', name), to = path.join(stage, name);
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    records.push({ path: name, size: fs.statSync(to).size, sha256: hashFile(to) });
  }
  const manifest = { format: 1, toolVersion: '0.12.0', appVersion: source.candidate.report.version, createdAt: new Date().toISOString(), selectedOptions: source.candidate.report.selectedOptions, inactiveMinutes: source.candidate.report.inactiveMinutes,
    sourceRoot: source.root, sourceState: source.state, sourceAsarSha256: source.candidate.report.sourceSha256,
    sourceExeSha256: source.candidate.report.sourceExeSha256, candidateAsarSha256: source.candidate.report.candidateSha256,
    candidateExeSha256: source.candidate.report.candidateExeSha256, launchArguments: launchArguments(source.candidate.report.selectedOptions),
    files: records.map(({ inputHash, ...record }) => record) };
  fs.writeFileSync(path.join(stage, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  check(!fs.existsSync(output), '目标目录已被其他操作创建，请保留 .building 现场并选择新目录。');
  fs.renameSync(stage, output);
  return { ...report(source), status: 'copy-created', output, launcher: path.join(output, '启动优化版.cmd'), fileCount: records.length };
}

export function verifyCopy(directory) {
  const root = fs.realpathSync(directory), manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'));
  check(manifest.format === 1 && Array.isArray(manifest.files), '副本清单格式不支持。');
  for (const item of manifest.files) {
    const file = path.resolve(root, item.path);
    check(inside(root, file) && file !== root && !fs.lstatSync(file).isSymbolicLink() && inside(root, fs.realpathSync(file)), '副本清单文件越界。');
    check(hashFile(file) === item.sha256, `副本文件已变化：${item.path}。请从原安装重新生成。`);
  }
  return { status: 'copy-verified', version: manifest.appVersion, fileCount: manifest.files.length, output: root };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), [command, input, output] = args;
    const size = command === 'create' ? 3 : 2;
    check(['inspect', 'create', 'verify'].includes(command) && input && args.length >= size && !(command === 'verify' && args.length !== size),
      '用法：node copy.mjs inspect <app.asar> [--options=id,id] [--inactive-minutes=5] | create <app.asar> <新副本目录> [--options=id,id] [--inactive-minutes=5] | verify <副本目录>');
    const { selected, inactiveMinutes } = parsePatchArguments(args.slice(size));
    const result = command === 'inspect' ? inspectSource(input, selected, inactiveMinutes) : command === 'create' ? createCopy(input, output, selected, inactiveMinutes) : verifyCopy(input);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}
