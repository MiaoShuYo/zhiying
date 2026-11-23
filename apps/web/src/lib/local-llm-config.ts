import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export type LocalLlmConfig = {
  baseUrl: string;
  model: string;
  keepAlive: string;
  numCtx: number;
  stream: boolean;
  maxConcurrency: number;
  lockDir: string;
  warnings: string[];
};

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number, name: string, warnings: string[]) {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    warnings.push(`${name} 必须是 ${min}–${max} 的整数，当前使用默认值 ${fallback}`);
    return fallback;
  }
  return parsed;
}

function configuredBoolean(value: string | undefined, fallback: boolean, name: string, warnings: string[]) {
  if (value === undefined || value.trim() === '') return fallback;
  if (/^(true|1|yes)$/i.test(value.trim())) return true;
  if (/^(false|0|no)$/i.test(value.trim())) return false;
  warnings.push(`${name} 必须是 true 或 false，当前使用默认值 ${fallback}`);
  return fallback;
}

function configuredKeepAlive(value: string | undefined, warnings: string[]) {
  if (value === undefined || value.trim() === '') return '30m';
  const normalized = value.trim();
  const duration = /^(\d+)(ms|s|m|h)$/i.exec(normalized);
  const maximum = duration ? ({ ms: 86_400_000, s: 86_400, m: 1_440, h: 24 }[duration[2].toLowerCase() as 'ms' | 's' | 'm' | 'h']) : 0;
  if (/^0$/.test(normalized) || (duration && Number(duration[1]) <= maximum)) return normalized;
  warnings.push('OLLAMA_KEEP_ALIVE 格式无效，支持 0 或不超过 24 小时的 ms/s/m/h 时长；当前使用默认值 30m');
  return '30m';
}

export function readLocalLlmConfig(env: Record<string, string | undefined> = process.env): LocalLlmConfig {
  const warnings: string[] = [];
  let baseUrl = env.OLLAMA_BASE_URL?.trim() || 'http://127.0.0.1:11434';
  try {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('invalid');
    if (parsed.hostname.toLowerCase() === 'localhost') parsed.hostname = '127.0.0.1';
    baseUrl = parsed.toString().replace(/\/$/, '');
  } catch {
    warnings.push('OLLAMA_BASE_URL 格式无效，当前使用默认本机地址');
    baseUrl = 'http://127.0.0.1:11434';
  }
  const repoRoot = resolve(process.cwd(), '../..');
  return {
    baseUrl,
    model: env.OLLAMA_MODEL?.trim() || 'qwen3:4b',
    keepAlive: configuredKeepAlive(env.OLLAMA_KEEP_ALIVE, warnings),
    numCtx: boundedInteger(env.OLLAMA_NUM_CTX, 4096, 512, 32768, 'OLLAMA_NUM_CTX', warnings),
    stream: configuredBoolean(env.OLLAMA_STREAM, true, 'OLLAMA_STREAM', warnings),
    maxConcurrency: boundedInteger(env.LLM_MAX_CONCURRENCY, 1, 1, 4, 'LLM_MAX_CONCURRENCY', warnings),
    lockDir: resolve(env.OLLAMA_LOCK_DIR?.trim() || resolve(repoRoot, 'data', 'ollama-locks')),
    warnings,
  };
}

function pidIsAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

const STALE_SLOT_MS = 5000;
/** A reclaimer holds the guard for milliseconds; an older guard was left by a crashed process. */
const STALE_GUARD_MS = 30_000;

async function slotIsStale(candidate: string): Promise<boolean> {
  let raw: string | null = null;
  try {
    raw = await readFile(candidate, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
  }
  if (raw !== null) {
    try {
      const owner = JSON.parse(raw) as { pid?: unknown; createdAt?: unknown };
      if (owner && typeof owner === 'object') {
        const createdAt = typeof owner.createdAt === 'number' ? owner.createdAt : 0;
        return Date.now() - createdAt > STALE_SLOT_MS && !pidIsAlive(owner.pid);
      }
    } catch {
      /* 半写入或损坏：按修改时间判断 */
    }
  }
  try {
    return Date.now() - (await stat(candidate)).mtimeMs > STALE_SLOT_MS;
  } catch {
    return false;
  }
}

/**
 * Removes a dead owner's slot file without ever deleting a live replacement (#194).
 *
 * Two waiters used to read the same dead owner; after the first unlinked it and acquired the
 * slot, the second unlinked that new lock and both generated beyond the limit. Reclaimers now
 * take `slot-<n>.reclaim` exclusively and re-check under it: while the stale file exists nobody
 * can acquire the slot and only one reclaimer runs, so the unlinked file is the one judged
 * stale. services/python/app/local_llm_config.py follows exactly the same protocol.
 */
async function reclaimStaleSlot(candidate: string): Promise<void> {
  if (!(await slotIsStale(candidate))) return;
  const guard = candidate.replace(/\.lock$/, '.reclaim');
  try {
    const handle = await open(guard, 'wx');
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      try {
        if (Date.now() - (await stat(guard)).mtimeMs > STALE_GUARD_MS) await unlink(guard);
      } catch {}
    }
    return;
  }
  try {
    if (await slotIsStale(candidate)) await unlink(candidate).catch(() => {});
  } finally {
    await unlink(guard).catch(() => {});
  }
}

function wait(ms: number) { return new Promise(resolveWait => setTimeout(resolveWait, ms)); }

/** Cross-process Ollama slot shared with the Python pronunciation service. */
export async function withLocalLlmSlot<T>(operation: () => Promise<T>, config = readLocalLlmConfig()): Promise<T> {
  await mkdir(config.lockDir, { recursive: true });
  const token = randomUUID();
  let lockPath = '';
  while (!lockPath) {
    for (let slot = 0; slot < config.maxConcurrency; slot += 1) {
      const candidate = resolve(config.lockDir, `slot-${slot}.lock`);
      try {
        const handle = await open(candidate, 'wx');
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }));
        await handle.close();
        lockPath = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await reclaimStaleSlot(candidate);
      }
    }
    if (!lockPath) await wait(100);
  }
  try {
    return await operation();
  } finally {
    try {
      const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { token?: string };
      if (owner.token === token) await unlink(lockPath);
    } catch {}
  }
}
