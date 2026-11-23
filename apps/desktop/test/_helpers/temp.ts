/**
 * 临时目录助手：全部测试临时目录固定在 <repo>/data/tmp/v21 下（gitignore），
 * 支持中文/空格路径、长路径、junction，Windows 删除重试与全局兜底清理。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** apps/desktop/test/_helpers -> repo root */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
export const TMP_ROOT = path.join(REPO_ROOT, 'data', 'tmp', 'v21');

const registered = new Set<string>();

/**
 * Every directory this test process created, kept for the whole run (unlike `registered`, it is
 * not emptied by cleanup). Cleanup helpers use it as ownership evidence, so they only touch
 * installers, uninstall entries and shortcuts that point into this run's own folders (#131, #132).
 */
const owned = new Set<string>();

function normalizeOwned(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}

export function registerOwnedTestRoot(dir: string): void {
  owned.add(normalizeOwned(dir));
  try {
    owned.add(normalizeOwned(fs.realpathSync.native(dir)));
  } catch {
    /* 目录可能尚未创建或已删除 */
  }
}

/** True when `value` is one of this run's directories or a path inside one. */
export function isOwnedTestPath(value: string | undefined | null): boolean {
  if (!value) return false;
  let normalized: string;
  try {
    normalized = normalizeOwned(value.trim().replace(/^"|"$/g, ''));
  } catch {
    return false;
  }
  for (const root of owned) {
    if (normalized === root || normalized.startsWith(`${root}\\`) || normalized.startsWith(`${root}/`)) return true;
  }
  return false;
}

/** True when a command line mentions one of this run's directories (quoted or not). */
export function commandLineUsesOwnedPath(commandLine: string): boolean {
  const lowered = commandLine.toLowerCase().replace(/\//g, '\\');
  for (const root of owned) {
    const rootBackslash = root.replace(/\//g, '\\');
    if (lowered.includes(`${rootBackslash}\\`) || lowered.includes(`${rootBackslash}"`) || lowered.endsWith(rootBackslash)) return true;
  }
  return false;
}

export function ensureTmpRoot(): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return TMP_ROOT;
}

let counter = 0;

/** 创建 <tmp>/<label>-<pid>-<counter>-<rand> 临时目录并登记自动清理。 */
export function makeTempRoot(label = 'case'): string {
  ensureTmpRoot();
  const name = `${label}-${process.pid}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  registered.add(dir);
  registerOwnedTestRoot(dir);
  return dir;
}

/** 中文 + 空格 + 括号 的目录名，用于路径兼容性测试。 */
export function makeChineseSpaceDir(parent: string, name = '知影 安装 目录'): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  registered.add(dir);
  registerOwnedTestRoot(dir);
  return dir;
}

/** 在 parent 下创建指定字符数的单段长目录名（Windows 长路径场景）。 */
export function makeLongDir(parent: string, segments: number, segmentLength: number, label = 'long'): string {
  const parts: string[] = [];
  for (let i = 0; i < segments; i++) {
    const base = `${label}-${String(i).padStart(2, '0')}-`;
    parts.push(base + 'x'.repeat(Math.max(1, segmentLength - base.length)));
  }
  const dir = path.join(parent, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  registered.add(dir);
  return dir;
}

/** 生成一个超过 240 字符的绝对路径（不一定创建）。 */
export function makeLongPath(base: string, totalLength = 300): string {
  let p = base;
  let i = 0;
  while (p.length < totalLength) {
    p = path.join(p, `段-${i.toString().padStart(2, '0')}-` + 'y'.repeat(8));
    i++;
  }
  return p;
}

export function isRegistered(dir: string): boolean {
  return registered.has(path.resolve(dir));
}

/** 删除单个临时目录（Windows 上做多次重试）。 */
export function removeTempDir(dir: string): void {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      registered.delete(path.resolve(dir));
      return;
    } catch {
      // 被杀进程/句柄释放需要时间
      sleepSync(150 * (attempt + 1));
    }
  }
}

/** 全局兜底清理：测试文件 after() 调用。 */
export function cleanupRegisteredTempDirs(): void {
  for (const dir of [...registered]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* 尽力而为 */
    }
    registered.delete(dir);
  }
}

/** 注册 node:test 的 after 钩子清理（在 test 文件内调用一次即可）。 */
export function registerTempCleanup(t: { after(fn: () => void): void }): void {
  t.after(() => cleanupRegisteredTempDirs());
}

export function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  // eslint-disable-next-line no-empty
  while (Date.now() < end) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(50, end - Date.now()));
    } catch {
      /* 简化 */
    }
  }
}

/** 同时用于本地调用与子进程的 node 可执行文件。 */
export const NODE_EXE = process.execPath;
