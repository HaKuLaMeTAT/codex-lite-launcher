import fs from 'node:fs';

export const OPTIONS = JSON.parse(fs.readFileSync(new URL('./options.json', import.meta.url), 'utf8'));
export function normalizeOptions(selected = OPTIONS.map(option => option.id)) {
  if (!Array.isArray(selected) || selected.some(id => !OPTIONS.some(option => option.id === id)) || new Set(selected).size !== selected.length)
    throw new Error('优化选项包含未知或重复标识。');
  return OPTIONS.filter(option => selected.includes(option.id)).map(option => option.id);
}
export function selectedEdits(selected) {
  const ids = normalizeOptions(selected);
  return OPTIONS.filter(option => ids.includes(option.id)).flatMap(option => option.edits);
}
// CLI 与界面共用显式列表；省略时全选，none 表示不新增任何优化。
export function parseOptionsArgument(value) {
  if (value === undefined) return undefined;
  if (!value.startsWith('--options=')) throw new Error('选项格式：--options=menu,batched-pty-output 或 --options=none');
  const text = value.slice('--options='.length);
  return normalizeOptions(text === 'none' ? [] : text.split(','));
}
