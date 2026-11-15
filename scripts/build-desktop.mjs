#!/usr/bin/env node
/**
 * #102 桌面发行版构建脚本。
 *
 * 组装 `<out>\desktop\Zhiying-<version>-<profile>\`：
 *   §2.2 目录骨架 + Zhiying.exe（csc 编译的薄壳）+ app\desktop\*.js
 *   + runtime\node\node.exe + release-manifest.json + components.json + SHA256SUMS.txt
 *
 * lite profile 使用 fixture 服务（可真实启动、健康检查、模型下载闭环测试）；
 * full profile 需要 --web-standalone/--python-dir/--ffmpeg-dir/--ollama-dir，缺件明确报错。
 *
 * 只使用 Node 内置模块 + 系统 csc.exe；--dry-run 不写盘。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const DEFAULT_VERSION = '1.8.0';
const CSC_PATH = process.env.CSC_PATH || 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

export function parseBuildArgs(argv) {
  const options = {
    version: DEFAULT_VERSION,
    outDir: resolve(REPO_ROOT, 'dist'),
    profile: 'lite',
    node: undefined,
    ffmpegDir: undefined,
    pythonDir: undefined,
    ollamaDir: undefined,
    webStandalone: undefined,
    dryRun: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const equals = raw.indexOf('=');
    const key = equals >= 0 ? raw.slice(0, equals) : raw;
    const inlineValue = equals >= 0 ? raw.slice(equals + 1) : undefined;
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        index += 1;
        return next;
      }
      return undefined;
    };
    switch (key) {
      case '--version': {
        const value = takeValue();
        if (value) options.version = value;
        break;
      }
      case '--out': {
        const value = takeValue();
        if (value) options.outDir = resolve(process.cwd(), value);
        break;
      }
      case '--profile': {
        const value = takeValue();
        if (value === 'lite' || value === 'full') options.profile = value;
        else throw new Error(`--profile 只能是 lite 或 full（当前：${value}）`);
        break;
      }
      case '--node': {
        const value = takeValue();
        if (value) options.node = resolve(process.cwd(), value);
        break;
      }
      case '--ffmpeg-dir': {
        const value = takeValue();
        if (value) options.ffmpegDir = resolve(process.cwd(), value);
        break;
      }
      case '--python-dir': {
        const value = takeValue();
        if (value) options.pythonDir = resolve(process.cwd(), value);
        break;
      }
      case '--ollama-dir': {
        const value = takeValue();
        if (value) options.ollamaDir = resolve(process.cwd(), value);
        break;
      }
      case '--web-standalone': {
        const value = takeValue();
        if (value) options.webStandalone = resolve(process.cwd(), value);
        break;
      }
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
        options.help = true;
        break;
      default:
        break;
    }
  }
  return options;
}

function productDirectory(options) {
  return join(options.outDir, 'desktop', `Zhiying-${options.version}-${options.profile}`);
}

function validateFullProfile(options) {
  if (options.profile !== 'full') return [];
  const missing = [];
  if (!options.webStandalone) missing.push('--web-standalone <Next standalone 目录>');
  if (!options.pythonDir) missing.push('--python-dir <Python venv 目录>');
  if (!options.ffmpegDir) missing.push('--ffmpeg-dir <FFmpeg 8 full-shared 目录>');
  if (!options.ollamaDir) missing.push('--ollama-dir <Ollama 目录>');
  return missing;
}

function assemblyVersion(version) {
  const parts = String(version)
    .split(/[.-]/)
    .map(part => Number.parseInt(part, 10))
    .filter(value => Number.isInteger(value) && value >= 0)
    .slice(0, 4);
  while (parts.length < 4) parts.push(0);
  return parts.join('.');
}

async function runTsc(outDir) {
  const tscPath = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tscPath)) throw new Error(`未找到 TypeScript 编译器：${tscPath}（请先运行 pnpm install）`);
  try {
    await execFileAsync(process.execPath, [tscPath, '-p', join(REPO_ROOT, 'apps', 'desktop', 'tsconfig.build.json'), '--outDir', outDir], {
      cwd: REPO_ROOT,
      windowsHide: true,
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    throw new Error(`编译 apps/desktop TypeScript 失败：\n${output || error.message}`);
  }
}

async function renameCliEntries(cliDir) {
  const entries = await readdir(cliDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const from = join(cliDir, entry.name);
    const to = join(cliDir, `${entry.name.slice(0, -3)}.mjs`);
    await rename(from, to);
  }
}

async function copyNodeRuntime(nodeSource, destination) {
  const source = nodeSource || process.execPath;
  if (!existsSync(source)) throw new Error(`Node 运行时不存在：${source}`);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination);
}

async function writeLiteFixtures(fixturesDir) {
  await mkdir(fixturesDir, { recursive: true });
  const pythonFixture = `// 知影 lite profile Python 服务 fixture（仅供本地/发行验证）。
import { createServer } from 'node:http';
function portFromArgs(argv) {
  for (const arg of argv) {
    const match = /^--port=(\\d+)$/.exec(arg);
    if (match) return Number(match[1]);
  }
  const index = argv.indexOf('--port');
  if (index >= 0 && argv[index + 1]) return Number(argv[index + 1]);
  return Number(process.env.PORT || 8000);
}
const port = portFromArgs(process.argv.slice(2));
const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({
      ok: true, python: 'fixture', fixture: true, pdf: true, ocr: false,
      ttsModels: false, tts: false, torchcodec: false, ffmpeg: false, ffprobe: false,
      modelsRoot: process.env.M2V_MODELS_ROOT || '', f5ttsModelDir: process.env.F5TTS_MODEL_DIR || '',
      vocoderDir: process.env.F5TTS_VOCODER_DIR || '', hfCache: process.env.HF_HOME || '',
    }));
    return;
  }
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ ok: true, fixture: true, path: request.url || '/' }));
});
server.listen(port, '127.0.0.1', () => { process.stdout.write('[fixture:python] listening on ' + port + '\\n'); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
`;
  const webFixture = `// 知影 lite profile Web 服务 fixture（仅供本地/发行验证）。
import { createServer } from 'node:http';
function portFromArgs(argv) {
  const index = argv.indexOf('--port');
  if (index >= 0 && argv[index + 1]) return Number(argv[index + 1]);
  return Number(process.env.PORT || 3000);
}
const port = portFromArgs(process.argv.slice(2));
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>知影 lite fixture</title></head><body><h1>知影 lite fixture</h1><p>这是无模型发行验证用的占位 Web 服务。</p></body></html>';
const server = createServer((request, response) => {
  if (request.url === '/api/health') {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ ok: true, fixture: true, installRoot: process.env.M2V_INSTALL_ROOT || '' }));
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(html);
});
server.listen(port, '127.0.0.1', () => { process.stdout.write('[fixture:web] listening on ' + port + '\\n'); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
`;
  const workerFixture = `// 知影 lite profile 渲染 Worker fixture（写心跳后常驻）。
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const dataDir = process.env.M2V_DATA_DIR || process.cwd();
async function heartbeat() {
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'worker-heartbeat.json'), JSON.stringify({ time: Date.now(), pid: process.pid, fixture: true }), 'utf8');
  } catch (error) {
    process.stderr.write('[fixture:worker] heartbeat failed: ' + String(error) + '\\n');
  }
}
await heartbeat();
const timer = setInterval(heartbeat, 2000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(timer); process.exit(0); });
`;
  const ollamaFixture = `// 知影 lite profile 受管 Ollama fixture。
import { createServer } from 'node:http';
function portFromArgs(argv) {
  for (const arg of argv) {
    const match = /^--port=(\\d+)$/.exec(arg);
    if (match) return Number(match[1]);
  }
  const index = argv.indexOf('--port');
  if (index >= 0 && argv[index + 1]) return Number(argv[index + 1]);
  return Number(process.env.OLLAMA_PORT || 11434);
}
const port = portFromArgs(process.argv.slice(2));
const server = createServer((request, response) => {
  if ((request.url || '').startsWith('/api/version')) {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ version: '0.0.0-lite-fixture' }));
    return;
  }
  if ((request.url || '').startsWith('/api/tags')) {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ models: [] }));
    return;
  }
  if ((request.url || '').startsWith('/api/pull')) {
    response.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    response.write(JSON.stringify({ status: 'pulling manifest' }) + '\\n');
    response.write(JSON.stringify({ status: 'success' }) + '\\n');
    response.end();
    return;
  }
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ ok: true, fixture: true }));
});
server.listen(port, '127.0.0.1', () => { process.stdout.write('[fixture:ollama] listening on ' + port + '\\n'); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
`;
  await writeFile(join(fixturesDir, 'python.mjs'), pythonFixture, 'utf8');
  await writeFile(join(fixturesDir, 'web.mjs'), webFixture, 'utf8');
  await writeFile(join(fixturesDir, 'worker.mjs'), workerFixture, 'utf8');
  await writeFile(join(fixturesDir, 'ollama.mjs'), ollamaFixture, 'utf8');
}

/**
 * 归一化 csc 产物中的非确定性字段（PE 时间戳与 .NET 元数据 MVID），
 * 使相同输入重复构建得到相同字节（#102-18 构建可复现）。
 * 仅在输出文件名（metadata module name）一致时有效——构建脚本固定输出 Zhiying.exe。
 */
export function normalizePeExecutable(path) {
  const buffer = readFileSync(path);
  if (buffer.length < 0x40) return;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset > 0 && peOffset + 12 <= buffer.length && buffer.subarray(peOffset, peOffset + 4).toString('latin1') === 'PE\u0000\u0000') {
    buffer.writeUInt32LE(0, peOffset + 8); // COFF TimeDateStamp
  }
  let metadata = -1;
  for (let index = 0; index < buffer.length - 4; index += 1) {
    if (buffer[index] === 0x42 && buffer[index + 1] === 0x53 && buffer[index + 2] === 0x4a && buffer[index + 3] === 0x42) {
      metadata = index;
      break;
    }
  }
  if (metadata < 0) {
    writeFileSync(path, buffer);
    return;
  }
  try {
    const versionLength = buffer.readUInt32LE(metadata + 12);
    let pointer = metadata + 16 + versionLength + 4;
    const streamCount = buffer.readUInt16LE(pointer - 2);
    for (let stream = 0; stream < streamCount; stream += 1) {
      const offset = buffer.readUInt32LE(pointer);
      let nameEnd = pointer + 8;
      while (nameEnd < buffer.length && buffer[nameEnd] !== 0) nameEnd += 1;
      const name = buffer.subarray(pointer + 8, nameEnd).toString('latin1');
      if (name === '#GUID') {
        const guidStart = metadata + offset;
        for (let index = 0; index < 16 && guidStart + index < buffer.length; index += 1) buffer[guidStart + index] = 0;
      }
      let next = nameEnd + 1;
      while ((next - pointer) % 4 !== 0) next += 1;
      pointer = next;
      if (pointer >= buffer.length) break;
    }
  } catch {
    /* 元数据解析失败时至少归一化 PE 时间戳。 */
  }
  writeFileSync(path, buffer);
}

async function compileNativeLauncher(productDir, options) {
  if (process.platform !== 'win32') throw new Error('Zhiying.exe 只能在本机 Windows 上通过 csc.exe 构建');
  if (!existsSync(CSC_PATH)) throw new Error(`未找到 csc.exe：${CSC_PATH}（可通过 CSC_PATH 环境变量指定）`);
  const nativeSource = join(REPO_ROOT, 'apps', 'desktop', 'native', 'ZhiyingLauncher.cs');
  if (!existsSync(nativeSource)) throw new Error(`缺少 native 源文件：${nativeSource}`);
  const buildTemp = await mkdtempBuild();
  const assemblyInfo = join(buildTemp, 'ZhiyingLauncher.AssemblyInfo.cs');
  const version = assemblyVersion(options.version);
  await writeFile(
    assemblyInfo,
    [
      'using System.Reflection;',
      `[assembly: AssemblyVersion("${version}")]`,
      `[assembly: AssemblyFileVersion("${version}")]`,
      '[assembly: AssemblyTitle("知影 Zhiying Launcher")]',
      '[assembly: AssemblyProduct("知影 Zhiying")]',
      '[assembly: AssemblyCompany("知影 / Zhiying")]',
      '[assembly: AssemblyDescription("知影桌面启动器")]',
      '',
    ].join('\n'),
    'utf8',
  );
  const target = join(productDir, 'Zhiying.exe');
  const args = ['/nologo', '/target:exe', '/platform:x64', '/optimize+', `/out:${target}`, nativeSource, assemblyInfo];
  try {
    await execFileAsync(CSC_PATH, args, { windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    normalizePeExecutable(target);
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    throw new Error(`编译 Zhiying.exe 失败：\n${output || error.message}`);
  } finally {
    await rm(buildTemp, { recursive: true, force: true }).catch(() => undefined);
  }
  return target;
}

async function mkdtempBuild() {
  const directory = join(tmpdir(), `m2v-build-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function runVersionCommand(command, args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd, windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
    return `${stdout}\n${stderr}`.split(/\r?\n/).find(line => line.trim())?.trim() ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function detectComponents(options) {
  const components = {
    node: {
      version: process.version.replace(/^v/, ''),
      source: options.node || 'bundled (process.execPath)',
      license: 'MIT',
    },
    launcher: {
      version: assemblyVersion(options.version),
      source: 'apps/desktop/native/ZhiyingLauncher.cs (csc)',
      license: 'Proprietary',
    },
  };
  if (options.profile === 'full') {
    const pythonExe = options.pythonDir ? join(options.pythonDir, 'Scripts', 'python.exe') : undefined;
    components.python = {
      version: pythonExe && existsSync(pythonExe) ? await runVersionCommand(pythonExe, ['--version'], dirname(pythonExe)) : 'unknown',
      source: options.pythonDir || 'unknown',
      license: 'PSF-2.0',
    };
    const ffmpegExe = options.ffmpegDir ? join(options.ffmpegDir, 'ffmpeg.exe') : undefined;
    components.ffmpeg = {
      version: ffmpegExe && existsSync(ffmpegExe) ? await runVersionCommand(ffmpegExe, ['-version'], dirname(ffmpegExe)) : 'unknown',
      source: options.ffmpegDir || 'unknown',
      license: 'LGPL/GPL（以 FFmpeg 构建配置为准）',
    };
    const ollamaExe = options.ollamaDir ? join(options.ollamaDir, 'ollama.exe') : undefined;
    components.ollama = {
      version: ollamaExe && existsSync(ollamaExe) ? await runVersionCommand(ollamaExe, ['--version'], dirname(ollamaExe)) : 'unknown',
      source: options.ollamaDir || 'unknown',
      license: 'MIT',
    };
    components.web = { version: options.version, source: options.webStandalone || 'unknown', license: 'AGPL-3.0（Next.js/Remotion 等以各自许可证为准）' };
  } else {
    components.python = { version: 'lite-fixture', source: 'app/fixtures/python.mjs', license: 'Fixture（仅构建验证）' };
    components.ffmpeg = { version: 'lite-fixture', source: 'runtime/ffmpeg/fixture.txt', license: 'Fixture（仅构建验证）' };
    components.ollama = { version: 'lite-fixture', source: 'app/fixtures/ollama.mjs', license: 'Fixture（仅构建验证）' };
    components.web = { version: 'lite-fixture', source: 'app/fixtures/web.mjs', license: 'Fixture（仅构建验证）' };
  }
  return { schemaVersion: 1, product: 'zhiying', version: options.version, profile: options.profile, components };
}

async function walkFiles(root, options = {}) {
  const results = [];
  const readDir = async directory => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relativePath = relative(root, absolute).split(sep).join('/');
      if (options.skip(relativePath, entry)) continue;
      if (entry.isDirectory()) await readDir(absolute);
      else if (entry.isFile()) results.push({ absolute, relativePath });
      else if (entry.isSymbolicLink()) {
        // 不跟随符号链接，避免把个人路径/外部内容打进发行包。
      }
    }
  };
  await readDir(root);
  results.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));
  return results;
}

async function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', rejectPromise);
    stream.once('end', () => resolvePromise(hash.digest('hex')));
  });
}

async function writeTemplates(productDir, options) {
  const template = {
    schemaVersion: 1,
    product: 'zhiying',
    version: options.version,
    payloadProfile: options.profile,
    perUser: true,
    runtime: {
      node: join('runtime', 'node', 'node.exe'),
      python: join('runtime', 'python', 'python.exe'),
      ffmpegDir: join('runtime', 'ffmpeg'),
      ollama: join('runtime', 'ollama', 'ollama.exe'),
    },
    ports: { web: 3000, python: 8000, ollama: 11434, manager: 8790 },
    managedProcesses: { ollama: true },
    modelManifest: join('models', '.downloads', 'manifest.json'),
    firstRunCompleted: false,
  };
  await mkdir(join(productDir, 'config'), { recursive: true });
  await writeFile(join(productDir, 'config', 'install.template.json'), `${JSON.stringify(template, null, 2)}\n`, 'utf8');
  return template;
}

async function writeReleaseManifest(productDir, options, template) {
  const files = await walkFiles(productDir, {
    skip: relativePath => relativePath === 'release-manifest.json' || relativePath === 'SHA256SUMS.txt',
  });
  const entries = [];
  for (const file of files) {
    entries.push({ path: file.relativePath, sizeBytes: (await stat(file.absolute)).size, sha256: await sha256File(file.absolute) });
  }
  const manifest = {
    schemaVersion: 1,
    product: 'zhiying',
    version: options.version,
    profile: options.profile,
    template: 'config/install.template.json',
    files: entries,
  };
  const manifestPath = join(productDir, 'release-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(
    join(productDir, 'SHA256SUMS.txt'),
    `${entries.map(entry => `${entry.sha256}  ${entry.path}`).join('\n')}\n`,
    'utf8',
  );
  return { manifest, manifestPath, fileCount: entries.length, totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0) };
}

async function copyFullPayload(productDir, options) {
  await mkdir(join(productDir, 'runtime', 'python'), { recursive: true });
  await mkdir(join(productDir, 'runtime', 'ffmpeg'), { recursive: true });
  await mkdir(join(productDir, 'runtime', 'ollama'), { recursive: true });
  await mkdir(join(productDir, 'app', 'web'), { recursive: true });
  await mkdir(join(productDir, 'app', 'worker'), { recursive: true });
  await mkdir(join(productDir, 'app', 'python'), { recursive: true });
  await cp(options.pythonDir, join(productDir, 'runtime', 'python'), { recursive: true, force: true, dereference: true });
  await cp(options.ffmpegDir, join(productDir, 'runtime', 'ffmpeg'), { recursive: true, force: true, dereference: true });
  await cp(options.ollamaDir, join(productDir, 'runtime', 'ollama'), { recursive: true, force: true, dereference: true });
  await cp(options.webStandalone, join(productDir, 'app', 'web'), { recursive: true, force: true, dereference: true });
  const workerBuilt = join(REPO_ROOT, 'apps', 'worker', 'dist');
  if (existsSync(workerBuilt)) await cp(workerBuilt, join(productDir, 'app', 'worker'), { recursive: true, force: true });
  else {
    await writeFile(
      join(productDir, 'app', 'worker', 'README.txt'),
      'full profile：请在构建前生成 apps/worker 产物；本次构建未找到 apps/worker/dist。\n',
      'utf8',
    );
  }
  const pythonApp = join(REPO_ROOT, 'services', 'python', 'app');
  if (existsSync(pythonApp)) await cp(pythonApp, join(productDir, 'app', 'python'), { recursive: true, force: true });

}

async function writeLiteRuntimePlaceholders(productDir) {
  for (const name of ['ffmpeg', 'python', 'ollama']) {
    const directory = join(productDir, 'runtime', name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'fixture.txt'),
      `lite profile：${name} 由 app/fixtures 中的 Node fixture 代替，用于无模型发行验证。真实 ${name} 运行时请使用 full profile 构建。\n`,
      'utf8',
    );
  }
}

/** 构建桌面发行目录；返回构建摘要（供 build-installer 复用）。 */
export async function buildDesktop(options) {
  const quality = validateFullProfile(options);
  if (quality.length > 0) {
    throw new Error(`full profile 缺少必需参数（不会静默降级为 lite）：\n- ${quality.join('\n- ')}`);
  }
  const productDir = productDirectory(options);
  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      productDir,
      version: options.version,
      profile: options.profile,
      planned: [
        '编译 apps/desktop TypeScript 到 app/desktop（CLI 输出 .mjs）',
        '复制 runtime/node/node.exe',
        options.profile === 'lite' ? '写入 app/fixtures/{web,python,worker,ollama}.mjs' : '复制 full profile 的 web/python/ffmpeg/ollama 产物',
        '写入 config/install.template.json',
        'csc 编译 native/ZhiyingLauncher.cs 为 Zhiying.exe',
        '写入 release-manifest.json + components.json + SHA256SUMS.txt',
      ],
    };
  }
  await rm(productDir, { recursive: true, force: true });
  const appDesktop = join(productDir, 'app', 'desktop');
  for (const directory of ['app', 'models', 'data', 'config', 'logs', 'runtime']) {
    await mkdir(join(productDir, directory), { recursive: true });
  }
  await mkdir(join(productDir, 'models', '.downloads'), { recursive: true });
  await mkdir(join(productDir, 'data', 'tmp'), { recursive: true });
  await runTsc(appDesktop);
  await renameCliEntries(join(appDesktop, 'cli'));
  // 发行目录内无仓库根 package.json，必须自带 type=module 让 .js 产物按 ESM 解释。
  await writeFile(
    join(appDesktop, 'package.json'),
    `${JSON.stringify({ name: '@m2v/desktop-runtime', version: options.version, private: true, type: 'module' }, null, 2)}\n`,
    'utf8',
  );
  const defaultManifest = join(REPO_ROOT, 'apps', 'desktop', 'src', 'model-manifest.default.json');
  if (!existsSync(defaultManifest)) throw new Error(`缺少默认模型清单：${defaultManifest}（请先运行 pnpm generate:model-manifest）`);
  await cp(defaultManifest, join(appDesktop, 'model-manifest.default.json'), { force: true });
  const nodeDestination = join(productDir, 'runtime', 'node', 'node.exe');
  await copyNodeRuntime(options.node, nodeDestination);
  if (options.profile === 'lite') {
    await writeLiteFixtures(join(productDir, 'app', 'fixtures'));
    await writeLiteRuntimePlaceholders(productDir);
  } else {
    await copyFullPayload(productDir, options);
  }
  const template = await writeTemplates(productDir, options);
  await compileNativeLauncher(productDir, options);
  const components = await detectComponents(options);
  await writeFile(join(productDir, 'components.json'), `${JSON.stringify(components, null, 2)}\n`, 'utf8');
  const release = await writeReleaseManifest(productDir, options, template);
  return {
    ok: true,
    dryRun: false,
    productDir,
    version: options.version,
    profile: options.profile,
    manifestPath: release.manifestPath,
    fileCount: release.fileCount,
    totalBytes: release.totalBytes,
    componentsPath: join(productDir, 'components.json'),
    nodeExe: nodeDestination,
    templatePath: join(productDir, 'config', 'install.template.json'),
  };
}

function printHelp() {
  process.stdout.write(
    [
      '构建知影 Windows 桌面发行目录（lite/full）',
      '',
      '用法：node scripts/build-desktop.mjs [选项]',
      '  --version <x.y.z>         版本号（默认 1.8.0）',
      '  --out <dir>               输出根目录（默认 dist）',
      '  --profile lite|full       发行 profile（默认 lite）',
      '  --node <node.exe>         随包 Node 运行时（默认当前 node）',
      '  --ffmpeg-dir <dir>        full：FFmpeg 8 full-shared 目录',
      '  --python-dir <dir>        full：Python venv 目录',
      '  --ollama-dir <dir>        full：Ollama 目录',
      '  --web-standalone <dir>    full：Next.js standalone 目录',
      '  --dry-run                 只打印计划，不写盘',
      '  --json                    以 JSON 输出摘要',
      '',
    ].join('\n'),
  );
}

async function main() {
  const options = parseBuildArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  if (options.profile !== 'lite' && options.profile !== 'full') {
    process.stderr.write('--profile 只能是 lite 或 full。\n');
    return 2;
  }
  try {
    const result = await buildDesktop(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      process.stdout.write(`构建完成：${result.productDir}\n`);
      if (result.dryRun) {
        for (const item of result.planned) process.stdout.write(`  · ${item}\n`);
      } else {
        process.stdout.write(`  版本：${result.version}  发行 profile：${result.profile}\n`);
        process.stdout.write(`  文件数：${result.fileCount}  总字节：${result.totalBytes}\n`);
        process.stdout.write(`  发布清单：${result.manifestPath}\n`);
        process.stdout.write(`  组件清单：${result.componentsPath}\n`);
      }
    }
    return 0;
  } catch (error) {
    process.stderr.write(`构建失败：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main()
    .then(code => process.exit(code))
    .catch(error => {
      process.stderr.write(`构建异常：${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}

