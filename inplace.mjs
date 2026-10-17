import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveUpgrade, requireStopped, sha256 } from './patch.mjs';
import { parsePatchArguments } from './options.mjs';

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
    installedOptions: plan.installedOptions, installedInactiveMinutes: plan.installedInactiveMinutes, matchesSelection: plan.matchesSelection,
    requiredFreeBytes: backupBytes + stageBytes, backupBytes: items.reduce((sum, item) => sum + item.before.length, 0),
    freeBytes: disk.bavail * disk.bsize };
}
export function inspectUpgrade(target, selected, inactiveMinutes) { return report(resolveUpgrade(target, selected, false, inactiveMinutes)); }
function currentUnchanged(plan) {
  check([plan.target, plan.exe].every((file, i) => sha256(fs.readFileSync(file)) === plan.currentHashes[i]), '准备期间安装文件发生变化，已停止。');
  check((fs.existsSync(plan.selectionFile) ? fs.readFileSync(plan.selectionFile, 'utf8') : null) === plan.selectionText, '准备期间优化选项记录发生变化，已停止。');
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
export function applyUpgrade(target, requireIdle = requireStopped, selected, inactiveMinutes) {
  requireIdle();
  const plan = resolveUpgrade(target, selected, false, inactiveMinutes), info = report(plan), items = files(plan);
  if (plan.state !== 'partial' && plan.matchesSelection) return report(plan, 'upgrade-applied');
  check(plan.state !== 'partial', '安装处于半完成状态，请先执行原位回滚。');
  check(info.freeBytes >= info.requiredFreeBytes, `磁盘空间不足，至少需要 ${(info.requiredFreeBytes / 1024 ** 3).toFixed(2)} GiB 可用空间。`);
  checkTemporary(items);
  currentUnchanged(plan);
  for (const item of items) {
    if (!fs.existsSync(item.backup)) fs.copyFileSync(item.target, item.backup, fs.constants.COPYFILE_EXCL);
    check(sha256(fs.readFileSync(item.backup)) === sha256(item.before), `回滚备份校验失败：${item.backup}`);
  }
  // 文件准备和二次退出检查通过后才登记新版本，避免准备失败提前改变安装记录。
  stage(items, 'after');
  requireIdle(); currentUnchanged(plan);
  // 始终复用最初配套备份；升级期间记录上一组选项，不额外复制一份旧补丁安装。
  const record = { format: 1, revision: plan.candidate.report.patchVersion, options: plan.candidate.report.selectedOptions, inactiveMinutes: plan.candidate.report.inactiveMinutes, beforeHashes: plan.beforeHashes,
    ...(plan.state === 'upgraded' ? { previousOptions: plan.installedOptions, previousRevision: plan.installedRevision, previousInactiveMinutes: plan.installedInactiveMinutes } : {}) };
  const selectionText = JSON.stringify(record, null, 2) + '\n';
  fs.writeFileSync(plan.selectionFile + '.tmp', selectionText, { flag: 'wx' });
  fs.renameSync(plan.selectionFile + '.tmp', plan.selectionFile);
  plan.selectionText = selectionText;
  replace(items, 'after');
  // 上一组选项只是少量恢复元数据，下次升级直接覆盖，不累积文件或历史记录。
  return report({ ...plan, state: 'upgraded', backupsComplete: true, matchesSelection: true, installedOptions: plan.candidate.report.selectedOptions, installedInactiveMinutes: plan.candidate.report.inactiveMinutes }, 'upgrade-applied');
}
export function restoreUpgrade(target, requireIdle = requireStopped) {
  requireIdle();
  const plan = resolveUpgrade(target, undefined, true), items = files(plan);
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
    const [command, target, ...arguments_] = process.argv.slice(2);
    check(['inspect', 'apply', 'restore'].includes(command) && target && !(command === 'restore' && arguments_.length),
      '用法：node inplace.mjs inspect|apply <resources/app.asar> [--options=id,id] [--inactive-minutes=5] | restore <resources/app.asar>');
    const { selected, inactiveMinutes } = parsePatchArguments(arguments_);
    const result = command === 'inspect' ? inspectUpgrade(target, selected, inactiveMinutes) : command === 'apply' ? applyUpgrade(target, requireStopped, selected, inactiveMinutes) : restoreUpgrade(target);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}
