import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { appendFile, cp, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  formatTimestamp,
  loadInstallConfig,
  resolveInstallLayout,
  writeInstallConfig,
  writeJsonAtomic,
} from './install-layout.js';
import type { InstallConfig, InstallLayout } from './install-layout.js';
import {
  assertNoReparseEscape,
  getDiskFreeBytes,
  isPathWithin,
  probeWritableDirectory,
} from './model-paths.js';
import { defaultModelManifest, loadModelManifest, validateModelManifest } from './model-manifest.js';
import type { ModelManifest } from './model-manifest.js';
import { inspectPort, isProcessAlive } from './process-probe.js';
import { readServiceState } from './launcher.js';
import { computeDirectoryBytes, removeRegistryEntry, removeShortcut, renameWithRetry } from './installer.js';
import { hashFileSha256 } from './downloader.js';

/**
 * #106 首次启动诊断、模型修复、程序升级与卸载（数据保留策略）。
 *
 * 所有检查只读；修复动作必须由调用方/用户确认后执行（CLI --repair 需要 --yes）。
 */

const execFileAsync = promisify(execFile);
const PRESERVED_DIRECTORIES = ['models', 'data', 'logs', 'config'] as const;

export type DiagnosticStatus = 'ok' | 'warn' | 'fail' | 'missing' | 'corrupted' | 'unknown';

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: DiagnosticStatus;
  detail: string;
  fix?: string;
}

export interface DiagnosticReport {
  generatedAt: string;
  installRoot: string;
  version: string;
  checks: DiagnosticCheck[];
  summary: { ok: number; warn: number; fail: number };
}

export interface RepairAction {
  kind: 'download_models' | 'verify_models' | 'restart_services' | 'open_logs' | 'repair_install';
  description: string;
  modelIds?: string[];
}

function bytesLabel(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${Math.round(gb * 10) / 10} GB`;
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${Math.round(mb * 10) / 10} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function summarize(checks: DiagnosticCheck[]): DiagnosticReport['summary'] {
  const ok = checks.filter(check => check.status === 'ok').length;
  const fail = checks.filter(check => check.status === 'fail').length;
  return { ok, warn: checks.length - ok - fail, fail };
}

async function loadManifestForDiagnostics(layout: InstallLayout, config: InstallConfig): Promise<{ manifest?: ModelManifest; error?: string; path: string }> {
  const configured = join(layout.installRoot, config.modelManifest);
  const fallback = join(layout.app, 'desktop', 'model-manifest.default.json');
  const path = existsSync(configured) ? configured : fallback;
  try {
    if (existsSync(path)) return { manifest: await loadModelManifest(path), path };
    return { manifest: defaultModelManifest(), path: '（内置默认清单）' };
  } catch (error) {
    return { error: (error as Error).message, path };
  }
}

interface DownloadStateFile {
  models?: Record<string, { status?: string; receivedBytes?: number; error?: { message?: string } }>;
}

async function readDownloadState(layout: InstallLayout): Promise<DownloadStateFile | undefined> {
  try {
    const raw = await readFile(layout.modelStatePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as DownloadStateFile) : undefined;
  } catch {
    return undefined;
  }
}

/** 运行完整环境诊断（安装配置/版本/运行时/模型/服务/磁盘/未完成下载/数据目录）。 */
export async function runDiagnostics(input: {
  installRoot: string;
  probeServices?: boolean;
  probeModels?: boolean;
  fetchImpl?: typeof fetch;
  deps?: { diskFreeBytes?: (dir: string) => Promise<number> };
}): Promise<DiagnosticReport> {
  const checks: DiagnosticCheck[] = [];
  const generatedAt = new Date().toISOString();
  let layout: InstallLayout;
  let config: InstallConfig;
  try {
    layout = resolveInstallLayout(input.installRoot);
    config = await loadInstallConfig(input.installRoot);
    checks.push({ id: 'install-config', label: '安装配置', status: 'ok', detail: `config/install.json 可读，版本 ${config.version}` });
    checks.push({ id: 'program-version', label: '程序版本', status: 'ok', detail: `知影 ${config.version}（${config.payloadProfile} 发行）` });
  } catch (error) {
    return {
      generatedAt,
      installRoot: input.installRoot,
      version: 'unknown',
      checks: [
        {
          id: 'install-config',
          label: '安装配置',
          status: 'fail',
          detail: (error as Error).message,
          fix: '请重新运行 Zhiying-Setup.exe 修复安装（默认保留 models/data）。',
        },
      ],
      summary: { ok: 0, warn: 0, fail: 1 },
    };
  }

  // 运行时组件
  const runtimeChecks: Array<{ id: string; label: string; relative?: string; required: boolean }> = [
    { id: 'runtime-node', label: 'Node 运行时', relative: config.runtime.node, required: true },
  ];
  if (config.payloadProfile === 'full') {
    if (config.runtime.python) runtimeChecks.push({ id: 'runtime-python', label: 'Python 运行时', relative: config.runtime.python, required: true });
    if (config.runtime.ffmpegDir) runtimeChecks.push({ id: 'runtime-ffmpeg', label: 'FFmpeg 运行时', relative: config.runtime.ffmpegDir, required: true });
    if (config.runtime.ollama) runtimeChecks.push({ id: 'runtime-ollama', label: 'Ollama 运行时', relative: config.runtime.ollama, required: true });
  } else {
    checks.push({ id: 'runtime-fixtures', label: 'lite fixture 服务', status: 'ok', detail: 'lite 发行包使用 app/fixtures 下的 Node fixture 服务（用于发行链路验证）' });
    if (config.runtime.ffmpegDir) {
      checks.push({
        id: 'runtime-ffmpeg',
        label: 'FFmpeg 运行时',
        status: 'warn',
        detail: 'lite 发行包不包含真实 FFmpeg，依赖 FFmpeg 的导出功能需使用 full 发行包或自行安装 FFmpeg 8',
        fix: '发布前使用 full profile 构建，或把 FFmpeg 8 full-shared 目录放入 runtime/ffmpeg。',
      });
    }
  }
  for (const runtimeCheck of runtimeChecks) {
    if (!runtimeCheck.relative) continue;
    const target = join(layout.installRoot, runtimeCheck.relative);
    if (existsSync(target)) {
      checks.push({ id: runtimeCheck.id, label: runtimeCheck.label, status: 'ok', detail: target });
    } else {
      checks.push({
        id: runtimeCheck.id,
        label: runtimeCheck.label,
        status: 'missing',
        detail: `缺少 ${target}`,
        fix: '请重新运行安装程序覆盖安装（保留用户数据），或运行维护 CLI --upgrade 使用新发行包修复。',
      });
    }
  }

  // 模型清单 + 已安装状态
  const manifestInfo = await loadManifestForDiagnostics(layout, config);
  const downloadState = await readDownloadState(layout);
  if (!manifestInfo.manifest) {
    checks.push({
      id: 'model-manifest',
      label: '模型清单',
      status: 'corrupted',
      detail: `模型清单无效：${manifestInfo.error ?? '未知错误'}（${manifestInfo.path}）`,
      fix: '运行维护 CLI --diagnostics 后使用模型管理器重新下载/修复模型，或重新安装以恢复默认清单。',
    });
  } else {
    checks.push({ id: 'model-manifest', label: '模型清单', status: 'ok', detail: `清单版本 ${manifestInfo.manifest.version}（${manifestInfo.manifest.models.length} 个模型）` });
    for (const entry of manifestInfo.manifest.models) {
      const state = downloadState?.models?.[entry.id];
      let status: DiagnosticStatus = 'unknown';
      let detail = '';
      if (entry.files.length === 0) {
        const installed = state?.status === 'installed';
        status = installed ? 'ok' : 'missing';
        detail = installed ? '已安装（由 Ollama 管理）' : '未安装（通过 ollama pull 下载）';
      } else {
        let existing = 0;
        let wrongSize = 0;
        for (const file of entry.files) {
          const target = entry.installDir.replace(/\//g, '\\').toLowerCase().startsWith('huggingface')
            ? join(layout.modelsHuggingFace, 'hub', `models--${(entry.source.repo ?? '').replace('/', '--')}`, 'snapshots', entry.source.revision ?? 'main', file.path)
            : join(layout.modelsRoot, entry.installDir, file.path);
          try {
            const fileStat = await stat(target);
            existing += 1;
            if (fileStat.size !== file.sizeBytes) wrongSize += 1;
            else if (input.probeModels && entry.integrity === 'sha256' && file.sha256) {
              // 流式 SHA-256（不整文件读入内存），供 CLI --diagnostics/--repair 真实校验模型完整性。
              const digest = await hashFileSha256(target);
              if (digest !== file.sha256) wrongSize += 1;
            }
          } catch {
            /* 缺失。 */
          }
        }
        if (existing === entry.files.length && wrongSize === 0) {
          status = 'ok';
          detail = `已安装（${entry.files.length} 个文件）`;
        } else if (existing > 0) {
          status = 'corrupted';
          detail = `文件不完整或校验失败（${existing}/${entry.files.length} 存在，${wrongSize} 大小/哈希不符）`;
        } else if (state?.status === 'failed' || state?.status === 'corrupted') {
          status = 'fail';
          detail = state?.error?.message ?? '下载失败';
        } else {
          status = 'missing';
          detail = '尚未安装';
        }
      }
      const check: DiagnosticCheck = { id: `model:${entry.id}`, label: `模型：${entry.name}`, status, detail };
      if (status !== 'ok') {
        check.fix = '打开模型管理器下载/重试；损坏模型可先“重新校验”再重下，已校验模型不会被删除。';
      }
      checks.push(check);
    }
  }

  // 未完成下载任务
  if (downloadState?.models) {
    const unfinished = Object.entries(downloadState.models).filter(([, state]) => ['downloading', 'paused', 'verifying'].includes(state.status ?? ''));
    checks.push(
      unfinished.length > 0
        ? {
            id: 'downloads-unfinished',
            label: '未完成下载任务',
            status: 'warn',
            detail: `${unfinished.length} 个模型下载未完成：${unfinished.map(([id]) => id).join('、')}`,
            fix: '打开模型管理器恢复/重试下载；已下载片段会保留继续续传。',
          }
        : { id: 'downloads-unfinished', label: '未完成下载任务', status: 'ok', detail: '没有未完成的模型下载任务' },
    );
  }

  // 服务健康（端口可连）
  if (input.probeServices !== false) {
    const servicePorts: Array<{ id: string; label: string; port: number }> = [
      { id: 'service-web', label: 'Web 服务', port: config.ports.web },
      { id: 'service-python', label: 'Python 服务', port: config.ports.python },
      { id: 'service-ollama', label: '受管 Ollama', port: config.ports.ollama },
      { id: 'service-manager', label: '模型管理器', port: config.ports.manager },
    ];
    for (const service of servicePorts) {
      const inspection = await inspectPort(service.port);
      if (inspection.open) {
        checks.push({ id: service.id, label: service.label, status: 'ok', detail: `端口 ${service.port} 可连接` });
      } else {
        checks.push({
          id: service.id,
          label: service.label,
          status: 'warn',
          detail: `端口 ${service.port} 未监听（知影当前可能未启动）`,
          fix: '双击 Zhiying.exe 启动知影；若启动失败请查看 logs 目录下的服务日志。',
        });
      }
    }
    const managedState = await readServiceState(layout);
    if (managedState) {
      const stale = managedState.services.filter(service => !isProcessAlive(service.pid));
      if (stale.length > 0) {
        checks.push({
          id: 'services-stale',
          label: '受管进程状态',
          status: 'warn',
          detail: `${stale.length} 个记录的服务进程已不存在：${stale.map(service => service.id).join('、')}`,
          fix: '运行 Zhiying.exe --stop 清理陈旧状态后重新启动。',
        });
      } else {
        checks.push({ id: 'services-stale', label: '受管进程状态', status: 'ok', detail: `${managedState.services.length} 个受管服务进程存活` });
      }
    }
  }

  // 磁盘空间
  const diskFree = input.deps?.diskFreeBytes ?? getDiskFreeBytes;
  const freeBytes = await diskFree(layout.modelsRoot);
  if (freeBytes <= 0) {
    checks.push({ id: 'disk-space', label: '磁盘空间', status: 'unknown', detail: '无法读取模型目录所在磁盘的可用空间' });
  } else if (freeBytes < 1 * 1024 * 1024 * 1024) {
    checks.push({
      id: 'disk-space',
      label: '磁盘空间',
      status: 'fail',
      detail: `可用空间仅 ${bytesLabel(freeBytes)}，不足以继续下载模型或渲染`,
      fix: '清理磁盘后重试；模型可先下载必需项，稍后补充可选模型。',
    });
  } else if (freeBytes < 5 * 1024 * 1024 * 1024) {
    checks.push({ id: 'disk-space', label: '磁盘空间', status: 'warn', detail: `可用空间 ${bytesLabel(freeBytes)}，空间偏紧`, fix: '建议释放至少 5 GB 空间后再下载模型或渲染视频。' });
  } else {
    checks.push({ id: 'disk-space', label: '磁盘空间', status: 'ok', detail: `模型目录所在磁盘可用 ${bytesLabel(freeBytes)}` });
  }

  // 数据目录可写
  const dataWritable = await probeWritableDirectory(layout.data);
  checks.push(
    dataWritable
      ? { id: 'data-writable', label: '数据目录', status: 'ok', detail: `${layout.data} 可写` }
      : {
          id: 'data-writable',
          label: '数据目录',
          status: 'fail',
          detail: `数据目录不可写：${layout.data}`,
          fix: '检查目录权限，或把知影安装到当前用户可写目录（%LOCALAPPDATA%\\Programs\\Zhiying 或 D 盘自建目录）。',
        },
  );

  return {
    generatedAt,
    installRoot: layout.installRoot,
    version: config.version,
    checks,
    summary: summarize(checks),
  };
}

/** 根据诊断报告生成修复建议（只给建议，不自动执行）。 */
export function planRepairs(report: DiagnosticReport): { actions: RepairAction[] } {
  const actions: RepairAction[] = [];
  const modelIdsToDownload: string[] = [];
  const modelIdsToVerify: string[] = [];
  let restartServices = false;
  let repairInstall = false;
  let openLogs = false;
  for (const check of report.checks) {
    if (check.status === 'ok') continue;
    if (check.id.startsWith('model:')) {
      const modelId = check.id.slice('model:'.length);
      if (check.status === 'missing' || check.status === 'fail') modelIdsToDownload.push(modelId);
      else if (check.status === 'corrupted') modelIdsToVerify.push(modelId);
      continue;
    }
    if (check.id === 'model-manifest' || check.id === 'install-config' || check.id.startsWith('runtime-') || check.id === 'data-writable') {
      repairInstall = true;
      continue;
    }
    if (check.id.startsWith('service-') || check.id === 'services-stale') {
      restartServices = true;
      continue;
    }
    if (check.id === 'disk-space' || check.id === 'downloads-unfinished') {
      openLogs = openLogs || check.id === 'downloads-unfinished';
    }
  }
  if (modelIdsToDownload.length > 0) {
    actions.push({ kind: 'download_models', description: `下载/重试缺失模型：${modelIdsToDownload.join('、')}（已校验模型不会重复下载）`, modelIds: modelIdsToDownload });
  }
  if (modelIdsToVerify.length > 0) {
    actions.push({ kind: 'verify_models', description: `重新校验并修复损坏模型：${modelIdsToVerify.join('、')}`, modelIds: modelIdsToVerify });
  }
  if (restartServices) actions.push({ kind: 'restart_services', description: '重启知影服务：先 Zhiying.exe --stop，再双击 Zhiying.exe 启动，并查看 logs 目录' });
  if (repairInstall) actions.push({ kind: 'repair_install', description: '修复安装：重新运行 Zhiying-Setup.exe 覆盖安装（默认保留 models/data/logs/config 用户数据）' });
  if (openLogs) actions.push({ kind: 'open_logs', description: '打开日志目录排查磁盘/下载/服务错误（logs 目录）' });
  return { actions };
}

async function directorySizeSafe(path: string): Promise<number> {
  return computeDirectoryBytes(path);
}

export interface UpgradeResult {
  ok: boolean;
  fromVersion: string;
  toVersion: string;
  preserved: string[];
  backupPath?: string;
  errors: string[];
}

interface UpgradeDeps {
  copyTree?: (from: string, to: string) => Promise<void>;
  removeTree?: (path: string) => Promise<void>;
  now?: () => number;
}

async function defaultCopyTree(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true, force: true, errorOnExist: false, dereference: false });
}

async function defaultRemoveTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/**
 * 原地升级：替换 app/runtime，保留 models/data/logs/config；升级前备份 install.json 与 SQLite。
 * 服务运行中时安全拒绝，避免破坏数据库。
 */
export async function upgradeInstall(input: {
  installRoot: string;
  payloadRoot: string;
  version: string;
  dryRun?: boolean;
  deps?: UpgradeDeps;
}): Promise<UpgradeResult> {
  const copyTree = input.deps?.copyTree ?? defaultCopyTree;
  const removeTree = input.deps?.removeTree ?? defaultRemoveTree;
  const now = input.deps?.now ?? Date.now;
  const errors: string[] = [];
  const preserved = [...PRESERVED_DIRECTORIES];
  let layout: InstallLayout;
  let config: InstallConfig;
  try {
    layout = resolveInstallLayout(input.installRoot);
    config = await loadInstallConfig(input.installRoot);
  } catch (error) {
    return { ok: false, fromVersion: 'unknown', toVersion: input.version, preserved, errors: [(error as Error).message] };
  }
  const fromVersion = config.version;
  const payloadRoot = resolve(input.payloadRoot);
  for (const required of ['Zhiying.exe', 'app', 'runtime']) {
    if (!existsSync(join(payloadRoot, required))) {
      return { ok: false, fromVersion, toVersion: input.version, preserved, errors: [`升级包不完整：缺少 ${required}（${payloadRoot}）`] };
    }
  }
  const runningState = await readServiceState(layout);
  if (runningState) {
    const alive = runningState.services.filter(service => isProcessAlive(service.pid));
    if (alive.length > 0) {
      return {
        ok: false,
        fromVersion,
        toVersion: input.version,
        preserved,
        errors: [`知影服务正在运行（${alive.map(service => service.id).join('、')}），请先执行 Zhiying.exe --stop 停止后再升级，避免破坏数据库。`],
      };
    }
    await rm(layout.serviceStatePath, { force: true }).catch(() => undefined);
  }
  if (input.dryRun) {
    return { ok: true, fromVersion, toVersion: input.version, preserved, errors: [] };
  }
  const stamp = formatTimestamp(new Date(now()));
  const stagingDir = join(layout.installRoot, `.upgrade-${stamp}`);
  const backups: Array<{ original: string; backup: string }> = [];
  const swapEntries = ['app', 'runtime', 'Zhiying.exe'];
  try {
    // 备份 config/install.json 与 SQLite
    const backupDir = join(layout.data, 'backups', stamp);
    await mkdir(backupDir, { recursive: true });
    await cp(layout.installConfigPath, join(backupDir, 'install.json'), { force: true }).catch(() => undefined);
    const database = join(layout.data, 'm2v.db');
    if (existsSync(database)) await cp(database, join(backupDir, 'm2v.db'), { force: true });
    await mkdir(stagingDir, { recursive: true });
    for (const name of swapEntries) {
      const source = join(payloadRoot, name);
      const destination = join(stagingDir, name);
      await copyTree(source, destination);
    }
    for (const name of swapEntries) {
      const source = join(stagingDir, name);
      if (!existsSync(source)) throw new Error(`升级包缺少必要内容：${name}`);
      const target = join(layout.installRoot, name);
      if (existsSync(target)) {
        const backup = join(layout.installRoot, `.old-${name}-${stamp}`);
        await removeTree(backup).catch(() => undefined);
        await renameWithRetry(target, backup);
        backups.push({ original: target, backup });
      }
      await renameWithRetry(source, target);
    }
    const updated: InstallConfig = {
      ...config,
      version: input.version,
      updatedAt: new Date(now()).toISOString(),
      firstRunCompleted: false,
    };
    await writeInstallConfig(updated);
    const manifestPath = join(layout.modelsRoot, '.downloads', 'manifest.json');
    const manifest = existsSync(manifestPath) ? await loadModelManifest(manifestPath).catch(() => undefined) : undefined;
    await writeJsonAtomic(join(layout.data, 'runtime', 'versions.json'), {
      programVersion: input.version,
      previousProgramVersion: fromVersion,
      modelManifestVersion: manifest?.version ?? 'unknown',
      updatedAt: new Date(now()).toISOString(),
    });
    for (const backup of backups) await removeTree(backup.backup).catch(() => undefined);
    await removeTree(stagingDir).catch(() => undefined);
    await appendFile(join(layout.logs, `upgrade-${stamp}.log`), `升级成功：${fromVersion} → ${input.version}；备份：${backupDir}\n`, 'utf8').catch(() => undefined);
    return { ok: true, fromVersion, toVersion: input.version, preserved, backupPath: backupDir, errors: [] };
  } catch (error) {
    errors.push((error as Error).message || String(error));
    for (const backup of backups.reverse()) {
      if (existsSync(backup.backup)) {
        await removeTree(backup.original).catch(() => undefined);
        await renameWithRetry(backup.backup, backup.original).catch(() => undefined);
      }
    }
    await removeTree(stagingDir).catch(() => undefined);
    await appendFile(join(layout.logs, `upgrade-${stamp}.log`), `升级失败：${(error as Error).message}\n`, 'utf8').catch(() => undefined);
    return { ok: false, fromVersion, toVersion: input.version, preserved, errors };
  }
}

export interface UninstallPlan {
  installRoot: string;
  targets: Array<{ path: string; bytes: number; kind: 'program' | 'models' | 'data' | 'logs' | 'config' }>;
  preserved: string[];
  errors: string[];
}

/** 卸载计划：默认仅移除程序（app/runtime/Zhiying.exe），保留 models/data/logs/config。 */
export async function planUninstall(input: { installRoot: string; purgeData?: boolean; purgeModels?: boolean }): Promise<UninstallPlan> {
  const errors: string[] = [];
  let layout: InstallLayout;
  try {
    layout = resolveInstallLayout(input.installRoot);
  } catch (error) {
    return { installRoot: input.installRoot, targets: [], preserved: [], errors: [(error as Error).message] };
  }
  const targets: UninstallPlan['targets'] = [];
  const candidate: Array<{ relative: string; kind: UninstallPlan['targets'][number]['kind'] }> = [
    { relative: 'app', kind: 'program' },
    { relative: 'runtime', kind: 'program' },
    { relative: 'Zhiying.exe', kind: 'program' },
  ];
  if (input.purgeModels) candidate.push({ relative: 'models', kind: 'models' });
  if (input.purgeData) candidate.push({ relative: 'data', kind: 'data' });
  for (const item of candidate) {
    const target = join(layout.installRoot, item.relative);
    if (!isPathWithin(layout.installRoot, target) || resolve(target) === resolve(layout.installRoot)) {
      errors.push(`拒绝删除安装目录之外的路径：${target}`);
      continue;
    }
    if (!existsSync(target)) continue;
    try {
      await assertNoReparseEscape(layout.installRoot, target);
    } catch (error) {
      errors.push((error as Error).message);
      continue;
    }
    targets.push({ path: target, bytes: await directorySizeSafe(target), kind: item.kind });
  }
  const purge = new Set<string>();
  if (input.purgeData) purge.add('data');
  if (input.purgeModels) purge.add('models');
  const preserved = PRESERVED_DIRECTORIES.filter(name => !purge.has(name)).map(name => join(layout.installRoot, name));
  targets.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { installRoot: layout.installRoot, targets, preserved, errors };
}

/** 用一个短命的 cmd（进程退出后执行）延迟删除目录，用于被运行中 exe 锁定的 runtime。 */
function scheduleDirectoryRemoval(directory: string): void {
  try {
    const child = spawn(
      'cmd.exe',
      ['/d', '/s', '/c', 'ping', '-n', '3', '127.0.0.1', '>nul', '&', 'rmdir', '/s', '/q', directory],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
  } catch {
    /* 调度失败时保留目录，下次安装/维护可清理。 */
  }
}

/** 清理历史上卸载时被移动的 runtime 目录（进程退出后由 cmd 删除；这里兜底）。 */
async function cleanupRenamedRuntimes(installRoot: string): Promise<void> {
  try {
    const parent = dirname(resolve(installRoot));
    const entries = await readdir(parent, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\.zhiying-uninstall-runtime-/.test(entry.name)) continue;
      const target = join(parent, entry.name);
      await rm(target, { recursive: true, force: true }).catch(() => {
        scheduleDirectoryRemoval(target);
      });
    }
  } catch {
    /* 忽略。 */
  }
}

/** 卸载：默认仅移除程序并保留用户数据；显式清理需 confirm=true。 */
export async function uninstall(input: {
  installRoot: string;
  purgeData?: boolean;
  purgeModels?: boolean;
  confirm: boolean;
  dryRun?: boolean;
  deps?: { removeTree?: (path: string) => Promise<void>; removeRegistry?: () => Promise<void>; removeShortcut?: () => Promise<void> };
}): Promise<{ ok: boolean; plan: UninstallPlan; errors: string[] }> {
  const errors: string[] = [];
  const plan = await planUninstall(input);
  errors.push(...plan.errors);
  const needsConfirm = Boolean(input.purgeData || input.purgeModels);
  if (needsConfirm && !input.confirm) {
    return { ok: false, plan, errors: [...errors, '删除模型或用户数据需要显式确认（--purge-data/--purge-models 必须与 --yes 同时使用）。'] };
  }
  if (input.dryRun) return { ok: errors.length === 0, plan, errors };
  const removeTree = input.deps?.removeTree ?? defaultRemoveTree;
  let layout: InstallLayout | undefined;
  try {
    layout = resolveInstallLayout(input.installRoot);
  } catch {
    layout = undefined;
  }
  if (layout) await cleanupRenamedRuntimes(layout.installRoot);
  // 维护 CLI 可能正运行在 <root>\runtime\node\node.exe 上：Windows 不允许删除正在执行的 exe。
  // 先把 runtime 目录移动到安装目录同级的隐藏目录（同卷 rename），父进程退出后由 cmd 删除。
  const runtimeTarget = layout ? join(layout.installRoot, 'runtime') : undefined;
  const lockedRuntime = Boolean(
    runtimeTarget
      && existsSync(runtimeTarget)
      && isPathWithin(input.installRoot, process.execPath)
      && plan.targets.some(target => resolve(target.path).toLowerCase() === resolve(runtimeTarget).toLowerCase()),
  );
  if (lockedRuntime && runtimeTarget && layout) {
    const renamed = join(dirname(layout.installRoot), `.zhiying-uninstall-runtime-${formatTimestamp()}-${Math.random().toString(16).slice(2, 8)}`);
    try {
      await renameWithRetry(runtimeTarget, renamed);
      plan.targets = plan.targets.filter(target => resolve(target.path).toLowerCase() !== resolve(runtimeTarget).toLowerCase());
      scheduleDirectoryRemoval(renamed);
    } catch (error) {
      errors.push(`无法移动运行中的 runtime 目录（${(error as Error).message}），将在进程退出后尝试清理。`);
    }
  }
  // 未完成下载任务安全终止（保留的 models 下标记为 paused，不伪造完成）
  if (layout && !input.purgeModels) {
    try {
      const raw = await readFile(layout.modelStatePath, 'utf8');
      const state = JSON.parse(raw) as DownloadStateFile;
      if (state.models) {
        for (const value of Object.values(state.models)) {
          if (['downloading', 'verifying'].includes(value.status ?? '')) value.status = 'paused';
        }
        await writeJsonAtomic(layout.modelStatePath, state);
      }
    } catch {
      /* 没有下载状态。 */
    }
  }
  for (const target of plan.targets) {
    try {
      if (!isPathWithin(plan.installRoot, target.path)) throw new Error(`拒绝删除安装目录之外的路径：${target.path}`);
      await assertNoReparseEscape(plan.installRoot, target.path);
      await removeTree(target.path);
    } catch (error) {
      errors.push(`删除失败：${target.path}（${(error as Error).message}）`);
    }
  }
  try {
    await (input.deps?.removeRegistry ?? removeRegistryEntry)();
  } catch {
    /* 注册表项可能不存在。 */
  }
  try {
    await (input.deps?.removeShortcut ?? removeShortcut)();
  } catch {
    /* 快捷方式可能不存在。 */
  }
  if (layout) {
    await appendFile(
      join(layout.logs, `uninstall-${formatTimestamp()}.log`),
      `卸载完成：删除 ${plan.targets.length} 项；保留 ${plan.preserved.length} 个用户目录。\n`,
      'utf8',
    ).catch(() => undefined);
  }
  return { ok: errors.length === 0, plan, errors };
}

/** 供 CLI 展示：日志目录（若不存在返回 undefined）。 */
export function logsDirectory(installRoot: string): string | undefined {
  try {
    return resolveInstallLayout(installRoot).logs;
  } catch {
    return undefined;
  }
}

/** 校验清单文本（维护 CLI 可用；转发 model-manifest 校验以便统一错误）。 */
export function validateManifestText(raw: unknown): string[] {
  const result = validateModelManifest(raw);
  return result.ok ? [] : result.errors;
}

export { dirname as installDirname };

