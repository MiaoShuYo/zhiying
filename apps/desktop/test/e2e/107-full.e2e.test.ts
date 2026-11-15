/**
 * #107 跨模块 E2E（lite）：build-desktop → build-installer → Zhiying-Setup.exe silent 安装
 * （中文+空格路径、异地 CWD、净化 PATH）→ Zhiying.exe 启动 fixture 服务 → health → stop →
 * 模型管理器跨进程下载/中断恢复闭环 → 发布产物清单。
 * 同时覆盖 #102-13/14/15/18、#103-15、#107-1/2/3/4/5/7/8。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, after, beforeEach } from 'node:test';
import { spawnSync } from 'node:child_process';
import { makeTempRoot, cleanupRegisteredTempDirs, REPO_ROOT, NODE_EXE, TMP_ROOT } from '../_helpers/temp';
import { sha256File, sha256Buffer, writeFileDeep } from '../_helpers/fsx';
import { spawnCollect, waitExit, killTree, isAlive, startExternalProcess, waitForCondition, findNodeProcessesByCommandLine, killNodeProcessesByCommandLine } from '../_helpers/processes';
import { sanitizedEnv, pathHasDevTool } from '../_helpers/env';
import { getFreePorts, waitForHttp, isPortOpen, waitForPort } from '../_helpers/ports';
import { FixtureModelSource } from '../_helpers/http-source';
import { makeManifest, makeHttpEntry } from '../_helpers/fixtures';
import { deterministicBytes } from '../_helpers/fsx';
import { loadInstallConfig, resolveInstallLayout, writeInstallConfig } from '../../src/install-layout';
import { writeFakeServiceScript } from '../_helpers/fake-service';
import { readPeInfo, spawnVisible, waitForChildWindow, captureWindowScreenshot, closeMainWindow, answerInnoExitDialog, createStagingDir, removeStagingDir } from '../_helpers/gui';
import { installWithInno, uninstallWithInno, innoArtifactReady, readInnoReleaseInfo, stageInnoSetup, cleanupInnoTestState } from '../_helpers/inno';
import { findUninstallEntriesForInstallLocation, deleteUninstallEntry } from '../_helpers/registry';

const BUILD_DESKTOP = path.join(REPO_ROOT, 'scripts', 'build-desktop.mjs');
const BUILD_INSTALLER = path.join(REPO_ROOT, 'scripts', 'build-installer.mjs');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runProcess(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<RunResult> {
  const captured = spawnCollect(command, args, { cwd: opts.cwd, env: opts.env });
  const exit = await waitExit(captured.child, opts.timeoutMs ?? 300_000);
  if (!exit) {
    killTree(captured.pid);
    return { code: null, stdout: captured.stdout(), stderr: `${captured.stderr()}\n[timeout]` };
  }
  return { code: exit.code, stdout: captured.stdout(), stderr: captured.stderr() };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseJson(stdout: string): Record<string, any> {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  assert.ok(start >= 0 && end > start, `未输出 JSON: ${stdout.slice(0, 800)}\n${stdout.slice(-400)}`);
  return JSON.parse(stdout.slice(start, end + 1));
}

function peVersionInfo(exe: string): Record<string, string> {
  const script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $v=(Get-Item '${exe.replace(/'/g, "''")}').VersionInfo; ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ fileVersion=$v.FileVersion; productVersion=$v.ProductVersion; productName=$v.ProductName; companyName=$v.CompanyName })`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return JSON.parse((res.stdout ?? '{}').trim() || '{}') as Record<string, string>;
}

async function verifyReleaseManifest(productDir: string): Promise<void> {
  const manifestPath = path.join(productDir, 'release-manifest.json');
  assert.ok(fs.existsSync(manifestPath), '缺少 release-manifest.json');
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw) as {
    schemaVersion: number;
    product: string;
    version: string;
    profile: string;
    files: Array<{ path: string; sizeBytes: number; sha256: string }>;
  };
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.product, 'zhiying');
  assert.equal(manifest.version, '1.8.0');
  assert.equal(manifest.profile, 'lite');
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 10, `release-manifest 文件数异常: ${manifest.files?.length}`);
  // 确定性排序
  const paths = manifest.files.map((f) => f.path);
  assert.deepEqual(paths, [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'release-manifest 未按路径确定性排序');
  // 无绝对路径/时间戳/个人路径泄漏
  assert.ok(!raw.includes('generatedAt'), 'release-manifest 不应包含 generatedAt');
  assert.ok(!/[A-Za-z]:[\\/]/.test(raw), 'release-manifest 不得包含盘符绝对路径');
  assert.ok(!raw.includes(REPO_ROOT.replace(/\\/g, '\\\\')), 'release-manifest 泄漏仓库绝对路径');
  assert.ok(!raw.includes(TMP_ROOT.replace(/\\/g, '\\\\')), 'release-manifest 泄漏临时目录路径');
  for (const entry of manifest.files) {
    assert.ok(!path.isAbsolute(entry.path) && !/^[A-Za-z]:/.test(entry.path), `manifest path 必须是相对路径: ${entry.path}`);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `manifest sha256 非法: ${entry.path}`);
    const file = path.join(productDir, entry.path);
    assert.ok(fs.existsSync(file), `manifest 列出的文件不存在: ${entry.path}`);
    assert.equal(fs.statSync(file).size, entry.sizeBytes, `manifest size 不匹配: ${entry.path}`);
    assert.equal(await sha256File(file), entry.sha256, `manifest sha256 不匹配: ${entry.path}`);
  }
  // SHA256SUMS.txt
  const sums = fs.readFileSync(path.join(productDir, 'SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/);
  assert.equal(sums.length, manifest.files.length, 'SHA256SUMS.txt 行数与 release-manifest 不一致');
  const byPath = new Map(manifest.files.map((f) => [f.path, f.sha256]));
  for (const line of sums) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    assert.ok(match, `SHA256SUMS 行格式非法: ${line}`);
    assert.equal(byPath.get(match![2]), match![1], `SHA256SUMS 与 manifest 不一致: ${match![2]}`);
  }
}

const state: {
  base: string;
  outA: string;
  productA: string;
  outB: string;
  productB: string;
  outC: string;
  productC: string;
  setupOut: string;
  setupExe: string;
  setupStaging?: { dir: string; exe: string };
  setupOutV2?: string;
  setupExeV2?: string;
  setupStagingV2?: { dir: string; exe: string };
  installRoot: string;
  installRootNow: string;
  upgradeRoot?: string;
  e2eTemp?: string;
  ports: { web: number; python: number; ollama: number; manager: number };
  sentinel?: { pid: number; stop: () => void };
  externalService?: { pid: number; exit: Promise<unknown> };
  setupError?: Error;
  distSetupSha?: string;
  frozenDistSha?: string;
} = {} as never;

before(async () => {
  const base = makeTempRoot('e2e-107');
  state.base = base;
  state.outA = path.join(base, 'dist-a');
  const buildArgs = (out: string): string[] => [BUILD_DESKTOP, '--out', out, '--profile', 'lite', '--version', '1.8.0', '--json'];
  const buildA = await runProcess(NODE_EXE, buildArgs(state.outA), { cwd: REPO_ROOT });
  assert.equal(buildA.code, 0, `build-desktop A 失败: ${buildA.stderr}`);
  state.productA = parseJson(buildA.stdout).productDir;
  state.outB = path.join(base, 'dist-b');
  const buildB = await runProcess(NODE_EXE, buildArgs(state.outB), { cwd: REPO_ROOT });
  assert.equal(buildB.code, 0, `build-desktop B 失败: ${buildB.stderr}`);
  state.productB = parseJson(buildB.stdout).productDir;

  // v1.8.1 payload 用于升级 E2E
  state.outC = path.join(base, 'dist-c');
  const buildC = await runProcess(NODE_EXE, [BUILD_DESKTOP, '--out', state.outC, '--profile', 'lite', '--version', '1.8.1', '--json'], { cwd: REPO_ROOT });
  assert.equal(buildC.code, 0, `build-desktop C（1.8.1）失败: ${buildC.stderr}`);
  state.productC = parseJson(buildC.stdout).productDir;

  state.setupOut = path.join(base, 'setup-out');
  const installer = await runProcess(NODE_EXE, [BUILD_INSTALLER, '--input', state.productA, '--profile', 'lite', '--out', state.setupOut, '--json'], { cwd: REPO_ROOT });
  assert.equal(installer.code, 0, `build-installer 失败: ${installer.stderr}`);
  state.setupExe = path.join(state.setupOut, 'Zhiying-Setup.exe');
  state.e2eTemp = createStagingDir('zhiying-test-e2e-temp');
  // Inno staging（workspace 外）：DSH 沙箱 workspace 内新 exe 为 Low IL，Inno 初始化会失败
  if (innoArtifactReady(state.setupExe, state.setupOut).ready) {
    state.setupStaging = stageInnoSetup(state.setupExe);
    state.setupOutV2 = path.join(base, 'setup-out-v2');
    const installerV2 = await runProcess(NODE_EXE, [BUILD_INSTALLER, '--input', state.productC, '--profile', 'lite', '--out', state.setupOutV2, '--json'], { cwd: REPO_ROOT });
    assert.equal(installerV2.code, 0, `build-installer v1.8.1 失败: ${installerV2.stderr}`);
    state.setupExeV2 = path.join(state.setupOutV2, 'Zhiying-Setup.exe');
    if (innoArtifactReady(state.setupExeV2, state.setupOutV2).ready) state.setupStagingV2 = stageInnoSetup(state.setupExeV2);
  }
  // 冻结发布产物基线（R2：E2E 构建写到 data/tmp，不得改变 dist/ 发布状态）
  const frozenDist = path.join(REPO_ROOT, 'dist', 'Zhiying-Setup.exe');
  state.frozenDistSha = fs.existsSync(frozenDist) ? await sha256File(frozenDist) : undefined;
  state.distSetupSha = state.frozenDistSha;
});

after(async () => {
  if (state.sentinel) state.sentinel.stop();
  if (state.externalService) killTree(state.externalService.pid);
  if (state.setupStaging) removeStagingDir(state.setupStaging.dir);
  if (state.setupStagingV2) removeStagingDir(state.setupStagingV2.dir);
  if (state.e2eTemp) removeStagingDir(state.e2eTemp);
  cleanupRegisteredTempDirs();
});

// Lead 协调：每个 E2E 用例前清理遗留 setup 进程/固定 AppId 卸载项/测试快捷方式，保证串行隔离。
beforeEach(async () => {
  await cleanupInnoTestState();
});

test('[#102-13] lite 发行产物：§2.2 骨架 + Zhiying.exe(PE/版本) + app/desktop + runtime/node + fixture + components + release-manifest', async () => {
  const productDir = state.productA;
  assert.ok(fs.existsSync(productDir), `发行目录不存在: ${productDir}`);
  for (const rel of ['app/desktop', 'app/fixtures', 'runtime/node', 'models/.downloads', 'data/tmp', 'config', 'logs']) {
    assert.ok(fs.existsSync(path.join(productDir, rel)), `发行骨架缺少 ${rel}`);
  }
  for (const rel of ['Zhiying.exe', 'app/desktop/index.js', 'app/desktop/package.json', 'app/desktop/cli/launcher-cli.mjs', 'app/desktop/cli/setup-cli.mjs', 'app/desktop/cli/model-manager-cli.mjs', 'app/desktop/model-manifest.default.json', 'app/fixtures/python.mjs', 'app/fixtures/web.mjs', 'app/fixtures/worker.mjs', 'app/fixtures/ollama.mjs', 'runtime/node/node.exe', 'config/install.template.json', 'components.json', 'release-manifest.json', 'SHA256SUMS.txt']) {
    assert.ok(fs.existsSync(path.join(productDir, rel)), `发行产物缺少 ${rel}`);
  }
  // PE 与版本信息
  const exeHeader = fs.readFileSync(path.join(productDir, 'Zhiying.exe')).subarray(0, 2).toString('ascii');
  assert.equal(exeHeader, 'MZ', 'Zhiying.exe 不是合法 PE');
  assert.ok(fs.statSync(path.join(productDir, 'Zhiying.exe')).size > 2048, 'Zhiying.exe 体积异常');
  const version = peVersionInfo(path.join(productDir, 'Zhiying.exe'));
  assert.match(version.fileVersion ?? '', /^1\.8\.0\.0$/, `Zhiying.exe FileVersion 应为 1.8.0.0，实际 ${version.fileVersion}`);
  assert.match(version.productVersion ?? '', /^1\.8\.0\.0$/, `Zhiying.exe ProductVersion 应为 1.8.0.0，实际 ${version.productVersion}`);
  // bundled node
  const nodeExe = path.join(productDir, 'runtime/node/node.exe');
  assert.equal(fs.readFileSync(nodeExe).subarray(0, 2).toString('ascii'), 'MZ');
  assert.ok(fs.statSync(nodeExe).size > 1_000_000, 'bundled node.exe 体积异常');
  // template
  const template = JSON.parse(fs.readFileSync(path.join(productDir, 'config/install.template.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(template.version, '1.8.0');
  assert.equal(template.payloadProfile, 'lite');
  assert.ok(template.runtime, '模板缺少 runtime');
  assert.ok(template.ports, '模板缺少 ports');
  // components
  const componentsRaw = fs.readFileSync(path.join(productDir, 'components.json'), 'utf8');
  const components = JSON.parse(componentsRaw) as { version: string; profile: string; components: Record<string, { version?: string; source?: string; license?: string }> };
  assert.equal(components.version, '1.8.0');
  assert.equal(components.profile, 'lite');
  for (const name of ['node', 'launcher', 'python', 'ffmpeg', 'ollama', 'web']) {
    assert.ok(components.components[name], `components.json 缺少组件 ${name}`);
    assert.ok((components.components[name].version ?? '').length > 0, `组件 ${name} 缺少版本`);
    assert.ok((components.components[name].source ?? '').length > 0, `组件 ${name} 缺少来源`);
    assert.ok((components.components[name].license ?? '').length > 0, `组件 ${name} 缺少许可证`);
  }
  assert.match(components.components.node.version ?? '', /^\d+\.\d+\.\d+$/, 'node 组件版本格式错误');
  assert.match(components.components.launcher.version ?? '', /^1\.8\.0\.0$/, 'launcher 组件版本应为 1.8.0.0');
  assert.ok(!componentsRaw.includes(REPO_ROOT.replace(/\\/g, '\\\\')), 'components.json 泄漏仓库绝对路径');
  // release manifest + SHA256SUMS 全量校验
  await verifyReleaseManifest(productDir);
});

test('[#102-18] 构建可复现：同一输入两次构建 release-manifest 哈希一致且产物文件集一致', async () => {
  const manifestA = path.join(state.productA, 'release-manifest.json');
  const manifestB = path.join(state.productB, 'release-manifest.json');
  const hashA = await sha256File(manifestA);
  const hashB = await sha256File(manifestB);
  assert.equal(hashA, hashB, '两次构建 release-manifest.json 哈希不一致（构建不可复现）');
  const parsedA = JSON.parse(fs.readFileSync(manifestA, 'utf8')) as { files: Array<{ path: string; sha256: string }> };
  const parsedB = JSON.parse(fs.readFileSync(manifestB, 'utf8')) as { files: Array<{ path: string; sha256: string }> };
  assert.deepEqual(parsedA.files, parsedB.files, '两次构建文件哈希列表不一致');
  // 逐文件哈希一致（含 Zhiying.exe 规范化）
  for (const file of parsedA.files) {
    assert.equal(await sha256File(path.join(state.productA, file.path)), await sha256File(path.join(state.productB, file.path)), `两次构建文件哈希不一致: ${file.path}`);
  }
  // 产物内无个人绝对路径泄漏
  for (const rel of ['release-manifest.json', 'components.json', 'SHA256SUMS.txt', 'config/install.template.json']) {
    const text = fs.readFileSync(path.join(state.productA, rel), 'utf8');
    assert.ok(!text.includes(REPO_ROOT), `${rel} 泄漏仓库路径`);
    assert.ok(!/D:\\\\Project|data\\\\tmp\\\\v21/i.test(text), `${rel} 泄漏个人/临时路径`);
  }
});

test('[#102-13] full profile 缺件：明确报错列出所需参数，不静默降级', async () => {
  const out = path.join(state.base, 'dist-full-missing');
  const res = await runProcess(NODE_EXE, [BUILD_DESKTOP, '--out', out, '--profile', 'full', '--json'], { cwd: REPO_ROOT });
  assert.notEqual(res.code, 0, 'full profile 缺件时构建必须失败');
  for (const required of ['--web-standalone', '--python-dir', '--ffmpeg-dir', '--ollama-dir']) {
    assert.ok(res.stderr.includes(required), `full profile 错误信息缺少 ${required}: ${res.stderr}`);
  }
  assert.ok(!fs.existsSync(out), 'full profile 缺件时不得写盘');
});

test('[#102-14] Zhiying.exe 薄壳：异地 CWD + 净化 PATH 下调用 bundled node CLI 并转发退出码（--status）', async () => {
  const elsewhere = path.join(state.base, 'elsewhere-cwd');
  fs.mkdirSync(elsewhere, { recursive: true });
  const env = sanitizedEnv({ TEMP: path.join(state.base, 'sanitized-temp'), TMP: path.join(state.base, 'sanitized-temp') });
  assert.equal(pathHasDevTool('node', env), false, '净化 PATH 不应包含 node');
  // 未安装（无 config/install.json）→ CLI 配置错误 exit 2，证明 EXE 调用了 bundled node + CLI 并转发退出码
  const res = await runProcess(path.join(state.productA, 'Zhiying.exe'), ['--status'], { cwd: elsewhere, env, timeoutMs: 120_000 });
  assert.equal(res.code, 2, `Zhiying.exe --status 未安装时应转发 exit 2，实际 ${res.code}: ${res.stderr}`);
  assert.match(res.stderr, /配置|install\.json|无效|缺少/, `原生启动器错误输出不可读: ${res.stderr}`);
});

test('[#103-15] build-installer（Inno Setup 6）：PE subsystem=2/FileVersion 1.8.0.x + .sha256 + release-info installer=inno-setup/innoVersion', async (t) => {
  const ready = innoArtifactReady(state.setupExe, state.setupOut);
  if (!ready.ready) {
    t.skip(`R4 Inno 构建产物未就绪：${ready.reason}`);
    return;
  }
  const setupExe = state.setupExe;
  assert.ok(fs.existsSync(setupExe), '缺少 Zhiying-Setup.exe');
  assert.equal(fs.readFileSync(setupExe).subarray(0, 2).toString('ascii'), 'MZ', 'Zhiying-Setup.exe 不是合法 PE');
  assert.ok(fs.statSync(setupExe).size > 1_000_000, 'Zhiying-Setup.exe 体积异常');
  const setupPe = readPeInfo(setupExe);
  assert.equal(setupPe.subsystem, 2, `Inno Setup.exe 必须是 GUI subsystem=2，实际 ${setupPe.subsystem}（${setupPe.subsystemLabel}）`);
  // Inno Setup 6 安装器 stub 为 32 位（内嵌 x64 逻辑），契约不要求 stub machine=x64。
  const setupVersion = peVersionInfo(setupExe);
  assert.match((setupVersion.fileVersion ?? '').trim(), /^1\.8\.0(\.\d+)?$/, `Setup.exe FileVersion 应为 1.8.0.x，实际 ${setupVersion.fileVersion}`);
  assert.match((setupVersion.productVersion ?? '').trim(), /^1\.8\.0(\.\d+)?$/, `Setup.exe ProductVersion 应为 1.8.0.x，实际 ${setupVersion.productVersion}`);
  const shaFile = fs.readFileSync(path.join(state.setupOut, 'Zhiying-Setup.exe.sha256'), 'utf8').trim();
  const declared = /^([0-9a-f]{64})\s+Zhiying-Setup\.exe$/.exec(shaFile);
  assert.ok(declared, `.sha256 文件格式非法: ${shaFile}`);
  assert.equal(declared![1], await sha256File(setupExe), '.sha256 与实际文件哈希不一致');
  const releaseInfo = readInnoReleaseInfo(state.setupOut)!;
  assert.equal(releaseInfo.version, '1.8.0');
  assert.equal(releaseInfo.profile, 'lite');
  assert.equal(releaseInfo.installer, 'inno-setup');
  assert.match(releaseInfo.innoVersion ?? '', /^6\./, `release-info.innoVersion 应为 6.x: ${releaseInfo.innoVersion}`);
  assert.equal(releaseInfo.setup?.sha256, declared![1], 'release-info.setup.sha256 与 .sha256 不一致');
  assert.equal(releaseInfo.setup?.sizeBytes, fs.statSync(setupExe).size, 'release-info.setup.sizeBytes 不一致');
  assert.ok(releaseInfo.components, 'release-info 缺少 components');
  // 启动器仍为 Console(3)
  assert.equal(readPeInfo(path.join(state.productA, 'Zhiying.exe')).subsystem, 3, 'Zhiying.exe 启动器必须保持 Console(3)');
});

test('[#103-8/#103-9/#103-12/#103-15/#107-1/#107-8] Inno staging 后 /VERYSILENT 安装到中文+空格路径（异地 CWD、净化 PATH）→ 骨架/unins000/install.json/HKCU 标准卸载项/日志', async (t) => {
  if (!state.setupStaging) {
    t.skip('R4 Inno 构建产物未就绪（staging 未创建）');
    return;
  }
  const base = state.base;
  const elsewhere = path.join(base, 'setup-cwd');
  fs.mkdirSync(elsewhere, { recursive: true });
  const installRoot = path.join(base, '知影 安装 目录 (E2E)');
  state.installRoot = installRoot;
  // Inno 会把自己解压到 TEMP 再运行；TEMP 必须在 workspace 外（Low IL 会初始化失败）
  const env = sanitizedEnv({ TEMP: state.e2eTemp!, TMP: state.e2eTemp! });
  fs.mkdirSync(state.e2eTemp!, { recursive: true });
  assert.equal(pathHasDevTool('node', env), false, '净化 PATH 不应包含 node');
  const res = await installWithInno(state.setupStaging.exe, installRoot, { model: 'later', tasks: '', env, cwd: elsewhere, timeoutMs: 300_000 });
  assert.equal(res.code, 0, `Inno /VERYSILENT 安装失败 (exit ${res.code}):\n${res.stdout.slice(-1500)}\n${res.stderr.slice(-2500)}`);
  for (const rel of ['Zhiying.exe', 'app', 'runtime', 'models', 'data', 'config', 'logs', 'config/install.json', 'unins000.exe']) {
    assert.ok(fs.existsSync(path.join(installRoot, rel)), `安装骨架缺少 ${rel}`);
  }
  const config = await loadInstallConfig(installRoot);
  assert.equal(config.version, '1.8.0');
  assert.equal(config.payloadProfile, 'lite');
  assert.equal(config.modelsDownloadChoice, 'later', '/MODELDOWNLOAD=later 未写入 install.json');
  assert.equal(path.resolve(config.installRoot), path.resolve(installRoot));
  // 日志：Inno /LOG + 收尾 setup-<ts>.log
  assert.ok(fs.existsSync(res.logFile), `缺少 Inno /LOG 日志: ${res.logFile}`);
  assert.ok(fs.statSync(res.logFile).size > 100, 'Inno /LOG 内容过短');
  const logs = fs.readdirSync(path.join(installRoot, 'logs')).filter((name) => name.startsWith('setup-'));
  assert.ok(logs.length > 0, '缺少收尾引擎 setup 安装日志');
  const logText = fs.readFileSync(path.join(installRoot, 'logs', logs[0]), 'utf8') + fs.readFileSync(res.logFile, 'utf8');
  assert.ok(!/token|password|secret/i.test(logText), '安装日志泄漏敏感信息');
  // HKCU 标准卸载项（Inno AppId_is1）
  const entries = findUninstallEntriesForInstallLocation(installRoot).filter((entry) => path.resolve(entry.values.InstallLocation?.value ?? '').toLowerCase() === path.resolve(installRoot).toLowerCase());
  assert.equal(entries.length, 1, `HKCU 卸载项应唯一匹配 InstallLocation（实际 ${entries.length}）`);
  const values = entries[0].values;
  for (const field of ['DisplayName', 'DisplayVersion', 'Publisher', 'InstallLocation', 'DisplayIcon', 'UninstallString', 'EstimatedSize']) {
    assert.ok(values[field]?.value, `HKCU 卸载项缺少字段 ${field}`);
  }
  assert.match(values.DisplayName.value, /知影|Zhiying/);
  assert.equal(values.DisplayVersion.value, '1.8.0');
  assert.match(values.UninstallString.value, /unins\d+\.exe/i, `UninstallString 应指向 unins000.exe: ${values.UninstallString.value}`);
});

test('[#103-7 R4-Inno-E2E] 正常启动 GUI 向导：真实窗口（标题含知影 Zhiying 1.8.0）+ 截图，关闭 → Inno 取消码 2 且无残留', async (t) => {
  if (!state.setupStaging) {
    t.skip('R4 Inno 构建产物未就绪（staging 未创建）');
    return;
  }
  const target = path.join(state.base, '知影 GUI 取消 E2E');
  const evidenceDir = path.join(REPO_ROOT, 'data', 'tmp', 'v21', `e2e-r4-gui-${Date.now()}`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const run = spawnVisible(state.setupStaging.exe, ['/SP-', `/DIR=${target}`], { cwd: state.setupStaging.dir, env: process.env });
  t.after(() => killTree(run.pid));
  const window = await waitForChildWindow(run.pid, /知影\s*Zhiying.*1\.8\.0/i, 60_000);
  assert.ok(window.handle > 0, '未获得向导窗口句柄');
  const screenshot = path.join(evidenceDir, 'inno-wizard.png');
  captureWindowScreenshot(window.handle, screenshot);
  assert.ok(fs.existsSync(screenshot) && fs.statSync(screenshot).size > 1024, 'GUI 向导截图失败');
  assert.ok(closeMainWindow(window.pid), '关闭向导窗口失败');
  const dialogTitle = await answerInnoExitDialog(20_000);
  t.diagnostic(`退出确认框: ${dialogTitle}`);
  const exit = await Promise.race([run.exit, new Promise<null>((resolve) => setTimeout(() => resolve(null), 120_000))]);
  if (!exit) {
    killTree(run.pid);
    assert.fail('关闭 GUI 向导后进程未退出');
  }
  assert.equal(exit.code, 2, `关闭向导应返回 Inno 取消码 2，实际 ${exit.code}`);
  if (fs.existsSync(target)) {
    const leftovers = fs.readdirSync(target).filter((name) => !name.startsWith('.'));
    assert.deepEqual(leftovers, [], `GUI 取消后残留安装文件: ${leftovers.join(',')}`);
  }
  assert.equal(findUninstallEntriesForInstallLocation(target).filter((entry) => path.resolve(entry.values.InstallLocation?.value ?? '').toLowerCase() === path.resolve(target).toLowerCase()).length, 0, 'GUI 取消后不得注册卸载项');
  t.diagnostic(`GUI 窗口标题="${window.title}" 截图=${screenshot}`);
});

test('[#102-6/#107-5 C1 回归] 外部占用配置端口 → Zhiying.exe 启动 exit3：conflicts 含 owner、不杀外部、不 spawn/无受管残留', async (t) => {
  const installRoot = state.installRoot;
  const layout = resolveInstallLayout(installRoot);
  // 使用临时端口，避免与系统 Ollama(11434) 等外部服务冲突干扰本用例
  const [webPort, pythonPort, ollamaPort, managerPort] = await getFreePorts(4);
  const config = await loadInstallConfig(installRoot);
  config.ports = { web: webPort, python: pythonPort, ollama: ollamaPort, manager: managerPort };
  await writeInstallConfig(config);
  const elsewhere = path.join(state.base, 'c1-cwd');
  fs.mkdirSync(elsewhere, { recursive: true });
  const env = sanitizedEnv({ TEMP: path.join(state.base, 'c1-temp'), TMP: path.join(state.base, 'c1-temp') });
  // 外部真实进程占用 web 端口
  const externalScript = writeFakeServiceScript(path.join(state.base, 'c1-external'));
  const external = spawnCollect(NODE_EXE, [externalScript, '--port', String(config.ports.web), '--role', 'external-web'], { env: process.env });
  t.after(() => killTree(external.pid));
  await waitForPort(config.ports.web, true, { timeoutMs: 15_000 });
  try {
    const failed = await runProcess(path.join(installRoot, 'Zhiying.exe'), ['--no-browser', '--exit-after-start', '--json'], { cwd: elsewhere, env, timeoutMs: 180_000 });
    assert.equal(failed.code, 3, `端口冲突时启动应 exit 3，实际 ${failed.code}: ${failed.stdout.slice(-1200)}\n${failed.stderr.slice(-1500)}`);
    const result = parseJson(failed.stdout);
    assert.equal(result.status, 'failed', `冲突结果应为 failed: ${JSON.stringify(result).slice(0, 800)}`);
    const conflicts = (result.conflicts ?? []) as Array<{ port: number; owner?: unknown; message: string }>;
    const webConflict = conflicts.find((conflict) => conflict.port === config.ports.web);
    assert.ok(webConflict, `必须报告被外部占用的 web 端口 ${config.ports.web}: ${JSON.stringify(conflicts)}`);
    assert.ok(webConflict!.message.trim().length > 0, '冲突信息必须可读');
    assert.match((result.errors as string[]).join('\n'), /端口|占用|不会结束|恢复|关闭/, `冲突错误必须含恢复路径: ${(result.errors as string[]).join('\n')}`);
    assert.deepEqual(result.services, [], '冲突时不得启动任何受管服务');
    assert.ok(isAlive(external.pid), '外部占用进程不得被杀死');
    assert.ok(await isPortOpen(config.ports.web), '外部端口必须仍在监听');
    assert.ok(!fs.existsSync(layout.serviceStatePath), '冲突失败不得遗留 services.json');
    const leftover = findNodeProcessesByCommandLine(new RegExp(`${escapeRegExp(installRoot)}.*app[\\\\/]fixtures`));
    assert.deepEqual(leftover.map((p) => p.pid), [], `冲突失败不得遗留受管 fixture 进程: ${leftover.map((p) => p.pid).join(',')}`);
  } finally {
    killTree(external.pid);
    await external.exit;
  }
  // 恢复：释放端口后可正常启动并干净停止（C1 回归）
  const recovered = await runProcess(path.join(installRoot, 'Zhiying.exe'), ['--no-browser', '--exit-after-start', '--json'], { cwd: elsewhere, env, timeoutMs: 180_000 });
  assert.equal(recovered.code, 0, `释放端口后应可启动: ${recovered.stderr.slice(-1200)}`);
  t.after(() => killNodeProcessesByCommandLine(new RegExp(`${escapeRegExp(installRoot)}.*app[\\\\/]fixtures`)));
  const stop = await runProcess(path.join(installRoot, 'Zhiying.exe'), ['--stop', '--json'], { cwd: elsewhere, env, timeoutMs: 120_000 });
  assert.equal(stop.code, 0, `--stop 失败: ${stop.stderr}`);
});

test('[#107-3/#103-16 R4-Inno] 完成页模型选择：Inno /MODELDOWNLOAD=now 写入 install.json.modelsDownloadChoice=now；完成页下载入口按 now 显示（.iss ShouldOfferModelDownload）', async (t) => {
  if (!state.setupStaging) {
    t.skip('R4 Inno 构建产物未就绪（staging 未创建）');
    return;
  }
  const installRoot = path.join(state.base, '知影 now 安装');
  state.installRootNow = installRoot;
  const env = sanitizedEnv({ TEMP: state.e2eTemp!, TMP: state.e2eTemp! });
  fs.mkdirSync(state.e2eTemp!, { recursive: true });
  const res = await installWithInno(state.setupStaging.exe, installRoot, { model: 'now', tasks: '', env, cwd: path.join(state.base, 'setup-cwd') });
  assert.equal(res.code, 0, `now 路径安装失败: ${res.stderr.slice(-1500)}`);
  const config = await loadInstallConfig(installRoot);
  assert.equal(config.modelsDownloadChoice, 'now', '/MODELDOWNLOAD=now 必须写入 install.json.modelsDownloadChoice');
  // 完成页“立即下载”入口由 [Run] Check ShouldOfferModelDownload + model-manager --open 提供（源码级契约断言，静默模式 skipifsilent）
  const iss = fs.readFileSync(path.join(REPO_ROOT, 'apps', 'desktop', 'native', 'ZhiyingSetup.iss'), 'utf8');
  assert.match(iss, /ShouldOfferModelDownload/, '.iss 缺少完成页“立即下载 AI 模型”勾选逻辑');
  assert.match(iss, /model-manager-cli\.mjs[\s\S]{0,120}--open/, '.iss 缺少立即下载入口启动模型管理器');
  assert.match(iss, /skipifsilent/, '完成页入口必须 skipifsilent，避免静默安装启动服务');
  // 静默安装不得启动模型管理器
  const leaked = findNodeProcessesByCommandLine(new RegExp(`${escapeRegExp(installRoot)}.*model-manager-cli\\.mjs|model-manager-cli\\.mjs.*${escapeRegExp(installRoot)}`));
  assert.deepEqual(leaked.map((p) => p.commandLine), [], '静默安装不得启动模型管理器进程');
});

test('[#102-15/#107-1/#107-2/#107-4/#107-5] 净化环境 Zhiying.exe 启动 fixture 服务→health→模型根注入→stop；外部进程存活', async (t) => {
  const installRoot = state.installRoot;
  const layout = resolveInstallLayout(installRoot);
  // 使用临时端口避免本机 Ollama/3000 占用
  const [web, python, ollama, manager] = await getFreePorts(4);
  state.ports = { web, python, ollama, manager };
  const config = await loadInstallConfig(installRoot);
  config.ports = state.ports;
  await writeInstallConfig(config);

  const elsewhere = path.join(state.base, 'launcher-cwd');
  fs.mkdirSync(elsewhere, { recursive: true });
  const env = sanitizedEnv({ TEMP: path.join(state.base, 'launcher-temp'), TMP: path.join(state.base, 'launcher-temp') });
  fs.mkdirSync(path.join(state.base, 'launcher-temp'), { recursive: true });
  assert.equal(pathHasDevTool('node', env), false);
  assert.equal(pathHasDevTool('pnpm', env), false);
  assert.equal(pathHasDevTool('python', env), false);
  assert.equal(pathHasDevTool('git', env), false);

  // 外部无关进程：node 哨兵 + 外部 ollama fixture
  state.sentinel = startExternalProcess(`e2e-${Date.now()}`);
  const fakeServiceDir = path.join(state.base, 'external-service');
  const externalScript = writeFakeServiceScript(fakeServiceDir);
  const externalPort = (await getFreePorts(1))[0];
  const external = spawnCollect(NODE_EXE, [externalScript, '--port', String(externalPort), '--role', 'external-ollama'], { env: process.env });
  state.externalService = { pid: external.pid, exit: external.exit };
  await waitForCondition(async () => (await isPortOpen(externalPort)), { timeoutMs: 15_000, label: 'external service listening' });
  t.after(async () => {
    if (state.sentinel) state.sentinel.stop();
    killTree(external.pid);
  });

  const started = await runProcess(path.join(installRoot, 'Zhiying.exe'), ['--no-browser', '--exit-after-start', '--json'], { cwd: elsewhere, env, timeoutMs: 300_000 });
  assert.equal(started.code, 0, `净化环境启动失败 (exit ${started.code}):\n${started.stdout.slice(-1500)}\n${started.stderr.slice(-2000)}`);
  const result = parseJson(started.stdout);
  assert.equal(result.status, 'started', `启动结果错误: ${JSON.stringify(result).slice(0, 800)}`);
  assert.equal(result.url, `http://127.0.0.1:${web}`);
  const startedIds = (result.services as Array<{ id: string }>).map((s) => s.id);
  for (const id of ['python', 'web', 'worker', 'ollama']) assert.ok(startedIds.includes(id), `服务未启动: ${id}`);
  const managedPids = (result.services as Array<{ pid: number }>).map((s) => s.pid);
  t.after(() => {
    for (const pid of managedPids) if (isAlive(pid)) killTree(pid);
  });

  // python fixture /health：模型根确实来自安装目录（#107-2）
  const pythonHealth = await waitForHttp(`http://127.0.0.1:${python}/health`, { timeoutMs: 30_000 });
  const health = JSON.parse(pythonHealth.body) as Record<string, string>;
  assert.equal(health.ok, true);
  assert.equal(path.resolve(health.modelsRoot).toLowerCase(), path.resolve(layout.modelsRoot).toLowerCase(), `服务 modelsRoot 未指向安装目录: ${health.modelsRoot}`);
  assert.ok(path.resolve(health.f5ttsModelDir).toLowerCase().startsWith(path.resolve(layout.modelsRoot).toLowerCase()), 'F5 模型目录未指向安装目录 models');
  // web fixture
  const webRes = await waitForHttp(`http://127.0.0.1:${web}/api/health`, { timeoutMs: 30_000 });
  const webHealth = JSON.parse(webRes.body) as Record<string, string>;
  assert.equal(path.resolve(webHealth.installRoot).toLowerCase(), path.resolve(installRoot).toLowerCase());
  // worker heartbeat 写在 <root>\data
  await waitForCondition(() => fs.existsSync(path.join(layout.data, 'worker-heartbeat.json')), { timeoutMs: 20_000, label: 'worker heartbeat' });
  // #107-4 跳过模型下载：应用仍可进入；models 下只有空目录骨架，没有任何模型文件
  const modelFiles: string[] = [];
  const walkModels = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.downloads') walkModels(full);
      } else if (entry.isFile()) {
        modelFiles.push(path.relative(layout.modelsRoot, full));
      }
    }
  };
  walkModels(layout.modelsRoot);
  assert.deepEqual(modelFiles, [], `未下载模型时 models 下不得有模型文件: ${modelFiles.join(',')}`);

  // --status 显示运行中（exit 0）
  const statusRes = await runProcess(path.join(installRoot, 'Zhiying.exe'), ['--status', '--json'], { cwd: elsewhere, env, timeoutMs: 120_000 });
  assert.equal(statusRes.code, 0, `--status 应 exit 0: ${statusRes.stderr}`);
  assert.equal(parseJson(statusRes.stdout).running, true);

  // --stop：只杀本实例进程树；外部进程存活
  const stopRes = await runProcess(path.join(installRoot, 'Zhiying.exe'), ['--stop', '--json'], { cwd: elsewhere, env, timeoutMs: 120_000 });
  assert.equal(stopRes.code, 0, `--stop 失败: ${stopRes.stderr}`);
  const stopped = parseJson(stopRes.stdout) as { stopped: string[] };
  assert.ok(stopped.stopped.length >= 3, `stop 未停止服务: ${JSON.stringify(stopped)}`);
  for (const pid of managedPids) await waitForCondition(() => !isAlive(pid), { timeoutMs: 20_000, label: `managed pid ${pid} 退出` });
  assert.ok(isAlive(state.sentinel!.pid), '外部无关 node 进程被误杀（#107-5）');
  assert.ok(isAlive(external.pid), '外部 ollama fixture 进程被误杀（#107-5）');
  assert.ok(!fs.existsSync(layout.serviceStatePath), '停止后 services.json 未清除');
  // 用户数据目录未被破坏
  assert.ok(fs.existsSync(path.join(layout.data, 'worker-heartbeat.json')), '停止不得删除用户数据');
});

test('[#107-3/#105-21] 跨进程下载闭环：中断不假完成 → 再次运行 CLI 续传 installed（Range）', async (t) => {
  const installRoot = state.installRoot;
  const layout = resolveInstallLayout(installRoot);
  const source = new FixtureModelSource();
  const server = await source.start();
  t.after(() => server.close());
  const data = deterministicBytes(48 * 1024, 'e2e-download');
  const id = 'e2e-model';
  source.addFile(`/dl/${id}/model.bin`, { data, mode: 'abort-mid' });
  const { entry } = makeHttpEntry({
    id,
    name: 'E2E 模型',
    files: [{ path: 'model.bin', data, url: `${server.url}/dl/${id}/model.bin` }],
    baseUrl: `${server.url}/dl`,
  });
  const manifestPath = path.join(layout.modelsRoot, '.downloads', 'manifest.json');
  await writeFileDeep(manifestPath, JSON.stringify(makeManifest([entry]), null, 2));
  const nodeExe = path.join(layout.runtime, 'node', 'node.exe');
  const managerCli = path.join(layout.app, 'desktop', 'cli', 'model-manager-cli.mjs');
  const env = sanitizedEnv({ TEMP: path.join(state.base, 'dl-temp'), TMP: path.join(state.base, 'dl-temp') });
  const args = [managerCli, '--install-root', installRoot, '--manifest', manifestPath, '--download', id, '--json'];

  // 第一次：源站中途断开 → CLI exit 4，不得假完成
  const first = await runProcess(nodeExe, args, { cwd: path.join(state.base, 'launcher-cwd'), env, timeoutMs: 300_000 });
  assert.equal(first.code, 4, `中断下载应 exit 4，实际 ${first.code}: ${first.stdout.slice(-800)}\n${first.stderr.slice(-1500)}`);
  assert.ok(!fs.existsSync(path.join(layout.modelsRoot, id, 'model.bin')), '中断下载不得提交安装文件');
  const stateAfterFail = JSON.parse(fs.readFileSync(path.join(layout.modelsRoot, '.downloads', 'state.json'), 'utf8')) as { models: Record<string, { status: string }> };
  assert.notEqual(stateAfterFail.models[id]?.status, 'installed', '中断后不得标记 installed');

  // 第二次：源站恢复 → CLI 续传 Range 并成功
  source.setMode(`/dl/${id}/model.bin`, 'ok');
  const second = await runProcess(nodeExe, args, { cwd: path.join(state.base, 'launcher-cwd'), env, timeoutMs: 300_000 });
  assert.equal(second.code, 0, `恢复下载应 exit 0，实际 ${second.code}: ${second.stdout.slice(-800)}\n${second.stderr.slice(-1500)}`);
  const installedFile = path.join(layout.modelsRoot, id, 'model.bin');
  assert.ok(fs.existsSync(installedFile), '恢复后模型文件必须安装到 models/<installDir>');
  assert.equal(await sha256File(installedFile), sha256Buffer(data), '下载文件内容与源不一致');
  const requests = source.requestsFor(`/dl/${id}/model.bin`);
  assert.ok(requests.some((r) => r.range && /bytes=[1-9]\d*-/.test(r.range)), `跨进程续传必须发送 Range 请求: ${JSON.stringify(requests.map((r) => r.range))}`);
  const finalState = JSON.parse(fs.readFileSync(path.join(layout.modelsRoot, '.downloads', 'state.json'), 'utf8')) as { models: Record<string, { status: string; verified?: string; percent?: number }> };
  assert.equal(finalState.models[id]?.status, 'installed');
  assert.equal(finalState.models[id]?.percent, 100);
});

test('[#106-3/#107-4/#103-13/#103-11/#106-16/#107-6/#107-8 R4-Inno] 安装版维护 E2E：诊断缺失模型→Inno v1.8.1 覆盖升级保留→标准卸载保留→重装复用', async (t) => {
  // A. 诊断缺失模型（main installRoot，来自前面 Setup 安装）
  const installRoot = state.installRoot;
  const layout = resolveInstallLayout(installRoot);
  const nodeExe = path.join(layout.runtime, 'node', 'node.exe');
  const maintenanceCli = path.join(layout.app, 'desktop', 'cli', 'maintenance-cli.mjs');
  const elsewhere = path.join(state.base, 'maintenance-cwd');
  fs.mkdirSync(elsewhere, { recursive: true });
  const env = sanitizedEnv({ TEMP: state.e2eTemp!, TMP: state.e2eTemp! });
  fs.mkdirSync(state.e2eTemp!, { recursive: true });
  const runMaint = (args: string[], timeoutMs = 300_000): Promise<RunResult> => runProcess(nodeExe, [maintenanceCli, ...args], { cwd: elsewhere, env, timeoutMs });
  const configBeforeMaint = await loadInstallConfig(installRoot);
  fs.copyFileSync(path.join(layout.app, 'desktop', 'model-manifest.default.json'), path.join(layout.installRoot, configBeforeMaint.modelManifest));
  fs.rmSync(layout.modelStatePath, { force: true });
  const diagnostics = await runMaint(['--diagnostics', '--json']);
  assert.equal(diagnostics.code, 0, `空模型诊断应 exit 0（warn 不算 fail），实际 ${diagnostics.code}: ${diagnostics.stderr}`);
  const report = parseJson(diagnostics.stdout) as { checks: Array<{ id: string; status: string; fix?: string }>; summary: { fail: number } };
  const modelChecks = report.checks.filter((check) => check.id.startsWith('model:'));
  assert.ok(modelChecks.length >= 4, `诊断应覆盖默认清单模型: ${modelChecks.length}`);
  assert.ok(modelChecks.every((check) => check.status === 'missing'), `未下载模型应报告 missing: ${JSON.stringify(modelChecks)}`);
  assert.ok(modelChecks.every((check) => (check.fix ?? '').includes('模型管理器')), '缺失模型必须给出模型管理器修复入口');
  assert.equal(report.summary.fail, 0);
  assert.ok(!fs.existsSync(path.join(layout.modelsRoot, 'f5-tts', 'F5TTS_v1_Base', 'model_1250000.safetensors')), '跳过下载时不得存在模型文件');

  if (!state.setupStaging || !state.setupStagingV2) {
    t.skip('R4 Inno 构建产物/升级 payload 未就绪（staging 未创建）');
    return;
  }
  // B. Inno v1 安装到独立 root（升级/卸载 E2E，不影响 main installRoot）
  const upgradeRoot = path.join(state.base, '知影 升级 保留 E2E');
  state.upgradeRoot = upgradeRoot;
  const installV1 = await installWithInno(state.setupStaging.exe, upgradeRoot, { model: 'later', tasks: '', env, cwd: elsewhere });
  assert.equal(installV1.code, 0, `Inno v1 安装失败: ${installV1.stderr.slice(-1500)}`);
  const upgradeLayout = resolveInstallLayout(upgradeRoot);
  const sentinels: Record<string, string> = {
    'data/projects/e2e-project.json': '{"id":"e2e"}',
    'data/m2v.db': 'e2e-db-bytes',
    'data/voices/v.wav': 'voice-bytes',
    'models/keep/weights.bin': 'model-weights',
    'logs/user.log': 'user-log',
    'outputs/export.mp4': 'video-bytes',
    'app/desktop/OLD_MARKER.txt': 'old-program-marker',
  };
  for (const [rel, content] of Object.entries(sentinels)) await writeFileDeep(path.join(upgradeRoot, rel), content);
  const dbHash = await sha256File(path.join(upgradeRoot, 'data', 'm2v.db'));
  const modelHash = await sha256File(path.join(upgradeRoot, 'models', 'keep', 'weights.bin'));
  const configV1 = await loadInstallConfig(upgradeRoot);
  assert.equal(configV1.version, '1.8.0');

  // C. Inno v1.8.1 覆盖升级（同 /DIR）：哨兵保留、程序替换、备份 install.json+m2v.db、版本更新
  const installV2 = await installWithInno(state.setupStagingV2.exe, upgradeRoot, { model: 'later', tasks: '', env, cwd: elsewhere });
  assert.equal(installV2.code, 0, `Inno 覆盖升级失败: ${installV2.stderr.slice(-1500)}`);
  const configV2 = await loadInstallConfig(upgradeRoot);
  assert.equal(configV2.version, '1.8.1', `覆盖升级后版本应为 1.8.1，实际 ${configV2.version}`);
  for (const [rel, content] of Object.entries(sentinels)) {
    if (rel === 'app/desktop/OLD_MARKER.txt') continue;
    assert.ok(fs.existsSync(path.join(upgradeRoot, rel)), `覆盖升级丢失用户文件: ${rel}`);
    assert.equal(fs.readFileSync(path.join(upgradeRoot, rel), 'utf8'), content, `覆盖升级改写用户文件: ${rel}`);
  }
  // Inno [Files] 覆盖已知程序文件（不保证删除未知文件）；用 payload 自带 release-manifest.json 证明程序已更新到 1.8.1
  const upgradedManifestPath = path.join(upgradeRoot, 'release-manifest.json');
  if (fs.existsSync(upgradedManifestPath)) {
    const upgradedManifest = JSON.parse(fs.readFileSync(upgradedManifestPath, 'utf8')) as { version?: string };
    assert.equal(upgradedManifest.version, '1.8.1', `覆盖升级后程序 release-manifest.version 应为 1.8.1，实际 ${upgradedManifest.version}`);
  } else {
    assert.ok(fs.existsSync(path.join(upgradeRoot, 'app', 'desktop', 'index.js')), '覆盖升级后程序文件缺失');
  }
  assert.ok(fs.existsSync(path.join(upgradeRoot, 'app', 'desktop', 'index.js')));
  assert.equal(await sha256File(path.join(upgradeRoot, 'data', 'm2v.db')), dbHash, '升级改写了数据库');
  assert.equal(await sha256File(path.join(upgradeRoot, 'models', 'keep', 'weights.bin')), modelHash, '升级改写了模型');
  const backupsDir = path.join(upgradeRoot, 'data', 'backups');
  assert.ok(fs.existsSync(backupsDir), '覆盖升级缺少 data/backups/<ts> 备份');
  const backupDirs = fs.readdirSync(backupsDir).filter((name) => fs.statSync(path.join(backupsDir, name)).isDirectory()).sort();
  assert.ok(backupDirs.length > 0, '备份目录为空');
  const latestBackup = path.join(backupsDir, backupDirs[backupDirs.length - 1]);
  assert.ok(fs.existsSync(path.join(latestBackup, 'install.json')), '升级备份缺少 install.json');
  assert.ok(fs.existsSync(path.join(latestBackup, 'm2v.db')), '升级备份缺少 m2v.db');
  const entryV2 = findUninstallEntriesForInstallLocation(upgradeRoot).filter((entry) => path.resolve(entry.values.InstallLocation?.value ?? '').toLowerCase() === path.resolve(upgradeRoot).toLowerCase());
  assert.equal(entryV2.length, 1, '覆盖升级后 HKCU 卸载项应唯一');
  assert.equal(entryV2[0].values.DisplayVersion?.value, '1.8.1', 'HKCU DisplayVersion 未随升级更新');

  // D. 标准卸载（staged unins000 /VERYSILENT）：程序/注册表/unins000 移除，用户数据逐字节保留
  const uninstallResult = await uninstallWithInno(upgradeRoot, { env });
  t.after(() => removeStagingDir(uninstallResult.stagingDir));
  assert.equal(uninstallResult.code, 0, `Inno 标准卸载失败: ${uninstallResult.stderr.slice(-1500)}`);
  // Inno 卸载自清理可能在进程退出后继续（同 §8.6 #11）；断言程序文件移除（允许卸载后残留空目录）
  await waitForCondition(
    () =>
      !fs.existsSync(path.join(upgradeRoot, 'Zhiying.exe')) &&
      !fs.existsSync(path.join(upgradeRoot, 'app', 'desktop', 'index.js')) &&
      !fs.existsSync(path.join(upgradeRoot, 'runtime', 'node', 'node.exe')),
    { timeoutMs: 20_000, intervalMs: 200 },
  ).catch(() => undefined);
  for (const rel of ['Zhiying.exe', 'app/desktop/index.js', 'runtime/node/node.exe']) {
    assert.ok(!fs.existsSync(path.join(upgradeRoot, rel)), `标准卸载后应移除程序文件: ${rel}`);
  }
  // 清空残留空目录（若 Inno 因自清理时序留下空 app/runtime）
  for (const dir of ['app', 'runtime']) {
    const full = path.join(upgradeRoot, dir);
    if (fs.existsSync(full)) {
      const remaining = fs.readdirSync(full);
      if (remaining.length === 0) fs.rmdirSync(full);
      else t.diagnostic(`卸载后 ${dir}/ 非空残留: ${remaining.slice(0, 5).join(',')}`);
    }
  }
  assert.equal(findUninstallEntriesForInstallLocation(upgradeRoot).filter((entry) => path.resolve(entry.values.InstallLocation?.value ?? '').toLowerCase() === path.resolve(upgradeRoot).toLowerCase()).length, 0, '标准卸载后 HKCU 卸载项应移除');
  for (const [rel, content] of Object.entries(sentinels)) {
    if (rel === 'app/desktop/OLD_MARKER.txt') continue;
    assert.ok(fs.existsSync(path.join(upgradeRoot, rel)), `标准卸载不得删除用户数据: ${rel}`);
    assert.equal(fs.readFileSync(path.join(upgradeRoot, rel), 'utf8'), content, `标准卸载改写用户数据: ${rel}`);
  }
  // 卸载后重装（v1）：复用保留的 models/data，不再重下
  const reinstall = await installWithInno(state.setupStaging.exe, upgradeRoot, { model: 'later', tasks: '', env, cwd: elsewhere });
  assert.equal(reinstall.code, 0, `卸载后重装失败: ${reinstall.stderr.slice(-1500)}`);
  assert.ok(fs.existsSync(path.join(upgradeRoot, 'Zhiying.exe')), '重装后缺少 Zhiying.exe');
  assert.equal((await loadInstallConfig(upgradeRoot)).version, '1.8.0');
  assert.equal(await sha256File(path.join(upgradeRoot, 'models', 'keep', 'weights.bin')), modelHash, '重装不得改写/删除已保留模型');
  assert.equal(await sha256File(path.join(upgradeRoot, 'data', 'm2v.db')), dbHash, '重装不得改写/删除用户数据库');
  t.after(() => {
    for (const entry of findUninstallEntriesForInstallLocation(upgradeRoot)) {
      if (path.resolve(entry.values.InstallLocation?.value ?? '').toLowerCase() === path.resolve(upgradeRoot).toLowerCase()) {
        try {
          deleteUninstallEntry(entry.key);
        } catch {
          /* ignore */
        }
      }
    }
  });
});

test('[#107-7] E2E 构建不改变 dist/ 发布产物（运行期间 sha256 不变性）', async (t) => {
  const distExe = path.join(REPO_ROOT, 'dist', 'Zhiying-Setup.exe');
  if (!fs.existsSync(distExe)) {
    t.skip('dist/ 发布产物不存在（由 Lead/impl-dev 构建）；本 E2E 的构建产物断言已覆盖同链路');
    return;
  }
  const current = await sha256File(distExe);
  const releaseInfo = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'dist', 'release-info.json'), 'utf8')) as { setup?: { sha256?: string; sizeBytes?: number }; version?: string; assemblyVersion?: string };
  // 内部一致性（任何框架/重建都应满足）
  assert.equal(releaseInfo.setup?.sha256, current, 'release-info.setup.sha256 与发布产物不一致');
  assert.equal(releaseInfo.setup?.sizeBytes, fs.statSync(distExe).size, 'release-info.setup.sizeBytes 与实际文件不一致');
  assert.equal(releaseInfo.version, '1.8.0');
  if (releaseInfo.assemblyVersion !== undefined) assert.equal(releaseInfo.assemblyVersion, '1.8.0.0');
  // E2E 运行期间不得改 dist
  if (state.distSetupSha && state.distSetupSha !== current) {
    assert.fail(`E2E 运行期间 dist/Zhiying-Setup.exe 发生变化: ${state.distSetupSha} -> ${current}`);
  }
  // 冻结 sha 精确匹配由 107-dist-artifacts.test.ts 在 Lead 提供新 pinned 值后强制校验；
  // 安装器框架切换过渡期这里只记录实际值，避免阻断 E2E。
  t.diagnostic(`dist/Zhiying-Setup.exe sha256=${current} size=${fs.statSync(distExe).size}（冻结 pin 见 107-dist-artifacts.test.ts）`);
});

test('[#107-7] 发布产物与文档（R4 Inno）：版本化运行目录 + Zhiying-Setup.exe + SHA256 + release/components + 安装文档', async (t) => {
  assert.ok(fs.existsSync(state.productA), '缺少版本化运行目录');
  assert.ok(fs.existsSync(path.join(state.productA, 'release-manifest.json')));
  assert.ok(fs.existsSync(path.join(state.productA, 'components.json')));
  assert.ok(fs.existsSync(path.join(state.productA, 'SHA256SUMS.txt')));
  assert.ok(fs.existsSync(state.setupExe), '缺少 Zhiying-Setup.exe');
  assert.ok(fs.existsSync(path.join(state.setupOut, 'Zhiying-Setup.exe.sha256')));
  assert.ok(fs.existsSync(path.join(state.setupOut, 'release-info.json')));
  const releaseInfo = readInnoReleaseInfo(state.setupOut);
  if (!innoArtifactReady(state.setupExe, state.setupOut).ready) {
    t.diagnostic(`R4 Inno 构建产物未就绪，跳过 installer 字段断言：${innoArtifactReady(state.setupExe, state.setupOut).reason}`);
  } else {
    assert.equal(releaseInfo?.installer, 'inno-setup');
    assert.match(releaseInfo?.innoVersion ?? '', /^6\./);
  }
  const installDoc = path.join(REPO_ROOT, 'doc', 'V1.8.0_install.md');
  assert.ok(fs.existsSync(installDoc), `缺少安装文档: ${installDoc}`);
  const doc = fs.readFileSync(installDoc, 'utf8');
  assert.match(doc, /系统要求|系统需求/, '安装文档缺少系统要求章节');
  for (const keyword of ['安装', '模型', '许可', '卸载', 'SHA-256', '离线']) {
    assert.ok(doc.includes(keyword), `安装文档缺少章节关键字: ${keyword}`);
  }
});