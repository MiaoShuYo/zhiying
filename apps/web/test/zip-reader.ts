import assert from 'node:assert/strict';

export type ZipEntry = { name: string; method: number; crc: number; size: number; data: Buffer };

/** Minimal reader for the store-only archives this project writes. */
export function readZip(buffer: Buffer): ZipEntry[] {
  const eocd = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(eocd), 0x06054b50, '缺少中央目录结束记录');
  const count = buffer.readUInt16LE(eocd + 10);
  const size = buffer.readUInt32LE(eocd + 12);
  const start = buffer.readUInt32LE(eocd + 16);
  assert.equal(start + size, eocd, '中央目录长度必须与结束记录一致');
  const entries: ZipEntry[] = [];
  let cursor = start;
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, `第 ${index + 1} 条目录项签名错误`);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const stored = buffer.readUInt32LE(cursor + 20);
    const raw = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.equal(buffer.readUInt16LE(cursor + 8) & 0x0800, 0x0800, '文件名必须标记为 UTF-8');
    assert.equal(buffer.readUInt32LE(offset), 0x04034b50, `${name} 的本地头签名错误`);
    const localName = buffer.readUInt16LE(offset + 26);
    const localExtra = buffer.readUInt16LE(offset + 28);
    const from = offset + 30 + localName + localExtra;
    const data = buffer.subarray(from, from + raw);
    assert.equal(data.length, stored, `${name} 的数据长度与目录项不符`);
    entries.push({ name, method, crc, size: raw, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
