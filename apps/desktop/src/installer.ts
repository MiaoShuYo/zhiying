import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULT_PORTS,
  formatTimestamp,
  loadInstallConfig,
  resolveInstallLayout,
  validateInstallConfig,
  writeInstallConfig,
  writeJsonAtomic,
} from './install-layout.js';
import type { InstallConfig, InstallLayout, PayloadProfile } from './install-layout.js';
import {
  assertNoReparseEscape,
  getDiskFreeBytes,
  probeWritableDirectory,
  validateInstallPath,
} from './model-paths.js';
import { loadModelManifest } from './model-manifest.js';

/**
 * #103 Windows 安装器（per-user，控制台向导由 setup-cli/native 承担）。
 *
 * 关键保证：先复制到 `<root>\\.staging-<ts>` 再原子移动；升级保留 models/data/logs/config；
 * 失败回滚不留下半安装；不执行 pnpm/uv/git，不联网（“立即下载”由模型管理器另行联网）。
 */

const execFileAsync = promisify(execFile);
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zhiying';
const PAYLOAD_SKIP_ENTRIES = new Set(['models', 'data', 'logs', 'config']);

export function defaultPerUserInstallRoot(env: NodeJS.ProcessEnv = process.env): string {
  const localAppData = env.LOCALAPPDATA?.trim() || join(env.USERPROFILE?.trim() || homedir(), 'AppData', 'Local');
  return join(localAppData, 'Programs', 'Zhiying');
}

export interface InstallTargetValidation {
  ok: boolean;
  targetRoot?: string;
  errors: string[];
  warnings: string[];
  existing?: { version: string; canUpgrade: boolean };
}

function parseVersion(version: string): number[] {
  return version
    .split(/[.-]/)
    .slice(0, 3)
    .map(part => {
      const match = part.match(/^\d+/);
      return match ? Number(match[0]) : 0;
    });
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** 校验安装目标（默认 per-user 目录；拒绝受保护目录、非法路径、不可写目录）。 */
export async function validateInstallTarget(
  raw: string | undefined,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<InstallTargetValidation> {
  const env = opts.env ?? process.env;
  const input = typeof raw === 'string' ? raw.trim() : '';
  const target = !input || input.toLowerCase() === 'default' ? defaultPerUserInstallRoot(env) : input;
  const validation = await validateInstallPath(target, { requireWritable: true, allowExisting: true });
  const errors = [...validation.errors];
  const warnings = [...validation.warnings];
  let existing: InstallTargetValidation['existing'];
  if (errors.length === 0) {
    try {
      const config = await loadInstallConfig(target);
      existing = { version: config.version, canUpgrade: true };
      warnings.push(`检测到已安装的知影 ${config.version}，本次安装将进入升级/修复模式，并保留 models、data、logs、config。`);
    } catch {
      /* 未安装或配置损坏：按全新安装处理。 */
    }
  }
  const result: InstallTargetValidation = {
    ok: errors.length === 0,
    errors,
    warnings,
  };
  if (validation.normalized) result.targetRoot = validation.normalized;
  if (existing) result.existing = existing;
  return result;
}

export interface InstallPlan {
  targetRoot: string;
  payloadRoot: string;
  version: string;
  profile: PayloadProfile;
  createShortcut: boolean;
  writeRegistry: boolean;
  downloadModels: 'now' | 'later';
  upgrade: boolean;
  preservePaths: string[];
  steps: string[];
}

/** 递归统计目录/文件字节数（不跟随 reparse point，避免重复/越界）。 */
export async function computeDirectoryBytes(target: string): Promise<number> {
  let total = 0;
  let stats;
  try {
    stats = await stat(target);
  } catch {
    return 0;
  }
  if (stats.isFile()) return stats.size;
  if (!stats.isDirectory()) return 0;
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    total += await computeDirectoryBytes(join(target, entry.name));
  }
  return total;
}

function bytesLabel(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${Math.round(gb * 10) / 10} GB`;
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${Math.round(mb * 10) / 10} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 生成安装计划；参数/路径/磁盘不足时抛出可读中文错误（安装器 exit 3 语义）。 */
export async function planInstall(input: {
  payloadRoot: string;
  targetRoot?: string;
  version: string;
  profile: PayloadProfile;
  createShortcut?: boolean;
  writeRegistry?: boolean;
  downloadModels?: 'now' | 'later';
  env?: NodeJS.ProcessEnv;
  /** 测试注入（向后兼容）：磁盘剩余空间探测与时钟。默认使用真实磁盘与系统时间。 */
  deps?: { diskFreeBytes?: (dir: string) => Promise<number>; now?: () => number };
}): Promise<InstallPlan> {
  const payloadRoot = resolve(input.payloadRoot);
  if (!existsSync(payloadRoot)) throw new Error(`安装包目录不存在：${payloadRoot}`);
  const launchFiles = ['Zhiying.exe', 'app', 'runtime'];
  for (const name of launchFiles) {
    if (!existsSync(join(payloadRoot, name))) {
      throw new Error(`安装包不完整：缺少 ${name}（${payloadRoot}）。请重新构建或重新下载安装包。`);
    }
  }
  const validation = await validateInstallTarget(input.targetRoot, { env: input.env });
  if (!validation.ok || !validation.targetRoot) {
    throw new Error(`安装目录不可用：\n- ${validation.errors.join('\n- ')}`);
  }
  const targetRoot = validation.targetRoot;
  const payloadBytes = await computeDirectoryBytes(payloadRoot);
  const diskFree = input.deps?.diskFreeBytes ?? getDiskFreeBytes;
  const freeBytes = await diskFree(existsSync(targetRoot) ? targetRoot : dirname(targetRoot));
  const requiredBytes = payloadBytes + Math.max(payloadBytes * 0.1, 64 * 1024 * 1024);
  if (freeBytes > 0 && freeBytes < requiredBytes) {
    throw new Error(
      `磁盘空间不足：安装需要约 ${bytesLabel(requiredBytes)}（含临时空间余量），目标磁盘可用 ${bytesLabel(freeBytes)}。请清理磁盘或更换安装目录后重试。`,
    );
  }
  const upgrade = Boolean(validation.existing);
  const steps: string[] = ['校验安装目录与磁盘空间', '复制程序文件到临时目录'];
  if (upgrade) steps.push('备份并替换程序文件（保留 models/data/logs/config）');
  else steps.push('移动程序文件到安装目录');
  steps.push('创建 models/data/config/logs 目录结构');
  steps.push('写入 config/install.json');
  steps.push('写入模型清单模板');
  if (input.createShortcut ?? true) steps.push('创建桌面快捷方式');
  if (input.writeRegistry ?? true) steps.push('写入当前用户卸载注册表项');
  steps.push('写入安装日志');
  return {
    targetRoot,
    payloadRoot,
    version: input.version,
    profile: input.profile,
    createShortcut: input.createShortcut ?? true,
    writeRegistry: input.writeRegistry ?? true,
    downloadModels: input.downloadModels ?? 'later',
    upgrade,
    preservePaths: upgrade ? ['models', 'data', 'logs', 'config'] : [],
    steps,
  };
}

export interface InstallResult {
  ok: boolean;
  plan: InstallPlan;
  logPath: string;
  errors: string[];
  warnings: string[];
  launchModelManager: boolean;
}

export interface InstallerDeps {
  copyTree?: (from: string, to: string) => Promise<void>;
  removeTree?: (path: string) => Promise<void>;
  createShortcut?: (plan: InstallPlan) => Promise<void>;
  writeRegistry?: (plan: InstallPlan) => Promise<void>;
  now?: () => number;
}

interface Logger {
  lines: string[];
  path: string;
  write: (line: string) => Promise<void>;
}

async function createLogger(installRoot: string, now: () => number): Promise<Logger> {
  const stamp = formatTimestamp(new Date(now()));
  const primary = join(installRoot, 'logs', `setup-${stamp}.log`);
  let logPath = primary;
  try {
    await mkdir(dirname(primary), { recursive: true });
    await writeFile(primary, '', 'utf8');
  } catch {
    const localAppData = process.env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local');
    logPath = join(localAppData, 'Zhiying', 'logs', `setup-${stamp}.log`);
    await mkdir(dirname(logPath), { recursive: true }).catch(() => undefined);
  }
  const lines: string[] = [];
  return {
    lines,
    path: logPath,
    write: async (line: string) => {
      const entry = `[${new Date(now()).toISOString()}] ${line}`;
      lines.push(entry);
      await appendFile(logPath, `${entry}\n`, 'utf8').catch(() => undefined);
    },
  };
}

async function defaultCopyTree(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true, force: true, errorOnExist: false, dereference: false });
}

async function defaultRemoveTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/**
 * Windows 上文件句柄释放/杀毒扫描可能造成短暂的 EPERM/EBUSY；
 * 对目录替换类 rename 做有限重试（总计约 3 秒），避免瞬时锁定导致安装/升级失败。
 */
export async function renameWithRetry(from: string, to: string, attempts = 6, delayMs = 500): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(code ?? '') || attempt === attempts - 1) throw error;
      await new Promise(resolvePromise => setTimeout(resolvePromise, delayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function resolveDesktopDirectory(): Promise<string> {
  // Windows Known Folder（支持 OneDrive/组策略重定向桌面），不能假设 %USERPROFILE%\Desktop。
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('Desktop')"],
      { windowsHide: true, timeout: 15_000, encoding: 'utf8' },
    );
    const resolved = stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .pop();
    if (resolved) return resolved;
  } catch {
    /* 回退到 USERPROFILE。 */
  }
  const profile = process.env.USERPROFILE?.trim();
  return profile ? join(profile, 'Desktop') : join(homedir(), 'Desktop');
}

/** 返回当前用户真实桌面目录（Known Folder，供安装/卸载/测试共用）。 */
export async function resolveDesktopPath(): Promise<string> {
  return resolveDesktopDirectory();
}

async function defaultCreateShortcut(plan: InstallPlan): Promise<void> {
  const desktop = await resolveDesktopDirectory();
  const shortcutPath = join(desktop, '知影.lnk');
  const target = join(plan.targetRoot, 'Zhiying.exe');
  const script = [
    '$shell = New-Object -ComObject WScript.Shell',
    `$shortcut = $shell.CreateShortcut(${powershellQuote(shortcutPath)})`,
    `$shortcut.TargetPath = ${powershellQuote(target)}`,
    `$shortcut.WorkingDirectory = ${powershellQuote(plan.targetRoot)}`,
    `$shortcut.Description = ${powershellQuote('知影 - 本地 AI 视频工作室')}`,
    `$shortcut.IconLocation = ${powershellQuote(`${target},0`)}`,
    '$shortcut.Save()',
  ].join('; ');
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000 });
}

async function defaultWriteRegistry(plan: InstallPlan): Promise<void> {
  const layout = resolveInstallLayout(plan.targetRoot);
  const nodeExe = resolve(layout.installRoot, 'runtime', 'node', 'node.exe');
  const maintenanceCli = join(layout.app, 'desktop', 'cli', 'maintenance-cli.mjs');
  const estimatedSizeKb = Math.max(1, Math.round((await computeDirectoryBytes(plan.targetRoot)) / 1024));
  const values: Array<[string, string]> = [
    ['DisplayName', '知影 Zhiying'],
    ['DisplayVersion', plan.version],
    ['Publisher', '知影 / Zhiying'],
    ['InstallLocation', plan.targetRoot],
    ['DisplayIcon', join(plan.targetRoot, 'Zhiying.exe')],
    ['UninstallString', `"${nodeExe}" "${maintenanceCli}" --install-root "${plan.targetRoot}" --uninstall --yes`],
    ['EstimatedSize', String(estimatedSizeKb)],
    ['NoModify', '1'],
    ['NoRepair', '1'],
  ];
  for (const [name, value] of values) {
    await execFileAsync('reg.exe', ['add', UNINSTALL_KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true, timeout: 20_000 });
  }
}

export async function removeRegistryEntry(): Promise<void> {
  await execFileAsync('reg.exe', ['delete', UNINSTALL_KEY, '/f'], { windowsHide: true, timeout: 20_000 });
}

export async function removeShortcut(): Promise<void> {
  const desktop = await resolveDesktopDirectory();
  const shortcutPath = join(desktop, '知影.lnk');
  await rm(shortcutPath, { force: true }).catch(() => undefined);
}

interface TemplateDefaults {
  runtime?: InstallConfig['runtime'];
  ports?: InstallConfig['ports'];
  managedProcesses?: InstallConfig['managedProcesses'];
  modelManifest?: string;
  version?: string;
  payloadProfile?: PayloadProfile;
}

async function readTemplateDefaults(payloadRoot: string): Promise<TemplateDefaults> {
  try {
    const raw = await readFile(join(payloadRoot, 'config', 'install.template.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const record = parsed as Record<string, unknown>;
    const defaults: TemplateDefaults = {};
    if (record.runtime && typeof record.runtime === 'object') defaults.runtime = record.runtime as InstallConfig['runtime'];
    if (record.ports && typeof record.ports === 'object') defaults.ports = record.ports as InstallConfig['ports'];
    if (record.managedProcesses && typeof record.managedProcesses === 'object') {
      defaults.managedProcesses = record.managedProcesses as InstallConfig['managedProcesses'];
    }
    if (typeof record.modelManifest === 'string' && record.modelManifest.trim()) defaults.modelManifest = record.modelManifest;
    if (typeof record.version === 'string' && record.version.trim()) defaults.version = record.version.trim();
    if (record.payloadProfile === 'lite' || record.payloadProfile === 'full') defaults.payloadProfile = record.payloadProfile;
    return defaults;
  } catch {
    return {};
  }
}

function buildInstallConfig(plan: InstallPlan, template: TemplateDefaults, existing: InstallConfig | undefined, now: () => number): InstallConfig {
  const installerDefaults: InstallConfig['runtime'] = {
    node: join('runtime', 'node', 'node.exe'),
    python: join('runtime', 'python', 'python.exe'),
    ffmpegDir: join('runtime', 'ffmpeg'),
    ollama: join('runtime', 'ollama', 'ollama.exe'),
  };
  const config: InstallConfig = {
    schemaVersion: 1,
    product: 'zhiying',
    version: plan.version,
    installRoot: plan.targetRoot,
    installedAt: existing?.installedAt ?? new Date(now()).toISOString(),
    perUser: existing?.perUser ?? true,
    payloadProfile: plan.profile,
    runtime: existing?.runtime ?? template.runtime ?? installerDefaults,
    ports: existing?.ports ?? template.ports ?? { ...DEFAULT_PORTS },
    managedProcesses: existing?.managedProcesses ?? template.managedProcesses ?? { ollama: true },
    modelManifest: existing?.modelManifest ?? template.modelManifest ?? join('models', '.downloads', 'manifest.json'),
    firstRunCompleted: false,
  };
  if (plan.downloadModels === 'now' || plan.downloadModels === 'later') config.modelsDownloadChoice = plan.downloadModels;
  if (existing) config.updatedAt = new Date(now()).toISOString();
  return config;
}

/**
 * 安装后收尾（#103 Inno Setup 路径）：Inno 已把 payload 复制到 `{app}`、创建快捷方式与卸载项，
 * 这里只负责写/校验 `config/install.json`、创建目录骨架、保留升级用户字段、记录程序/模型版本与安装日志。
 * 不复制程序文件、不创建快捷方式/注册表、不联网。
 */
export interface FinalizeInstallInput {
  installRoot: string;
  profile?: PayloadProfile;
  version?: string;
  downloadModels?: 'now' | 'later';
  logPath?: string;
  now?: () => number;
}

export interface FinalizeInstallResult {
  ok: boolean;
  installRoot: string;
  version: string;
  profile: PayloadProfile;
  upgrade: boolean;
  logPath: string;
  modelsDownloadChoice: 'now' | 'later';
  warnings: string[];
  errors: string[];
}

const FINALIZE_RUNTIME_DEFAULTS: InstallConfig['runtime'] = {
  node: join('runtime', 'node', 'node.exe'),
  python: join('runtime', 'python', 'python.exe'),
  ffmpegDir: join('runtime', 'ffmpeg'),
  ollama: join('runtime', 'ollama', 'ollama.exe'),
};

export async function finalizeInstall(input: FinalizeInstallInput): Promise<FinalizeInstallResult> {
  const now = input.now ?? Date.now;
  const warnings: string[] = [];
  const errors: string[] = [];
  let logPath = input.logPath ?? '';
  const logLines: string[] = [];
  const addLog = async (line: string): Promise<void> => {
    logLines.push(`[${new Date(now()).toISOString()}] ${line}`);
  };
  let layout: InstallLayout;
  try {
    layout = resolveInstallLayout(input.installRoot);
  } catch (error) {
    return {
      ok: false,
      installRoot: input.installRoot,
      version: input.version ?? '1.8.0',
      profile: input.profile ?? 'lite',
      upgrade: false,
      logPath,
      modelsDownloadChoice: input.downloadModels ?? 'later',
      warnings,
      errors: [(error as Error).message],
    };
  }
  const resultBase = {
    installRoot: layout.installRoot,
    version: input.version ?? '1.8.0',
    profile: input.profile ?? 'lite',
    upgrade: false,
    logPath,
    modelsDownloadChoice: input.downloadModels ?? 'later',
  };
  try {
    if (!logPath) logPath = join(layout.logs, `setup-${formatTimestamp(new Date(now()))}.log`);
    await mkdir(dirname(logPath), { recursive: true }).catch(() => undefined);
    await addLog(`安装后收尾开始：root=${layout.installRoot} profile=${input.profile ?? '（模板）'}`);

    // 目录骨架（Inno [Dirs] 已创建大部分，这里兜底并补 models 子目录）。
    const directories = [
      layout.modelsRoot,
      layout.modelsOllama,
      layout.modelsF5Tts,
      layout.modelsVocos,
      layout.modelsHuggingFace,
      join(layout.modelsHuggingFace, 'hub'),
      layout.downloads,
      layout.data,
      join(layout.data, 'tmp'),
      join(layout.data, 'runtime'),
      join(layout.data, 'backups'),
      layout.logs,
      layout.config,
    ];
    for (const directory of directories) await mkdir(directory, { recursive: true });
    await addLog('目录骨架已创建/校验');
    if (!(await probeWritableDirectory(layout.data))) {
      throw new Error(`数据目录不可写：${layout.data}。请改用当前用户可写目录重新安装。`);
    }
    if (!(await probeWritableDirectory(layout.modelsRoot))) {
      throw new Error(`模型目录不可写：${layout.modelsRoot}。请检查安装目录权限（不要使用 Program Files 等受保护目录）。`);
    }

    const template = await readTemplateDefaults(layout.installRoot);
    let existing: InstallConfig | undefined;
    try {
      existing = await loadInstallConfig(layout.installRoot);
    } catch {
      existing = undefined;
    }
    const version = input.version ?? template.version ?? existing?.version ?? '1.8.0';
    const profile: PayloadProfile = input.profile ?? template.payloadProfile ?? existing?.payloadProfile ?? 'lite';
    const downloadModels: 'now' | 'later' = input.downloadModels ?? existing?.modelsDownloadChoice ?? 'later';
    const config: InstallConfig = {
      schemaVersion: 1,
      product: 'zhiying',
      version,
      installRoot: layout.installRoot,
      installedAt: existing?.installedAt ?? new Date(now()).toISOString(),
      perUser: existing?.perUser ?? true,
      payloadProfile: profile,
      runtime: template.runtime ?? existing?.runtime ?? FINALIZE_RUNTIME_DEFAULTS,
      ports: existing?.ports ?? template.ports ?? { ...DEFAULT_PORTS },
      managedProcesses: existing?.managedProcesses ?? template.managedProcesses ?? { ollama: true },
      modelManifest: existing?.modelManifest ?? template.modelManifest ?? join('models', '.downloads', 'manifest.json'),
      modelsDownloadChoice: downloadModels,
      firstRunCompleted: false,
    };
    if (existing) config.updatedAt = new Date(now()).toISOString();
    const validation = validateInstallConfig(config);
    if (!validation.ok) throw new Error(`安装配置生成失败：${validation.errors.join('；')}`);
    await writeInstallConfig(validation.config);
    await addLog(`install.json 已写入：version=${version} profile=${profile} upgrade=${Boolean(existing)}`);

    // 模型清单模板（升级保留既有清单，避免覆盖用户已固定的 revision/状态）。
    const manifestTarget = join(layout.installRoot, config.modelManifest);
    const manifestSource = join(layout.app, 'desktop', 'model-manifest.default.json');
    let manifestVersion = 'unknown';
    if (!existsSync(manifestTarget)) {
      if (existsSync(manifestSource)) {
        await mkdir(dirname(manifestTarget), { recursive: true });
        await cp(manifestSource, manifestTarget, { force: true });
        await addLog('模型清单模板已写入 models/.downloads/manifest.json');
      } else {
        warnings.push(`缺少模型清单模板：${manifestSource}（模型管理器将使用内置默认清单）`);
      }
    }
    try {
      manifestVersion = (await loadModelManifest(manifestTarget)).version;
    } catch {
      manifestVersion = 'unknown';
    }

    await writeJsonAtomic(join(layout.data, 'runtime', 'versions.json'), {
      programVersion: version,
      previousProgramVersion: existing?.version ?? null,
      modelManifestVersion: manifestVersion,
      updatedAt: new Date(now()).toISOString(),
    });
    await addLog('versions.json 已写入（程序版本/模型清单版本分别记录）');
    await addLog(`安装后收尾完成：modelsDownloadChoice=${downloadModels} warnings=${warnings.length}`);
    await appendFile(logPath, `${logLines.join('\n')}\n`, 'utf8');
    return {
      ok: true,
      installRoot: layout.installRoot,
      version,
      profile,
      upgrade: Boolean(existing),
      logPath,
      modelsDownloadChoice: downloadModels,
      warnings,
      errors: [],
    };
  } catch (error) {
    errors.push((error as Error).message || String(error));
    await addLog(`安装后收尾失败：${(error as Error).message}`);
    try {
      await appendFile(logPath, `${logLines.join('\n')}\n`, 'utf8');
    } catch {
      /* 日志写入失败不覆盖原始错误。 */
    }
    return { ...resultBase, ok: false, logPath, warnings, errors };
  }
}

/**
 * 执行安装/升级（旧复制/快捷方式/注册表路径，保留给维护 CLI 与单元测试；Setup.exe 已改由 Inno 负责）：
 * 所有写入先到 staging，再原子替换程序目录，失败回滚。
 */
export async function executeInstall(plan: InstallPlan, deps: InstallerDeps = {}): Promise<InstallResult> {
  const copyTree = deps.copyTree ?? defaultCopyTree;
  const removeTree = deps.removeTree ?? defaultRemoveTree;
  const createShortcut = deps.createShortcut ?? defaultCreateShortcut;
  const writeRegistry = deps.writeRegistry ?? defaultWriteRegistry;
  const now = deps.now ?? Date.now;
  const errors: string[] = [];
  const warnings: string[] = [];
  let logger: Logger | undefined;
  const stamp = formatTimestamp(new Date(now()));
  const stagingDir = join(plan.targetRoot, `.staging-${stamp}-${randomUUID().slice(0, 6)}`);
  const backups: Array<{ original: string; backup: string }> = [];
  const createdDirectories: string[] = [];
  const movedEntries: string[] = [];
  let existingConfig: InstallConfig | undefined;
  try {
    logger = await createLogger(plan.targetRoot, now);
    await logger.write(`开始安装知影 ${plan.version}（${plan.profile}）到 ${plan.targetRoot}`);
    await logger.write(`安装包：${plan.payloadRoot}`);
    await logger.write(`模式：${plan.upgrade ? '升级/修复（保留用户数据）' : '全新安装'}`);
    try {
      existingConfig = await loadInstallConfig(plan.targetRoot);
      if (compareVersions(existingConfig.version, plan.version) > 0) {
        warnings.push(`即将安装的版本 ${plan.version} 低于已安装版本 ${existingConfig.version}，如需回滚请先备份数据。`);
      }
    } catch {
      existingConfig = undefined;
    }
    await mkdir(plan.targetRoot, { recursive: true });
    await assertNoReparseEscape(plan.targetRoot, plan.targetRoot);
    await logger.write('步骤 1/8：目录校验通过');
    for (const relative of ['models', 'data', 'config', 'logs', join('data', 'tmp'), join('models', '.downloads')]) {
      const directory = join(plan.targetRoot, relative);
      if (!existsSync(directory)) createdDirectories.push(directory);
      await mkdir(directory, { recursive: true });
    }
    await mkdir(stagingDir, { recursive: true });
    const payloadEntries = await readdir(plan.payloadRoot, { withFileTypes: true });
    for (const entry of payloadEntries) {
      if (PAYLOAD_SKIP_ENTRIES.has(entry.name)) continue;
      const from = join(plan.payloadRoot, entry.name);
      const to = join(stagingDir, entry.name);
      await copyTree(from, to);
    }
    await logger.write('步骤 2/8：程序文件已复制到临时目录');
    const swapEntries = ['app', 'runtime', 'Zhiying.exe'];
    for (const name of swapEntries) {
      const source = join(stagingDir, name);
      if (!existsSync(source)) {
        if (name === 'Zhiying.exe' || name === 'app' || name === 'runtime') {
          throw new Error(`安装包缺少必要内容：${name}`);
        }
        continue;
      }
      const target = join(plan.targetRoot, name);
      if (existsSync(target)) {
        const backup = join(plan.targetRoot, `.old-${name}-${stamp}`);
        await removeTree(backup).catch(() => undefined);
        await renameWithRetry(target, backup);
        backups.push({ original: target, backup });
      }
      try {
        await renameWithRetry(source, target);
        movedEntries.push(target);
      } catch (error) {
        throw new Error(`替换程序文件失败：${target}（${(error as Error).message}）`);
      }
    }
    for (const extra of await readdir(stagingDir)) {
      const source = join(stagingDir, extra);
      const target = join(plan.targetRoot, extra);
      await removeTree(target).catch(() => undefined);
      await renameWithRetry(source, target).catch(async () => {
        await copyTree(source, target);
      });
    }
    await logger.write(`步骤 3/8：程序文件已就位${plan.upgrade ? '（已备份旧版本）' : ''}`);
    const template = await readTemplateDefaults(plan.payloadRoot);
    const config = buildInstallConfig(plan, template, existingConfig, now);
    const validation = validateInstallConfig(config);
    if (!validation.ok) throw new Error(`安装配置生成失败：${validation.errors.join('；')}`);
    await writeInstallConfig(config);
    await logger.write('步骤 4/8：config/install.json 已写入');
    const layout = resolveInstallLayout(plan.targetRoot);
    const manifestSource = join(plan.targetRoot, 'app', 'desktop', 'model-manifest.default.json');
    const manifestTarget = join(layout.modelsRoot, '.downloads', 'manifest.json');
    if (!existsSync(manifestTarget) && existsSync(manifestSource)) {
      await mkdir(dirname(manifestTarget), { recursive: true });
      await cp(manifestSource, manifestTarget, { force: true });
    }
    await logger.write('步骤 5/8：models 目录与模型清单已准备');
    if (plan.createShortcut) {
      try {
        await createShortcut(plan);
        await logger.write('步骤 6/8：桌面快捷方式已创建');
      } catch (error) {
        warnings.push(`创建桌面快捷方式失败（不影响使用）：${(error as Error).message}`);
        await logger.write(`警告：创建桌面快捷方式失败：${(error as Error).message}`);
      }
    } else {
      await logger.write('步骤 6/8：按参数跳过桌面快捷方式');
    }
    if (plan.writeRegistry) {
      try {
        await writeRegistry(plan);
        await logger.write('步骤 7/8：卸载注册表项已写入');
      } catch (error) {
        warnings.push(`写入卸载注册表项失败（不影响使用）：${(error as Error).message}`);
        await logger.write(`警告：写入卸载注册表项失败：${(error as Error).message}`);
      }
    } else {
      await logger.write('步骤 7/8：按参数跳过卸载注册表项');
    }
    for (const backup of backups) await removeTree(backup.backup).catch(() => undefined);
    await removeTree(stagingDir).catch(() => undefined);
    await logger.write(`步骤 8/8：安装完成，模型下载选择：${plan.downloadModels === 'now' ? '立即下载' : '稍后下载'}`);
    return { ok: true, plan, logPath: logger.path, errors, warnings, launchModelManager: plan.downloadModels === 'now' };
  } catch (error) {
    const message = (error as Error).message || String(error);
    errors.push(message);
    if (logger) await logger.write(`错误：${message}`);
    for (const moved of movedEntries) await removeTree(moved).catch(() => undefined);
    for (const backup of backups.reverse()) {
      if (existsSync(backup.backup)) {
        await removeTree(backup.original).catch(() => undefined);
        await renameWithRetry(backup.backup, backup.original).catch(() => undefined);
      }
    }
    await removeTree(stagingDir).catch(() => undefined);
    if (!plan.upgrade) {
      for (const directory of createdDirectories.reverse()) await removeTree(directory).catch(() => undefined);
      const configPath = join(plan.targetRoot, 'config', 'install.json');
      await rm(configPath, { force: true }).catch(() => undefined);
      try {
        const remaining = await readdir(plan.targetRoot);
        if (remaining.length === 0) await removeTree(plan.targetRoot).catch(() => undefined);
      } catch {
        /* 目标目录可能尚未创建。 */
      }
    }
    if (logger) await logger.write(`安装失败，已回滚。日志：${logger.path}`);
    return { ok: false, plan, logPath: logger?.path ?? '', errors, warnings, launchModelManager: false };
  }
}

/** 读取安装日志尾部（维护 CLI --open-logs/诊断用）。 */
export async function readSetupLogTail(logPath: string, maxLines = 30): Promise<string> {
  try {
    const raw = await readFile(logPath, 'utf8');
    return raw.split(/\r?\n/).slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

/** 删除空目录（重装/卸载辅助）。 */
export async function removeEmptyDirectory(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    if (entries.length === 0) {
      await rm(path, { recursive: false, force: true });
      return true;
    }
  } catch {
    /* 忽略。 */
  }
  return false;
}

/** 清理升级遗留的 `.old-*`/`.staging-*` 目录。 */
export async function cleanInstallArtifacts(installRoot: string): Promise<string[]> {
  const removed: string[] = [];
  let entries;
  try {
    entries = await readdir(installRoot, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (/^\.(staging|old)-/.test(entry.name)) {
      await rm(join(installRoot, entry.name), { recursive: true, force: true }).catch(() => undefined);
      removed.push(entry.name);
    }
  }
  return removed;
}
