import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, mkdir, realpath, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, parse, resolve, sep } from 'node:path';
import { resolveInstallLayout } from './install-layout.js';
import type { InstallLayout } from './install-layout.js';

/**
 * #104 统一模型路径解析与 Windows 路径安全。
 *
 * 本模块是 `install-layout.ts` 的底层路径原语：
 * - 受保护目录/盘符根/穿越/非法字符/ADS/保留名一律在开始写盘前拒绝；
 * - 支持中文、空格与超过 240 字符的长路径（`\\?\` 扩展长度路径）；
 * - 不读取、不记录任何凭据。
 */

const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const WINDOWS_INVALID_CHARS = /[<>:"|?*\u0000-\u001f]/;

function buildProtectedDirs(): string[] {
  const values = new Set<string>([
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
  ]);
  for (const key of ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim()) values.add(value.trim());
  }
  return [...values].map(value => normalize(value.replace(/[\\/]+$/, '') || value));
}

/** Windows/Program Files/System32 等受保护目录（大小写不敏感比较）。 */
export const PROTECTED_DIRS: readonly string[] = Object.freeze(buildProtectedDirs());

function stripTrailingSeparator(input: string): string {
  if (input.length <= 3 && /^[A-Za-z]:[\\/]$/.test(input)) return input.slice(0, 2) + sep;
  let output = input;
  while (output.length > 1 && (output.endsWith('\\') || output.endsWith('/'))) {
    const root = parse(output).root;
    if (output === root) break;
    output = output.slice(0, -1);
  }
  return output;
}

function normalizeForComparison(input: string): string {
  return process.platform === 'win32' ? input.toLowerCase() : input;
}

function hasTraversalSegment(raw: string): boolean {
  return raw.split(/[\\/]/).some(segment => segment === '..');
}

function isUncOrDevicePath(raw: string): boolean {
  return /^[\\/]{2}/.test(raw);
}

/** 校验并规范化安装根目录；非法输入抛可读错误。 */
export function resolveInstallRootPath(raw: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('安装目录不能为空');
  const input = raw.trim();
  if (input.includes('\u0000')) throw new Error('安装目录包含非法字符（NUL）');
  if (isUncOrDevicePath(input)) throw new Error('不支持 UNC 网络路径或设备路径，请选择本地磁盘目录');
  if (!/^[A-Za-z]:[\\/]/.test(input)) throw new Error('安装目录必须是带盘符的绝对路径，例如 D:\\Zhiying');
  if (hasTraversalSegment(input)) throw new Error('安装目录不能包含“..”路径穿越片段');
  const normalized = stripTrailingSeparator(normalize(input));
  const driveRoot = parse(normalized).root;
  if (normalizeForComparison(normalized) === normalizeForComparison(stripTrailingSeparator(driveRoot))) {
    throw new Error('安装目录不能是盘符根目录，请选择其下的子目录，例如 D:\\Zhiying');
  }
  if (isProtectedDirectory(normalized)) {
    throw new Error(`安装目录不能位于受保护的系统目录（${normalized}），请选择当前用户可写目录，例如 %LOCALAPPDATA%\\Programs\\Zhiying`);
  }
  if (!existsSync(driveRoot)) throw new Error(`安装目录所在磁盘不存在：${driveRoot}`);
  return normalized;
}

/** `child` 是否位于 `parent` 内（含相等；Windows 大小写不敏感）。 */
export function isPathWithin(parent: string, child: string): boolean {
  if (typeof parent !== 'string' || typeof child !== 'string') return false;
  const parentAbs = normalize(resolve(parent));
  const childAbs = normalize(resolve(child));
  const left = normalizeForComparison(parentAbs);
  const right = normalizeForComparison(childAbs);
  if (left === right) return true;
  const prefix = left.endsWith(sep) ? left : `${left}${sep}`;
  return right.startsWith(prefix);
}

/** `target` 是否等于或位于某个受保护目录内。 */
export function isProtectedDirectory(target: string): boolean {
  if (typeof target !== 'string' || !target.trim()) return false;
  const resolved = normalize(resolve(target));
  return PROTECTED_DIRS.some(protectedDir => isPathWithin(protectedDir, resolved));
}

/**
 * 校验“相对安装根目录”的路径片段；返回使用平台分隔符的规范化相对路径。
 * 拒绝绝对路径、盘符、UNC、空段、`.`/`..`、非法字符、ADS、Windows 保留名。
 */
export function assertSafeRelativePath(rel: string): string {
  if (typeof rel !== 'string' || !rel.length) throw new Error('相对路径不能为空');
  if (rel.includes('\u0000')) throw new Error('相对路径包含非法字符（NUL）');
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw new Error(`相对路径不能是绝对路径：${rel}`);
  if (isUncOrDevicePath(rel)) throw new Error(`相对路径不能是 UNC/设备路径：${rel}`);
  const segments = rel.split(/[\\/]/);
  for (const segment of segments) {
    if (!segment) throw new Error(`相对路径不能包含空段：${rel}`);
    if (segment === '.' || segment === '..') throw new Error(`相对路径不能包含“${segment}”：${rel}`);
    if (WINDOWS_INVALID_CHARS.test(segment)) {
      throw new Error(`相对路径包含 Windows 非法字符（<>:"|?* 或控制字符）：${segment}`);
    }
    if (/[. ]$/.test(segment)) throw new Error(`相对路径片段不能以点或空格结尾：${segment}`);
    if (RESERVED_WINDOWS_NAMES.test(segment)) throw new Error(`相对路径包含 Windows 保留名称：${segment}`);
  }
  return segments.join(sep);
}

/** 将安装根目录与安全相对路径组合为绝对路径；越界时抛错。 */
export function resolveWithinRoot(root: string, relative: string): string {
  const rootAbs = resolve(root);
  const relativeSafe = assertSafeRelativePath(relative);
  const target = resolve(rootAbs, relativeSafe);
  if (!isPathWithin(rootAbs, target)) throw new Error(`目标路径越出安装目录：${relative}`);
  return target;
}

/** 超过 240 字符时返回带 `\\?\` 前缀的扩展长度路径（Windows）。 */
export function toExtendedLengthPath(absPath: string): string {
  const normalized = normalize(absPath);
  if (/^[\\/]{2}\?[\\/]/.test(normalized)) return normalized;
  if (normalized.length <= 240) return normalized;
  if (isUncOrDevicePath(normalized)) return `\\\\?\\UNC\\${normalized.replace(/^[\\/]+/, '')}`;
  return `\\\\?\\${normalized}`;
}

/** 实际写一个临时探针文件验证目录可写，随后删除探针。 */
export async function probeWritableDirectory(dir: string): Promise<boolean> {
  try {
    const stats = await stat(dir);
    if (!stats.isDirectory()) return false;
    const probePath = join(dir, `.m2v-write-probe-${randomUUID()}.tmp`);
    await writeFile(probePath, 'probe', { encoding: 'utf8' });
    await unlink(probePath);
    return true;
  } catch {
    return false;
  }
}

/** 返回目录所在卷的可用空间字节数（无法读取时返回 0）。 */
export async function getDiskFreeBytes(dir: string): Promise<number> {
  try {
    const stats = await statfs(dir);
    const free = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(free) && free > 0 ? free : 0;
  } catch {
    return 0;
  }
}

async function safeRealpath(path: string): Promise<string> {
  try {
    return normalize(await realpath(path));
  } catch {
    return normalize(resolve(path));
  }
}

function nearestExistingAncestor(path: string): string {
  let current = resolve(path);
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * 校验 `target` 在解析 reparse point / 符号链接后仍在 `installRoot` 内。
 * 越界视为安全错误并抛出可读中文错误。
 */
export async function assertNoReparseEscape(installRoot: string, target: string): Promise<void> {
  const rootRaw = normalize(resolve(installRoot));
  const targetAbs = normalize(resolve(target));
  if (!isPathWithin(rootRaw, targetAbs)) {
    throw new Error(`目标路径不在安装目录内：${targetAbs}`);
  }
  const rootReal = await safeRealpath(rootRaw);
  const ancestor = nearestExistingAncestor(targetAbs);
  const ancestorReal = await safeRealpath(ancestor);
  const withinReal = isPathWithin(rootReal, ancestorReal) || isPathWithin(rootRaw, ancestorReal);
  if (!withinReal) {
    throw new Error(`目标路径经过链接/重解析点后越出安装目录，已拒绝：${targetAbs}`);
  }
  if (existsSync(targetAbs)) {
    const targetReal = await safeRealpath(targetAbs);
    if (!isPathWithin(rootReal, targetReal) && !isPathWithin(rootRaw, targetReal)) {
      throw new Error(`目标路径经过链接/重解析点后越出安装目录，已拒绝：${targetAbs}`);
    }
  }
}

export interface PathValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  normalized?: string;
}

/**
 * 安装/模型写入前的完整路径校验（#103/#104 共用）：
 * 绝对路径、本地盘、非盘符根、非受保护目录、无穿越/非法字符/ADS、磁盘存在、按需可写。
 */
export async function validateInstallPath(
  raw: string,
  opts: { requireWritable?: boolean; allowExisting?: boolean } = {},
): Promise<PathValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { requireWritable = false, allowExisting = true } = opts;
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, errors: ['安装目录不能为空'], warnings };
  }
  const input = raw.trim();
  if (input.includes('\u0000')) return { ok: false, errors: ['安装目录包含非法字符（NUL）'], warnings };
  if (isUncOrDevicePath(input)) {
    return { ok: false, errors: ['不支持 UNC 网络路径或设备路径，请选择本地磁盘目录（如 D:\\Zhiying）'], warnings };
  }
  if (!isAbsolute(input) || !/^[A-Za-z]:[\\/]/.test(input)) {
    return { ok: false, errors: [`必须使用带盘符的绝对路径，例如 D:\\Zhiying（当前：${input}）`], warnings };
  }
  if (hasTraversalSegment(input)) {
    return { ok: false, errors: ['安装目录不能包含“..”路径穿越片段，请填写规范化后的目录'], warnings };
  }
  const normalized = stripTrailingSeparator(normalize(input));
  const driveRoot = parse(normalized).root;
  if (normalizeForComparison(normalized) === normalizeForComparison(stripTrailingSeparator(driveRoot))) {
    return { ok: false, errors: ['安装目录不能是盘符根目录，请选择其下的子目录'], warnings };
  }
  const remainder = normalized.slice(driveRoot.length);
  for (const segment of remainder.split(/[\\/]/)) {
    if (!segment) continue;
    if (WINDOWS_INVALID_CHARS.test(segment)) {
      errors.push(`安装目录包含 Windows 非法字符：${segment}`);
    } else if (/[. ]$/.test(segment)) {
      errors.push(`安装目录片段不能以点或空格结尾：${segment}`);
    } else if (RESERVED_WINDOWS_NAMES.test(segment)) {
      errors.push(`安装目录包含 Windows 保留名称：${segment}`);
    }
  }
  if (isProtectedDirectory(normalized)) {
    errors.push(
      `不能安装到受保护的系统目录：${normalized}。请选择当前用户可写目录（如 %LOCALAPPDATA%\\Programs\\Zhiying）或 D 盘自建目录。`,
    );
  }
  if (!existsSync(driveRoot)) errors.push(`安装目录所在磁盘不存在：${driveRoot}`);
  if (errors.length) return { ok: false, errors, warnings };
  if (normalized.length > 240) {
    warnings.push(`路径较长（${normalized.length} 字符），将使用扩展长度路径访问；建议缩短目录层级。`);
  }
  if (existsSync(normalized)) {
    try {
      const stats = await stat(normalized);
      if (!stats.isDirectory()) errors.push(`目标路径已被文件占用：${normalized}`);
    } catch (error) {
      errors.push(`无法读取目标路径：${normalized}（${String(error)}）`);
    }
    if (allowExisting) {
      warnings.push('目标目录已存在，安装程序将进入升级/修复模式并保留用户数据。');
    } else if (errors.length === 0) {
      errors.push(`目标目录已存在：${normalized}`);
    }
  }
  if (errors.length) return { ok: false, errors, warnings };
  if (requireWritable) {
    try {
      await access(normalized, 2 /* W_OK */);
    } catch {
      /* 目录不存在时继续检查最近的已存在父目录。 */
    }
    const probeTarget = existsSync(normalized) ? normalized : nearestExistingAncestor(dirname(normalized));
    const writable = await probeWritableDirectory(probeTarget);
    if (!writable) {
      errors.push(
        `目录不可写：${probeTarget}。请选择当前用户有写权限的目录（例如 %LOCALAPPDATA%\\Programs\\Zhiying），不要使用 Program Files 等受保护目录。`,
      );
    }
  }
  return { ok: errors.length === 0, errors, warnings, normalized };
}

export interface ModelDirectoryResolver {
  readonly modelsRoot: string;
  resolveModelsRoot(): string;
  resolveOllamaStore(): string;
  resolveF5TtsRoot(): string;
  resolveVocosRoot(): string;
  resolveHfCache(): string;
  resolveTempDownloadPath(): string;
  resolveModelInstallPath(modelId: string): string;
  ensureModelDirectories(): Promise<void>;
  describe(): Promise<{ modelsRoot: string; writable: boolean; freeBytes: number }>;
}

/**
 * 创建统一模型目录解析器。模型根恒为 `<InstallRoot>\\models`，与 CWD/全局环境变量无关。
 */
export function createModelDirectoryResolver(installRootOrLayout: string | InstallLayout): ModelDirectoryResolver {
  const layout = typeof installRootOrLayout === 'string' ? resolveInstallLayout(installRootOrLayout) : installRootOrLayout;
  if (!layout || typeof layout.modelsRoot !== 'string' || !layout.modelsRoot.trim()) {
    throw new Error('无效的安装布局：缺少 modelsRoot');
  }
  const modelsRoot = normalize(resolve(layout.modelsRoot));
  const ensureInsideModelsRoot = (target: string, label: string): string => {
    if (!isPathWithin(modelsRoot, target)) throw new Error(`${label} 越出模型根目录，已拒绝：${target}`);
    return target;
  };
  return {
    modelsRoot,
    resolveModelsRoot: () => modelsRoot,
    resolveOllamaStore: () => ensureInsideModelsRoot(join(modelsRoot, 'ollama'), 'Ollama 模型目录'),
    resolveF5TtsRoot: () => ensureInsideModelsRoot(join(modelsRoot, 'f5-tts', 'F5TTS_v1_Base'), 'F5-TTS 模型目录'),
    resolveVocosRoot: () => ensureInsideModelsRoot(join(modelsRoot, 'f5-tts', 'vocos-mel-24khz'), 'Vocos 模型目录'),
    resolveHfCache: () => ensureInsideModelsRoot(join(modelsRoot, 'huggingface'), 'Hugging Face 缓存目录'),
    resolveTempDownloadPath: () => ensureInsideModelsRoot(join(modelsRoot, '.downloads'), '模型下载临时目录'),
    resolveModelInstallPath: (modelId: string) => {
      if (typeof modelId !== 'string' || !modelId.trim()) throw new Error('模型 ID/安装子目录不能为空');
      return ensureInsideModelsRoot(resolveWithinRoot(modelsRoot, modelId), '模型安装目录');
    },
    ensureModelDirectories: async () => {
      const directories = [
        modelsRoot,
        join(modelsRoot, 'ollama'),
        join(modelsRoot, 'f5-tts'),
        join(modelsRoot, 'f5-tts', 'F5TTS_v1_Base'),
        join(modelsRoot, 'f5-tts', 'vocos-mel-24khz'),
        join(modelsRoot, 'huggingface'),
        join(modelsRoot, 'huggingface', 'hub'),
        join(modelsRoot, '.downloads'),
      ];
      for (const directory of directories) await mkdir(toExtendedLengthPath(directory), { recursive: true });
    },
    describe: async () => {
      let writable = false;
      try {
        await mkdir(toExtendedLengthPath(modelsRoot), { recursive: true });
        writable = await probeWritableDirectory(modelsRoot);
      } catch {
        writable = false;
      }
      const freeBytes = await getDiskFreeBytes(modelsRoot);
      return { modelsRoot, writable, freeBytes };
    },
  };
}

