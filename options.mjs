import fs from 'node:fs';

export const OPTIONS = JSON.parse(fs.readFileSync(new URL('./options.json', import.meta.url), 'utf8'));
export const DEFAULT_OPTIONS = OPTIONS.filter(option => option.default).map(option => option.id);
export const ALL_OPTIONS = OPTIONS.map(option => option.id);
export function normalizeOptions(selected = DEFAULT_OPTIONS) {
  if (!Array.isArray(selected) || selected.some(id => !OPTIONS.some(option => option.id === id)) || new Set(selected).size !== selected.length)
    throw new Error('优化选项包含未知或重复标识。');
  return OPTIONS.filter(option => selected.includes(option.id)).map(option => option.id);
}
export function selectedEdits(selected) {
  const ids = normalizeOptions(selected);
  return OPTIONS.filter(option => ids.includes(option.id)).flatMap(option => option.edits);
}
// 默认只启用基础六项；显式 all / none 分别表示全选和不新增优化。
export function parseOptionsArgument(value) {
  if (value === undefined) return undefined;
  if (!value.startsWith('--options=')) throw new Error('选项格式：--options=menu,batched-pty-output 或 --options=none');
  const text = value.slice('--options='.length);
  return normalizeOptions(text === 'all' ? ALL_OPTIONS : text === 'none' ? [] : text.split(','));
}

export function normalizeInactiveMinutes(value = 5) {
  if (!Number.isInteger(value) || value < 1 || value > 180) throw new Error('非活跃会话保留时间须为 1–180 的整数分钟。');
  return value;
}

export function parsePatchArguments(args) {
  let selected, inactiveMinutes = 5;
  const seen = new Set();
  for (const arg of args) {
    const name = arg.split('=')[0];
    if (seen.has(name)) throw new Error('补丁参数重复：' + name);
    seen.add(name);
    if (name === '--options') selected = parseOptionsArgument(arg);
    else if (/^--inactive-minutes=\d+$/.test(arg)) inactiveMinutes = normalizeInactiveMinutes(Number(arg.slice('--inactive-minutes='.length)));
    else throw new Error('未知或无效的补丁参数：' + arg);
  }
  return { selected, inactiveMinutes };
}
