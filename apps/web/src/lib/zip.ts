import { createReadStream } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';

/**
 * Store-only ZIP writer. Delivery packages hold already-compressed media, so
 * deflating would cost time without saving space, and this keeps the builder a
 * few hundred lines with no dependency to audit.
 */
const MAX_ENTRIES = 100;
const MAX_BYTES = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

/** Chainable CRC32: pass the previous result to keep hashing a stream. */
export function crc32(chunk: Buffer, seed = 0) {
  let crc = seed ^ 0xffffffff;
  for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

type Entry = { name: Buffer; size: number; crc: number; offset: number; time: number; date: number };

function dosStamp(date: Date) {
  const value = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = Math.min(Math.max(value.getFullYear(), 1980), 2107);
  return {
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | (value.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
  };
}

function entryName(name: string) {
  if (!name || name.length > 200 || name.startsWith('/') || name.includes('\\') || name.includes('\0')) throw new Error('交付包文件名无效');
  if (name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) throw new Error('交付包文件名无效');
  const encoded = Buffer.from(name, 'utf8');
  if (encoded.length > 255) throw new Error('交付包文件名过长');
  return encoded;
}

export class ZipWriter {
  private entries: Entry[] = [];
  private offset = 0;
  private closed = false;

  private constructor(private handle: FileHandle) {}

  static async create(file: string) {
    return new ZipWriter(await open(file, 'w'));
  }

  private async write(chunk: Buffer) {
    let written = 0;
    while (written < chunk.length) {
      const { bytesWritten } = await this.handle.write(chunk, written, chunk.length - written, this.offset);
      this.offset += bytesWritten;
      written += bytesWritten;
    }
  }

  private async header(name: Buffer, size: number, crc: number, mtime: Date) {
    const { time, date } = dosStamp(mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const offset = this.offset;
    await this.write(local);
    await this.write(name);
    return { offset, time, date };
  }

  async addBuffer(name: string, data: Buffer, mtime = new Date()) {
    if (this.closed) throw new Error('交付包已经关闭');
    if (this.entries.length >= MAX_ENTRIES) throw new Error(`交付包最多包含 ${MAX_ENTRIES} 个文件`);
    if (this.offset + data.length > MAX_BYTES) throw new Error('交付包超过 4 GiB，请改用网盘分享成片');
    const encoded = entryName(name);
    const crc = data.length ? crc32(data) : 0;
    const { offset, time, date } = await this.header(encoded, data.length, crc, mtime);
    await this.write(data);
    this.entries.push({ name: encoded, size: data.length, crc, offset, time, date });
  }

  async addText(name: string, text: string, mtime = new Date()) {
    await this.addBuffer(name, Buffer.from(text, 'utf8'), mtime);
  }

  async addFile(name: string, source: string) {
    if (this.closed) throw new Error('交付包已经关闭');
    const info = await stat(source);
    if (!info.isFile()) throw new Error(`${name} 不是文件`);
    if (this.entries.length >= MAX_ENTRIES) throw new Error(`交付包最多包含 ${MAX_ENTRIES} 个文件`);
    if (this.offset + info.size > MAX_BYTES) throw new Error('交付包超过 4 GiB，请改用网盘分享成片');
    let crc = 0;
    for await (const chunk of createReadStream(source)) crc = crc32(chunk as Buffer, crc);
    const encoded = entryName(name);
    const { offset, time, date } = await this.header(encoded, info.size, crc, info.mtime);
    let copied = 0;
    for await (const chunk of createReadStream(source)) {
      await this.write(chunk as Buffer);
      copied += (chunk as Buffer).length;
    }
    if (copied !== info.size) throw new Error(`${name} 在打包过程中发生变化，请重试`);
    this.entries.push({ name: encoded, size: info.size, crc, offset, time, date });
  }

  /** Writes the central directory and closes the file. */
  async finish() {
    if (this.closed) return;
    const start = this.offset;
    for (const entry of this.entries) {
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(0, 10);
      central.writeUInt16LE(entry.time, 12);
      central.writeUInt16LE(entry.date, 14);
      central.writeUInt32LE(entry.crc, 16);
      central.writeUInt32LE(entry.size, 20);
      central.writeUInt32LE(entry.size, 24);
      central.writeUInt16LE(entry.name.length, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE(0, 38);
      central.writeUInt32LE(entry.offset, 42);
      await this.write(central);
      await this.write(entry.name);
    }
    const size = this.offset - start;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(start, 16);
    end.writeUInt16LE(0, 20);
    await this.write(end);
    this.closed = true;
    await this.handle.close();
  }

  async abort() {
    if (!this.closed) {
      this.closed = true;
      await this.handle.close().catch(() => {});
    }
  }
}
