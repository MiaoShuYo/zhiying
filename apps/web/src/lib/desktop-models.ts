import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * #105 D：web「设置 → 模型」只读入口。
 *
 * 只读取安装版 `<InstallRoot>` 下的 config/install.json、models/.downloads/state.json
 * 与模型清单；任何缺失/损坏都返回 available:false（绝不抛异常、不读取凭据）。
 */

export type DesktopModelStatus = 'not_installed' | 'downloading' | 'paused' | 'verifying' | 'installed' | 'failed' | 'corrupted';

export interface DesktopModelRow {
  id: string;
  name: string;
  purpose: string;
  required: boolean;
  sizeBytes: number;
  status: DesktopModelStatus;
  percent?: number;
  receivedBytes: number;
  installPath: string;
  licenseName: string;
  commercialUse: 'allowed' | 'restricted' | 'unknown';
  errorMessage?: string;
}

export interface DesktopModelStatusResult {
  available: boolean;
  reason?: string;
  installRoot?: string;
  modelsRoot?: string;
  managerUrl?: string;
  overall?: { receivedBytes: number; totalBytes: number; percent?: number; indeterminate: boolean };
  models: DesktopModelRow[];
}

interface InstallConfigShape {
  version?: string;
  installRoot?: string;
  modelManifest?: string;
  ports?: { manager?: number };
}

interface ManifestFileShape {
  path?: string;
  sizeBytes?: number;
}

interface ManifestModelShape {
  id?: string;
  name?: string;
  purpose?: string;
  required?: boolean;
  installDir?: string;
  totalBytes?: number;
  files?: ManifestFileShape[];
  license?: { name?: string; commercialUse?: string };
}

interface ManifestShape {
  schemaVersion?: number;
  version?: string;
  models?: ManifestModelShape[];
}

interface DownloadStateShape {
  models?: Record<string, { status?: string; percent?: number; receivedBytes?: number; totalBytes?: number; error?: { message?: string } }>;
}

const DEFAULT_PORTS = { manager: 8790 };

export function defaultDesktopInstallRoot(env: NodeJS.ProcessEnv = process.env): string {
  const localAppData = env.LOCALAPPDATA?.trim() || join(env.USERPROFILE?.trim() || homedir(), 'AppData', 'Local');
  return join(localAppData, 'Programs', 'Zhiying');
}

function isStatus(value: unknown): value is DesktopModelStatus {
  return typeof value === 'string' && ['not_installed', 'downloading', 'paused', 'verifying', 'installed', 'failed', 'corrupted'].includes(value);
}

function normalizeInstallPath(modelsRoot: string, installDir: string): string {
  const prefix = installDir.replace(/[\\/]+$/, '');
  return `${modelsRoot.replace(/[\\/]+$/, '')}\\${prefix.replace(/\//g, '\\')}`;
}

function statusResult(reason: string): DesktopModelStatusResult {
  return { available: false, reason, models: [] };
}

async function readJson(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as unknown;
}

/** 读取安装版模型状态（缺失/损坏返回 available:false）。 */
export async function readDesktopModelStatus(
  options: { installRoot?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<DesktopModelStatusResult> {
  const env = options.env ?? process.env;
  if (env.M2V_DEV_MODE === '1' && !options.installRoot && !env.M2V_INSTALL_ROOT) {
    return statusResult('当前为开发模式，未检测到安装版目录。安装版用户可在“设置 → 模型”管理模型。');
  }
  const installRoot = options.installRoot?.trim() || env.M2V_INSTALL_ROOT?.trim() || defaultDesktopInstallRoot(env);
  if (!existsSync(installRoot)) {
    return statusResult(`未检测到知影安装版目录：${installRoot}。请先运行 Zhiying-Setup.exe 完成安装。`);
  }
  const configPath = join(installRoot, 'config', 'install.json');
  if (!existsSync(configPath)) {
    return statusResult(`安装目录缺少 config/install.json：${configPath}。请重新运行安装程序修复安装。`);
  }
  let config: InstallConfigShape;
  try {
    const parsed = await readJson(configPath);
    if (!parsed || typeof parsed !== 'object') return statusResult('config/install.json 内容不是对象。');
    config = parsed as InstallConfigShape;
  } catch (error) {
    return statusResult(`config/install.json 无法读取或已损坏：${(error as Error).message}`);
  }
  const root = typeof config.installRoot === 'string' && config.installRoot.trim() ? config.installRoot.trim() : installRoot;
  const modelsRoot = join(root, 'models');
  const manifestCandidates = [
    typeof config.modelManifest === 'string' ? join(root, config.modelManifest) : undefined,
    join(root, 'app', 'desktop', 'model-manifest.default.json'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  let manifest: ManifestShape | undefined;
  for (const candidate of manifestCandidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = await readJson(candidate);
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as ManifestShape).models)) {
        manifest = parsed as ManifestShape;
        break;
      }
    } catch {
      return statusResult(`模型清单已损坏：${candidate}。请重新安装或在模型管理器中修复。`);
    }
  }
  if (!manifest) return statusResult('未找到模型清单（models/.downloads/manifest.json）。请重新运行安装程序修复安装。');
  if (!Array.isArray(manifest.models) || manifest.models.length === 0) return statusResult('模型清单为空或格式不正确。');

  let downloadState: DownloadStateShape | undefined;
  const statePath = join(modelsRoot, '.downloads', 'state.json');
  if (existsSync(statePath)) {
    try {
      const parsed = await readJson(statePath);
      if (parsed && typeof parsed === 'object') downloadState = parsed as DownloadStateShape;
    } catch {
      return statusResult('模型下载状态文件已损坏（models/.downloads/state.json）。请打开模型管理器执行修复。');
    }
  }

  const managerPort = Number.isInteger(config.ports?.manager) ? (config.ports?.manager as number) : DEFAULT_PORTS.manager;
  const rows: DesktopModelRow[] = [];
  let receivedBytes = 0;
  let totalBytes = 0;
  let indeterminate = false;
  for (const entry of manifest.models) {
    if (!entry || typeof entry.id !== 'string') continue;
    const id = entry.id;
    const saved = downloadState?.models?.[id];
    const status: DesktopModelStatus = isStatus(saved?.status) ? saved!.status! : 'not_installed';
    const sizeBytes = typeof entry.totalBytes === 'number' && entry.totalBytes > 0 ? entry.totalBytes : 0;
    const entryReceived = typeof saved?.receivedBytes === 'number' && saved.receivedBytes > 0 ? saved.receivedBytes : 0;
    receivedBytes += entryReceived;
    // #140: same rule as ModelDownloadManager.computeOverall. An initialised state's own totalBytes is
    // the real size (the manifest's Ollama size is only an estimate); without one, the entry is
    // indeterminate unless installed. Only entries with no saved state fall back to the manifest.
    const savedTotal = saved ? (typeof saved.totalBytes === 'number' && saved.totalBytes > 0 ? saved.totalBytes : undefined) : sizeBytes || undefined;
    if (savedTotal !== undefined) totalBytes += savedTotal;
    else if (status !== 'installed') indeterminate = true;
    const row: DesktopModelRow = {
      id,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : id,
      purpose: typeof entry.purpose === 'string' ? entry.purpose : 'unknown',
      required: Boolean(entry.required),
      sizeBytes,
      status,
      receivedBytes: entryReceived,
      installPath: typeof entry.installDir === 'string' ? normalizeInstallPath(modelsRoot, entry.installDir) : modelsRoot,
      licenseName: typeof entry.license?.name === 'string' ? entry.license.name : '未知',
      commercialUse:
        entry.license?.commercialUse === 'allowed' || entry.license?.commercialUse === 'restricted'
          ? entry.license.commercialUse
          : 'unknown',
    };
    if (typeof saved?.percent === 'number') row.percent = saved.percent;
    if (saved?.error?.message) row.errorMessage = saved.error.message;
    rows.push(row);
  }
  const overall = indeterminate
    ? { receivedBytes, totalBytes, indeterminate: true }
    : {
        receivedBytes,
        totalBytes,
        percent: totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 1000) / 10) : undefined,
        indeterminate: false,
      };
  return {
    available: true,
    installRoot: root,
    modelsRoot,
    managerUrl: `http://127.0.0.1:${managerPort}`,
    overall,
    models: rows,
  };
}
