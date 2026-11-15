/**
 * 环境变量助手：快照/断言未修改、净化 PATH 环境（模拟无开发工具干净机）、子进程运行。
 */
import { spawnSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WINDOWS_DIR = process.env.SystemRoot || 'C:\\Windows';
const SYSTEM32 = path.join(WINDOWS_DIR, 'System32');
const WIN_DIR = WINDOWS_DIR;

/** process.env 的深拷贝快照，用于断言“未修改全局环境”。 */
export function snapshotEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export function diffEnv(a: Record<string, string>, b: Record<string, string>): string[] {
  const diffs: string[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k] !== b[k]) diffs.push(`${k}: ${JSON.stringify(a[k])} -> ${JSON.stringify(b[k])}`);
  }
  return diffs;
}

/** 净化环境：PATH 只保留 Windows/System32 等系统目录（无 node/pnpm/python/git）。 */
export function sanitizedEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    SystemRoot: WINDOWS_DIR,
    windir: WINDOWS_DIR,
    ComSpec: path.join(SYSTEM32, 'cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PATH: [SYSTEM32, WIN_DIR, path.join(SYSTEM32, 'Wbem'), path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0')].join(';'),
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
    USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    USERNAME: process.env.USERNAME,
    NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS,
    PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE,
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  // 清理干净机不应继承的变量
  for (const k of ['NODE_OPTIONS', 'NODE_PATH', 'PNPM_HOME', 'npm_config_user_agent', 'PYTHONPATH', 'PYTHONHOME', 'OLLAMA_HOST', 'OLLAMA_MODELS', 'HF_HOME', 'HF_HUB_CACHE', 'TRANSFORMERS_CACHE', 'VIRTUAL_ENV']) {
    if (!(k in overrides) && overrides[k] !== undefined) delete env[k];
  }
  return env;
}

/** 断言 PATH 中不含 node/pnpm/python/git（净化环境自检）。 */
export function pathHasDevTool(command: string, env: NodeJS.ProcessEnv): boolean {
  const pathDirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = (env.PATHEXT ?? '.EXE').split(';');
  for (const dir of pathDirs) {
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, command + ext.toLowerCase())) || fs.existsSync(path.join(dir, command + ext.toUpperCase()))) return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** 同步运行一个命令（测试用；注入 env，不继承开发工具）。 */
export function runSync(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; shell?: boolean } = {}): RunResult {
  const res = spawnSync(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    timeout: opts.timeoutMs ?? 60_000,
    encoding: 'utf8',
    windowsHide: true,
    shell: opts.shell ?? false,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** 异步运行一个命令，返回 ChildProcess（由调用方收集输出）。 */
export function runAsync(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ChildProcess {
  return spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** 读取环境键值数组快照，过滤 undefined。 */
export function pickEnv(env: NodeJS.ProcessEnv, keys: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of keys) out[k] = env[k];
  return out;
}
