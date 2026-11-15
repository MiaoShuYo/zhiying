#!/usr/bin/env node
/**
 * #105 默认模型清单生成器。
 *
 * 通过 Hugging Face Hub API 读取固定 revision 的文件树，使用 `lfs.oid`（即真实
 * SHA-256）与小文件的原始字节哈希生成 `apps/desktop/src/model-manifest.default.json`。
 *
 * 行为约定（冻结契约 §2.5）：
 * - 能取得可信哈希时才写 `integrity: 'sha256'`；
 * - 无网络/无法取得哈希时退化为 `integrity: 'size'` 并打印明确警告，绝不伪造哈希；
 * - 只使用 Node 内置模块（Node 18+ 全局 fetch），不新增依赖。
 *
 * 用法：
 *   node scripts/generate-model-manifest.mjs [--out <file>] [--offline] [--json]
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const DEFAULT_OUT = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'model-manifest.default.json');
const MANIFEST_VERSION = '1.8.0';
const NETWORK_TIMEOUT_MS = 45_000;
const MAX_HASH_DOWNLOAD_BYTES = 2 * 1024 * 1024;

const QWEN_ENTRY = {
  id: 'qwen3-4b',
  name: 'Qwen3 4B（Ollama 本地模型）',
  purpose: 'llm',
  required: true,
  source: { kind: 'ollama', ollamaModel: 'qwen3:4b' },
  installDir: 'ollama',
  integrity: 'ollama-digest',
  files: [],
  totalBytes: 2_600_000_000,
  license: {
    name: 'Apache-2.0',
    url: 'https://huggingface.co/Qwen/Qwen3-4B',
    notes: '模型体积为估算值（实际以 Ollama 层为准）；下载/校验由 ollama pull 官方 digest 机制完成。',
    commercialUse: 'allowed',
  },
};

const REPO_SPECS = [
  {
    id: 'f5-tts-base',
    name: 'F5-TTS v1 Base（语音合成）',
    purpose: 'tts',
    required: true,
    repo: 'SWivid/F5-TTS',
    installDir: 'f5-tts/F5TTS_v1_Base',
    files: [
      { repoPath: 'F5TTS_v1_Base/model_1250000.safetensors', path: 'model_1250000.safetensors' },
      { repoPath: 'F5TTS_v1_Base/vocab.txt', path: 'vocab.txt' },
    ],
    license: {
      name: 'CC BY-NC 4.0',
      url: 'https://creativecommons.org/licenses/by-nc/4.0/',
      notes: 'F5-TTS 权重按上游模型卡标注为非商业许可（CC BY-NC 4.0）；商业用途需另行取得授权，知影不代为授予。',
      commercialUse: 'restricted',
    },
  },
  {
    id: 'vocos-mel-24khz',
    name: 'Vocos Mel 24kHz 声码器',
    purpose: 'vocoder',
    required: true,
    repo: 'charactr/vocos-mel-24khz',
    installDir: 'f5-tts/vocos-mel-24khz',
    files: [
      { repoPath: 'config.yaml', path: 'config.yaml' },
      { repoPath: 'pytorch_model.bin', path: 'pytorch_model.bin' },
    ],
    license: {
      name: 'MIT',
      url: 'https://huggingface.co/charactr/vocos-mel-24khz',
      notes: '按上游模型卡标注为 MIT 许可；使用前请自行复核模型卡。',
      commercialUse: 'allowed',
    },
  },
  {
    id: 'align-zh-xlsr',
    name: '中文字幕强制对齐模型（Wav2Vec2 XLSR-53）',
    purpose: 'alignment',
    required: true,
    repo: 'jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn',
    installDir: 'huggingface',
    files: [
      { repoPath: 'config.json', path: 'config.json' },
      { repoPath: 'preprocessor_config.json', path: 'preprocessor_config.json' },
      { repoPath: 'special_tokens_map.json', path: 'special_tokens_map.json' },
      { repoPath: 'vocab.json', path: 'vocab.json' },
      { repoPath: 'pytorch_model.bin', path: 'pytorch_model.bin' },
    ],
    license: {
      name: 'Apache-2.0',
      url: 'https://huggingface.co/jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn',
      notes: '按上游模型卡标注为 Apache-2.0；下载固定 revision，校验通过后写入 models/huggingface 缓存结构。',
      commercialUse: 'allowed',
    },
  },
];

/**
 * 无网络时的降级数据：固定 revision 与已知字节数（取自最近一次在线生成）。
 * 仅用于保持清单结构可用，integrity 会退化为 size 并输出警告。
 */
const OFFLINE_FALLBACK = {
  'SWivid/F5-TTS': {
    revision: '84e5a410d9cead4de2f847e7c9369a6440bdfaca',
    files: {
      'F5TTS_v1_Base/model_1250000.safetensors': 1348435761,
      'F5TTS_v1_Base/vocab.txt': 13800,
    },
  },
  'charactr/vocos-mel-24khz': {
    revision: '0feb3fdd929bcd6649e0e7c5a688cf7dd012ef21',
    files: { 'config.yaml': 461, 'pytorch_model.bin': 54365991 },
  },
  'jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn': {
    revision: '99ccb2737be22b8bb50dcfcc39ad4d567fb90cfd',
    files: {
      'config.json': 1567,
      'preprocessor_config.json': 158,
      'special_tokens_map.json': 85,
      'vocab.json': 44357,
      'pytorch_model.bin': 1276296151,
    },
  },
};

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, offline: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      options.out = resolve(process.cwd(), argv[index + 1] ?? '');
      index += 1;
    } else if (arg === '--offline' || arg === '--no-network') {
      options.offline = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }
  return options;
}

function encodePath(path) {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

async function fetchWithRetry(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS), headers: { 'user-agent': 'zhiying-v1.8.0-manifest-generator' } });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolvePromise => setTimeout(resolvePromise, 1500 * attempt));
    }
  }
  throw lastError;
}

async function fetchJson(url) {
  const response = await fetchWithRetry(url);
  return response.json();
}

async function fetchSha256(url) {
  const response = await fetchWithRetry(url);
  const buffer = Buffer.from(await response.arrayBuffer());
  return createHash('sha256').update(buffer).digest('hex');
}

async function resolveRepoFiles(spec) {
  const info = await fetchJson(`https://huggingface.co/api/models/${spec.repo}`);
  const revision = typeof info.sha === 'string' && info.sha ? info.sha : 'main';
  const tree = await fetchJson(`https://huggingface.co/api/models/${spec.repo}/tree/${revision}?recursive=true`);
  if (!Array.isArray(tree)) throw new Error(`HF 返回的文件树格式异常：${spec.repo}`);
  const byPath = new Map();
  for (const entry of tree) {
    if (entry && entry.type === 'file' && typeof entry.path === 'string') byPath.set(entry.path, entry);
  }
  const files = [];
  let degraded = false;
  for (const wanted of spec.files) {
    const entry = byPath.get(wanted.repoPath);
    if (!entry) throw new Error(`HF 仓库 ${spec.repo}@${revision} 缺少文件 ${wanted.repoPath}`);
    const sizeBytes = typeof entry.size === 'number' && Number.isInteger(entry.size) && entry.size >= 0 ? entry.size : undefined;
    if (sizeBytes === undefined) throw new Error(`HF 文件 ${wanted.repoPath} 缺少 size`);
    let sha256 = entry.lfs && typeof entry.lfs.oid === 'string' ? entry.lfs.oid : undefined;
    if (!sha256 && sizeBytes <= MAX_HASH_DOWNLOAD_BYTES) {
      sha256 = await fetchSha256(`https://huggingface.co/${spec.repo}/resolve/${revision}/${encodePath(wanted.repoPath)}`);
    }
    if (!sha256) degraded = true;
    files.push({
      path: wanted.path,
      sizeBytes,
      ...(sha256 ? { sha256 } : {}),
      url: `https://huggingface.co/${spec.repo}/resolve/${revision}/${encodePath(wanted.repoPath)}`,
    });
  }
  return { revision, files, degraded };
}

function buildOfflineFiles(spec) {
  const fallback = OFFLINE_FALLBACK[spec.repo];
  if (!fallback) throw new Error(`缺少离线降级数据：${spec.repo}`);
  const files = spec.files.map(wanted => {
    const sizeBytes = fallback.files[wanted.repoPath];
    if (!Number.isInteger(sizeBytes)) throw new Error(`缺少离线大小：${spec.repo}/${wanted.repoPath}`);
    return {
      path: wanted.path,
      sizeBytes,
      url: `https://huggingface.co/${spec.repo}/resolve/${fallback.revision}/${encodePath(wanted.repoPath)}`,
    };
  });
  return { revision: fallback.revision, files, degraded: true };
}

function buildManifest(repoResults) {
  const models = [QWEN_ENTRY];
  for (const spec of REPO_SPECS) {
    const result = repoResults[spec.id];
    if (!result) throw new Error(`缺少仓库解析结果：${spec.id}`);
    const integrity = result.files.every(file => typeof file.sha256 === 'string') ? 'sha256' : 'size';
    const totalBytes = result.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    const notes = result.degraded
      ? `${spec.license.notes}（本轮部分文件无法取得官方 SHA-256，integrity 退化为 size 校验）`
      : spec.license.notes;
    models.push({
      id: spec.id,
      name: spec.name,
      purpose: spec.purpose,
      required: spec.required,
      source: { kind: 'huggingface', repo: spec.repo, revision: result.revision },
      installDir: spec.installDir,
      integrity,
      files: result.files,
      totalBytes,
      license: { ...spec.license, notes },
    });
  }
  return {
    schemaVersion: 1,
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    models,
  };
}

function selfCheck(manifest) {
  const ids = new Set();
  for (const model of manifest.models) {
    if (ids.has(model.id)) throw new Error(`生成清单存在重复 id：${model.id}`);
    ids.add(model.id);
    const sum = model.files.reduce((total, file) => total + file.sizeBytes, 0);
    if (model.files.length > 0 && sum !== model.totalBytes) {
      throw new Error(`生成清单 ${model.id} 的 totalBytes 与文件大小之和不一致`);
    }
  }
  if (!ids.has('qwen3-4b') || !ids.has('f5-tts-base') || !ids.has('vocos-mel-24khz') || !ids.has('align-zh-xlsr')) {
    throw new Error('生成清单缺少必需的四个模型条目');
  }
}

function printHelp() {
  process.stdout.write(
    [
      '生成 apps/desktop/src/model-manifest.default.json',
      '',
      '参数：',
      '  --out <file>   输出路径（默认 apps/desktop/src/model-manifest.default.json）',
      '  --offline      不访问网络，使用内置降级大小/固定 revision（integrity=size）',
      '  --json         以 JSON 打印生成摘要',
      '  --help         显示帮助',
      '',
    ].join('\n'),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  const warnings = [];
  const repoResults = {};
  for (const spec of REPO_SPECS) {
    if (options.offline) {
      repoResults[spec.id] = buildOfflineFiles(spec);
      warnings.push(`离线模式：${spec.repo} 使用内置固定 revision 与文件大小，integrity 退化为 size（不伪造 SHA-256）。`);
      continue;
    }
    try {
      repoResults[spec.id] = await resolveRepoFiles(spec);
    } catch (error) {
      repoResults[spec.id] = buildOfflineFiles(spec);
      warnings.push(
        `无法从 Hugging Face 获取 ${spec.repo}（${error instanceof Error ? error.message : String(error)}），` +
          '已退化为 integrity=size（使用内置已知大小），未伪造 SHA-256。',
      );
    }
  }
  const manifest = buildManifest(repoResults);
  selfCheck(manifest);
  await mkdir(dirname(options.out), { recursive: true });
  await writeFile(options.out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  for (const warning of warnings) process.stderr.write(`警告：${warning}\n`);
  const summary = {
    ok: true,
    out: options.out,
    online: !options.offline && warnings.length === 0,
    models: manifest.models.map(model => ({
      id: model.id,
      purpose: model.purpose,
      integrity: model.integrity,
      totalBytes: model.totalBytes,
      files: model.files.length,
    })),
    warnings,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`已生成模型清单：${options.out}\n`);
    for (const model of summary.models) {
      process.stdout.write(`  - ${model.id}（${model.purpose}，${model.integrity}，${model.totalBytes} 字节，${model.files} 个文件）\n`);
    }
    if (warnings.length > 0) process.stdout.write(`警告 ${warnings.length} 条（见上方 stderr）。\n`);
  }
  return 0;
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    process.stderr.write(`生成模型清单失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
