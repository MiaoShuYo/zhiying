/**
 * Fake `ollama` 子进程：真实 spawn 的 node 脚本，输出官方风格 NDJSON 流。
 * 通过注入 spawnImpl 把 `ollama pull <model>` 映射到 `node fake-ollama.mjs pull <model>`，
 * 从而在不依赖外部 Ollama 的情况下验证 ollama-pull 的流解析/暂停/恢复/失败语义。
 *
 * 脚本行为由环境变量控制：
 *  FAKE_OLLAMA_MODE   success | fail | bad-json | hang | slow | no-progress | error-exit
 *  FAKE_OLLAMA_TOTAL  总字节数（默认 1_000_000）
 *  FAKE_OLLAMA_STEPS  进度条数（默认 5）
 *  FAKE_OLLAMA_DELAY  每行间隔 ms（默认 5）
 *  FAKE_OLLAMA_FAIL_AT  fail 模式失败前输出几行（默认 2）
 *  FAKE_OLLAMA_RECORD  调用记录 JSONL 路径（argv + 时间）
 *  FAKE_OLLAMA_EXIT    显式退出码
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { spawn as SpawnFn } from 'node:child_process';
import { NODE_EXE } from './temp';

export function fakeOllamaScriptSource(): string {
  return `#!/usr/bin/env node
import fs from 'node:fs';
const env = process.env;
const mode = env.FAKE_OLLAMA_MODE || 'success';
const total = Number(env.FAKE_OLLAMA_TOTAL || 1000000);
const steps = Number(env.FAKE_OLLAMA_STEPS || 5);
const delay = Number(env.FAKE_OLLAMA_DELAY || 5);
const failAt = Number(env.FAKE_OLLAMA_FAIL_AT || 2);
const record = env.FAKE_OLLAMA_RECORD;
const argv = process.argv.slice(2);
if (record) {
  try { fs.appendFileSync(record, JSON.stringify({ argv, at: Date.now(), mode, pid: process.pid, ollamaModels: env.OLLAMA_MODELS || null, ollamaBaseUrl: env.OLLAMA_BASE_URL || null }) + '\\n'); } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
async function main() {
  if (mode === 'error-exit') {
    process.stderr.write('Error: model not found\\n');
    process.exit(Number(env.FAKE_OLLAMA_EXIT || 1));
  }
  if (mode === 'bad-json') {
    process.stdout.write('not-json-line\\n');
    process.stdout.write('{"status":"pulling manifest"}\\n');
    await sleep(delay);
    emit({ status: 'downloading', digest: 'sha256:aaaa', total, completed: Math.floor(total / 2) });
    process.stdout.write('garbage after json\\n');
    await sleep(delay);
    emit({ status: 'verifying sha256 digest' });
    await sleep(delay);
    emit({ status: 'writing manifest' });
    emit({ status: 'success' });
    return;
  }
  if (mode === 'no-progress') {
    emit({ status: 'pulling manifest' });
    await sleep(delay);
    emit({ status: 'downloading' });
    await sleep(delay);
    emit({ status: 'verifying sha256 digest' });
    emit({ status: 'success' });
    return;
  }
  emit({ status: 'pulling manifest' });
  await sleep(delay);
  if (mode === 'fail') {
    for (let i = 0; i < failAt; i++) {
      emit({ status: 'downloading', digest: 'sha256:aaaa', total, completed: Math.floor((total * (i + 1)) / (failAt + 1)) });
      await sleep(delay);
    }
    process.stderr.write('Error: pull failed: simulated network error\\n');
    process.exit(Number(env.FAKE_OLLAMA_EXIT || 1));
  }
  if (mode === 'hang') {
    emit({ status: 'downloading', digest: 'sha256:aaaa', total, completed: Math.floor(total * 0.3) });
    await sleep(delay);
    setInterval(() => {}, 1000);
    return;
  }
  for (let i = 1; i <= steps; i++) {
    if (mode === 'slow') await sleep(Number(env.FAKE_OLLAMA_DELAY || 200));
    emit({ status: 'downloading', digest: 'sha256:aaaa', total, completed: Math.floor((total * i) / steps) });
    if (mode !== 'slow') await sleep(delay);
  }
  emit({ status: 'verifying sha256 digest' });
  await sleep(delay);
  emit({ status: 'writing manifest' });
  await sleep(delay);
  emit({ status: 'success' });
}
main().catch((err) => { process.stderr.write(String(err) + '\\n'); process.exit(1); });
`;
}

/** 写 fake ollama 脚本到 dir，返回路径。 */
export function writeFakeOllamaScript(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'fake-ollama.mjs');
  fs.writeFileSync(file, fakeOllamaScriptSource(), 'utf8');
  return file;
}

export interface FakeOllamaOptions {
  mode?: 'success' | 'fail' | 'bad-json' | 'hang' | 'slow' | 'no-progress' | 'error-exit';
  total?: number;
  steps?: number;
  delayMs?: number;
  failAt?: number;
  exitCode?: number;
  env?: Record<string, string>;
}

/**
 * 构造可注入的 spawnImpl：无论被要求 spawn 什么命令，都真实 spawn node fake 脚本。
 * 记录的调用参数通过 FAKE_OLLAMA_RECORD 文件断言。
 */
export function makeFakeOllamaSpawn(scriptPath: string, recordFile: string, options: FakeOllamaOptions = {}): typeof SpawnFn {
  const env: Record<string, string> = {
    FAKE_OLLAMA_MODE: options.mode ?? 'success',
    FAKE_OLLAMA_TOTAL: String(options.total ?? 1_000_000),
    FAKE_OLLAMA_STEPS: String(options.steps ?? 5),
    FAKE_OLLAMA_DELAY: String(options.delayMs ?? 5),
    FAKE_OLLAMA_FAIL_AT: String(options.failAt ?? 2),
    FAKE_OLLAMA_RECORD: recordFile,
    ...(options.exitCode !== undefined ? { FAKE_OLLAMA_EXIT: String(options.exitCode) } : {}),
    ...(options.env ?? {}),
  };
  const impl = ((command: string, args: readonly string[] = [], spawnOptions?: Record<string, unknown>) => {
    const injectedEnv = (spawnOptions as { env?: NodeJS.ProcessEnv } | undefined)?.env ?? {};
    const child = spawn(NODE_EXE, [scriptPath, ...args], {
      ...(spawnOptions as object),
      env: { ...process.env, ...injectedEnv, ...env },
      windowsHide: true,
    });
    return child;
  }) as unknown as typeof SpawnFn;
  return impl;
}

/** 读取 fake ollama 调用记录。 */
export function readFakeOllamaCalls(file: string): Array<{ argv: string[]; at: number; mode: string; pid: number }> {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
