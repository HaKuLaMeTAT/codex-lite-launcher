import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, requireStopped } from '../patch.mjs';

const suffix = '.before-lite-image';
const same = (a, b) => path.resolve(a) === path.resolve(b);
export function prepareHistory(source, imageName, output) {
  source = path.resolve(source); output = path.resolve(output);
  if (same(source, output) || fs.existsSync(output) || fs.existsSync(output + '.json')) throw Error('候选路径必须是另一个尚不存在的文件。');
  if (imageName !== path.basename(imageName) || !imageName) throw Error('请提供图片文件名，不是路径。');
  const original = fs.readFileSync(source), text = original.toString('utf8');
  if (!Buffer.from(text).equals(original)) throw Error('会话不是 UTF-8 文本，拒绝修改。');
  const lines = text.split(/(?<=\n)/);
  let image;
  for (const line of lines) {
    if (!line.includes(imageName)) continue;
    const record = JSON.parse(line), payload = record.payload;
    if (record.type !== 'response_item' || payload?.role !== 'user') continue;
    const images = payload.content?.filter(c => c.type === 'input_image' && /^data:image\/png;base64,/.test(c.image_url)) ?? [];
    if (images.length !== 1 || image) throw Error('原始图片字节不能唯一对应，请先检查会话记录。');
    image = images[0].image_url;
  }
  if (!image) throw Error('会话中未找到唯一的原始 PNG 图片字节。');
  const png = Buffer.from(image.split(',')[1], 'base64');
  if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw Error('保存内容不是 PNG。');
  let changes = 0;
  const updated = lines.map(line => {
    if (!line.includes(imageName)) return line;
    const record = JSON.parse(line), item = record.payload?.item;
    if (record.type !== 'item_completed' || item?.type !== 'UserMessage') return line;
    for (const content of item.content ?? []) {
      if (content.type !== 'local_image' || path.win32.basename(content.path ?? '') !== imageName) continue;
      const before = JSON.stringify(content), after = JSON.stringify({ type: 'image', image_url: image });
      if (line.split(before).length !== 2) throw Error('历史图片原文不能唯一定位，拒绝重写整行。');
      line = line.replace(before, after); changes++;
    }
    return line;
  }).join('');
  if (changes !== 1) throw Error(`应修改一处历史图片，实际 ${changes} 处。`);
  const candidate = Buffer.from(updated);
  fs.writeFileSync(output, candidate, { flag: 'wx' });
  const manifest = { format: 1, source, originalSha256: sha256(original), candidateSha256: sha256(candidate), imageSha256: sha256(png) };
  fs.writeFileSync(output + '.json', JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}
export function applyHistory(source, stage, restore = false, stopped = requireStopped) {
  stopped(); source = path.resolve(source); stage = path.resolve(stage);
  const manifest = JSON.parse(fs.readFileSync(stage + '.json', 'utf8')), backup = source + suffix;
  if (manifest.format !== 1 || !same(manifest.source, source)) throw Error('候选记录与来源不匹配。');
  const current = fs.readFileSync(source), wanted = restore ? manifest.candidateSha256 : manifest.originalSha256;
  if (sha256(current) !== wanted) throw Error('会话已有其他修改，拒绝覆盖。');
  const candidate = fs.readFileSync(restore ? backup : stage);
  if (sha256(candidate) !== (restore ? manifest.originalSha256 : manifest.candidateSha256)) throw Error('候选或备份摘要不匹配。');
  if (!restore) fs.copyFileSync(source, backup, fs.constants.COPYFILE_EXCL);
  // 只替换用户明确指定的一份会话；其他行和换行字节在准备阶段保持不变。
  fs.writeFileSync(source + '.lite-image.tmp', candidate, { flag: 'wx' });
  stopped();
  if (sha256(fs.readFileSync(source)) !== wanted) throw Error('准备期间会话发生变化，已停止。');
  fs.renameSync(source + '.lite-image.tmp', source);
  if (sha256(fs.readFileSync(source)) !== sha256(candidate)) throw Error('写入后摘要不匹配。');
  return { status: restore ? 'restored' : 'applied', backup };
}
if (process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    const [mode, source, argument, output] = process.argv.slice(2);
    if (mode === 'prepare' && source && argument && output) console.log(JSON.stringify(prepareHistory(source, argument, output)));
    else if (['install', 'restore'].includes(mode) && source && argument && !output) console.log(JSON.stringify(applyHistory(source, argument, mode === 'restore')));
    else throw Error('用法：prepare <会话.jsonl> <图片文件名> <候选.jsonl>；install|restore <会话.jsonl> <候选.jsonl>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
