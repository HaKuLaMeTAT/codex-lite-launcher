import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LAUNCH_METADATA = 'codex-lite-launch.json';
export const LAUNCH_FILES = ['启动优化版.cmd', 'start-optimized.ps1'];
const templates = path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates');
export const launchArguments = selected => selected.includes('clipboard-compat') ? ['--disable-features=NonBlockingOsClipboardReads'] : [];
export function readLaunchConfig(root) {
  const file = path.join(root, LAUNCH_METADATA);
  if (!fs.existsSync(file)) return null;
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (config.format !== 1 || config.owner !== 'codex-lite-launcher' || !Array.isArray(config.launchArguments) ||
      config.launchArguments.some(arg => arg !== '--disable-features=NonBlockingOsClipboardReads')) throw Error('启动配置不是本工具的有效记录，拒绝覆盖。');
  return config;
}
export function checkLaunchFiles(root, selected) {
  if (fs.existsSync(path.join(root, LAUNCH_METADATA + '.tmp'))) throw Error('启动配置临时文件已存在，请先核对。');
  const previous = readLaunchConfig(root);
  if (!selected.includes('clipboard-compat') && !previous) return;
  for (const name of LAUNCH_FILES) {
    const file = path.join(root, name);
    if (fs.existsSync(file) && (!previous || fs.lstatSync(file).isSymbolicLink() || !fs.readFileSync(file).equals(fs.readFileSync(path.join(templates, name)))))
      throw Error('启动文件已存在或已被修改，拒绝覆盖：' + file);
  }
}
export function writeLaunchConfig(root, hashes, selected) {
  checkLaunchFiles(root, selected);
  if (!selected.includes('clipboard-compat') && !readLaunchConfig(root)) return null;
  for (const name of LAUNCH_FILES) if (!fs.existsSync(path.join(root, name))) fs.copyFileSync(path.join(templates, name), path.join(root, name), fs.constants.COPYFILE_EXCL);
  // 专用入口每次校验配套文件；取消勾选或回滚只清空参数，保留可用的轻量入口。
  const config = { format: 1, owner: 'codex-lite-launcher', selectedOptions: selected, candidateAsarSha256: hashes[0], candidateExeSha256: hashes[1], launchArguments: launchArguments(selected) };
  const file = path.join(root, LAUNCH_METADATA);
  if (fs.existsSync(file + '.tmp')) throw Error('启动配置临时文件已存在，请核对：' + file + '.tmp');
  fs.writeFileSync(file + '.tmp', JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(file + '.tmp', file);
  return path.join(root, LAUNCH_FILES[0]);
}
