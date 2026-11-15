#!/usr/bin/env node
/**
 * #103 Zhiying-Setup.exe 构建脚本。
 *
 * 复用 build-desktop 产物（或 --input 指定已有发行目录），用 PowerShell Compress-Archive
 * 打包 payload.zip，再用系统 csc.exe 编译 native/ZhiyingSetup.cs（嵌入 payload 资源或
 * external payload），输出：
 *   <out>\Zhiying-Setup.exe
 *   <out>\Zhiying-Setup.exe.sha256
 *   <out>\release-info.json
 *
 * --dry-run 不写盘；EXE 带 1.8.0.0 程序集版本信息。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildDesktop, normalizePeExecutable, parseBuildArgs } from './build-desktop.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const CSC_PATH = process.env.CSC_PATH || 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const DEFAULT_VERSION = '1.8.0';

function parseInstallerArgs(argv) {
  const options = {
    version: undefined,
    outDir: resolve(REPO_ROOT, 'dist'),
    profile: 'lite',
    inputDir: undefined,
    externalPayload: false,
    embedPayload: false,
    dryRun: false,
    json: false,
    buildNode: undefined,
    buildFfmpegDir: undefined,
    buildPythonDir: undefined,
    buildOllamaDir: undefined,
    buildWebStandalone: undefined,
    help: false,
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
      case '--input':
      case '--desktop-dir': {
        const value = takeValue();
        if (value) options.inputDir = resolve(process.cwd(), value);
        break;
      }
      case '--external-payload':
        options.externalPayload = true;
        break;
      case '--embed-payload':
        options.embedPayload = true;
        break;
      case '--node': {
        const value = takeValue();
        if (value) options.buildNode = resolve(process.cwd(), value);
        break;
      }
      case '--ffmpeg-dir': {
        const value = takeValue();
        if (value) options.buildFfmpegDir = resolve(process.cwd(), value);
        break;
      }
      case '--python-dir': {
        const value = takeValue();
        if (value) options.buildPythonDir = resolve(process.cwd(), value);
        break;
      }
      case '--ollama-dir': {
        const value = takeValue();
        if (value) options.buildOllamaDir = resolve(process.cwd(), value);
        break;
      }
      case '--web-standalone': {
        const value = takeValue();
        if (value) options.buildWebStandalone = resolve(process.cwd(), value);
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

function assemblyVersion(version) {
  const parts = String(version)
    .split(/[.-]/)
    .map(part => Number.parseInt(part, 10))
    .filter(value => Number.isInteger(value) && value >= 0)
    .slice(0, 4);
  while (parts.length < 4) parts.push(0);
  return parts.join('.');
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

async function makeTempDir() {
  const directory = join(tmpdir(), `m2v-installer-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function compressPayload(productDir, zipPath) {
  await rm(zipPath, { force: true }).catch(() => undefined);
  const escapedSource = `${productDir.replace(/'/g, "''")}\\*`;
  const escapedTarget = zipPath.replace(/'/g, "''");
  const script = `Compress-Archive -Path '${escapedSource}' -DestinationPath '${escapedTarget}' -CompressionLevel Optimal -Force`;
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`payload.zip 压缩失败：${`${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || error.message}`);
  }
  if (!existsSync(zipPath)) throw new Error('payload.zip 未生成');
  return zipPath;
}

async function compileSetupExe(options, productDir, payloadZip, tempDir) {
  if (process.platform !== 'win32') throw new Error('Zhiying-Setup.exe 只能在本机 Windows 上通过 csc.exe 构建');
  if (!existsSync(CSC_PATH)) throw new Error(`未找到 csc.exe：${CSC_PATH}（可通过 CSC_PATH 环境变量指定）`);
  const nativeSource = join(REPO_ROOT, 'apps', 'desktop', 'native', 'ZhiyingSetup.cs');
  if (!existsSync(nativeSource)) throw new Error(`缺少 native 源文件：${nativeSource}`);
  const version = assemblyVersion(options.version);
  const assemblyInfo = join(tempDir, 'ZhiyingSetup.AssemblyInfo.cs');
  await writeFile(
    assemblyInfo,
    [
      'using System.Reflection;',
      `[assembly: AssemblyVersion("${version}")]`,
      `[assembly: AssemblyFileVersion("${version}")]`,
      '[assembly: AssemblyTitle("知影 Zhiying Setup")]',
      '[assembly: AssemblyProduct("知影 Zhiying")]',
      '[assembly: AssemblyCompany("知影 / Zhiying")]',
      '[assembly: AssemblyDescription("知影 Windows 安装程序")]',
      '',
    ].join('\n'),
    'utf8',
  );
  const target = join(options.outDir, 'Zhiying-Setup.exe');
  const embed = !options.externalPayload || options.embedPayload;
  const args = [
    '/nologo',
    '/target:exe',
    '/platform:x64',
    '/optimize+',
    `/out:${target}`,
    '/r:System.dll',
    '/r:System.Core.dll',
    '/r:System.IO.Compression.FileSystem.dll',
  ];
  if (embed) args.push(`/resource:${payloadZip},payload.zip`);
  args.push(nativeSource, assemblyInfo);
  try {
    await execFileAsync(CSC_PATH, args, { windowsHide: true, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    normalizePeExecutable(target);
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    throw new Error(`编译 Zhiying-Setup.exe 失败：\n${output || error.message}`);
  }
  return target;
}

async function readComponents(productDir) {
  try {
    return JSON.parse(await readFile(join(productDir, 'components.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/** 构建安装器；返回摘要。 */
export async function buildInstaller(options) {
  let productDir;
  let version = options.version;
  let profile = options.profile;
  let buildSummary;
  if (options.inputDir) {
    productDir = options.inputDir;
    if (!existsSync(join(productDir, 'release-manifest.json'))) {
      throw new Error(`--input 目录不是有效的发行目录（缺少 release-manifest.json）：${productDir}`);
    }
    const manifest = JSON.parse(await readFile(join(productDir, 'release-manifest.json'), 'utf8'));
    if (!version && typeof manifest.version === 'string') version = manifest.version;
    if (manifest.profile === 'lite' || manifest.profile === 'full') profile = manifest.profile;
  } else {
    const buildOptions = parseBuildArgs([]);
    buildOptions.version = options.version ?? DEFAULT_VERSION;
    buildOptions.outDir = options.outDir;
    buildOptions.profile = options.profile;
    if (options.buildNode) buildOptions.node = options.buildNode;
    if (options.buildFfmpegDir) buildOptions.ffmpegDir = options.buildFfmpegDir;
    if (options.buildPythonDir) buildOptions.pythonDir = options.buildPythonDir;
    if (options.buildOllamaDir) buildOptions.ollamaDir = options.buildOllamaDir;
    if (options.buildWebStandalone) buildOptions.webStandalone = options.buildWebStandalone;
    buildSummary = await buildDesktop(buildOptions);
    productDir = buildSummary.productDir;
    version = buildSummary.version;
    profile = buildSummary.profile;
  }
  version = version ?? DEFAULT_VERSION;
  const external = options.externalPayload || (profile === 'full' && !options.embedPayload);
  const embed = !external;
  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      productDir,
      version,
      profile,
      embed,
      setupExe: join(options.outDir, 'Zhiying-Setup.exe'),
      sha256Path: join(options.outDir, 'Zhiying-Setup.exe.sha256'),
      releaseInfoPath: join(options.outDir, 'release-info.json'),
      planned: [
        `压缩 payload：${productDir} → payload.zip`,
        `${embed ? '嵌入' : '外置'} payload 到 Zhiying-Setup.exe（程序集版本 ${assemblyVersion(version)}）`,
        '生成 Zhiying-Setup.exe.sha256 与 release-info.json',
      ],
      build: buildSummary,
    };
  }
  await mkdir(options.outDir, { recursive: true });
  const tempDir = await makeTempDir();
  try {
    const payloadZip = join(tempDir, 'payload.zip');
    await compressPayload(productDir, payloadZip);
    const payloadSha256 = await sha256File(payloadZip);
    const payloadSizeBytes = (await stat(payloadZip)).size;
    const setupExe = await compileSetupExe({ ...options, version }, productDir, payloadZip, tempDir);
    if (!embed) await cp(payloadZip, join(options.outDir, 'payload.zip'), { force: true });
    const setupSha256 = await sha256File(setupExe);
    const setupSizeBytes = (await stat(setupExe)).size;
    await writeFile(join(options.outDir, 'Zhiying-Setup.exe.sha256'), `${setupSha256}  Zhiying-Setup.exe\n`, 'utf8');
    const components = await readComponents(productDir);
    const releaseInfo = {
      schemaVersion: 1,
      product: 'zhiying',
      version,
      profile,
      assemblyVersion: assemblyVersion(version),
      setup: {
        file: 'Zhiying-Setup.exe',
        sha256: setupSha256,
        sizeBytes: setupSizeBytes,
      },
      payload: {
        embedded: embed,
        file: embed ? 'embedded' : 'payload.zip',
        sha256: payloadSha256,
        sizeBytes: payloadSizeBytes,
      },
      components,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(options.outDir, 'release-info.json'), `${JSON.stringify(releaseInfo, null, 2)}\n`, 'utf8');
    return {
      ok: true,
      dryRun: false,
      productDir,
      version,
      profile,
      embed,
      setupExe,
      setupSha256,
      setupSizeBytes,
      payloadSha256,
      payloadSizeBytes,
      sha256Path: join(options.outDir, 'Zhiying-Setup.exe.sha256'),
      releaseInfoPath: join(options.outDir, 'release-info.json'),
      build: buildSummary,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function printHelp() {
  process.stdout.write(
    [
      '构建知影 Windows 单文件安装程序 Zhiying-Setup.exe',
      '',
      '用法：node scripts/build-installer.mjs [选项]',
      '  --version <x.y.z>       版本号（默认沿用发行目录/1.8.0）',
      '  --out <dir>             输出目录（默认 dist）',
      '  --profile lite|full     发行 profile（默认 lite）',
      '  --input <dir>           复用已有发行目录（不重新构建）',
      '  --external-payload      不嵌入 payload.zip，改为同目录外置文件',
      '  --embed-payload         full profile 也强制嵌入 payload',
      '  --dry-run               只打印计划，不写盘',
      '  --json                  以 JSON 输出摘要',
      '',
    ].join('\n'),
  );
}

async function main() {
  const options = parseInstallerArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  try {
    const result = await buildInstaller(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (result.dryRun) {
      process.stdout.write(`安装器构建计划（dry-run）：\n`);
      for (const item of result.planned) process.stdout.write(`  · ${item}\n`);
    } else {
      process.stdout.write(`安装器构建完成：${result.setupExe}\n`);
      process.stdout.write(`  SHA-256：${result.setupSha256}\n`);
      process.stdout.write(`  版本：${result.version}  发行 profile：${result.profile}  payload：${result.embed ? '嵌入' : '外置'}\n`);
      process.stdout.write(`  哈希文件：${result.sha256Path}\n发布信息：${result.releaseInfoPath}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`安装器构建失败：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main()
    .then(code => process.exit(code))
    .catch(error => {
      process.stderr.write(`安装器构建异常：${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
