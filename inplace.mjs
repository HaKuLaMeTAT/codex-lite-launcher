import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveUpgrade, requireStopped, sha256 } from './patch.mjs';

const TEMP_SUFFIX = '.lite-v5.tmp';
function check(ok, message) { if (!ok) throw new Error(message); }
function files(plan) {
  return [
    { target: plan.target, backup: plan.backup, before: plan.beforeAsar, after: plan.candidate.asar },
    { target: plan.exe, backup: plan.exeBackup, before: plan.beforeExe, after: plan.candidate.exe },
  ];
}
function report(plan, status = 'upgrade-ready') {
  const items = files(plan);
  const backupBytes = items.reduce((sum, item) => sum + (fs.existsSync(item.backup) ? 0 : item.before.length), 0);
  const stageBytes = items.reduce((sum, item) => sum + Math.max(item.before.length, item.after.length), 0);
  const disk = fs.statfsSync(path.dirname(plan.target));
  return { ...plan.candidate.report, status, state: plan.state, beforeState: plan.beforeState,
    backup: plan.backup, exeBackup: plan.exeBackup, canRestore: plan.backupsComplete,
    requiredFreeBytes: backupBytes + stageBytes, backupBytes: items.reduce((sum, item) => sum + item.before.length, 0),
    freeBytes: disk.bavail * disk.bsize };
}
export function inspectUpgrade(target) { return report(resolveUpgrade(target)); }
function currentUnchanged(plan) {
  check([plan.target, plan.exe].every((file, i) => sha256(fs.readFileSync(file)) === plan.currentHashes[i]), '准备期间安装文件发生变化，已停止。');
}
function checkTemporary(items) {
  for (const item of items) {
    const temp = item.target + TEMP_SUFFIX;
    if (!fs.existsSync(temp)) continue;
    check(!fs.lstatSync(temp).isSymbolicLink(), `不支持链接临时文件：${temp}`);
    check([sha256(item.before), sha256(item.after)].includes(sha256(fs.readFileSync(temp))),
      `遗留临时文件内容未知，请先核对并移走该文件后重试：${temp}`);
  }
}
function stage(items, direction) {
  for (const item of items) {
    const temp = item.target + TEMP_SUFFIX, bytes = item[direction];
    fs.writeFileSync(temp, bytes, { flag: fs.existsSync(temp) ? 'w' : 'wx' });
    check(sha256(fs.readFileSync(temp)) === sha256(bytes), `临时文件校验失败：${temp}`);
  }
}
function replace(items, direction) {
  // 两文件不能单次原子替换；第二次失败时保留配套备份和剩余临时文件，供原位回滚。
  try {
    for (const item of items) fs.renameSync(item.target + TEMP_SUFFIX, item.target);
    for (const item of items) check(sha256(fs.readFileSync(item.target)) === sha256(item[direction]), `替换后校验失败：${item.target}`);
  } catch (error) {
    throw new Error(`替换未完成：${error.message}。请保持 Codex 关闭，重新检查后执行原位回滚。`);
  }
}
export function applyUpgrade(target, requireIdle = requireStopped) {
  requireIdle();
  const plan = resolveUpgrade(target), info = report(plan), items = files(plan);
  if (plan.state === 'upgraded') return report(plan, 'upgrade-applied');
  check(plan.state !== 'partial', '安装处于半完成状态，请先执行原位回滚。');
  check(info.freeBytes >= info.requiredFreeBytes, `磁盘空间不足，至少需要 ${(info.requiredFreeBytes / 1024 ** 3).toFixed(2)} GiB 可用空间。`);
  checkTemporary(items);
  currentUnchanged(plan);
  for (const item of items) {
    if (!fs.existsSync(item.backup)) fs.copyFileSync(item.target, item.backup, fs.constants.COPYFILE_EXCL);
    check(sha256(fs.readFileSync(item.backup)) === sha256(item.before), `回滚备份校验失败：${item.backup}`);
  }
  stage(items, 'after');
  requireIdle(); currentUnchanged(plan);
  replace(items, 'after');
  return report({ ...plan, state: 'upgraded', backupsComplete: true }, 'upgrade-applied');
}
export function restoreUpgrade(target, requireIdle = requireStopped) {
  requireIdle();
  const plan = resolveUpgrade(target), items = files(plan);
  check(plan.backupsComplete, '没有完整的原位升级备份，不能回滚。');
  checkTemporary(items);
  const disk = fs.statfsSync(path.dirname(plan.target));
  check(disk.bavail * disk.bsize >= items.reduce((sum, item) => sum + item.before.length, 0), '空间不足，无法准备配套回滚临时文件。');
  stage(items, 'before');
  requireIdle(); currentUnchanged(plan);
  replace(items, 'before');
  return report({ ...plan, state: plan.beforeState }, 'upgrade-restored');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, target] = process.argv.slice(2);
    check(['inspect', 'apply', 'restore'].includes(command) && target && process.argv.length === 4,
      '用法：node inplace.mjs inspect|apply|restore <resources/app.asar>');
    const result = command === 'inspect' ? inspectUpgrade(target) : command === 'apply' ? applyUpgrade(target) : restoreUpgrade(target);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}
