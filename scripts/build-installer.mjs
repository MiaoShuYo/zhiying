#!/usr/bin/env node
/**
 * #103 Zhiying-Setup.exe 构建脚本（Inno Setup 6 标准安装程序）。
 *
 * 复用 build-desktop 产物（或 --input 指定发行目录），通过 ISCC.exe 编译
 * apps/desktop/native/ZhiyingSetup.iss（payload 由 Inno [Files] 直接内嵌，不再生成 payload.zip）。
 *
 * 输出：dist/Zhiying-Setup.exe + Zhiying-Setup.exe.sha256 + release-info.json。
 * 最终 EXE 是 GUI 启动壳，内嵌 Inno 单文件安装器，并为 Inno 子进程设置独立可写 TEMP/TMP。
 *
 * ISCC 定位顺序：ISCC_PATH → %LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe
 * → %ProgramFiles(x86)%\Inno Setup 6\ISCC.exe → PATH 中 iscc。
 * --dry-run 只打印 ISCC 命令与产物计划，不写盘。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildDesktop, normalizePeExecutable, parseBuildArgs } from './build-desktop.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const DEFAULT_VERSION = '1.8.0';
const ISS_PATH = join(REPO_ROOT, 'apps', 'desktop', 'native', 'ZhiyingSetup.iss');
const BOOTSTRAPPER_PATH = join(REPO_ROOT, 'apps', 'desktop', 'native', 'ZhiyingSetupBootstrapper.cs');
const LANGUAGE_PATH = join(REPO_ROOT, 'apps', 'desktop', 'native', 'languages', 'ChineseSimplified.isl');
const CSC_PATH = process.env.CSC_PATH || 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

function parseInstallerArgs(argv) {
  const options = {
    version: undefined,
    outDir: resolve(REPO_ROOT, 'dist'),
    profile: 'lite',
    inputDir: undefined,
    isccPath: undefined,
    dryRun: false,
    json: false,
    help: false,
    buildNode: undefined,
    buildFfmpegDir: undefined,
    buildPythonDir: undefined,
    buildOllamaDir: undefined,
    buildWebStandalone: undefined,
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
      case '--iscc': {
        const value = takeValue();
        if (value) options.isccPath = resolve(process.cwd(), value);
        break;
      }
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

/** 按契约顺序定位 Inno Setup 6 的 ISCC.exe。 */
function locateIscc(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  if (process.env.ISCC_PATH) candidates.push(process.env.ISCC_PATH);
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) candidates.push(join(localAppData, 'Programs', 'Inno Setup 6', 'ISCC.exe'));
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  if (programFilesX86) candidates.push(join(programFilesX86, 'Inno Setup 6', 'ISCC.exe'));
  const programFiles = process.env.ProgramFiles;
  if (programFiles) candidates.push(join(programFiles, 'Inno Setup 6', 'ISCC.exe'));
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  for (const directory of pathValue.split(';')) {
    if (!directory.trim()) continue;
    candidates.push(join(directory.trim(), 'iscc.exe'));
    candidates.push(join(directory.trim(), 'ISCC.exe'));
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return resolve(candidate);
  }
  throw new Error(
    '未找到 Inno Setup 6 的 ISCC.exe。\n' +
      '请安装 Inno Setup 6（构建期工具，最终用户无需安装）：\n' +
      '  winget install -e --id JRSoftware.InnoSetup\n' +
      '或设置环境变量 ISCC_PATH 指向 ISCC.exe。',
  );
}

async function detectInnoVersion() {
  const script = [
    "$keys = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Inno Setup 6_is1',",
    "'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Inno Setup 6_is1',",
    "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Inno Setup 6_is1');",
    'foreach ($key in $keys) { if (Test-Path $key) { (Get-ItemProperty $key).DisplayVersion; break } }',
  ].join(' ');
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const version = stdout.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean).pop();
    return version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function readPeSubsystem(path) {
  const buffer = readFileSync(path);
  const peOffset = buffer.readUInt32LE(0x3c);
  return buffer.readUInt16LE(peOffset + 0x5c);
}

async function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    import('node:fs').then(fs => {
      const hash = createHash('sha256');
      const fileStream = fs.createReadStream(path);
      fileStream.on('data', chunk => hash.update(chunk));
      fileStream.once('error', rejectPromise);
      fileStream.once('end', () => resolvePromise(hash.digest('hex')));
    });
  });
}

function quoteForDisplay(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

async function readComponents(productDir) {
  try {
    return JSON.parse(await readFile(join(productDir, 'components.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

async function verifySetupExecutable(setupExe, version) {
  if (!existsSync(setupExe)) throw new Error(`ISCC 未生成安装程序：${setupExe}`);
  const subsystem = readPeSubsystem(setupExe);
  if (subsystem !== 2) throw new Error(`Zhiying-Setup.exe 子系统应为 GUI(2)，实际 ${subsystem}`);
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item '${setupExe.replace(/'/g, "''")}').VersionInfo.FileVersion`],
      { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const fileVersion = stdout.trim();
    const expectedPrefix = version.split('.').slice(0, 3).join('.');
    if (fileVersion && !fileVersion.startsWith(expectedPrefix)) {
      throw new Error(`Zhiying-Setup.exe FileVersion=${fileVersion} 与版本 ${version} 不一致`);
    }
  } catch (error) {
    if (/与版本/.test((error?.message ?? ''))) throw error;
    /* 版本读取失败不阻塞构建（ISCC 已按 /D 注入版本）。 */
  }
}

/** 将 Inno 单文件安装器嵌入 GUI 启动壳，并为 Inno 子进程提供独立可写的 TEMP/TMP。 */
async function compileSetupBootstrapper(outputPath, payloadPath, version) {
  if (process.platform !== 'win32') throw new Error('安装器启动壳只能在 Windows 上通过 csc.exe 构建');
  if (!existsSync(CSC_PATH)) throw new Error(`未找到 csc.exe：${CSC_PATH}（可通过 CSC_PATH 环境变量指定）`);
  if (!existsSync(BOOTSTRAPPER_PATH)) throw new Error(`缺少安装器启动壳源码：${BOOTSTRAPPER_PATH}`);

  const buildDir = await mkdtemp(join(tmpdir(), 'zhiying-setup-bootstrapper-'));
  const assemblyInfo = join(buildDir, 'ZhiyingSetupBootstrapper.AssemblyInfo.cs');
  const version4 = assemblyVersion(version);
  await writeFile(
    assemblyInfo,
    [
      'using System.Reflection;',
      `[assembly: AssemblyVersion("${version4}")]`,
      `[assembly: AssemblyFileVersion("${version4}")]`,
      '[assembly: AssemblyTitle("知影 Zhiying Setup")]',
      '[assembly: AssemblyProduct("知影 Zhiying")]',
      '[assembly: AssemblyCompany("MiaoShuYo")]',
      '[assembly: AssemblyDescription("知影安装程序启动壳（修复临时目录权限兼容）")]',
      '',
    ].join('\n'),
    'utf8',
  );
  const args = [
    '/nologo',
    '/target:winexe',
    '/platform:x64',
    '/optimize+',
    '/reference:System.Windows.Forms.dll',
    `/out:${outputPath}`,
    `/resource:${payloadPath},Zhiying.SetupPayload`,
    BOOTSTRAPPER_PATH,
    assemblyInfo,
  ];
  try {
    await execFileAsync(CSC_PATH, args, { windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    normalizePeExecutable(outputPath);
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    throw new Error(`编译安装器启动壳失败：\n${output || error.message}`);
  } finally {
    await rm(buildDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 构建 Inno Setup 安装程序；返回摘要。 */
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
  for (const required of ['Zhiying.exe', 'app', 'runtime']) {
    if (!existsSync(join(productDir, required))) {
      throw new Error(`发行目录不完整：缺少 ${required}（${productDir}）。请先运行 pnpm build:desktop。`);
    }
  }
  if (!existsSync(ISS_PATH)) throw new Error(`缺少 Inno Setup 脚本：${ISS_PATH}`);
  if (!existsSync(BOOTSTRAPPER_PATH)) throw new Error(`缺少安装器启动壳源码：${BOOTSTRAPPER_PATH}`);
  if (!existsSync(LANGUAGE_PATH)) throw new Error(`缺少中文语言文件：${LANGUAGE_PATH}（来源 Inno 官方 issrc Files/Languages/ChineseSimplified.isl）`);

  const iscc = locateIscc(options.isccPath);
  const outDir = resolve(options.outDir);
  const setupExe = join(outDir, 'Zhiying-Setup.exe');
  const makeIsccArgs = payloadOutDir => [
    '/Qp',
    `/DAppVersion=${version}`,
    `/DAppVersion4=${assemblyVersion(version)}`,
    `/DAppProfile=${profile}`,
    `/DPayloadDir=${resolve(productDir)}`,
    `/DOutDir=${payloadOutDir}`,
    ISS_PATH,
  ];
  const plannedPayloadDir = join(outDir, '.zhiying-installer-payload');
  const plannedIsccArgs = makeIsccArgs(plannedPayloadDir);
  const commandLine = [iscc, ...plannedIsccArgs].map(quoteForDisplay).join(' ');
  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      installer: 'inno-setup',
      iscc,
      innoVersion: await detectInnoVersion(),
      productDir,
      version,
      profile,
      setupExe,
      bootstrapperSource: BOOTSTRAPPER_PATH,
      sha256Path: join(outDir, 'Zhiying-Setup.exe.sha256'),
      releaseInfoPath: join(outDir, 'release-info.json'),
      command: commandLine,
      planned: [
        `ISCC 编译 Inno payload：${ISS_PATH}`,
        `csc 将 payload 嵌入 GUI 启动壳：${setupExe}`,
        '启动壳只为安装器子进程设置独立可写的 TEMP/TMP，不修改系统或用户环境变量',
        `payload 目录：${resolve(productDir)}（由 Inno [Files] 内嵌，排除 models/data/logs/config/install.json）`,
        `输出：${setupExe}`,
        '生成 Zhiying-Setup.exe.sha256 与 release-info.json（installer=inno-setup）',
      ],
      build: buildSummary,
    };
  }
  await mkdir(outDir, { recursive: true });
  await rm(setupExe, { force: true }).catch(() => undefined);
  await rm(`${setupExe}.sha256`, { force: true }).catch(() => undefined);
  const buildDir = await mkdtemp(join(tmpdir(), 'zhiying-installer-build-'));
  const payloadSetupExe = join(buildDir, 'Zhiying-Setup.exe');
  const isccArgs = makeIsccArgs(buildDir);
  const actualCommandLine = [iscc, ...isccArgs].map(quoteForDisplay).join(' ');
  try {
    await execFileAsync(iscc, isccArgs, {
      cwd: REPO_ROOT,
      windowsHide: true,
      timeout: 1_800_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    await rm(buildDir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`ISCC 编译安装程序失败：\n${output || error.message}\n命令：${actualCommandLine}`);
  }
  try {
    await verifySetupExecutable(payloadSetupExe, version);
    await compileSetupBootstrapper(setupExe, payloadSetupExe, version);
    await verifySetupExecutable(setupExe, version);
  } finally {
    await rm(buildDir, { recursive: true, force: true }).catch(() => undefined);
  }
  const setupSha256 = await sha256File(setupExe);
  const setupSizeBytes = (await stat(setupExe)).size;
  await writeFile(join(outDir, 'Zhiying-Setup.exe.sha256'), `${setupSha256}  Zhiying-Setup.exe\n`, 'utf8');
  const components = await readComponents(productDir);
  const innoVersion = await detectInnoVersion();
  const releaseInfo = {
    schemaVersion: 1,
    product: 'zhiying',
    version,
    profile,
    installer: 'inno-setup',
    innoVersion,
    setup: {
      file: 'Zhiying-Setup.exe',
      sha256: setupSha256,
      sizeBytes: setupSizeBytes,
      bootstrapper: 'csharp-gui',
      tempDirectory: '%LOCALAPPDATA%\\Zhiying\\InstallerStaging\\<run-id>',
    },
    payload: {
      embedded: true,
      mode: 'inno-files',
      source: `desktop/Zhiying-${version}-${profile}`,
    },
    components,
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(outDir, 'release-info.json'), `${JSON.stringify(releaseInfo, null, 2)}\n`, 'utf8');
  return {
    ok: true,
    dryRun: false,
    installer: 'inno-setup',
    innoVersion,
    iscc,
    productDir,
    version,
    profile,
    setupExe,
    setupSha256,
    setupSizeBytes,
    sha256Path: join(outDir, 'Zhiying-Setup.exe.sha256'),
    releaseInfoPath: join(outDir, 'release-info.json'),
    build: buildSummary,
  };
}

function printHelp() {
  process.stdout.write(
    [
      '构建知影 Windows 标准安装程序（Inno Setup 6）',
      '',
      '用法：node scripts/build-installer.mjs [选项]',
      '  --version <x.y.z>       版本号（默认沿用发行目录/1.8.0）',
      '  --out <dir>             输出目录（默认 dist）',
      '  --profile lite|full     发行 profile（默认 lite）',
      '  --input <dir>           复用已有发行目录（不重新构建 desktop）',
      '  --iscc <path>           指定 ISCC.exe（默认按契约顺序自动定位）',
      '  --dry-run               只打印 ISCC 命令与产物计划，不写盘',
      '  --json                  以 JSON 输出摘要',
      '',
      'Inno Setup 6 是构建期工具（最终用户无需安装）：',
      '  winget install -e --id JRSoftware.InnoSetup',
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
      process.stdout.write('安装器构建计划（dry-run，未写盘）：\n');
      process.stdout.write(`  ISCC：${result.iscc}（Inno Setup ${result.innoVersion}）\n`);
      for (const item of result.planned) process.stdout.write(`  · ${item}\n`);
      process.stdout.write(`  命令：${result.command}\n`);
    } else {
      process.stdout.write(`安装器构建完成：${result.setupExe}\n`);
      process.stdout.write(`  SHA-256：${result.setupSha256}\n`);
      process.stdout.write(`  版本：${result.version}  profile：${result.profile}  Inno Setup：${result.innoVersion}\n`);
      process.stdout.write(`  大小：${result.setupSizeBytes} 字节\n`);
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
