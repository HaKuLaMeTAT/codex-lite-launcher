import crypto from 'node:crypto';

function check(ok, message) { if (!ok) throw new Error(message); }
export function headerHash(asar) {
  check(asar.length >= 16 && asar.readUInt32LE(0) === 4, 'ASAR 头部无效。');
  const size = asar.readUInt32LE(12);
  check(size > 0 && 16 + size <= asar.length, 'ASAR 头部越界。');
  return crypto.createHash('sha256').update(asar.subarray(16, 16 + size)).digest('hex');
}

// 从 PE 资源目录精确定位 Integrity/ElectronAsar，不能在整个 EXE 中盲替换字符串。
export function executableIntegrity(exe) {
  check(exe.length >= 64 && exe.toString('ascii', 0, 2) === 'MZ', '不是有效的 Windows EXE。');
  const pe = exe.readUInt32LE(60);
  check(pe + 24 <= exe.length && exe.readUInt32LE(pe) === 0x4550, 'PE 头部无效。');
  const count = exe.readUInt16LE(pe + 6), optionalSize = exe.readUInt16LE(pe + 20), optional = pe + 24;
  const magic = exe.readUInt16LE(optional);
  check(magic === 0x20b || magic === 0x10b, '不支持的 PE 类型。');
  const directories = optional + (magic === 0x20b ? 112 : 96);
  const sectionTable = optional + optionalSize;
  check(sectionTable + 40 * count <= exe.length, 'PE 节表越界。');
  function offset(rva, size) {
    for (let i = 0; i < count; i++) {
      const section = sectionTable + i * 40, address = exe.readUInt32LE(section + 12);
      const rawSize = exe.readUInt32LE(section + 16), raw = exe.readUInt32LE(section + 20);
      if (rva >= address && rva + size <= address + rawSize) {
        const result = raw + rva - address;
        check(result + size <= exe.length, 'PE 资源超出文件范围。');
        return result;
      }
    }
    throw new Error('PE 资源地址无法映射。');
  }
  const resourceSize = exe.readUInt32LE(directories + 20);
  const base = offset(exe.readUInt32LE(directories + 16), resourceSize);
  function range(relative, size) { check(relative >= 0 && relative + size <= resourceSize, 'PE 资源目录越界。'); return base + relative; }
  function entries(relative) {
    const start = range(relative, 16), length = exe.readUInt16LE(start + 12) + exe.readUInt16LE(start + 14);
    range(relative + 16, length * 8);
    return Array.from({ length }, (_, i) => {
      const item = start + 16 + i * 8, name = exe.readUInt32LE(item), value = exe.readUInt32LE(item + 4);
      let key = String(name);
      if (name & 0x80000000) {
        const p = name & 0x7fffffff, chars = exe.readUInt16LE(range(p, 2));
        const pos = range(p + 2, chars * 2); key = exe.toString('utf16le', pos, pos + chars * 2);
      }
      return { key, directory: !!(value & 0x80000000), relative: value & 0x7fffffff };
    });
  }
  function select(list, key) {
    const found = list.filter(e => e.key.toLowerCase() === key.toLowerCase());
    check(found.length === 1 && found[0].directory, `EXE 中未唯一找到 ${key} 校验资源。`);
    return found[0].relative;
  }
  const languages = entries(select(entries(select(entries(0), 'Integrity')), 'ElectronAsar'));
  check(languages.length === 1 && !languages[0].directory, 'EXE 校验资源语言布局不支持。');
  const data = range(languages[0].relative, 16), size = exe.readUInt32LE(data + 4);
  const start = offset(exe.readUInt32LE(data), size), text = exe.toString('utf8', start, start + size);
  const config = JSON.parse(text);
  check(Array.isArray(config), 'EXE 校验资源不是数组。');
  const records = config.filter(e => e.file?.replaceAll('\\', '/').toLowerCase() === 'resources/app.asar');
  check(records.length === 1 && records[0].alg?.toLowerCase() === 'sha256' && /^[a-f0-9]{64}$/i.test(records[0].value), 'EXE 中 app.asar 校验记录无效。');
  const hash = records[0].value;
  check(text.split(hash).length === 2, 'EXE 校验摘要出现多次，拒绝修改。');
  return { hash: hash.toLowerCase(), start: start + Buffer.byteLength(text.slice(0, text.indexOf(hash))), resourceStart: start, resourceSize: size };
}

export function updateExecutable(exe, originalAsar, candidateAsar) {
  const current = executableIntegrity(exe), before = headerHash(originalAsar), after = headerHash(candidateAsar);
  check(current.hash === before, 'EXE 与原 ASAR 的头部校验不匹配；请先恢复配套原文件。');
  const bytes = Buffer.from(exe);
  // 只改资源中的 64 字节摘要，不关闭 fuse、不改变资源大小和其他 EXE 内容。
  bytes.write(after, current.start, 64, 'ascii');
  check(executableIntegrity(bytes).hash === after, 'EXE 校验资源更新失败。');
  return { bytes, before, after };
}
