import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';

/**
 * #102 端口与进程身份探测。
 *
 * 只读探测：不结束任何进程，不修改系统状态。进程身份只认 `--m2v-instance=<id>` /
 * `M2V_MANAGED_INSTANCE=<id>` 标记或调用方记录的完整命令行，避免误杀用户已有进程。
 */

const execFileAsync = promisify(execFile);

const UTF8_OUTPUT = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ';

const EXEC_OPTIONS = { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' as const };

export interface PortOwner {
  pid?: number;
  name?: string;
}

export interface PortInspection {
  open: boolean;
  owner?: PortOwner;
}

function isValidPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

/** 进程是否存活（`EPERM` 视为存活，避免把受保护进程误判为不存在）。 */
export function isProcessAlive(pid: number): boolean {
  if (!isValidPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM' || code === 'EACCES';
  }
}

function connectOnce(port: number, host: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolvePromise => {
    let settled = false;
    const socket = createConnection({ port, host });
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

interface ProcessInfo {
  pid: number;
  parentPid?: number;
  commandLine?: string;
  name?: string;
}

function parsePowerShellJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function asProcessInfoList(value: unknown): ProcessInfo[] {
  if (!value) return [];
  const entries = Array.isArray(value) ? value : [value];
  const output: ProcessInfo[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const pid = Number(record.ProcessId ?? record.processId);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const info: ProcessInfo = { pid };
    if (typeof record.ParentProcessId === 'number') info.parentPid = record.ParentProcessId;
    if (typeof record.CommandLine === 'string') info.commandLine = record.CommandLine;
    if (typeof record.Name === 'string') info.name = record.Name;
    output.push(info);
  }
  return output;
}

/**
 * 批量读取 Windows 进程命令行/名称（单次 PowerShell 调用，避免逐个进程启动脚本）。
 * 非 Windows 或读取失败时返回空 Map。
 */
export async function readProcessInfos(pids: number[]): Promise<Map<number, ProcessInfo>> {
  const unique = [...new Set(pids.filter(isValidPid))];
  const result = new Map<number, ProcessInfo>();
  if (unique.length === 0 || process.platform !== 'win32') return result;
  const filter = unique.map(pid => `ProcessId=${pid}`).join(' or ');
  // #138: Windows PowerShell writes JSON in the console code page unless told otherwise, which
  // corrupts Chinese paths in command lines (used for ownership checks); force UTF-8 output.
  const command = `${UTF8_OUTPUT}Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ParentProcessId,CommandLine,Name | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], EXEC_OPTIONS);
    for (const info of asProcessInfoList(parsePowerShellJson(stdout))) result.set(info.pid, info);
  } catch {
    /* 探测失败按“无法确认身份”处理，绝不据此结束进程。 */
  }
  return result;
}

/** 批量读取进程命令行（Map<pid, commandLine>）。 */
export async function readProcessCommandLines(pids: number[]): Promise<Map<number, string>> {
  const infos = await readProcessInfos(pids);
  const output = new Map<number, string>();
  for (const [pid, info] of infos) {
    if (info.commandLine) output.set(pid, info.commandLine);
  }
  return output;
}

async function lookupPortOwner(port: number): Promise<PortOwner | undefined> {
  if (process.platform !== 'win32') return undefined;
  const script = [
    UTF8_OUTPUT.replace(/; $/, ''),
    `$connection = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
    'if ($connection) {',
    '  $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue',
    '  [pscustomobject]@{ pid = [int]$connection.OwningProcess; name = $process.ProcessName } | ConvertTo-Json -Compress',
    '}',
  ].join('; ');
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], EXEC_OPTIONS);
    const parsed = parsePowerShellJson(stdout);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const pid = Number(record.pid);
      const owner: PortOwner = {};
      if (Number.isInteger(pid) && pid > 0) owner.pid = pid;
      if (typeof record.name === 'string' && record.name.trim()) owner.name = record.name.trim();
      if (owner.pid !== undefined || owner.name !== undefined) return owner;
    }
  } catch {
    /* 退回 netstat 解析。 */
  }
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], EXEC_OPTIONS);
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+\S+\s+(\d+)\s*$/i);
      if (!match) continue;
      if (Number(match[1]) !== port) continue;
      const pid = Number(match[2]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      return { pid };
    }
  } catch {
    /* 探测失败时仍返回 open=true，只是没有占用者信息。 */
  }
  return undefined;
}

/** 探测端口是否被监听；开放时尽量给出占用者 PID/进程名。 */
export async function inspectPort(port: number, host = '127.0.0.1'): Promise<PortInspection> {
  const open = await connectOnce(port, host, 900);
  if (!open) return { open: false };
  const owner = await lookupPortOwner(port);
  return owner ? { open: true, owner } : { open: true };
}

export interface ManagedProcessInspection {
  alive: boolean;
  managed: boolean;
  commandLine?: string;
}

/**
 * 校验进程是否为本实例受管进程：存活且命令行含实例标记。
 */
export async function inspectManagedProcess(pid: number, instanceId: string): Promise<ManagedProcessInspection> {
  const alive = isProcessAlive(pid);
  if (!alive) return { alive: false, managed: false };
  const commandLines = await readProcessCommandLines([pid]);
  const commandLine = commandLines.get(pid);
  const managed = Boolean(commandLine && (commandLine.includes(`--m2v-instance=${instanceId}`) || commandLine.includes(`M2V_MANAGED_INSTANCE=${instanceId}`)));
  return commandLine === undefined ? { alive, managed } : { alive, managed, commandLine };
}
