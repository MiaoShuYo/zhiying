/**
 * 进程助手：真实 spawn / 等待退出 / 进程树查询 / tree-kill / 外部进程哨兵。
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { NODE_EXE } from './temp';

export interface SpawnResult {
  child: ChildProcess;
  pid: number;
  stdout: () => string;
  stderr: () => string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** spawn node 脚本（继承当前 env 或指定 env），收集输出。 */
export function spawnNode(scriptPath: string, args: string[] = [], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): SpawnResult {
  return spawnCollect(NODE_EXE, [scriptPath, ...args], opts);
}

/** spawn 任意命令并收集 stdout/stderr。 */
export function spawnCollect(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): SpawnResult {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (d: Buffer) => {
    out += d.toString();
  });
  child.stderr?.on('data', (d: Buffer) => {
    err += d.toString();
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: null }));
  });
  return { child, pid: child.pid ?? -1, stdout: () => out, stderr: () => err, exit };
}

/** 等待子进程退出，超时则返回 null（不自动杀；超时定时器 unref 避免拖住测试进程）。 */
export async function waitExit(child: ChildProcess, timeoutMs = 10_000): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { code: number | null; signal: NodeJS.Signals | null } | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(value);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => finish({ code, signal });
    child.once('exit', onExit);
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
  });
}

/** 进程是否存活。 */
export function isAlive(pid: number): boolean {
  if (!pid || pid < 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 用 taskkill /T /F 终止进程树（与 launcher 相同的 Windows 语义）。 */
export function killTree(pid: number): void {
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
}

/** 通过 PowerShell CIM 查询进程命令行与父进程。 */
export function getProcessInfo(pid: number): { pid: number; parentPid: number; name: string; commandLine: string } | null {
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if ($p) { $p | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress }`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  const text = (res.stdout ?? '').trim();
  if (!text) return null;
  try {
    const obj = JSON.parse(text) as { ProcessId: number; ParentProcessId: number; Name: string; CommandLine?: string };
    return { pid: obj.ProcessId, parentPid: obj.ParentProcessId, name: obj.Name, commandLine: obj.CommandLine ?? '' };
  } catch {
    return null;
  }
}

/** 查询 pid 的子孙进程（不包含自身）。 */
export function getDescendantPids(pid: number): number[] {
  const script = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; $result = @(); $queue = @(${pid}); while ($queue.Count -gt 0) { $cur = $queue[0]; $queue = $queue[1..($queue.Count)]; foreach ($p in $all) { if ($p.ParentProcessId -eq $cur) { $result += $p.ProcessId; $queue += $p.ProcessId } } }; $result -join ','`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  const text = (res.stdout ?? '').trim();
  if (!text) return [];
  return text
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** 轮询直到条件成立。 */
export async function waitForCondition<T>(fn: () => Promise<T> | T, opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {}): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 100));
  }
  throw new Error(`waitForCondition timeout (${opts.label ?? 'condition'}): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/** 启动一个“外部无关进程”（模拟用户已运行的 node/python/ollama），返回 pid 与停止函数。 */
export function startExternalProcess(sentinel: string): { pid: number; stop: () => void; child: ChildProcess } {
  // 注意：Windows 命令行解析会剥离双引号，-e 代码里只能使用单引号，否则子进程会立即报错退出。
  const code = `process.title='external-${sentinel.replace(/[^A-Za-z0-9_-]/g, '')}'; setInterval(() => {}, 1000);`;
  const child = spawn(NODE_EXE, ['-e', code, '--', `--external-sentinel=${sentinel}`], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return {
    pid: child.pid ?? -1,
    child,
    stop: () => {
      try {
        killTree(child.pid ?? -1);
      } catch {
        /* ignore */
      }
    },
  };
}

/** 查询命令行匹配的 node 进程（用于测试清理泄漏的受管服务）。 */
export function findNodeProcessesByCommandLine(matcher: RegExp): Array<{ pid: number; commandLine: string }> {
  const script = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  const text = (res.stdout ?? '').trim();
  if (!text || text === 'null') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const matches: Array<{ pid: number; commandLine: string }> = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { ProcessId?: number; CommandLine?: string };
    if (typeof record.ProcessId !== 'number' || typeof record.CommandLine !== 'string') continue;
    if (matcher.test(record.CommandLine)) matches.push({ pid: record.ProcessId, commandLine: record.CommandLine });
  }
  return matches;
}

/** 杀掉命令行匹配的 node 进程（测试清理用；只用于测试自己创建的安装目录）。 */
export function killNodeProcessesByCommandLine(matcher: RegExp): number[] {
  const killed: number[] = [];
  for (const found of findNodeProcessesByCommandLine(matcher)) {
    killTree(found.pid);
    killed.push(found.pid);
  }
  return killed;
}

/** 把 JSON 调用记录追加写入文件（供 fake 服务/ollama 断言调用参数）。 */
export function appendJsonLine(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + '\n', 'utf8');
}

export function readJsonLines<T = unknown>(file: string): T[] {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}
