/**
 * 文件系统助手：哈希、目录树快照、确定性字节、junction/reparse、长路径、Windows 删除重试。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sha256Text(text: string): string {
  return sha256Buffer(Buffer.from(text, 'utf8'));
}

export async function sha256File(file: string): Promise<string> {
  const buf = await fsp.readFile(file);
  return sha256Buffer(buf);
}

/** 生成确定性字节内容（seed 决定内容，size 决定长度）。 */
export function deterministicBytes(size: number, seed = 'seed'): Buffer {
  const chunks: Buffer[] = [];
  let produced = 0;
  let i = 0;
  while (produced < size) {
    const chunk = crypto.createHash('sha256').update(`${seed}:${i++}`).digest();
    chunks.push(chunk);
    produced += chunk.length;
  }
  return Buffer.concat(chunks).subarray(0, size);
}

export async function mkdirp(dir: string): Promise<string> {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** 写文件并确保父目录存在。 */
export async function writeFileDeep(file: string, data: string | Buffer): Promise<string> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, data);
  return file;
}

export async function readFileText(file: string): Promise<string> {
  return fsp.readFile(file, 'utf8');
}

export async function readJson<T = unknown>(file: string): Promise<T> {
  return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
}

export async function writeJson(file: string, value: unknown): Promise<string> {
  return writeFileDeep(file, JSON.stringify(value, null, 2));
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export function pathExistsSync(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export async function removeTree(target: string): Promise<void> {
  await fsp.rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

export interface TreeEntry {
  path: string;
  sizeBytes: number;
  sha256: string;
}

/** 递归列出目录下所有文件（相对路径用正斜杠、确定性排序）。 */
export async function listTree(root: string): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        out.push({
          path: path.relative(root, full).split(path.sep).join('/'),
          sizeBytes: (await fsp.stat(full)).size,
          sha256: await sha256File(full),
        });
      }
    }
  }
  await walk(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function listFiles(root: string): Promise<string[]> {
  return (await listTree(root)).map((e) => e.path);
}

/** 在两个目录树间比较（用于“升级保留 models/data”断言）。 */
export async function assertTreeContains(root: string, entries: TreeEntry[]): Promise<void> {
  const actual = new Map((await listTree(root)).map((e) => [e.path, e]));
  for (const expected of entries) {
    const found = actual.get(expected.path);
    if (!found) throw new Error(`tree missing ${expected.path}`);
    if (found.sizeBytes !== expected.sizeBytes) throw new Error(`tree size mismatch ${expected.path}`);
    if (found.sha256 !== expected.sha256) throw new Error(`tree hash mismatch ${expected.path}`);
  }
}

/** 直接为绝对路径加 \\?\ 前缀（长路径）。 */
export function toExtended(absPath: string): string {
  const resolved = path.resolve(absPath);
  if (resolved.startsWith('\\\\?\\')) return resolved;
  if (resolved.startsWith('\\\\')) return `\\\\?\\UNC\\${resolved.slice(2)}`;
  return `\\\\?\\${resolved}`;
}

/** 用 cmd mklink /J 创建目录 junction（无需管理员）；失败抛错。 */
export function createJunction(linkPath: string, targetPath: string): void {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  const res = spawnSync('cmd.exe', ['/d', '/c', 'mklink', '/J', linkPath, targetPath], { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) throw new Error(`mklink /J failed: ${res.stderr || res.stdout}`);
}

export function isReparsePointSync(p: string): boolean {
  try {
    // 跨 @types/node 版本（web 用 22.x）兼容：Windows 下 attributes 含 FILE_ATTRIBUTE_REPARSE_POINT(0x400)
    const attributes = (fs.lstatSync(p) as unknown as { attributes?: number }).attributes;
    return typeof attributes === 'number' && (attributes & 0x400) !== 0;
  } catch {
    return false;
  }
}

/** 等到路径出现（用于等待日志/状态文件）。 */
export async function waitForPath(target: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    if (await pathExists(target)) return;
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 100));
  }
  throw new Error(`waitForPath timeout: ${target}`);
}

/** 读取文件直到匹配 pattern 或超时。 */
export async function waitForFileMatch(file: string, pattern: RegExp, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<string> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  let last = '';
  while (Date.now() < deadline) {
    try {
      last = await fsp.readFile(file, 'utf8');
      if (pattern.test(last)) return last;
    } catch {
      /* 文件尚未出现 */
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 100));
  }
  throw new Error(`waitForFileMatch timeout: ${file} pattern=${pattern} last=${last.slice(0, 500)}`);
}

/** 快照一个目录（含 models/data 保留断言）。 */
export async function snapshotTree(root: string): Promise<TreeEntry[]> {
  return listTree(root);
}

/** 统计目录字节数（不抛错，缺失返回 0）。 */
export async function directorySize(root: string): Promise<number> {
  try {
    return (await listTree(root)).reduce((sum, e) => sum + e.sizeBytes, 0);
  } catch {
    return 0;
  }
}
