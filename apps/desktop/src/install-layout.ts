import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import {
  assertSafeRelativePath,
  isPathWithin,
  resolveInstallRootPath,
} from './model-paths.js';

/**
 * #102/#103/#104 安装布局与 `config/install.json` 唯一读写实现。
 *
 * 只有本模块可以定义安装目录结构；其它模块必须通过 `resolveInstallLayout` /
 * `loadInstallConfig` / `writeInstallConfig` 访问，禁止自行推导路径。
 */

export const INSTALL_CONFIG_SCHEMA_VERSION = 1 as const;

export const DEFAULT_PORTS: Readonly<{ web: number; python: number; ollama: number; manager: number }> = Object.freeze({
  web: 3000,
  python: 8000,
  ollama: 11434,
  manager: 8790,
});

export type PayloadProfile = 'lite' | 'full';

export interface InstallConfig {
  schemaVersion: 1;
  product: 'zhiying';
  version: string;
  installRoot: string;
  installedAt: string;
  updatedAt?: string;
  perUser: boolean;
  payloadProfile: PayloadProfile;
  runtime: { node: string; python?: string; ffmpegDir?: string; ollama?: string };
  ports: { web: number; python: number; ollama: number; manager: number };
  managedProcesses: { ollama: boolean };
  modelManifest: string;
  modelsDownloadChoice?: 'now' | 'later';
  firstRunCompleted: boolean;
}

export interface InstallLayout {
  installRoot: string;
  app: string;
  runtime: string;
  modelsRoot: string;
  data: string;
  config: string;
  logs: string;
  modelsOllama: string;
  modelsF5Tts: string;
  modelsVocos: string;
  modelsHuggingFace: string;
  downloads: string;
  installConfigPath: string;
  serviceStatePath: string;
  modelStatePath: string;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function isValidIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function validateRelativeField(errors: string[], label: string, value: unknown, optional = false): void {
  if (value === undefined || value === null) {
    if (!optional) errors.push(`${label} 不能为空`);
    return;
  }
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${label} 必须是非空字符串的相对路径`);
    return;
  }
  try {
    assertSafeRelativePath(value);
  } catch (error) {
    errors.push(`${label} 必须是安装目录内的安全相对路径：${(error as Error).message}`);
  }
}

function validatePort(errors: string[], label: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    errors.push(`${label} 必须是 1–65535 的整数端口`);
  }
}

function buildValidatedConfig(input: Record<string, unknown>): InstallConfig {
  const runtime = (input.runtime ?? {}) as Record<string, unknown>;
  const ports = (input.ports ?? {}) as Record<string, unknown>;
  const managedProcesses = (input.managedProcesses ?? {}) as Record<string, unknown>;
  const config: InstallConfig = {
    schemaVersion: INSTALL_CONFIG_SCHEMA_VERSION,
    product: 'zhiying',
    version: input.version as string,
    installRoot: input.installRoot as string,
    installedAt: input.installedAt as string,
    perUser: input.perUser as boolean,
    payloadProfile: input.payloadProfile as PayloadProfile,
    runtime: { node: runtime.node as string },
    ports: {
      web: ports.web as number,
      python: ports.python as number,
      ollama: ports.ollama as number,
      manager: ports.manager as number,
    },
    managedProcesses: { ollama: managedProcesses.ollama as boolean },
    modelManifest: input.modelManifest as string,
    firstRunCompleted: input.firstRunCompleted as boolean,
  };
  if (typeof input.updatedAt === 'string') config.updatedAt = input.updatedAt;
  if (typeof runtime.python === 'string') config.runtime.python = runtime.python;
  if (typeof runtime.ffmpegDir === 'string') config.runtime.ffmpegDir = runtime.ffmpegDir;
  if (typeof runtime.ollama === 'string') config.runtime.ollama = runtime.ollama;
  if (input.modelsDownloadChoice === 'now' || input.modelsDownloadChoice === 'later') {
    config.modelsDownloadChoice = input.modelsDownloadChoice;
  }
  return config;
}

/**
 * 校验任意输入是否为合法 `InstallConfig`；未知字段被忽略（向前兼容）。
 */
export function validateInstallConfig(
  input: unknown,
): { ok: true; config: InstallConfig } | { ok: false; errors: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['安装配置必须是一个 JSON 对象'] };
  }
  const raw = input as Record<string, unknown>;
  const errors: string[] = [];
  if (raw.schemaVersion !== INSTALL_CONFIG_SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须为 ${INSTALL_CONFIG_SCHEMA_VERSION}`);
  }
  if (raw.product !== 'zhiying') errors.push('product 必须为 "zhiying"');
  if (typeof raw.version !== 'string' || !VERSION_PATTERN.test(raw.version)) {
    errors.push('version 必须是形如 1.8.0 的版本号');
  }
  if (typeof raw.installRoot !== 'string' || !raw.installRoot.trim()) {
    errors.push('installRoot 不能为空');
  } else {
    try {
      const normalized = resolveInstallRootPath(raw.installRoot);
      if (normalize(normalized) !== normalize(raw.installRoot.trim())) {
        errors.push(`installRoot 必须是规范化后的绝对路径：${normalized}`);
      }
    } catch (error) {
      errors.push(`installRoot 非法：${(error as Error).message}`);
    }
  }
  if (!isValidIsoDate(raw.installedAt)) errors.push('installedAt 必须是 ISO 时间字符串');
  if (raw.updatedAt !== undefined && !isValidIsoDate(raw.updatedAt)) errors.push('updatedAt 必须是 ISO 时间字符串');
  if (typeof raw.perUser !== 'boolean') errors.push('perUser 必须是布尔值');
  if (raw.payloadProfile !== 'lite' && raw.payloadProfile !== 'full') errors.push('payloadProfile 必须是 "lite" 或 "full"');
  const runtime = raw.runtime;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    errors.push('runtime 必须是对象');
  } else {
    const runtimeRecord = runtime as Record<string, unknown>;
    validateRelativeField(errors, 'runtime.node', runtimeRecord.node);
    validateRelativeField(errors, 'runtime.python', runtimeRecord.python, true);
    validateRelativeField(errors, 'runtime.ffmpegDir', runtimeRecord.ffmpegDir, true);
    validateRelativeField(errors, 'runtime.ollama', runtimeRecord.ollama, true);
    if (typeof raw.installRoot === 'string' && raw.installRoot.trim()) {
      try {
        const root = resolveInstallRootPath(raw.installRoot);
        for (const key of ['node', 'python', 'ffmpegDir', 'ollama']) {
          const value = runtimeRecord[key];
          if (typeof value !== 'string' || !value.trim()) continue;
          const target = join(root, assertSafeRelativePath(value));
          if (!isPathWithin(root, target)) errors.push(`runtime.${key} 必须位于安装目录内`);
        }
      } catch {
        /* installRoot 的错误已单独报告。 */
      }
    }
  }
  const ports = raw.ports;
  if (!ports || typeof ports !== 'object' || Array.isArray(ports)) {
    errors.push('ports 必须是对象');
  } else {
    const portRecord = ports as Record<string, unknown>;
    validatePort(errors, 'ports.web', portRecord.web);
    validatePort(errors, 'ports.python', portRecord.python);
    validatePort(errors, 'ports.ollama', portRecord.ollama);
    validatePort(errors, 'ports.manager', portRecord.manager);
  }
  const managedProcesses = raw.managedProcesses;
  if (!managedProcesses || typeof managedProcesses !== 'object' || Array.isArray(managedProcesses)) {
    errors.push('managedProcesses 必须是对象');
  } else if (typeof (managedProcesses as Record<string, unknown>).ollama !== 'boolean') {
    errors.push('managedProcesses.ollama 必须是布尔值');
  }
  validateRelativeField(errors, 'modelManifest', raw.modelManifest);
  if (raw.modelsDownloadChoice !== undefined && raw.modelsDownloadChoice !== 'now' && raw.modelsDownloadChoice !== 'later') {
    errors.push('modelsDownloadChoice 必须是 "now" 或 "later"');
  }
  if (typeof raw.firstRunCompleted !== 'boolean') errors.push('firstRunCompleted 必须是布尔值');
  if (errors.length) return { ok: false, errors };
  return { ok: true, config: buildValidatedConfig(raw) };
}

/**
 * 计算 `<InstallRoot>` 下所有约定路径；不触碰文件系统（只校验路径形态）。
 */
export function resolveInstallLayout(installRoot: string): InstallLayout {
  const root = resolveInstallRootPath(installRoot);
  const modelsRoot = join(root, 'models');
  const data = join(root, 'data');
  let downloads = join(modelsRoot, '.downloads');
  downloads = normalize(downloads);
  return {
    installRoot: root,
    app: join(root, 'app'),
    runtime: join(root, 'runtime'),
    modelsRoot,
    data,
    config: join(root, 'config'),
    logs: join(root, 'logs'),
    modelsOllama: join(modelsRoot, 'ollama'),
    modelsF5Tts: join(modelsRoot, 'f5-tts', 'F5TTS_v1_Base'),
    modelsVocos: join(modelsRoot, 'f5-tts', 'vocos-mel-24khz'),
    modelsHuggingFace: join(modelsRoot, 'huggingface'),
    downloads,
    installConfigPath: join(root, 'config', 'install.json'),
    serviceStatePath: join(data, 'runtime', 'services.json'),
    modelStatePath: join(downloads, 'state.json'),
  };
}

/** 读取并校验 `config/install.json`；失败给出可读中文错误。 */
export async function loadInstallConfig(installRoot: string): Promise<InstallConfig> {
  const layout = resolveInstallLayout(installRoot);
  let raw: string;
  try {
    raw = await readFile(layout.installConfigPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`未找到安装配置文件：${layout.installConfigPath}（请先运行 Zhiying-Setup.exe 完成安装）`);
    }
    throw new Error(`读取安装配置文件失败：${layout.installConfigPath}（${String(error)}）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`安装配置文件不是合法 JSON：${layout.installConfigPath}（${(error as Error).message}）`);
  }
  const result = validateInstallConfig(parsed);
  if (!result.ok) {
    throw new Error(`安装配置文件校验失败：${layout.installConfigPath}\n- ${result.errors.join('\n- ')}`);
  }
  if (normalize(result.config.installRoot) !== normalize(layout.installRoot)) {
    throw new Error(
      `安装配置指向的目录与当前请求不一致：配置=${result.config.installRoot}，请求=${layout.installRoot}`,
    );
  }
  return result.config;
}

/** 原子写入 `config/install.json`（同目录临时文件 + rename，避免半写）。 */
export async function writeInstallConfig(config: InstallConfig): Promise<void> {
  const validation = validateInstallConfig(config);
  if (!validation.ok) throw new Error(`拒绝写入非法安装配置：\n- ${validation.errors.join('\n- ')}`);
  const layout = resolveInstallLayout(validation.config.installRoot);
  await mkdir(layout.config, { recursive: true });
  await writeJsonAtomic(layout.installConfigPath, validation.config);
}

/** 目录存在判断（同步，供快速路径探测）。 */
export function pathExists(target: string): boolean {
  return existsSync(target);
}

/** 确保目录存在（含长路径支持）。 */
export async function ensureDirectory(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
}

/** 读取 JSON 文件；错误信息带路径与解析原因。 */
export async function readJsonFile<T = unknown>(filePath: string): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`读取 JSON 文件失败：${filePath}（${String(error)}）`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`JSON 文件内容损坏：${filePath}（${(error as Error).message}）`);
  }
}

/** 原子写 JSON：同目录临时文件 + rename，失败清理临时文件。 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const target = normalize(resolve(filePath));
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try {
      await rename(temp, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EEXIST' || code === 'EACCES') {
        await unlink(target).catch(() => undefined);
        await rename(temp, target);
      } else {
        throw error;
      }
    }
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw new Error(`写入 JSON 文件失败：${target}（${String(error)}）`);
  }
}

/** 本地时间戳 `yyyyMMdd-HHmmss`，用于日志/备份目录名。 */
export function formatTimestamp(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 由安装配置触发路径（供启动器/维护读取，禁止在业务代码里重新推导）。 */
export function layoutFromConfig(config: InstallConfig): InstallLayout {
  const layout = resolveInstallLayout(config.installRoot);
  return layout;
}
