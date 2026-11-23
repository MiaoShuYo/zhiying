/**
 * R4 Inno Setup 6 安装/卸载测试助手（真实 exe，不 mock）。
 * 关键环境约束（契约 §8.6 #11）：DSH 沙箱中 workspace 内新 exe 为 Low IL，Inno 初始化 exit 1；
 * 必须先把 Setup.exe / unins000.exe 复制到 workspace 外 staging（%TEMP%\zhiying-test-*）再执行。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createStagingDir, stageExecutable, removeStagingDir, spawnVisible, waitForChildWindow, listProcesses } from './gui';
import { commandLineUsesOwnedPath, isOwnedTestPath } from './temp';
import { spawnCollect, waitExit, killTree } from './processes';
import { listUninstallEntries, deleteUninstallEntry } from './registry';

export { createStagingDir, stageExecutable, removeStagingDir, spawnVisible, waitForChildWindow };

export const DEFAULT_ISCC_PATH = process.env.ISCC_PATH ?? path.join(process.env.LOCALAPPDATA ?? 'C:\\Users\\Administrator\\AppData\\Local', 'Programs', 'Inno Setup 6', 'ISCC.exe');

export interface InnoReleaseInfo {
  version?: string;
  profile?: string;
  installer?: string;
  innoVersion?: string;
  setup?: { sha256?: string; sizeBytes?: number };
  components?: unknown;
  assemblyVersion?: string;
}

export function readInnoReleaseInfo(distDir: string): InnoReleaseInfo | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(distDir, 'release-info.json'), 'utf8')) as InnoReleaseInfo;
  } catch {
    return undefined;
  }
}

export function innoArtifactReady(setupExe: string, distDir: string): { ready: boolean; reason: string } {
  if (!fs.existsSync(setupExe)) return { ready: false, reason: `缺少 ${setupExe}` };
  const info = readInnoReleaseInfo(distDir);
  if (info?.installer !== 'inno-setup') return { ready: false, reason: `release-info.installer=${String(info?.installer)}，尚未 rebuild 为 inno-setup` };
  return { ready: true, reason: '' };
}

/** stage Setup.exe 到 workspace 外；返回 staging 目录与 exe。 */
export function stageInnoSetup(setupExe: string): { dir: string; exe: string } {
  return stageExecutable(setupExe);
}

/** 从安装根 stage 卸载器（unins000.exe + unins000.dat 等）到 workspace 外。 */
export function stageInnoUninstaller(installRoot: string): { dir: string; exe: string } {
  const files = fs.readdirSync(installRoot).filter((name) => /^unins\d+\./i.test(name));
  const exeName = files.find((name) => /\.exe$/i.test(name));
  if (!exeName) throw new Error(`安装根缺少 unins000.exe: ${installRoot}`);
  const dir = createStagingDir('zhiying-test-unins');
  for (const name of files) fs.copyFileSync(path.join(installRoot, name), path.join(dir, name));
  return { dir, exe: path.join(dir, exeName) };
}

export interface InnoSilentOptions {
  model?: 'now' | 'later';
  tasks?: string;
  dir?: string;
  logFile?: string;
  extra?: string[];
}

/** 标准 Inno 静默安装参数（契约 §2.7）。 */
export function innoSilentArgs(options: InnoSilentOptions = {}): string[] {
  const args = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'];
  if (options.dir) args.push(`/DIR=${options.dir}`);
  args.push(`/TASKS=${options.tasks ?? ''}`);
  if (options.model) args.push(`/MODELDOWNLOAD=${options.model}`);
  if (options.logFile) args.push(`/LOG=${options.logFile}`);
  for (const item of options.extra ?? []) args.push(item);
  return args;
}

export interface InnoRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export async function runStagedInno(exe: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<InnoRunResult> {
  const captured = spawnCollect(exe, args, { cwd: opts.cwd ?? path.dirname(exe), env: opts.env ?? process.env });
  const exit = await waitExit(captured.child, opts.timeoutMs ?? 300_000);
  if (!exit) {
    killTree(captured.pid);
    return { code: null, stdout: captured.stdout(), stderr: `${captured.stderr()}\n[timeout]` };
  }
  return { code: exit.code, stdout: captured.stdout(), stderr: captured.stderr() };
}

export interface InnoInstallResult extends InnoRunResult {
  logFile: string;
  target: string;
}

/** staging Setup.exe → /VERYSILENT 安装到 target（默认中文+空格临时目录由调用方提供）。 */
export async function installWithInno(
  stagedExe: string,
  target: string,
  opts: InnoSilentOptions & { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {},
): Promise<InnoInstallResult> {
  const logDir = opts.logFile ? path.dirname(opts.logFile) : path.join(path.dirname(stagedExe), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = opts.logFile ?? path.join(logDir, `inno-${Date.now()}.log`);
  const args = innoSilentArgs({ ...opts, dir: target, logFile });
  const result = await runStagedInno(stagedExe, args, { cwd: opts.cwd ?? path.dirname(stagedExe), env: opts.env, timeoutMs: opts.timeoutMs });
  return { ...result, logFile, target };
}

/** 标准卸载：staged unins000.exe /VERYSILENT [/PURGEDATA]。 */
export async function uninstallWithInno(
  installRoot: string,
  opts: { purgeData?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<InnoRunResult & { stagingDir: string }> {
  const uninstaller = stageInnoUninstaller(installRoot);
  try {
    const args = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ...(opts.purgeData ? ['/PURGEDATA'] : [])];
    const result = await runStagedInno(uninstaller.exe, args, { cwd: uninstaller.dir, env: opts.env ?? process.env, timeoutMs: opts.timeoutMs });
    return { ...result, stagingDir: uninstaller.dir };
  } finally {
    // 不立即删：uninstaller 可能仍在退出清理；由调用方/清理钩子删除
  }
}

/** 默认 per-user 安装根。 */
export function defaultPerUserInstallRoot(): string {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Programs', 'Zhiying');
}

/**
 * 卸载项基线：本进程第一次清理时记录已有的卸载键。之后只删除本次运行新建的键，
 * 已有的键（包括用户真实安装、其他软件、其他测试进程留下的键）一律保留（#131）。
 */
let baselineUninstallKeys: Set<string> | undefined;

function uninstallBaseline(): Set<string> {
  if (!baselineUninstallKeys) baselineUninstallKeys = new Set(listUninstallEntries().map((entry) => entry.key.toLowerCase()));
  return baselineUninstallKeys;
}

/**
 * 测试隔离清理（Lead 协调要求，避免与 acceptor/impl 并发冲突）：
 * - 结束本次运行启动的 Inno Setup 进程：命令行必须指向本进程创建的 staging/临时目录（#132）。
 *   不再按进程名判断，用户从“下载”目录打开的 Zhiying-Setup.exe、其他测试进程的安装器都不受影响。
 * - 删除本次运行新建、且 InstallLocation 位于本进程测试目录内的 HKCU 卸载项（#131）。
 * - 删除指向本进程测试目录的桌面/开始菜单快捷方式。
 */
export async function cleanupInnoTestState(): Promise<{ killedPids: number[]; removedRegistryKeys: string[]; removedShortcuts: string[] }> {
  const baseline = uninstallBaseline();
  const killedPids: number[] = [];
  for (const entry of listProcesses()) {
    if (entry.pid === process.pid) continue;
    const name = entry.name.toLowerCase();
    const cmd = entry.commandLine.toLowerCase();
    const isSetupProcess = /^zhiying-setup(\.exe|\.tmp)?$/.test(name) || (name.endsWith('.tmp') && cmd.includes('zhiying-setup'));
    // Inno 的 is-*.tmp 子进程通过 /SL5="...,<原 Setup.exe 路径>" 携带 staging 路径，因此同样能被识别。
    if (isSetupProcess && commandLineUsesOwnedPath(entry.commandLine)) {
      killTree(entry.pid);
      killedPids.push(entry.pid);
    }
  }
  const matchesTestPath = (value: string | undefined): boolean => isOwnedTestPath(value);
  const removedRegistryKeys: string[] = [];
  for (const entry of listUninstallEntries()) {
    if (baseline.has(entry.key.toLowerCase())) continue;
    const location = entry.values.InstallLocation?.value;
    if (matchesTestPath(location)) {
      try {
        deleteUninstallEntry(entry.key);
        removedRegistryKeys.push(entry.key);
      } catch {
        /* ignore */
      }
    }
  }
  const removedShortcuts: string[] = [];
  const readTarget = (lnk: string): string => {
    const script = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}'); [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $s.TargetPath`;
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    return (res.stdout ?? '').trim();
  };
  const candidates: string[] = [];
  const desktop = path.join(process.env.USERPROFILE ?? os.homedir(), 'Desktop');
  if (fs.existsSync(desktop)) {
    for (const name of fs.readdirSync(desktop)) {
      if (/知影|zhiying/i.test(name) && name.toLowerCase().endsWith('.lnk')) candidates.push(path.join(desktop, name));
    }
  }
  const startMenu = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/知影|zhiying/i.test(entry.name) && entry.name.toLowerCase().endsWith('.lnk')) candidates.push(full);
    }
  };
  walk(startMenu);
  for (const lnk of candidates) {
    const target = readTarget(lnk);
    if (target && matchesTestPath(target)) {
      try {
        fs.rmSync(lnk, { force: true });
        removedShortcuts.push(lnk);
      } catch {
        /* ignore */
      }
    }
  }
  return { killedPids, removedRegistryKeys, removedShortcuts };
}
