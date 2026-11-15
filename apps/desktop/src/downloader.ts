import { createHash } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, link, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { getDiskFreeBytes } from './model-paths.js';
import type { ModelDirectoryResolver } from './model-paths.js';
import { readJsonFile, writeJsonAtomic } from './install-layout.js';
import { resolveSourceUrl } from './model-manifest.js';
import type { ModelFileSpec, ModelManifest, ModelManifestEntry } from './model-manifest.js';
import { OllamaPullRunner } from './ollama-pull.js';

/**
 * #105 模型下载管理器：真实进度、Range 断点续传、暂停/恢复/取消/重试、
 * 完整性校验、原子提交、状态持久化与 Ollama pull 适配。
 *
 * 设计不变量：
 * - 只有全部文件校验通过后才把 `.part` 原子 rename 到目标位置，绝不“假完成”；
 * - 临时文件、状态、manifest 全部位于 `<InstallRoot>\\models` 内；
 * - 无 Content-Length 时 `percent` 保持 undefined，不伪造百分比；
 * - 外部注入 `fetchImpl` / `spawnImpl` / `now` / `diskFreeBytes` / `hashFile` 便于真实 E2E 测试。
 */

export type DownloadStatus = 'not_installed' | 'downloading' | 'paused' | 'verifying' | 'installed' | 'failed' | 'corrupted';
export type DownloadPhase = 'idle' | 'download' | 'extract' | 'verify' | 'load' | 'error';

export interface FileProgress {
  path: string;
  receivedBytes: number;
  totalBytes?: number;
  percent?: number;
  speedBps?: number;
}

export interface ModelState {
  id: string;
  status: DownloadStatus;
  phase: DownloadPhase;
  receivedBytes: number;
  totalBytes?: number;
  percent?: number;
  speedBps?: number;
  etaSeconds?: number;
  files: FileProgress[];
  partialKept: boolean;
  error?: { code: string; message: string };
  verified?: 'sha256' | 'size' | 'ollama-digest';
}

export interface DownloadManagerOptions {
  manifest: ModelManifest;
  resolver: ModelDirectoryResolver;
  statePath: string;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof nodeSpawn;
  now?: () => number;
  concurrency?: number;
  diskFreeBytes?: (dir: string) => Promise<number>;
  hashFile?: (path: string) => Promise<string>;
  /** 本地镜像/测试用下载根地址；覆盖默认 HF/HTTP 地址的 origin。 */
  sourceBaseUrl?: string;
  /** 受管 ollama 可执行文件（默认推导 `<installRoot>\\runtime\\ollama\\ollama.exe`）。 */
  ollamaCommand?: string;
  /** 传给 ollama pull 的额外环境变量（必须包含受管 OLLAMA_MODELS）。 */
  ollamaEnv?: NodeJS.ProcessEnv;
}

interface ResumeMeta {
  etag?: string;
  lastModified?: string;
}

interface RuntimeModel {
  entry: ModelManifestEntry;
  state: ModelState;
  controller?: AbortController;
  abortReason?: 'pause' | 'cancel' | 'dispose';
  cancelKeepPartial?: boolean;
  task?: Promise<void>;
  resume: Record<string, ResumeMeta>;
  startedFiles: Set<string>;
  speedAt?: number;
  speedBytes?: number;
  speedEma?: number;
  ollama?: OllamaPullRunner;
  layerProgress: Map<string, { total?: number; completed: number }>;
}

interface PersistedDownloadState {
  schemaVersion: 1;
  updatedAt: string;
  models: Record<string, ModelState>;
  resume?: Record<string, Record<string, ResumeMeta>>;
}

class DownloadError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
    this.retryable = retryable;
  }
}

const RETRY_DELAYS_MS = [500, 1000, 2000];
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

function delay(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DownloadError) return error.code === 'aborted';
  const name = (error as Error | undefined)?.name;
  return name === 'AbortError' || /aborted|abort/i.test(String((error as Error | undefined)?.message ?? ''));
}

function cloneState(state: ModelState): ModelState {
  return {
    ...state,
    files: state.files.map(file => ({ ...file })),
    ...(state.error ? { error: { ...state.error } } : {}),
  };
}

function initialState(entry: ModelManifestEntry): ModelState {
  const hasTotal = Number.isFinite(entry.totalBytes) && entry.totalBytes > 0;
  return {
    id: entry.id,
    status: 'not_installed',
    phase: 'idle',
    receivedBytes: 0,
    ...(hasTotal ? { totalBytes: entry.totalBytes, percent: 0 } : {}),
    files: entry.files.map(file => ({
      path: file.path,
      receivedBytes: 0,
      totalBytes: file.sizeBytes,
      percent: file.sizeBytes > 0 ? 0 : undefined,
    })),
    partialKept: false,
  };
}

function bytesLabel(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${Math.round(gb * 10) / 10} GB`;
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${Math.round(mb * 10) / 10} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function normalizeRelativePath(path: string): string {
  return path.split(/[\\/]/).filter(segment => segment.length > 0).join(sep);
}

function isHfCacheEntry(entry: ModelManifestEntry): boolean {
  if (entry.integrity !== 'sha256') return false;
  if (entry.source.kind !== 'huggingface' || !entry.source.repo) return false;
  const installDir = entry.installDir.replace(/\//g, sep).replace(/^[\\/]+/, '').toLowerCase();
  return installDir === 'huggingface' || installDir.startsWith(`huggingface${sep}`);
}

/** 默认 SHA-256 文件哈希（流式，不一次性读入内存）。 */
export async function hashFileSha256(path: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', rejectPromise);
    stream.once('end', () => resolvePromise(hash.digest('hex')));
  });
}

/**
 * 模型下载管理器。
 */
export class ModelDownloadManager {
  private readonly options: DownloadManagerOptions;
  private readonly manifest: ModelManifest;
  private readonly resolver: ModelDirectoryResolver;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof nodeSpawn;
  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly diskFree: (dir: string) => Promise<number>;
  private readonly hashFile: (path: string) => Promise<string>;
  private readonly runtimes = new Map<string, RuntimeModel>();
  private readonly listeners = new Set<(states: ModelState[]) => void>();
  private readonly queue: RuntimeModel[] = [];
  private active = 0;
  private persistChain: Promise<void> = Promise.resolve();
  private lastPersistAt = 0;
  private lastEmitAt = 0;
  private disposed = false;

  constructor(options: DownloadManagerOptions) {
    this.options = options;
    this.manifest = options.manifest;
    this.resolver = options.resolver;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnImpl = options.spawnImpl ?? nodeSpawn;
    this.now = options.now ?? Date.now;
    this.concurrency = Math.min(4, Math.max(1, Math.floor(options.concurrency ?? 2)));
    this.diskFree = options.diskFreeBytes ?? getDiskFreeBytes;
    this.hashFile = options.hashFile ?? hashFileSha256;
    for (const entry of this.manifest.models) {
      this.runtimes.set(entry.id, {
        entry,
        state: initialState(entry),
        resume: {},
        startedFiles: new Set(),
        layerProgress: new Map(),
      });
    }
  }

  /** 当前所有模型状态快照（按 manifest 顺序）。 */
  list(): ModelState[] {
    return this.manifest.models.map(entry => cloneState(this.runtimes.get(entry.id)!.state));
  }

  /** 只读访问当前清单（UI/服务用于补充名称、用途、许可证等元信息）。 */
  getManifest(): ModelManifest {
    return this.manifest;
  }

  get(id: string): ModelState {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`未知模型 id：${id}`);
    return cloneState(runtime.state);
  }

  onProgress(listener: (states: ModelState[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(force = false): void {
    if (this.listeners.size === 0) return;
    const nowMs = this.now();
    if (!force && nowMs - this.lastEmitAt < 120) return;
    this.lastEmitAt = nowMs;
    const snapshot = this.list();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* 监听器异常不影响下载。 */
      }
    }
  }

  private buildPersistedState(): PersistedDownloadState {
    const models: Record<string, ModelState> = {};
    const resume: Record<string, Record<string, ResumeMeta>> = {};
    for (const [id, runtime] of this.runtimes) {
      models[id] = cloneState(runtime.state);
      if (Object.keys(runtime.resume).length > 0) resume[id] = runtime.resume;
    }
    return { schemaVersion: 1, updatedAt: new Date(this.now()).toISOString(), models, resume };
  }

  private persistNow(): Promise<void> {
    const payload = this.buildPersistedState();
    this.persistChain = this.persistChain
      .then(async () => {
        await writeJsonAtomic(this.options.statePath, payload);
        this.lastPersistAt = this.now();
      })
      .catch(() => undefined);
    return this.persistChain;
  }

  private persistThrottled(force = false): void {
    const nowMs = this.now();
    if (!force && nowMs - this.lastPersistAt < 500) return;
    void this.persistNow();
  }

  private tempFilePath(entry: ModelManifestEntry, file: ModelFileSpec): string {
    const downloads = this.resolver.resolveTempDownloadPath();
    return join(downloads, entry.id, `${normalizeRelativePath(file.path)}.part`);
  }

  private flatTargetPath(entry: ModelManifestEntry, file: ModelFileSpec): string {
    const relative = `${entry.installDir.replace(/\//g, sep)}${sep}${normalizeRelativePath(file.path)}`;
    return this.resolver.resolveModelInstallPath(relative);
  }

  private hfRepositoryRoot(entry: ModelManifestEntry): string {
    const repo = entry.source.repo ?? '';
    if (!repo) throw new DownloadError('manifest_error', `模型 ${entry.id} 缺少 Hugging Face 仓库信息`, false);
    return join(this.resolver.resolveHfCache(), 'hub', `models--${repo.replace('/', '--')}`);
  }

  private hfPaths(entry: ModelManifestEntry, file: ModelFileSpec, resolvedSha?: string): { blobPath: string; snapshotPath: string } {
    const sha = resolvedSha ?? file.sha256;
    if (!sha) throw new DownloadError('manifest_error', `模型 ${entry.id}/${file.path} 缺少 sha256，无法写入 HF 缓存结构`, false);
    const root = this.hfRepositoryRoot(entry);
    const revision = entry.source.revision ?? 'main';
    return {
      blobPath: join(root, 'blobs', sha),
      snapshotPath: join(root, 'snapshots', revision, normalizeRelativePath(file.path)),
    };
  }

  private targetPath(entry: ModelManifestEntry, file: ModelFileSpec): string {
    if (isHfCacheEntry(entry)) return this.hfPaths(entry, file).snapshotPath;
    return this.flatTargetPath(entry, file);
  }

  /** 载入持久化状态并检测已安装/损坏模型（重启后调用，只会把 downloading 变为 paused）。 */
  async recover(): Promise<void> {
    await this.loadPersistedState();
    for (const runtime of this.runtimes.values()) {
      const check = await this.detectInstalled(runtime.entry);
      if (check.installed) {
        this.markInstalled(runtime, runtime.entry.integrity);
        continue;
      }
      if (runtime.state.status === 'installed') {
        runtime.state.status = 'corrupted';
        runtime.state.phase = 'idle';
        runtime.state.error = { code: 'integrity_failed', message: '模型文件缺失或校验失败，请重新下载修复。' };
        continue;
      }
      if (check.corrupted && runtime.state.status === 'not_installed') {
        runtime.state.status = 'corrupted';
        runtime.state.phase = 'idle';
        runtime.state.error = { code: 'integrity_failed', message: check.detail ?? '模型文件不完整或已损坏，请重新下载。' };
      }
      if (runtime.state.status === 'paused' || (runtime.state.status === 'downloading' && false)) {
        const sizes = await this.partialSizes(runtime.entry);
        if (sizes.total > 0) {
          runtime.state.receivedBytes = sizes.total;
          runtime.state.partialKept = true;
          for (const progress of runtime.state.files) {
            const found = sizes.files.get(progress.path);
            if (found !== undefined) progress.receivedBytes = found;
          }
        }
      }
    }
    this.emit(true);
    await this.persistNow();
  }

  private async loadPersistedState(): Promise<void> {
    let persisted: PersistedDownloadState | undefined;
    try {
      persisted = await readJsonFile<PersistedDownloadState>(this.options.statePath);
    } catch {
      return;
    }
    if (!persisted || typeof persisted !== 'object' || !persisted.models) return;
    for (const [id, saved] of Object.entries(persisted.models)) {
      const runtime = this.runtimes.get(id);
      if (!runtime || !saved || typeof saved !== 'object') continue;
      const state = cloneState(runtime.state);
      state.files = runtime.state.files.map(file => {
        const savedFile = Array.isArray(saved.files) ? saved.files.find(item => item?.path === file.path) : undefined;
        return savedFile ? { ...file, ...savedFile, path: file.path } : file;
      });
      state.receivedBytes = typeof saved.receivedBytes === 'number' && saved.receivedBytes >= 0 ? saved.receivedBytes : 0;
      if (typeof saved.totalBytes === 'number' && saved.totalBytes > 0) state.totalBytes = saved.totalBytes;
      if (typeof saved.percent === 'number') state.percent = saved.percent;
      state.partialKept = Boolean(saved.partialKept);
      if (saved.error && typeof saved.error === 'object') state.error = { ...saved.error };
      if (saved.verified) state.verified = saved.verified;
      if (saved.status === 'downloading' || saved.status === 'verifying') {
        state.status = 'paused';
        state.phase = 'idle';
        state.partialKept = true;
      } else if (saved.status) {
        state.status = saved.status;
        state.phase = saved.phase ?? 'idle';
      }
      runtime.state = state;
      const resume = persisted.resume?.[id];
      if (resume && typeof resume === 'object') runtime.resume = { ...resume };
    }
  }

  private async partialSizes(entry: ModelManifestEntry): Promise<{ total: number; files: Map<string, number> }> {
    const files = new Map<string, number>();
    let total = 0;
    for (const file of entry.files) {
      try {
        const stats = await stat(this.tempFilePath(entry, file));
        files.set(file.path, stats.size);
        total += stats.size;
      } catch {
        files.set(file.path, 0);
      }
    }
    return { total, files };
  }

  private markInstalled(runtime: RuntimeModel, integrity: ModelState['verified']): void {
    const state = runtime.state;
    state.status = 'installed';
    state.phase = 'idle';
    state.verified = integrity;
    state.error = undefined;
    state.partialKept = false;
    state.receivedBytes = state.totalBytes ?? runtime.entry.totalBytes;
    if (state.totalBytes && state.totalBytes > 0) state.percent = 100;
    for (const progress of state.files) {
      progress.receivedBytes = progress.totalBytes ?? progress.receivedBytes;
      progress.percent = 100;
    }
  }

  private async verifyInstalledFile(entry: ModelManifestEntry, file: ModelFileSpec, targetPath?: string): Promise<{ ok: boolean; exists: boolean }> {
    const path = targetPath ?? this.targetPath(entry, file);
    let stats;
    try {
      stats = await stat(path);
    } catch {
      return { ok: false, exists: false };
    }
    if (!stats.isFile()) return { ok: false, exists: true };
    if (stats.size !== file.sizeBytes) return { ok: false, exists: true };
    if (entry.integrity === 'sha256' && file.sha256) {
      const actual = await this.hashFile(path);
      if (actual !== file.sha256) return { ok: false, exists: true };
    }
    return { ok: true, exists: true };
  }

  private async detectInstalled(entry: ModelManifestEntry): Promise<{ installed: boolean; corrupted: boolean; detail?: string }> {
    if (entry.files.length === 0) return { installed: false, corrupted: false };
    let existing = 0;
    let invalid = 0;
    for (const file of entry.files) {
      const result = await this.verifyInstalledFile(entry, file);
      if (result.exists) existing += 1;
      if (!result.ok) invalid += 1;
    }
    if (existing === entry.files.length && invalid === 0) return { installed: true, corrupted: false };
    if (existing > 0) {
      return {
        installed: false,
        corrupted: true,
        detail: `模型文件不完整或校验失败（${existing}/${entry.files.length} 个文件存在，${invalid} 个无效），请重新下载修复。`,
      };
    }
    return { installed: false, corrupted: false };
  }

  /** 开始下载/安装指定模型。已安装且校验通过时直接跳过。 */
  async start(ids: string[]): Promise<void> {
    if (this.disposed) throw new Error('下载管理器已释放');
    const unique = [...new Set(ids)];
    const toStart: RuntimeModel[] = [];
    for (const id of unique) {
      const runtime = this.runtimes.get(id);
      if (!runtime) throw new Error(`未知模型 id：${id}`);
      if (runtime.state.status === 'downloading' || runtime.state.status === 'verifying') continue;
      if (runtime.state.status === 'installed') {
        const installed = await this.detectInstalled(runtime.entry);
        if (installed.installed) continue;
      }
      toStart.push(runtime);
    }
    if (toStart.length === 0) return;
    let remaining = 0;
    for (const runtime of toStart) {
      if (runtime.entry.source.kind === 'ollama') continue; // 大小由 Ollama 层管理，不做字节预算。
      remaining += Math.max(0, runtime.entry.totalBytes - Math.min(runtime.state.receivedBytes, runtime.entry.totalBytes));
    }
    if (remaining > 0) {
      const required = remaining + Math.ceil(remaining * 0.1);
      const free = await this.diskFree(this.resolver.resolveModelsRoot());
      if (free > 0 && free < required) {
        for (const runtime of toStart) {
          if (runtime.entry.source.kind === 'ollama') continue;
          runtime.state.status = 'failed';
          runtime.state.phase = 'error';
          runtime.state.error = {
            code: 'insufficient_space',
            message: `磁盘空间不足：模型需要约 ${bytesLabel(required)}（含临时文件余量），当前可用 ${bytesLabel(free)}。请清理磁盘或更换安装目录后重试。`,
          };
        }
        await this.persistNow();
        this.emit(true);
        return;
      }
    }
    for (const runtime of toStart) {
      runtime.state.status = 'downloading';
      runtime.state.phase = 'download';
      runtime.state.error = undefined;
      runtime.state.partialKept = false;
      // 传输总量以源站实际返回为准：在收到响应头前不声称已知总量，避免伪造百分比。
      runtime.state.totalBytes = undefined;
      runtime.state.percent = undefined;
      runtime.state.files = runtime.entry.files.map(file => ({
        path: file.path,
        receivedBytes: 0,
        totalBytes: undefined,
        percent: undefined,
      }));
      runtime.controller = new AbortController();
      runtime.abortReason = undefined;
      runtime.cancelKeepPartial = undefined;
      runtime.speedAt = undefined;
      runtime.speedBytes = undefined;
      runtime.speedEma = undefined;
      runtime.layerProgress.clear();
      this.queue.push(runtime);
    }
    await this.persistNow();
    this.emit(true);
    this.pump();
  }

  private pump(): void {
    while (!this.disposed && this.active < this.concurrency && this.queue.length > 0) {
      const runtime = this.queue.shift()!;
      this.active += 1;
      runtime.task = this.runModel(runtime)
        .catch(() => undefined)
        .finally(() => {
          this.active -= 1;
          runtime.task = undefined;
          void this.persistNow();
          this.emit(true);
          this.pump();
        });
    }
  }

  private async runModel(runtime: RuntimeModel): Promise<void> {
    try {
      if (runtime.entry.source.kind === 'ollama') await this.runOllama(runtime);
      else await this.runHttp(runtime);
    } catch (error) {
      const reason = runtime.abortReason;
      if (reason === 'pause' || reason === 'dispose') {
        runtime.state.status = 'paused';
        runtime.state.phase = 'idle';
        runtime.state.partialKept = true;
        runtime.state.speedBps = undefined;
        runtime.state.etaSeconds = undefined;
      } else if (reason === 'cancel') {
        await this.finishCancel(runtime);
      } else {
        const failure = error instanceof DownloadError ? error : new DownloadError('download_error', (error as Error).message || '下载失败', false);
        if (failure.code === 'integrity_failed') {
          runtime.state.status = 'corrupted';
          runtime.state.phase = 'idle';
          runtime.state.partialKept = true;
        } else {
          runtime.state.status = 'failed';
          runtime.state.phase = 'error';
        }
        runtime.state.speedBps = undefined;
        runtime.state.etaSeconds = undefined;
        runtime.state.error = { code: failure.code, message: failure.message };
      }
    } finally {
      runtime.controller = undefined;
      runtime.ollama = undefined;
    }
  }

  private async finishCancel(runtime: RuntimeModel): Promise<void> {
    const keepPartial = runtime.cancelKeepPartial !== false;
    if (keepPartial) {
      runtime.state.status = 'paused';
      runtime.state.phase = 'idle';
      runtime.state.partialKept = true;
      runtime.state.error = undefined;
      return;
    }
    const partialDir = join(this.resolver.resolveTempDownloadPath(), runtime.entry.id);
    await rm(partialDir, { recursive: true, force: true }).catch(() => undefined);
    runtime.state = initialState(runtime.entry);
    runtime.resume = {};
    runtime.startedFiles.clear();
  }

  private recomputeAggregate(runtime: RuntimeModel): void {
    const state = runtime.state;
    const entry = runtime.entry;
    let total = 0;
    let known = true;
    let received = 0;
    for (let index = 0; index < entry.files.length; index += 1) {
      const file = entry.files[index];
      const progress = state.files[index];
      if (!progress) continue;
      received += progress.receivedBytes;
      if (progress.totalBytes !== undefined) total += progress.totalBytes;
      else if (!runtime.startedFiles.has(file.path)) total += file.sizeBytes;
      else {
        known = false;
        break;
      }
    }
    state.receivedBytes = received;
    if (known && total > 0) {
      state.totalBytes = total;
      state.percent = Math.min(100, Math.round((received / total) * 1000) / 10);
    } else {
      state.totalBytes = undefined;
      state.percent = undefined;
    }
    const nowMs = this.now();
    if (runtime.speedAt === undefined) {
      runtime.speedAt = nowMs;
      runtime.speedBytes = received;
      return;
    }
    const elapsed = nowMs - runtime.speedAt;
    if (elapsed >= 250) {
      const deltaBytes = received - (runtime.speedBytes ?? received);
      const instant = deltaBytes / (elapsed / 1000);
      runtime.speedEma = runtime.speedEma === undefined ? instant : runtime.speedEma * 0.7 + instant * 0.3;
      runtime.speedAt = nowMs;
      runtime.speedBytes = received;
      if (runtime.speedEma > 0) {
        state.speedBps = Math.round(runtime.speedEma);
        if (state.totalBytes && state.percent !== undefined && state.percent < 100) {
          state.etaSeconds = Math.max(1, Math.ceil((state.totalBytes - received) / runtime.speedEma));
        } else {
          state.etaSeconds = undefined;
        }
      }
    }
  }

  private async runHttp(runtime: RuntimeModel): Promise<void> {
    const entry = runtime.entry;
    const state = runtime.state;
    const installed = await this.detectInstalled(entry);
    if (installed.installed) {
      this.markInstalled(runtime, entry.integrity);
      return;
    }
    state.status = 'downloading';
    state.phase = 'download';
    state.error = undefined;
    state.totalBytes = undefined;
    state.percent = undefined;
    state.files = entry.files.map(file => ({
      path: file.path,
      receivedBytes: 0,
      totalBytes: undefined,
      percent: undefined,
    }));
    const reuseTargets = !isHfCacheEntry(entry);
    for (let index = 0; index < entry.files.length; index += 1) {
      const file = entry.files[index];
      if (reuseTargets) {
        const target = this.flatTargetPath(entry, file);
        const check = await this.verifyInstalledFile(entry, file, target);
        if (check.ok) {
          state.files[index].receivedBytes = file.sizeBytes;
          state.files[index].totalBytes = file.sizeBytes;
          state.files[index].percent = 100;
          continue;
        }
      }
      runtime.startedFiles.add(file.path);
      await this.downloadOneFile(runtime, file, index);
      this.recomputeAggregate(runtime);
      this.emit();
      this.persistThrottled();
    }
    state.status = 'verifying';
    state.phase = 'verify';
    state.speedBps = undefined;
    state.etaSeconds = undefined;
    this.emit(true);
    await this.persistNow();
    for (const file of entry.files) {
      const partPath = this.tempFilePath(entry, file);
      const verification = await this.verifyPartFile(entry, file, partPath);
      if (!verification.ok) {
        throw new DownloadError('integrity_failed', verification.message ?? `模型文件校验失败：${file.path}，已保留临时文件，可重试修复。`, false);
      }
    }
    state.phase = 'load';
    this.emit(true);
    if (isHfCacheEntry(entry)) await this.commitHfCache(entry);
    else await this.commitFlat(entry);
    this.markInstalled(runtime, entry.integrity);
    this.emit(true);
    await this.persistNow();
  }

  private async verifyPartFile(entry: ModelManifestEntry, file: ModelFileSpec, partPath: string): Promise<{ ok: boolean; message?: string }> {
    let stats;
    try {
      stats = await stat(partPath);
    } catch {
      return { ok: false, message: `临时文件缺失：${file.path}，请重试下载。` };
    }
    if (stats.size !== file.sizeBytes) {
      return {
        ok: false,
        message: `文件大小校验失败：${file.path}（期望 ${file.sizeBytes} 字节，实际 ${stats.size} 字节）。已保留临时文件，可重试。`,
      };
    }
    if (entry.integrity === 'sha256' && file.sha256) {
      const actual = await this.hashFile(partPath);
      if (actual !== file.sha256) {
        return {
          ok: false,
          message: `文件 SHA-256 校验失败：${file.path}。已保留临时文件并标记为损坏，不会安装该文件；请重试下载。`,
        };
      }
    }
    return { ok: true };
  }

  private async downloadOneFile(runtime: RuntimeModel, file: ModelFileSpec, index: number): Promise<void> {
    const entry = runtime.entry;
    const partPath = this.tempFilePath(entry, file);
    await mkdir(dirname(partPath), { recursive: true });
    let offset = 0;
    try {
      const stats = await stat(partPath);
      offset = stats.size;
    } catch {
      offset = 0;
    }
    if (offset > file.sizeBytes) {
      offset = 0;
      await rm(partPath, { force: true }).catch(() => undefined);
    }
    const url = resolveSourceUrl(entry, file, this.options.sourceBaseUrl);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        await this.streamFileToDisk(runtime, file, index, url, partPath, offset);
        return;
      } catch (error) {
        if (runtime.abortReason || isAbortError(error)) throw error;
        const failure = error instanceof DownloadError ? error : new DownloadError('network_error', `下载失败：${file.path}（${(error as Error).message}）`, true);
        const retryable = failure.retryable;
        if (!retryable || attempt >= MAX_ATTEMPTS) throw failure;
        await delay(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]);
        try {
          offset = (await stat(partPath)).size;
        } catch {
          offset = 0;
        }
      }
    }
  }

  private async streamFileToDisk(
    runtime: RuntimeModel,
    file: ModelFileSpec,
    index: number,
    url: string,
    partPath: string,
    offset: number,
  ): Promise<void> {
    const entry = runtime.entry;
    const signal = runtime.controller?.signal;
    const resumeMeta = runtime.resume[file.path] ?? {};
    const headers: Record<string, string> = {};
    if (offset > 0) {
      headers.Range = `bytes=${offset}-`;
      const validator = resumeMeta.etag ?? resumeMeta.lastModified;
      if (validator) headers['If-Range'] = validator;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers, signal });
    } catch (error) {
      if (runtime.abortReason || isAbortError(error)) throw new DownloadError('aborted', '下载已中止', false);
      throw new DownloadError('network_error', `连接下载源失败：${file.path}（${(error as Error).message}）。请检查网络后重试。`, true);
    }
    if (!response.ok) {
      const status = response.status;
      if (status === 401 || status === 403) {
        throw new DownloadError(`http_${status}`, `下载被拒绝（HTTP ${status}）：${file.path}。请检查来源地址或模型许可，此类错误不会自动重试。`, false);
      }
      if (status === 404 || status === 410) {
        throw new DownloadError(`http_${status}`, `下载源不存在该文件（HTTP ${status}）：${file.path}。请检查清单来源后重试，此类错误不会自动重试。`, false);
      }
      throw new DownloadError(`http_${status}`, `下载失败（HTTP ${status}）：${file.path}，将按受限退避自动重试。`, RETRYABLE_STATUS.has(status));
    }
    let serverTotal: number | undefined;
    let append = false;
    if (response.status === 206) {
      const contentRange = response.headers.get('content-range') ?? '';
      const totalMatch = contentRange.match(/\/(\d+)\s*$/);
      if (totalMatch) serverTotal = Number(totalMatch[1]);
      const startMatch = contentRange.match(/^bytes\s+(\d+)-/i);
      if (startMatch && Number(startMatch[1]) !== offset) {
        throw new DownloadError('range_mismatch', `源站返回的续传区间与本地进度不一致（${file.path}），已改为从 0 重新下载。`, true);
      }
      append = offset > 0;
    } else {
      if (offset > 0) {
        runtime.state.error = { code: 'resume_fallback', message: '源站未支持断点续传，本次已从 0 重新开始下载（不会伪造续传）。' };
        append = false;
      }
      const length = response.headers.get('content-length');
      serverTotal = length ? Number(length) : undefined;
    }
    if (serverTotal !== undefined && serverTotal !== file.sizeBytes) {
      throw new DownloadError(
        'size_mismatch',
        `源文件大小与模型清单不一致：${file.path}（清单 ${file.sizeBytes} 字节，源站 ${serverTotal} 字节）。已停止下载以避免写入不可信文件。`,
        false,
      );
    }
    if (!response.body) throw new DownloadError('empty_body', `下载响应没有内容：${file.path}`, true);
    const progress = runtime.state.files[index];
    const handle = await open(partPath, append ? 'a' : 'w');
    let received = append ? offset : 0;
    progress.receivedBytes = received;
    progress.totalBytes = serverTotal;
    progress.percent = serverTotal && serverTotal > 0 ? Math.min(100, Math.round((received / serverTotal) * 1000) / 10) : undefined;
    try {
      const reader = response.body.getReader();
      for (;;) {
        if (runtime.abortReason || signal?.aborted) throw new DownloadError('aborted', '下载已中止', false);
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        await handle.write(Buffer.from(value));
        received += value.byteLength;
        if (received > file.sizeBytes) {
          throw new DownloadError('size_mismatch', `下载字节数超过清单大小：${file.path}，已停止写入。`, false);
        }
        progress.receivedBytes = received;
        progress.percent = serverTotal && serverTotal > 0 ? Math.min(100, Math.round((received / serverTotal) * 1000) / 10) : undefined;
        this.recomputeAggregate(runtime);
        this.emit();
        this.persistThrottled();
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    runtime.resume[file.path] = {
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
      ...(response.headers.get('last-modified') ? { lastModified: response.headers.get('last-modified')! } : {}),
    };
    if (serverTotal !== undefined && received !== serverTotal) {
      throw new DownloadError(
        'incomplete',
        `连接提前结束：${file.path} 已接收 ${received}/${serverTotal} 字节，可继续续传。`,
        true,
      );
    }
    if (!append && offset > 0) {
      progress.receivedBytes = received;
    }
  }

  private async commitFlat(entry: ModelManifestEntry): Promise<void> {
    for (const file of entry.files) {
      const partPath = this.tempFilePath(entry, file);
      const target = this.flatTargetPath(entry, file);
      await mkdir(dirname(target), { recursive: true });
      await rm(target, { force: true }).catch(() => undefined);
      try {
        await rename(partPath, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EXDEV') {
          await copyFile(partPath, target);
          await rm(partPath, { force: true }).catch(() => undefined);
        } else {
          throw new DownloadError('write_error', `写入模型文件失败：${target}（${(error as Error).message}）。可重试修复。`, true);
        }
      }
    }
    const partialDir = join(this.resolver.resolveTempDownloadPath(), entry.id);
    await rm(partialDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private async commitHfCache(entry: ModelManifestEntry): Promise<void> {
    const revision = entry.source.revision ?? 'main';
    const root = this.hfRepositoryRoot(entry);
    await mkdir(join(root, 'refs'), { recursive: true });
    for (const file of entry.files) {
      const partPath = this.tempFilePath(entry, file);
      const { blobPath, snapshotPath } = this.hfPaths(entry, file);
      await mkdir(dirname(blobPath), { recursive: true });
      try {
        await link(partPath, blobPath);
      } catch {
        await copyFile(partPath, blobPath);
      }
      await mkdir(dirname(snapshotPath), { recursive: true });
      await rm(snapshotPath, { force: true }).catch(() => undefined);
      try {
        await link(blobPath, snapshotPath);
      } catch {
        await copyFile(blobPath, snapshotPath);
      }
      await rm(partPath, { force: true }).catch(() => undefined);
    }
    await writeJsonAtomic(join(root, 'refs', 'main'), `${revision}\n`);
    const partialDir = join(this.resolver.resolveTempDownloadPath(), entry.id);
    await rm(partialDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private async runOllama(runtime: RuntimeModel): Promise<void> {
    const entry = runtime.entry;
    const state = runtime.state;
    const model = entry.source.ollamaModel;
    if (!model) throw new DownloadError('manifest_error', `模型 ${entry.id} 缺少 ollamaModel 配置`, false);
    state.status = 'downloading';
    state.phase = 'download';
    state.error = undefined;
    const env: NodeJS.ProcessEnv = {
      ...(this.options.ollamaEnv ?? process.env),
      OLLAMA_MODELS: this.resolver.resolveOllamaStore(),
    };
    const command = this.options.ollamaCommand ?? join(dirname(this.resolver.resolveModelsRoot()), 'runtime', 'ollama', 'ollama.exe');
    const runner = new OllamaPullRunner({
      exe: command,
      model,
      env,
      spawnImpl: this.spawnImpl,
      onEvent: event => {
        if (event.digest && (event.total !== undefined || event.completed !== undefined)) {
          const existing = runtime.layerProgress.get(event.digest) ?? { completed: 0 };
          runtime.layerProgress.set(event.digest, {
            total: event.total ?? existing.total,
            completed: event.completed ?? existing.completed,
          });
        }
        let total = 0;
        let completed = 0;
        let allKnown = runtime.layerProgress.size > 0;
        for (const layer of runtime.layerProgress.values()) {
          if (layer.total !== undefined) total += layer.total;
          else allKnown = false;
          completed += layer.completed;
        }
        state.phase = event.phase === 'verify' ? 'verify' : 'download';
        state.receivedBytes = completed;
        if (allKnown && total > 0) {
          state.totalBytes = total;
          state.percent = event.phase === 'verify' ? Math.min(99, Math.round((completed / total) * 1000) / 10) : Math.min(99, Math.round((completed / total) * 1000) / 10);
        } else {
          state.totalBytes = undefined;
          state.percent = undefined;
        }
        const nowMs = this.now();
        if (runtime.speedAt !== undefined && nowMs - runtime.speedAt >= 250) {
          const instant = (completed - (runtime.speedBytes ?? completed)) / ((nowMs - runtime.speedAt) / 1000);
          runtime.speedEma = runtime.speedEma === undefined ? instant : runtime.speedEma * 0.7 + instant * 0.3;
          runtime.speedAt = nowMs;
          runtime.speedBytes = completed;
          if (runtime.speedEma > 0) state.speedBps = Math.round(runtime.speedEma);
        } else if (runtime.speedAt === undefined) {
          runtime.speedAt = nowMs;
          runtime.speedBytes = completed;
        }
        this.emit();
        this.persistThrottled();
      },
    });
    runtime.ollama = runner;
    const result = await runner.pull();
    if (result.aborted || runtime.abortReason) throw new DownloadError('aborted', 'Ollama 拉取已中止', false);
    if (!result.ok) throw new DownloadError('ollama_pull_failed', result.error ?? 'ollama pull 失败', false);
    state.status = 'installed';
    state.phase = 'idle';
    state.verified = 'ollama-digest';
    state.error = undefined;
    state.partialKept = false;
    state.receivedBytes = state.totalBytes ?? entry.totalBytes;
    state.percent = 100;
    state.totalBytes = state.totalBytes ?? entry.totalBytes;
    this.emit(true);
    await this.persistNow();
  }

  /** 暂停：中止传输并保留已下载字节。 */
  async pause(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`未知模型 id：${id}`);
    if (runtime.state.status !== 'downloading' && runtime.state.status !== 'verifying') return;
    runtime.abortReason = 'pause';
    runtime.controller?.abort();
    await runtime.ollama?.abort();
    if (runtime.task) await runtime.task;
    await this.persistNow();
    this.emit(true);
  }

  /** 恢复：从已保留的临时文件续传。 */
  async resume(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`未知模型 id：${id}`);
    if (runtime.state.status === 'downloading' || runtime.state.status === 'verifying') return;
    await this.start([id]);
  }

  /** 取消：`keepPartial` 为真时保留临时片段（状态 paused），否则清理并回到未安装。 */
  async cancel(id: string, opts: { keepPartial?: boolean } = {}): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`未知模型 id：${id}`);
    const active = runtime.state.status === 'downloading' || runtime.state.status === 'verifying';
    runtime.cancelKeepPartial = opts.keepPartial ?? false;
    if (!active) {
      runtime.abortReason = 'cancel';
      await this.finishCancel(runtime);
      await this.persistNow();
      this.emit(true);
      return;
    }
    runtime.abortReason = 'cancel';
    runtime.controller?.abort();
    await runtime.ollama?.abort();
    if (runtime.task) await runtime.task;
    await this.persistNow();
    this.emit(true);
  }

  /** 重试失败/损坏的模型（保留已下载片段）。 */
  async retry(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`未知模型 id：${id}`);
    if (runtime.state.status === 'downloading' || runtime.state.status === 'verifying') return;
    runtime.state.error = undefined;
    runtime.state.status = 'paused';
    runtime.state.phase = 'idle';
    await this.start([id]);
  }

  /** 主动校验模型完整性；通过则标记 installed，失败标记 corrupted。 */
  async verify(id: string): Promise<boolean> {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`未知模型 id：${id}`);
    const check = await this.detectInstalled(runtime.entry);
    if (check.installed) {
      this.markInstalled(runtime, runtime.entry.integrity);
      await this.persistNow();
      this.emit(true);
      return true;
    }
    if (runtime.entry.files.length > 0) {
      runtime.state.status = 'corrupted';
      runtime.state.phase = 'idle';
      runtime.state.error = { code: 'integrity_failed', message: check.detail ?? '模型文件缺失或校验失败，请重新下载修复。' };
      await this.persistNow();
      this.emit(true);
    }
    return false;
  }

  /** 等待当前所有下载任务结束（CLI/E2E 用）。 */
  async whenIdle(): Promise<void> {
    for (;;) {
      const busy = this.active > 0 || this.queue.length > 0;
      if (!busy) return;
      await delay(50);
    }
  }

  /** 释放：中止所有任务并落盘最终状态。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const tasks: Array<Promise<void>> = [];
    for (const runtime of this.runtimes.values()) {
      if (runtime.state.status === 'downloading' || runtime.state.status === 'verifying') {
        runtime.abortReason = 'dispose';
        runtime.controller?.abort();
        await runtime.ollama?.abort();
        if (runtime.task) tasks.push(runtime.task);
      }
    }
    await Promise.allSettled(tasks);
    this.queue.length = 0;
    await this.persistNow();
    this.listeners.clear();
  }

  /** 按已接收/总字节计算总体进度（按字节加权，不按模型数量平均）。 */
  static computeOverall(states: ModelState[]): { receivedBytes: number; totalBytes: number; percent?: number; indeterminate: boolean } {
    let receivedBytes = 0;
    let totalBytes = 0;
    let indeterminate = false;
    for (const state of states) {
      receivedBytes += Math.max(0, state.receivedBytes);
      if (state.totalBytes === undefined || state.totalBytes <= 0) {
        if (state.status === 'installed') continue;
        indeterminate = true;
        continue;
      }
      totalBytes += state.totalBytes;
    }
    if (indeterminate || totalBytes <= 0) return { receivedBytes, totalBytes, indeterminate };
    const percent = Math.min(100, Math.round((receivedBytes / totalBytes) * 1000) / 10);
    return { receivedBytes, totalBytes, percent, indeterminate: false };
  }
}
