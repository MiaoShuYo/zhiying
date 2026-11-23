/**
 * R3 GUI 安装向导测试助手（真实 exe，不 mock）：
 * - PE 头解析（machine / magic / 子系统：2=WINDOWS_GUI，3=WINDOWS_CUI）
 * - GUI 进程窗口探测（MainWindowTitle/Handle 轮询）
 * - 可见窗口方式的真实 spawn（不隐藏窗口，同时捕获 stdout/stderr）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { registerOwnedTestRoot } from './temp';

export interface PeInfo {
  machine: number;
  numberOfSections: number;
  magic: number;
  is64: boolean;
  subsystem: number;
  subsystemLabel: 'WINDOWS_GUI' | 'WINDOWS_CUI' | 'OTHER';
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, position);
  if (read < length) throw new Error(`读取 PE 文件失败: 期望 ${length} 字节，实际 ${read}`);
  return buffer;
}

/** 解析 PE/COFF Optional Header 的 Subsystem（2=GUI/WinForms，3=Console）。 */
export function readPeInfo(file: string): PeInfo {
  const fd = fs.openSync(file, 'r');
  try {
    const dos = readAt(fd, 0, 0x40);
    if (dos.subarray(0, 2).toString('ascii') !== 'MZ') throw new Error(`不是 PE 文件（缺少 MZ）: ${file}`);
    const peOffset = dos.readUInt32LE(0x3c);
    const coff = readAt(fd, peOffset, 24);
    if (coff.subarray(0, 4).toString('ascii') !== 'PE\0\0') throw new Error(`不是 PE 文件（缺少 PE 签名）: ${file}`);
    const machine = coff.readUInt16LE(4);
    const numberOfSections = coff.readUInt16LE(6);
    const sizeOfOptionalHeader = coff.readUInt16LE(20);
    const optional = readAt(fd, peOffset + 24, Math.max(0x48, sizeOfOptionalHeader));
    const magic = optional.readUInt16LE(0);
    if (magic !== 0x10b && magic !== 0x20b) throw new Error(`未知 PE Optional Header Magic: 0x${magic.toString(16)}`);
    const subsystem = optional.readUInt16LE(0x44);
    return {
      machine,
      numberOfSections,
      magic,
      is64: magic === 0x20b,
      subsystem,
      subsystemLabel: subsystem === 2 ? 'WINDOWS_GUI' : subsystem === 3 ? 'WINDOWS_CUI' : 'OTHER',
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function isGuiSubsystem(file: string): boolean {
  return readPeInfo(file).subsystem === 2;
}

export function isConsoleSubsystem(file: string): boolean {
  return readPeInfo(file).subsystem === 3;
}

export interface WindowInfo {
  exists: boolean;
  pid: number;
  mainWindowTitle: string;
  mainWindowHandle: number;
}

/** 通过 PowerShell 读取进程主窗口标题/句柄（Get-Process 对 GUI 进程可用）。 */
export function getMainWindowInfo(pid: number): WindowInfo {
  const script = [
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    "if ($p) { $p | Select-Object Id,MainWindowTitle,MainWindowHandle | ConvertTo-Json -Compress } else { 'null' }",
  ].join('; ');
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  const text = (res.stdout ?? '').trim();
  if (!text || text === 'null') return { exists: false, pid, mainWindowTitle: '', mainWindowHandle: 0 };
  try {
    const parsed = JSON.parse(text) as { Id?: number; MainWindowTitle?: string; MainWindowHandle?: number };
    return {
      exists: true,
      pid: parsed.Id ?? pid,
      mainWindowTitle: parsed.MainWindowTitle ?? '',
      mainWindowHandle: Number(parsed.MainWindowHandle ?? 0),
    };
  } catch {
    return { exists: false, pid, mainWindowTitle: '', mainWindowHandle: 0 };
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询直到 GUI 进程出现非空 MainWindowTitle。返回首次观测到的窗口信息。 */
export async function waitForMainWindow(pid: number, timeoutMs = 20_000, intervalMs = 100): Promise<WindowInfo> {
  const deadline = Date.now() + timeoutMs;
  let last: WindowInfo = { exists: false, pid, mainWindowTitle: '', mainWindowHandle: 0 };
  while (Date.now() < deadline) {
    last = getMainWindowInfo(pid);
    if (last.exists && last.mainWindowTitle.trim().length > 0) return last;
    await sleep(intervalMs);
  }
  throw new Error(`等待 GUI 主窗口超时（pid=${pid}, 最后状态=${JSON.stringify(last)}）`);
}

export interface VisibleRun {
  child: ChildProcess;
  pid: number;
  stdout: () => string;
  stderr: () => string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** spawn 可见窗口进程（windowsHide=false），同时捕获 stdout/stderr（GUI 子系统在管道下仍可输出）。 */
export function spawnVisible(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): VisibleRun {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: null }));
  });
  return { child, pid: child.pid ?? -1, stdout: () => out, stderr: () => err, exit };
}

/** 等待文件出现且为合法 JSON；返回解析结果与原始文本。 */
export async function waitForJsonFile(file: string, timeoutMs = 60_000, intervalMs = 150): Promise<{ json: Record<string, unknown>; raw: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const json = JSON.parse(raw) as Record<string, unknown>;
      return { json, raw };
    } catch (error) {
      lastError = (error as Error).message;
      await sleep(intervalMs);
    }
  }
  throw new Error(`等待结果 JSON 超时: ${file}（${lastError}）`);
}

/** 读取 PE 版本信息（ASCII 字段，用于程序集 1.8.0.0 断言）。 */
export function readExeVersionInfo(exe: string): Record<string, string> {
  const script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $v=(Get-Item '${exe.replace(/'/g, "''")}').VersionInfo; ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ fileVersion=$v.FileVersion; productVersion=$v.ProductVersion; productName=$v.ProductName; companyName=$v.CompanyName; fileDescription=$v.FileDescription })`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const parsed = JSON.parse((res.stdout ?? '{}').trim() || '{}') as Record<string, unknown>;
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    output[key] = typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim();
  }
  return output;
}

export interface TopLevelWindow {
  handle: number;
  pid: number;
  className: string;
  title: string;
  visible: boolean;
}

/** 用 Win32 EnumWindows 枚举全部顶层窗口（含 #32770 消息框；Get-Process MainWindowTitle 会漏掉对话框）。 */
export function listTopLevelWindows(): TopLevelWindow[] {
  const script = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
    '$src = @"',
    'using System;',
    'using System.Text;',
    'using System.Collections.Generic;',
    'using System.Runtime.InteropServices;',
    'public class WinTopList {',
    '  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int n);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  public static List<string> List() {',
    '    var r = new List<string>();',
    '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
    '      var sb = new StringBuilder(1024); GetWindowText(h, sb, 1024);',
    '      var cn = new StringBuilder(256); GetClassName(h, cn, 256);',
    '      uint pid; GetWindowThreadProcessId(h, out pid);',
    '      var visible = IsWindowVisible(h) ? "1" : "0";',
    '      r.Add(pid + "\\u001f" + cn + "\\u001f" + visible + "\\u001f" + h.ToInt64() + "\\u001f" + sb);',
    '      return true;',
    '    }, IntPtr.Zero);',
    '    return r;',
    '  }',
    '}',
    '"@',
    'Add-Type -TypeDefinition $src | Out-Null',
    '[WinTopList]::List() | ConvertTo-Json -Compress',
  ].join('\n');
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const text = (res.stdout ?? '').trim();
  if (!text || text === 'null') return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const output: TopLevelWindow[] = [];
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const parts = item.split('\u001f');
      if (parts.length < 5) continue;
      const pid = Number(parts[0]);
      const handle = Number(parts[3]);
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(handle)) continue;
      output.push({ pid, className: parts[1] ?? '', visible: parts[2] === '1', handle, title: parts.slice(4).join('\u001f') });
    }
    return output;
  } catch {
    return [];
  }
}

/** 等待标题匹配的顶层窗口出现；返回窗口（含 pid/handle/title/class）。 */
export async function waitForTopLevelWindow(
  titlePattern: RegExp,
  timeoutMs = 45_000,
  intervalMs = 150,
  opts: { visibleOnly?: boolean } = {},
): Promise<TopLevelWindow> {
  const deadline = Date.now() + timeoutMs;
  let lastTitles: string[] = [];
  while (Date.now() < deadline) {
    const windows = listTopLevelWindows().filter((window) => titlePattern.test(window.title) && (!opts.visibleOnly || window.visible));
    if (windows.length > 0) {
      // 优先有标题的可见 TWizardForm/#32770
      const preferred = windows.find((window) => window.title.trim().length > 0 && window.visible) ?? windows[0];
      return preferred;
    }
    lastTitles = listTopLevelWindows().filter((w) => w.visible && w.title).map((w) => `${w.pid}:${w.title}`).slice(0, 20);
    await sleep(intervalMs);
  }
  throw new Error(`等待顶层窗口超时（pattern=${titlePattern}, 当前可见窗口: ${lastTitles.join(' | ')}）`);
}

export interface ChildWindow {
  handle: number;
  className: string;
  text: string;
}

/** 枚举某窗口的可见子窗口（按钮/编辑框等），并可用 BM_CLICK 点击。 */
export function childWindows(parentHandle: number): ChildWindow[] {
  const script = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
    '$src = @"',
    'using System;',
    'using System.Text;',
    'using System.Collections.Generic;',
    'using System.Runtime.InteropServices;',
    'public class WinChildList {',
    '  public delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);',
    '  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumChildProc cb, IntPtr lp);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int n);',
    '  public static List<string> List(IntPtr parent) {',
    '    var r = new List<string>();',
    '    EnumChildWindows(parent, delegate(IntPtr h, IntPtr l) {',
    '      var sb = new StringBuilder(1024); GetWindowText(h, sb, 1024);',
    '      var cn = new StringBuilder(256); GetClassName(h, cn, 256);',
    '      r.Add(cn + "\\u001f" + h.ToInt64() + "\\u001f" + sb);',
    '      return true;',
    '    }, IntPtr.Zero);',
    '    return r;',
    '  }',
    '}',
    '"@',
    'Add-Type -TypeDefinition $src | Out-Null',
    `[WinChildList]::List([IntPtr]${parentHandle}) | ConvertTo-Json -Compress`,
  ].join('\n');
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const text = (res.stdout ?? '').trim();
  if (!text || text === 'null') return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const output: ChildWindow[] = [];
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const parts = item.split('\u001f');
      if (parts.length < 3) continue;
      const handle = Number(parts[1]);
      if (!Number.isFinite(handle)) continue;
      output.push({ className: parts[0] ?? '', handle, text: parts.slice(2).join('\u001f') });
    }
    return output;
  } catch {
    return [];
  }
}

/** 点击子窗口按钮（BM_CLICK）；返回被点击按钮文本，未找到返回 undefined。 */
export function clickChildWindow(parentHandle: number, buttonPattern: RegExp): string | undefined {
  const children = childWindows(parentHandle);
  const target = children.find((child) => buttonPattern.test(child.text));
  if (!target) return undefined;
  const script = [
    '$src = @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class WinClick {',
    '  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);',
    '  public static void Click(IntPtr h) { SendMessage(h, 0x00F5, IntPtr.Zero, IntPtr.Zero); }',
    '}',
    '"@',
    'Add-Type -TypeDefinition $src | Out-Null',
    `[WinClick]::Click([IntPtr]${target.handle})`,
  ].join('\n');
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  return target.text;
}

/**
 * Inno 关闭向导后的“退出安装程序”确认框（#32770）：点击“是/Yes/退出”，返回确认框标题。
 * 若按钮文本不可得，则向对话框发送 WM_COMMAND IDYES。
 */
export async function answerInnoExitDialog(timeoutMs = 20_000): Promise<string> {
  const dialog = await waitForTopLevelWindow(/退出安装程序|Exit Setup|确定要退出/i, timeoutMs, 150, { visibleOnly: true });
  const clicked = clickChildWindow(dialog.handle, /^(是|Yes|退出|确定)/i);
  if (!clicked) {
    const script = [
      '$src = @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class WinCmd {',
      '  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);',
      '  public static void Yes(IntPtr h) { SendMessage(h, 0x0111, new IntPtr(6), IntPtr.Zero); }',
      '}',
      '"@',
      'Add-Type -TypeDefinition $src | Out-Null',
      `[WinCmd]::Yes([IntPtr]${dialog.handle})`,
    ].join('\n');
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  }
  return dialog.title;
}

// ===========================================================================
// R4 Inno Setup：staging（workspace 外）/ 子进程窗口定位 / UIA 文案 / 截图 / 优雅关闭
// ===========================================================================

/** 创建 workspace 外 staging 目录（Inno 在 DSH 沙箱 Low IL 下需要；%TEMP%\zhiying-test-*）。 */
export function createStagingDir(label = 'zhiying-test'): string {
  const base = os.tmpdir();
  const dir = path.join(base, `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  registerOwnedTestRoot(dir);
  return dir;
}

/** 把 exe 复制到 staging 目录（保留原文件名），返回 staging 后路径。 */
export function stageExecutable(source: string, stagingDir?: string): { dir: string; exe: string } {
  if (!fs.existsSync(source)) throw new Error(`staging 源文件不存在: ${source}`);
  const dir = stagingDir ?? createStagingDir();
  const exe = path.join(dir, path.basename(source));
  fs.copyFileSync(source, exe);
  return { dir, exe };
}

/** 递归删除 staging 目录（Windows 文件锁重试）。 */
export function removeStagingDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* 尽力而为 */
  }
}

export interface ProcessEntry {
  pid: number;
  parentPid: number;
  name: string;
  commandLine: string;
}

/** 读取全部进程（pid/parent/name/commandLine），供子进程窗口定位。 */
export function listProcesses(): ProcessEntry[] {
  const script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const text = (res.stdout ?? '').trim();
  if (!text || text === 'null') return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        pid: Number(item.ProcessId ?? 0),
        parentPid: Number(item.ParentProcessId ?? 0),
        name: String(item.Name ?? ''),
        commandLine: String(item.CommandLine ?? ''),
      }))
      .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);
  } catch {
    return [];
  }
}

/** 返回 rootPid 的所有子孙进程（不含自身）。 */
export function getDescendantProcesses(rootPid: number): ProcessEntry[] {
  const all = listProcesses();
  const childrenByParent = new Map<number, ProcessEntry[]>();
  for (const entry of all) {
    const list = childrenByParent.get(entry.parentPid) ?? [];
    list.push(entry);
    childrenByParent.set(entry.parentPid, list);
  }
  const result: ProcessEntry[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of childrenByParent.get(current) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      result.push(child);
      queue.push(child.pid);
    }
  }
  return result;
}

export interface WindowMatch {
  pid: number;
  processName: string;
  title: string;
  handle: number;
}

/** 枚举所有有非空 MainWindowTitle 的进程窗口（可按标题正则过滤）。 */
export function findWindows(pattern?: RegExp): WindowMatch[] {
  const script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Length -gt 0 } | Select-Object Id,ProcessName,MainWindowTitle,MainWindowHandle | ConvertTo-Json -Compress`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  const text = (res.stdout ?? '').trim();
  if (!text || text === 'null') return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        pid: Number(item.Id ?? 0),
        processName: String(item.ProcessName ?? ''),
        title: String(item.MainWindowTitle ?? ''),
        handle: Number(item.MainWindowHandle ?? 0),
      }))
      .filter((entry) => entry.pid > 0 && entry.title.length > 0 && (!pattern || pattern.test(entry.title)));
  } catch {
    return [];
  }
}

/** Inno 向导窗口属于 `setup-*.tmp`/`is-*.tmp` 子进程：在 rootPid 子树内按标题轮询。 */
export async function waitForChildWindow(
  rootPid: number,
  titlePattern: RegExp,
  timeoutMs = 45_000,
  intervalMs = 150,
): Promise<WindowMatch> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const windows = listTopLevelWindows().filter((window) => window.visible && titlePattern.test(window.title));
    if (windows.length > 0) {
      const descendants = new Set(getDescendantProcesses(rootPid).map((entry) => entry.pid));
      const owned = windows.find((window) => window.pid === rootPid || descendants.has(window.pid));
      const picked = owned ?? windows[0];
      return { pid: picked.pid, processName: '', title: picked.title, handle: picked.handle };
    }
    // 兼容 Get-Process MainWindowTitle 路径（少数窗口不在 EnumWindows 中）
    const legacy = findWindows(titlePattern);
    if (legacy.length > 0) return legacy[0];
    const alive = listProcesses().some((entry) => entry.pid === rootPid);
    last = alive ? `${listProcesses().length} processes` : 'root process 已退出';
    if (!alive) break;
    await sleep(intervalMs);
  }
  throw new Error(`等待安装向导窗口超时（rootPid=${rootPid}, title=${titlePattern}, ${last}）`);
}

/** 通过 Win32 EnumChildWindows 枚举窗口控件文本（按钮/编辑框等；VCL 非窗口化标签可能不可见）。 */
export function enumerateWindowTexts(handle: number): string[] {
  if (!handle) return [];
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
    '$src = @"',
    'using System;',
    'using System.Collections.Generic;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public class WinEnum {',
    '  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
    '  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);',
    '  public static List<string> Texts(IntPtr root) {',
    '    var result = new List<string>();',
    '    var sb = new StringBuilder(2048);',
    '    EnumChildWindows(root, delegate(IntPtr h, IntPtr l) {',
    '      GetWindowText(h, sb, sb.Capacity);',
    '      var t = sb.ToString();',
    '      if (t.Length > 0) result.Add(t);',
    '      return true;',
    '    }, IntPtr.Zero);',
    '    return result;',
    '  }',
    '}',
    '"@',
    'Add-Type -TypeDefinition $src | Out-Null',
    `[WinEnum]::Texts([IntPtr]${handle}) | ConvertTo-Json -Compress`,
  ].join('\n');
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const text = (res.stdout ?? '').trim();
  if (!text || text === 'null') return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.map((value) => String(value)).filter((value) => value.length > 0);
    return [String(parsed)];
  } catch {
    return [];
  }
}

/** 通过 UI Automation 枚举控件 Name（对标准按钮/编辑框/部分 VCL 控件有效；失败返回空）。 */
export function enumerateWindowVisibleTexts(handle: number): string[] {
  if (!handle) return [];
  const script = [
    'Add-Type -AssemblyName UIAutomationClient | Out-Null',
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
    'Add-Type -AssemblyName UIAutomationTypes | Out-Null',
    `$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${handle})`,
    'if ($null -eq $root) { "null" } else {',
    '  $items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)',
    '  $names = @(); foreach ($item in $items) { try { $n = $item.Current.Name; if ($n) { $names += $n } } catch {} }',
    '  ConvertTo-Json -Compress -InputObject @($names)',
    '}',
  ].join('\n');
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const text = (res.stdout ?? '').trim();
  if (!text || text === 'null') return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.map((value) => String(value)).filter((value) => value.trim().length > 0);
    return [String(parsed)];
  } catch {
    return [];
  }
}

/** 截图指定窗口到 PNG（PrintWindow + PW_RENDERFULLCONTENT；用于 GUI 向导证据）。 */
export function captureWindowScreenshot(handle: number, outPng: string): void {
  if (!handle) throw new Error('窗口 handle 为 0，无法截图');
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  const script = [
    'Add-Type -AssemblyName System.Drawing | Out-Null',
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
    '$src = @"',
    'using System;',
    'using System.Drawing;',
    'using System.Drawing.Imaging;',
    'using System.Runtime.InteropServices;',
    'public class WinCap {',
    '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);',
    '  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);',
    '  public static void Capture(IntPtr hWnd, string file) {',
    '    RECT rect; if (!GetWindowRect(hWnd, out rect)) throw new Exception("GetWindowRect failed");',
    '    int width = rect.Right - rect.Left; int height = rect.Bottom - rect.Top;',
    '    if (width <= 0 || height <= 0) throw new Exception("invalid window size");',
    '    using (var bitmap = new Bitmap(width, height)) {',
    '      using (var graphics = Graphics.FromImage(bitmap)) {',
    '        IntPtr hdc = graphics.GetHdc();',
    '        try { PrintWindow(hWnd, hdc, 2); } finally { graphics.ReleaseHdc(hdc); }',
    '      }',
    '      bitmap.Save(file, ImageFormat.Png);',
    '    }',
    '  }',
    '}',
    '"@',
    'Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing | Out-Null',
    `[WinCap]::Capture([IntPtr]${handle}, '${outPng.replace(/'/g, "''")}')`,
  ].join('\n');
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if ((res.status ?? 1) !== 0) throw new Error(`窗口截图失败: ${(res.stderr ?? '').slice(-800)}`);
  if (!fs.existsSync(outPng) || fs.statSync(outPng).size < 1024) throw new Error(`窗口截图文件异常: ${outPng}`);
}

/** 优雅关闭 GUI 主窗口（WM_CLOSE）；返回是否成功发出。 */
export function closeMainWindow(pid: number): boolean {
  const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.CloseMainWindow() } else { $false }`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  return /true/i.test((res.stdout ?? '').trim());
}

/** 等待进程退出（指定超时返回 null）。 */
export async function waitProcessExit(pid: number, timeoutMs = 60_000, intervalMs = 150): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await sleep(intervalMs);
  }
  return false;
}

