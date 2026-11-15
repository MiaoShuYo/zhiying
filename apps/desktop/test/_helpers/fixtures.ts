/**
 * 结构 fixture 构建器：安装目录骨架、install.json、lite payload、模型 manifest/文件。
 * 这些对象严格按 doc/V1.8.0_issues.md §2.2/§2.5 契约构造，用于测试真实模块。
 */
import fs from 'node:fs';
import path from 'node:path';
import { deterministicBytes, sha256Buffer, sha256File, writeFileDeep, writeJson, mkdirp } from './fsx';

export const PRODUCT = 'zhiying';
export const VERSION = '1.8.0';

export interface InstallConfigLike {
  schemaVersion: number;
  product: 'zhiying';
  version: string;
  installRoot: string;
  installedAt: string;
  updatedAt?: string;
  perUser: boolean;
  payloadProfile: 'lite' | 'full';
  runtime: { node: string; python?: string; ffmpegDir?: string; ollama?: string };
  ports: { web: number; python: number; ollama: number; manager: number };
  managedProcesses: { ollama: boolean };
  modelManifest: string;
  modelsDownloadChoice?: 'now' | 'later';
  firstRunCompleted: boolean;
}

export const DEFAULT_PORTS = { web: 3000, python: 8000, ollama: 11434, manager: 8790 };

export function makeInstallConfig(installRoot: string, overrides: Partial<InstallConfigLike> = {}): InstallConfigLike {
  const base: InstallConfigLike = {
    schemaVersion: 1,
    product: PRODUCT,
    version: VERSION,
    installRoot: path.resolve(installRoot),
    installedAt: '2026-11-15T00:00:00.000Z',
    perUser: true,
    payloadProfile: 'lite',
    runtime: {
      node: 'runtime\\node\\node.exe',
      python: 'runtime\\python',
      ffmpegDir: 'runtime\\ffmpeg',
      ollama: 'runtime\\ollama\\ollama.exe',
    },
    ports: { ...DEFAULT_PORTS },
    managedProcesses: { ollama: true },
    modelManifest: 'models/.downloads/manifest.json',
    firstRunCompleted: false,
    ...overrides,
  };
  return base;
}

/** 创建 §2.2 完整安装目录骨架（空目录 + 可选 install.json）。 */
export async function createInstallLayoutDirs(installRoot: string, opts: { withConfig?: boolean; config?: InstallConfigLike } = {}): Promise<InstallConfigLike> {
  const dirs = [
    'app',
    'app/desktop',
    'app/web',
    'app/worker',
    'runtime/node',
    'runtime/python',
    'runtime/ffmpeg',
    'runtime/ollama',
    'models/ollama',
    'models/f5-tts/F5TTS_v1_Base',
    'models/f5-tts/vocos-mel-24khz',
    'models/huggingface/hub',
    'models/.downloads',
    'data/projects',
    'data/voices',
    'data/audio',
    'data/tmp',
    'data/runtime',
    'data/backups',
    'config',
    'logs',
  ];
  for (const d of dirs) await mkdirp(path.join(installRoot, d));
  const config = opts.config ?? makeInstallConfig(installRoot);
  if (opts.withConfig !== false) {
    await writeJson(path.join(installRoot, 'config', 'install.json'), config);
  }
  return config;
}

/** 用原始 JSON 写 install.json（不依赖实现，用于损坏/旧版本场景）。 */
export async function writeInstallConfigRaw(installRoot: string, config: unknown): Promise<string> {
  return writeJson(path.join(installRoot, 'config', 'install.json'), config);
}

export interface PayloadOptions {
  version?: string;
  profile?: 'lite' | 'full';
  /** 是否写入真实 node 可执行文件（E2E 需要；unit 不需要，默认写占位字节）。 */
  includeRealNode?: boolean;
  /** Zhiying.exe 是否使用合法 PE（真实快捷方式创建需要有效目标；默认 true）。 */
  validPe?: boolean;
}

/** 取一个合法的小型 PE 文件内容（用于需要 Shell 解析的快捷方式测试）。 */
function getValidPeBytes(): Buffer {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  for (const candidate of [path.join(systemRoot, 'System32', 'cmd.exe'), path.join(systemRoot, 'System32', 'notepad.exe')]) {
    try {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate);
    } catch {
      /* 尝试下一个 */
    }
  }
  return Buffer.concat([Buffer.from('MZ'), deterministicBytes(4096, 'zhiying-exe')]);
}

/** 构造一个 lite payload 目录（模拟 build-desktop 产物结构）。 */
export async function createPayloadTree(payloadRoot: string, opts: PayloadOptions = {}): Promise<{ files: string[] }> {
  const version = opts.version ?? VERSION;
  const profile = opts.profile ?? 'lite';
  const files: Array<[string, string | Buffer]> = [
    ['Zhiying.exe', opts.validPe === false ? Buffer.concat([Buffer.from('MZ'), deterministicBytes(1024, 'zhiying-exe')]) : getValidPeBytes()],
    ['app/desktop/index.js', 'export const version = "1.8.0";\n'],
    ['app/desktop/cli/launcher-cli.mjs', 'process.stdout.write(JSON.stringify({ ok: true, cli: "launcher" }));\n'],
    ['app/desktop/cli/setup-cli.mjs', 'process.stdout.write(JSON.stringify({ ok: true, cli: "setup" }));\n'],
    ['app/desktop/cli/model-manager-cli.mjs', 'process.stdout.write(JSON.stringify({ ok: true, cli: "model-manager" }));\n'],
    ['app/desktop/cli/maintenance-cli.mjs', 'process.stdout.write(JSON.stringify({ ok: true, cli: "maintenance" }));\n'],
    ['app/fixtures/web.mjs', '// fixture web\n'],
    ['app/fixtures/python.mjs', '// fixture python\n'],
    ['app/fixtures/worker.mjs', '// fixture worker\n'],
    ['config/install.template.json', JSON.stringify(makeInstallConfig(payloadRoot, { version }), null, 2)],
    ['components.json', JSON.stringify({ node: '24.21.0', python: '3.13.3', ffmpeg: '8.0', ollama: '0.0.0-fixture', profile }, null, 2)],
    ['version.txt', version],
  ];
  if (opts.includeRealNode) {
    const nodeTarget = path.join(payloadRoot, 'runtime', 'node', 'node.exe');
    await mkdirp(path.dirname(nodeTarget));
    fs.copyFileSync(process.execPath, nodeTarget);
  } else {
    files.push(['runtime/node/node.exe', Buffer.concat([Buffer.from('MZ'), deterministicBytes(2048, 'node-exe')])]);
  }
  if (profile === 'full') {
    files.push(['runtime/python/python.exe', Buffer.concat([Buffer.from('MZ'), deterministicBytes(2048, 'python-exe')])]);
    files.push(['runtime/ffmpeg/ffmpeg.exe', Buffer.concat([Buffer.from('MZ'), deterministicBytes(2048, 'ffmpeg-exe')])]);
    files.push(['runtime/ollama/ollama.exe', Buffer.concat([Buffer.from('MZ'), deterministicBytes(2048, 'ollama-exe')])]);
  } else {
    files.push(['runtime/python/README-fixture.txt', 'lite python fixture']);
    files.push(['runtime/ffmpeg/README-fixture.txt', 'lite ffmpeg fixture']);
    files.push(['runtime/ollama/README-fixture.txt', 'lite ollama fixture']);
  }
  // 构建产物会包含默认模型清单（供安装器复制到 models/.downloads/manifest.json）
  const defaultManifestSource = path.resolve(import.meta.dirname, '..', '..', 'src', 'model-manifest.default.json');
  if (fs.existsSync(defaultManifestSource)) {
    files.push(['app/desktop/model-manifest.default.json', fs.readFileSync(defaultManifestSource)]);
  }
  for (const [rel, data] of files) {
    await writeFileDeep(path.join(payloadRoot, rel), data);
  }
  // release-manifest.json：确定性排序（不写绝对路径/时间）
  const manifestEntries: Array<{ path: string; sizeBytes: number; sha256: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && path.relative(payloadRoot, full).split(path.sep).join('/') !== 'release-manifest.json') {
        const rel = path.relative(payloadRoot, full).split(path.sep).join('/');
        manifestEntries.push({ path: rel, sizeBytes: fs.statSync(full).size, sha256: sha256Buffer(fs.readFileSync(full)) });
      }
    }
  };
  walk(payloadRoot);
  manifestEntries.sort((a, b) => (a.path < b.path ? -1 : 1));
  await writeJson(path.join(payloadRoot, 'release-manifest.json'), { version, profile, files: manifestEntries });
  return { files: manifestEntries.map((e) => e.path) };
}

// ---------------------------------------------------------------------------
// 模型 manifest fixture（§2.5）
// ---------------------------------------------------------------------------

export type ModelPurposeLike = 'llm' | 'tts' | 'vocoder' | 'alignment';
export type ModelSourceKindLike = 'http' | 'huggingface' | 'ollama';
export type IntegrityLike = 'sha256' | 'size' | 'ollama-digest';

export interface ModelFileSpecLike {
  path: string;
  sizeBytes: number;
  sha256?: string;
  url?: string;
}

export interface ModelManifestEntryLike {
  id: string;
  name: string;
  purpose: ModelPurposeLike;
  required: boolean;
  source: { kind: ModelSourceKindLike; url?: string; repo?: string; revision?: string; ollamaModel?: string };
  installDir: string;
  integrity: IntegrityLike;
  files: ModelFileSpecLike[];
  totalBytes: number;
  license: { name: string; url?: string; notes: string; commercialUse: 'allowed' | 'restricted' | 'unknown' };
  dependencies?: string[];
}

export interface ModelManifestLike {
  schemaVersion: 1;
  version: string;
  generatedAt: string;
  models: ModelManifestEntryLike[];
}

export const F5_LICENSE = {
  name: 'CC BY-NC 4.0',
  url: 'https://creativecommons.org/licenses/by-nc/4.0/',
  notes: 'F5-TTS 权重为非商业许可；商用需另行授权。',
  commercialUse: 'restricted' as const,
};

/** 生成一个合法的 http 源 manifest 条目（files 由给定内容构造，sha256 正确）。 */
export function makeHttpEntry(input: {
  id: string;
  name?: string;
  purpose?: ModelPurposeLike;
  installDir?: string;
  files: Array<{ path: string; data: Buffer; sha256?: string; url?: string; sizeBytes?: number }>;
  required?: boolean;
  integrity?: IntegrityLike;
  license?: Partial<ModelManifestEntryLike['license']>;
  dependencies?: string[];
  baseUrl?: string;
}): { entry: ModelManifestEntryLike; contents: Map<string, Buffer> } {
  const contents = new Map<string, Buffer>();
  const files: ModelFileSpecLike[] = input.files.map((f) => {
    contents.set(f.path, f.data);
    return {
      path: f.path,
      sizeBytes: f.sizeBytes ?? f.data.length,
      sha256: f.sha256 ?? sha256Buffer(f.data),
      url: f.url ?? `${input.baseUrl ?? `http://fixture.invalid/${input.id}`}/${f.path}`,
    };
  });
  const entry: ModelManifestEntryLike = {
    id: input.id,
    name: input.name ?? input.id,
    purpose: input.purpose ?? 'tts',
    required: input.required ?? true,
    source: { kind: 'http', url: input.baseUrl ?? `http://fixture.invalid/${input.id}` },
    installDir: input.installDir ?? input.id,
    integrity: input.integrity ?? 'sha256',
    files,
    totalBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
    license: {
      name: 'Fixture License',
      notes: 'test fixture license',
      commercialUse: 'allowed',
      ...input.license,
    },
    ...(input.dependencies ? { dependencies: input.dependencies } : {}),
  };
  return { entry, contents };
}

export function makeManifest(models: ModelManifestEntryLike[], overrides: Partial<ModelManifestLike> = {}): ModelManifestLike {
  return { schemaVersion: 1, version: '1.8.0', generatedAt: '2026-11-15T00:00:00.000Z', models, ...overrides };
}

/** 把 fixture 内容写入 installDir 下（模拟“已安装模型”）。 */
export async function installModelFiles(modelsRoot: string, installDir: string, contents: Map<string, Buffer>): Promise<void> {
  for (const [rel, data] of contents) {
    await writeFileDeep(path.join(modelsRoot, installDir, rel), data);
  }
}

/** 读取模型安装目录下某文件哈希。 */
export async function modelFileSha(modelsRoot: string, installDir: string, rel: string): Promise<string> {
  return sha256File(path.join(modelsRoot, installDir, rel));
}

/** 构造一个带 N 个文件、给定大小的模型（确定性内容），返回 entry/contents。 */
export function makeSizedHttpEntry(input: {
  id: string;
  baseUrl?: string;
  files?: Array<{ path: string; sizeBytes: number; seed?: string }>;
  integrity?: IntegrityLike;
  purpose?: ModelPurposeLike;
  license?: Partial<ModelManifestEntryLike['license']>;
}): { entry: ModelManifestEntryLike; contents: Map<string, Buffer> } {
  const fileDefs = input.files ?? [{ path: 'model.bin', sizeBytes: 64 * 1024 }];
  return makeHttpEntry({
    id: input.id,
    baseUrl: input.baseUrl,
    purpose: input.purpose ?? 'tts',
    integrity: input.integrity ?? 'sha256',
    license: input.license,
    files: fileDefs.map((f) => ({ path: f.path, data: deterministicBytes(f.sizeBytes, f.seed ?? `${input.id}:${f.path}`) })),
  });
}
