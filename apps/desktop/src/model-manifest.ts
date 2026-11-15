import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';
import { assertSafeRelativePath } from './model-paths.js';

/**
 * #105 模型清单（manifest）类型、校验与加载。
 *
 * 默认清单由 `scripts/generate-model-manifest.mjs` 通过 Hugging Face Hub API 生成；
 * 不伪造哈希：拿不到可信 SHA-256 时退化到 `integrity: 'size'` 并在 license.notes 中说明。
 */

export type ModelPurpose = 'llm' | 'tts' | 'vocoder' | 'alignment';
export type ModelSourceKind = 'http' | 'huggingface' | 'ollama';
export type Integrity = 'sha256' | 'size' | 'ollama-digest';

export interface ModelFileSpec {
  path: string;
  sizeBytes: number;
  sha256?: string;
  url?: string;
}

export interface ModelLicense {
  name: string;
  url?: string;
  notes: string;
  commercialUse: 'allowed' | 'restricted' | 'unknown';
}

export interface ModelManifestEntry {
  id: string;
  name: string;
  purpose: ModelPurpose;
  required: boolean;
  source: { kind: ModelSourceKind; url?: string; repo?: string; revision?: string; ollamaModel?: string };
  installDir: string;
  integrity: Integrity;
  files: ModelFileSpec[];
  totalBytes: number;
  license: ModelLicense;
  dependencies?: string[];
}

export interface ModelManifest {
  schemaVersion: 1;
  version: string;
  generatedAt: string;
  models: ModelManifestEntry[];
}

const PURPOSE_VALUES: readonly ModelPurpose[] = ['llm', 'tts', 'vocoder', 'alignment'];
const SOURCE_KIND_VALUES: readonly ModelSourceKind[] = ['http', 'huggingface', 'ollama'];
const INTEGRITY_VALUES: readonly Integrity[] = ['sha256', 'size', 'ollama-digest'];
const COMMERCIAL_USE_VALUES: readonly ModelLicense['commercialUse'][] = ['allowed', 'restricted', 'unknown'];
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizedForCompare(value: string): string {
  return value.replace(/\//g, sep).toLowerCase();
}

function directoryOverlaps(left: string, right: string): boolean {
  const a = normalizedForCompare(left).replace(/[\\/]+$/, '');
  const b = normalizedForCompare(right).replace(/[\\/]+$/, '');
  if (!a || !b) return false;
  if (a === b) return true;
  const separator = sep;
  return a.startsWith(`${b}${separator}`) || b.startsWith(`${a}${separator}`);
}

function validateFileSpec(
  errors: string[],
  entryId: string,
  file: unknown,
  index: number,
  integrity: Integrity,
): ModelFileSpec | undefined {
  const label = `models[${entryId}].files[${index}]`;
  if (!isPlainObject(file)) {
    errors.push(`${label} 必须是对象`);
    return undefined;
  }
  const spec: ModelFileSpec = { path: '', sizeBytes: 0 };
  if (typeof file.path !== 'string' || !file.path.trim()) {
    errors.push(`${label}.path 不能为空`);
  } else {
    try {
      assertSafeRelativePath(file.path);
      spec.path = file.path;
    } catch (error) {
      errors.push(`${label}.path 非法：${(error as Error).message}`);
    }
  }
  if (typeof file.sizeBytes !== 'number' || !Number.isInteger(file.sizeBytes) || file.sizeBytes < 0) {
    errors.push(`${label}.sizeBytes 必须是 ≥0 的整数`);
  } else {
    spec.sizeBytes = file.sizeBytes;
  }
  if (file.sha256 !== undefined) {
    if (typeof file.sha256 !== 'string' || !SHA256_PATTERN.test(file.sha256)) {
      errors.push(`${label}.sha256 必须是 64 位小写十六进制字符串`);
    } else {
      spec.sha256 = file.sha256;
    }
  }
  if (file.url !== undefined) {
    const url = file.url;
    if (typeof url !== 'string' || !isHttpUrl(url)) errors.push(`${label}.url 必须是 http(s) 地址`);
    else spec.url = url;
  }
  if (integrity === 'sha256' && !spec.sha256) {
    errors.push(`${label}.sha256 在 integrity='sha256' 时必填`);
  }
  return spec;
}

function validateEntry(errors: string[], raw: unknown, index: number): ModelManifestEntry | undefined {
  const label = `models[${index}]`;
  if (!isPlainObject(raw)) {
    errors.push(`${label} 必须是对象`);
    return undefined;
  }
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!MODEL_ID_PATTERN.test(id)) {
    errors.push(`${label}.id 必须匹配 [a-z0-9][a-z0-9._-]*（当前：${String(raw.id)}）`);
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) errors.push(`${label}.name 不能为空`);
  if (!PURPOSE_VALUES.includes(raw.purpose as ModelPurpose)) {
    errors.push(`${label}.purpose 必须是 ${PURPOSE_VALUES.join('/')}`);
  }
  if (typeof raw.required !== 'boolean') errors.push(`${label}.required 必须是布尔值`);
  let source: ModelManifestEntry['source'] | undefined;
  if (!isPlainObject(raw.source)) {
    errors.push(`${label}.source 必须是对象`);
  } else {
    source = { kind: raw.source.kind as ModelSourceKind };
    if (!SOURCE_KIND_VALUES.includes(source.kind)) {
      errors.push(`${label}.source.kind 必须是 ${SOURCE_KIND_VALUES.join('/')}`);
    } else if (source.kind === 'ollama') {
      if (typeof raw.source.ollamaModel !== 'string' || !raw.source.ollamaModel.trim()) {
        errors.push(`${label}.source.ollamaModel 在 ollama 源时必填`);
      } else {
        source.ollamaModel = raw.source.ollamaModel.trim();
      }
    } else if (source.kind === 'huggingface') {
      if (typeof raw.source.repo !== 'string' || !REPO_PATTERN.test(raw.source.repo)) {
        errors.push(`${label}.source.repo 必须是 org/repo 形式`);
      } else {
        source.repo = raw.source.repo;
      }
      if (typeof raw.source.revision !== 'string' || !raw.source.revision.trim()) {
        errors.push(`${label}.source.revision 在 huggingface 源时必填（固定 revision）`);
      } else {
        source.revision = raw.source.revision.trim();
      }
    } else if (source.kind === 'http') {
      if (raw.source.url !== undefined && !isHttpUrl(raw.source.url)) {
        errors.push(`${label}.source.url 必须是 http(s) 地址`);
      } else if (typeof raw.source.url === 'string') {
        source.url = raw.source.url;
      }
    }
  }
  let installDir = '';
  if (typeof raw.installDir !== 'string' || !raw.installDir.trim()) {
    errors.push(`${label}.installDir 不能为空`);
  } else {
    try {
      installDir = assertSafeRelativePath(raw.installDir);
    } catch (error) {
      errors.push(`${label}.installDir 非法：${(error as Error).message}`);
    }
  }
  const integrity = raw.integrity as Integrity;
  if (!INTEGRITY_VALUES.includes(integrity)) {
    errors.push(`${label}.integrity 必须是 ${INTEGRITY_VALUES.join('/')}`);
  }
  let files: ModelFileSpec[] = [];
  if (!Array.isArray(raw.files)) {
    errors.push(`${label}.files 必须是数组`);
  } else {
    if (integrity !== 'ollama-digest' && raw.files.length === 0) {
      errors.push(`${label}.files 在非 ollama 源时不能为空`);
    }
    files = raw.files
      .map((file, fileIndex) => validateFileSpec(errors, id || String(index), file, fileIndex, integrity))
      .filter((file): file is ModelFileSpec => file !== undefined);
  }
  let totalBytes = 0;
  if (typeof raw.totalBytes !== 'number' || !Number.isInteger(raw.totalBytes) || raw.totalBytes <= 0) {
    errors.push(`${label}.totalBytes 必须是 >0 的整数`);
  } else {
    totalBytes = raw.totalBytes;
  }
  if (files.length > 0) {
    const sum = files.reduce((accumulator, file) => accumulator + file.sizeBytes, 0);
    if (sum !== totalBytes) errors.push(`${label}.totalBytes（${totalBytes}）必须等于 files 大小之和（${sum}）`);
  }
  let license: ModelLicense | undefined;
  if (!isPlainObject(raw.license)) {
    errors.push(`${label}.license 必填`);
  } else {
    license = {
      name: typeof raw.license.name === 'string' ? raw.license.name : '',
      notes: typeof raw.license.notes === 'string' ? raw.license.notes : '',
      commercialUse: raw.license.commercialUse as ModelLicense['commercialUse'],
    };
    if (!license.name.trim()) errors.push(`${label}.license.name 不能为空`);
    if (typeof raw.license.notes !== 'string') errors.push(`${label}.license.notes 必须是字符串`);
    if (!COMMERCIAL_USE_VALUES.includes(license.commercialUse)) {
      errors.push(`${label}.license.commercialUse 必须是 ${COMMERCIAL_USE_VALUES.join('/')}`);
    }
    if (raw.license.url !== undefined) {
      const licenseUrl = raw.license.url;
      if (typeof licenseUrl !== 'string' || !isHttpUrl(licenseUrl)) errors.push(`${label}.license.url 必须是 http(s) 地址`);
      else license.url = licenseUrl;
    }
  }
  let dependencies: string[] | undefined;
  if (raw.dependencies !== undefined) {
    if (!Array.isArray(raw.dependencies) || raw.dependencies.some(item => typeof item !== 'string')) {
      errors.push(`${label}.dependencies 必须是字符串数组`);
    } else {
      dependencies = [...raw.dependencies];
    }
  }
  if (id && !MODEL_ID_PATTERN.test(id)) return undefined;
  if (!source || !license) return undefined;
  const entry: ModelManifestEntry = {
    id,
    name: typeof raw.name === 'string' ? raw.name : '',
    purpose: raw.purpose as ModelPurpose,
    required: raw.required as boolean,
    source,
    installDir,
    integrity,
    files,
    totalBytes,
    license,
  };
  if (dependencies) entry.dependencies = dependencies;
  return entry;
}

/** 校验任意输入是否为合法模型清单；非法输入返回可读错误列表。 */
export function validateModelManifest(
  input: unknown,
): { ok: true; manifest: ModelManifest } | { ok: false; errors: string[] } {
  if (!isPlainObject(input)) return { ok: false, errors: ['模型清单必须是一个 JSON 对象'] };
  const errors: string[] = [];
  if (input.schemaVersion !== 1) errors.push('schemaVersion 必须为 1');
  const version = typeof input.version === 'string' ? input.version : '';
  if (!version.trim()) errors.push('version 不能为空');
  const generatedAt = typeof input.generatedAt === 'string' ? input.generatedAt : '';
  if (!generatedAt || !Number.isFinite(Date.parse(generatedAt))) errors.push('generatedAt 必须是 ISO 时间字符串');
  const models: ModelManifestEntry[] = [];
  if (!Array.isArray(input.models) || input.models.length === 0) {
    errors.push('models 必须是非空数组');
  } else {
    const seen = new Set<string>();
    input.models.forEach((raw, index) => {
      const entry = validateEntry(errors, raw, index);
      if (!entry) return;
      if (entry.id) {
        if (seen.has(entry.id)) errors.push(`models 中存在重复 id：${entry.id}`);
        seen.add(entry.id);
      }
      models.push(entry);
    });
    for (let left = 0; left < models.length; left += 1) {
      for (let right = left + 1; right < models.length; right += 1) {
        if (models[left].installDir && models[right].installDir && directoryOverlaps(models[left].installDir, models[right].installDir)) {
          errors.push(`models[${models[left].id}].installDir 与 models[${models[right].id}].installDir 互相重叠`);
        }
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    manifest: { schemaVersion: 1, version, generatedAt, models },
  };
}

/** 读取并校验模型清单文件。 */
export async function loadModelManifest(path: string): Promise<ModelManifest> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`读取模型清单失败：${path}（${String(error)}）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`模型清单不是合法 JSON：${path}（${(error as Error).message}）`);
  }
  const result = validateModelManifest(parsed);
  if (!result.ok) throw new Error(`模型清单校验失败：${path}\n- ${result.errors.join('\n- ')}`);
  return result.manifest;
}

/** 读取随包默认清单（`src/model-manifest.default.json`）并校验。 */
export function defaultModelManifest(): ModelManifest {
  const path = fileURLToPath(new URL('./model-manifest.default.json', import.meta.url));
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`读取内置模型清单失败：${path}（${String(error)}）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`内置模型清单不是合法 JSON：${path}（${(error as Error).message}）`);
  }
  const result = validateModelManifest(parsed);
  if (!result.ok) throw new Error(`内置模型清单校验失败：${path}\n- ${result.errors.join('\n- ')}`);
  return result.manifest;
}

export function manifestEntryById(manifest: ModelManifest, id: string): ModelManifestEntry | undefined {
  return manifest.models.find(entry => entry.id === id);
}

export function requiredModelIds(manifest: ModelManifest): string[] {
  return manifest.models.filter(entry => entry.required).map(entry => entry.id);
}

function encodeRelativePath(path: string): string {
  return path
    .split(/[\\/]/)
    .filter(segment => segment.length > 0)
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

/**
 * 解析模型文件的真实下载地址。
 *
 * - `file.url` 优先；
 * - huggingface 源按固定 revision 推导 `https://huggingface.co/<repo>/resolve/<revision>/<path>`；
 * - http 源按 `source.url` + 相对路径拼接；
 * - `baseUrl` 用于测试/本地镜像：替换默认地址的 origin（保留 path/query），
 *   例如 fixture 服务只需按任意 path 返回字节即可。
 */
export function resolveSourceUrl(entry: ModelManifestEntry, file: ModelFileSpec, baseUrl?: string): string {
  let raw = file.url;
  if (!raw && entry.source.kind === 'huggingface' && entry.source.repo) {
    const revision = entry.source.revision ?? 'main';
    raw = `https://huggingface.co/${entry.source.repo}/resolve/${encodeRelativePath(revision)}/${encodeRelativePath(file.path)}`;
  }
  if (!raw && entry.source.kind === 'http' && entry.source.url) {
    raw = `${entry.source.url.replace(/\/+$/, '')}/${encodeRelativePath(file.path)}`;
  }
  if (!raw) {
    throw new Error(`无法解析模型文件下载地址：${entry.id}/${file.path}（Ollama 模型由 ollama pull 管理）`);
  }
  if (!baseUrl) return raw;
  const target = new URL(raw);
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const relativePath = target.pathname.replace(/^\/+/, '');
  return new URL(`${relativePath}${target.search}`, base).toString();
}
