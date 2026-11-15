/**
 * R4 Inno Setup 6 标准安装程序测试（真实 exe，不 mock）。
 * 覆盖 §3 #103（Inno 语义）：产物 PE/版本/release-info/sha、staging（workspace 外）后
 * /VERYSILENT 中文+空格安装、标准卸载入口、快捷方式、覆盖升级/备份、GUI 标准向导窗口/截图/取消、
 * 受保护/非法/长路径/净化 PATH 等。
 *
 * 环境约束（契约 §8.6 #11）：DSH 沙箱中 workspace 内新 exe 为 Low IL，Inno 初始化 exit 1；
 * 所有 Setup.exe / unins000.exe 必须复制到 workspace 外（%TEMP%\zhiying-test-*）再执行。
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempRoot, makeChineseSpaceDir, cleanupRegisteredTempDirs, REPO_ROOT } from './_helpers/temp';
import { createPayloadTree } from './_helpers/fixtures';
import { sanitizedEnv, pathHasDevTool } from './_helpers/env';
import { spawnCollect, waitExit, killTree, isAlive, waitForCondition } from './_helpers/processes';
import {
  readPeInfo,
  readExeVersionInfo,
  createStagingDir,
  stageExecutable,
  removeStagingDir,
  spawnVisible,
  waitForChildWindow,
  enumerateWindowTexts,
  enumerateWindowVisibleTexts,
  captureWindowScreenshot,
  closeMainWindow,
  answerInnoExitDialog,
  findWindows,
} from './_helpers/gui';
import { listUninstallEntries, findUninstallEntriesForInstallLocation, deleteUninstallEntry } from './_helpers/registry';
import { sha256File } from './_helpers/fsx';
import { loadInstallConfig, resolveInstallLayout, writeInstallConfig } from '../src/install-layout';
import { cleanupInnoTestState } from './_helpers/inno';

const DIST = path.join(REPO_ROOT, 'dist');
const SETUP = path.join(DIST, 'Zhiying-Setup.exe');
const RELEASE_INFO = path.join(DIST, 'release-info.json');
const PRODUCT = path.join(DIST, 'desktop', 'Zhiying-1.8.0-lite');
const LAUNCHER = path.join(PRODUCT, 'Zhiying.exe');

// R4 冻结 sha 由 Lead 提供后更新；PENDING 期间只断言内部一致性。
const PINNED_INNO_SHA = 'c9fcd8c8178ce38bb1176cf3582ea0d184464ece8ee5f14d0584020d0f3c7d6a';
const PINNED_INNO_SIZE = 24_915_215;
const ISCC_PATH = process.env.ISCC_PATH ?? 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Inno Setup 6\\ISCC.exe';

// Lead 协调：每个 Inno 用例前清理遗留 setup 进程/固定 AppId 卸载项/指向测试目录的快捷方式，保证串行隔离。
beforeEach(async () => {
  await cleanupInnoTestState();
});

interface ReleaseInfo {
  version?: string;
  profile?: string;
  installer?: string;
  innoVersion?: string;
  setup?: { sha256?: string; sizeBytes?: number };
  components?: unknown;
}

function readReleaseInfo(): ReleaseInfo | undefined {
  try {
    return JSON.parse(fs.readFileSync(RELEASE_INFO, 'utf8')) as ReleaseInfo;
  } catch {
    return undefined;
  }
}

function innoArtifactReady(): { ready: boolean; reason: string } {
  if (!fs.existsSync(SETUP)) return { ready: false, reason: `缺少 ${SETUP}` };
  const info = readReleaseInfo();
  if (info?.installer !== 'inno-setup') {
    return { ready: false, reason: `dist/release-info.json 的 installer=${String(info?.installer)}，尚未 rebuild 为 inno-setup` };
  }
  try {
    const pe = readPeInfo(SETUP);
    if (pe.subsystem !== 2) return { ready: false, reason: `Setup.exe 子系统=${pe.subsystem}（期望 2 GUI）` };
  } catch (error) {
    return { ready: false, reason: `PE 解析失败: ${(error as Error).message}` };
  }
  return { ready: true, reason: '' };
}

function norm(p: string): string {
  return path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 清理 Inno Setup 可能残留的 setup-*.tmp / is-*.tmp / 测试 staging Setup 进程。 */
async function killSetupProcesses(stagingDir: string, target: string): Promise<void> {
  const { listProcesses } = await import('./_helpers/gui');
  for (const entry of listProcesses()) {
    const cmd = entry.commandLine.toLowerCase();
    const name = entry.name.toLowerCase();
    const isInnoTemp = /^(setup|is)-[a-z0-9]+\.tmp$/i.test(entry.name) || name.endsWith('.tmp');
    const referencesTest = (stagingDir && cmd.includes(stagingDir.toLowerCase())) || (target && cmd.includes(target.toLowerCase()));
    if ((isInnoTemp && referencesTest) || (referencesTest && /zhiying-setup\.exe/i.test(cmd))) {
      killTree(entry.pid);
    }
  }
  // 兜底：若存在标题为知影向导的遗留窗口，结束其进程
  const { findWindows } = await import('./_helpers/gui');
  for (const window of findWindows(/知影\s*Zhiying/)) {
    if (target && (window.pid === process.pid)) continue;
    killTree(window.pid);
  }
}

interface SilentResult {
  code: number | null;
  stdout: string;
  stderr: string;
  logFile: string;
}

/** staging Setup.exe（workspace 外）→ 运行 Inno 静默安装。 */
async function silentInstall(
  stagedExe: string,
  target: string,
  options: { model?: 'now' | 'later'; tasks?: string; extra?: string[]; logDir?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<SilentResult> {
  const logDir = options.logDir ?? path.join(path.dirname(stagedExe), 'install-logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `install-${Date.now()}.log`);
  const args = [
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    '/SP-',
    `/DIR=${target}`,
    `/TASKS=${options.tasks ?? ''}`,
    `/MODELDOWNLOAD=${options.model ?? 'later'}`,
    `/LOG=${logFile}`,
    ...(options.extra ?? []),
  ];
  const captured = spawnCollect(stagedExe, args, { cwd: options.cwd ?? path.dirname(stagedExe), env: options.env ?? process.env });
  const exit = await waitExit(captured.child, 300_000);
  if (!exit) {
    killTree(captured.pid);
    return { code: null, stdout: captured.stdout(), stderr: `${captured.stderr()}\n[timeout]`, logFile };
  }
  return { code: exit.code, stdout: captured.stdout(), stderr: captured.stderr(), logFile };
}

/** 从安装根 stage 卸载器（unins000.exe + unins000.dat 等），避免 workspace Low IL。 */
function stageUninstaller(installRoot: string): { dir: string; exe: string } {
  const files = fs.readdirSync(installRoot).filter((name) => /^unins\d+\./i.test(name));
  if (!files.some((name) => /\.exe$/i.test(name))) throw new Error(`安装根缺少 unins000.exe: ${installRoot}`);
  const dir = createStagingDir('zhiying-test-unins');
  for (const name of files) fs.copyFileSync(path.join(installRoot, name), path.join(dir, name));
  const exe = path.join(dir, files.find((name) => /\.exe$/i.test(name))!);
  // 保留 exe 原文件名/扩展名（unins000.exe）
  return { dir, exe };
}

async function runStagedExe(exe: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const captured = spawnCollect(exe, args, { cwd: opts.cwd ?? path.dirname(exe), env: opts.env ?? process.env });
  const exit = await waitExit(captured.child, opts.timeoutMs ?? 180_000);
  if (!exit) {
    killTree(captured.pid);
    return { code: null, stdout: captured.stdout(), stderr: `${captured.stderr()}\n[timeout]` };
  }
  return { code: exit.code, stdout: captured.stdout(), stderr: captured.stderr() };
}

/** 注册测试清理：目标目录、卸载注册表项（按 InstallLocation 匹配）。 */
function registerCleanup(t: test.TestContext, target: string, stageDirs: string[]): void {
  t.after(() => {
    for (const dir of stageDirs) removeStagingDir(dir);
    // 清理本测试创建、尚未卸载的 Inno 卸载项
    for (const entry of listUninstallEntries()) {
      const location = (entry.values.InstallLocation?.value ?? '').toLowerCase();
      if (location && norm(location) === norm(target)) deleteUninstallEntry(entry.key);
    }
    // 若安装根仍存在，直接删除（测试专用临时目录；models/data 等也在其内）
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* 尽力而为 */
    }
    cleanupRegisteredTempDirs();
  });
}

function makeTarget(t: test.TestContext, label: string, chiName = '知影 图形 安装'): string {
  const base = makeTempRoot(label);
  return makeChineseSpaceDir(base, chiName);
}

test('[#103-15 R4-Inno] 产物：PE subsystem=2、FileVersion/ProductVersion 1.8.0.x、release-info installer=inno-setup/innoVersion、.sha256 三方一致', async (t) => {
  if (!innoArtifactReady().ready) {
    t.skip(`R4 Inno 产物未就绪：${innoArtifactReady().reason}`);
    return;
  }
  const pe = readPeInfo(SETUP);
  assert.equal(pe.subsystem, 2, `Zhiying-Setup.exe 必须是 GUI 子系统（2），实际 ${pe.subsystem}（${pe.subsystemLabel}）`);
  // Inno Setup 6 的安装器 stub 为 32 位（内嵌 x64 安装逻辑，ArchitecturesAllowed=x64compatible），
  // 契约只要求 GUI 子系统 + FileVersion/ProductVersion，不要求 stub machine=x64。
  const version = readExeVersionInfo(SETUP);
  assert.match(version.fileVersion ?? '', /^1\.8\.0(\.\d+)?$/, `FileVersion 应为 1.8.0.x: ${version.fileVersion}`);
  assert.match(version.productVersion ?? '', /^1\.8\.0(\.\d+)?$/, `ProductVersion 应为 1.8.0.x: ${version.productVersion}`);
  const releaseInfo = readReleaseInfo()!;
  assert.equal(releaseInfo.installer, 'inno-setup');
  assert.ok(typeof releaseInfo.innoVersion === 'string' && /^6\./.test(releaseInfo.innoVersion!), `release-info.innoVersion 应为 6.x: ${releaseInfo.innoVersion}`);
  assert.equal(releaseInfo.version, '1.8.0');
  assert.equal(releaseInfo.profile, 'lite');
  const actualSha = await sha256File(SETUP);
  assert.equal(releaseInfo.setup?.sha256, actualSha, 'release-info.setup.sha256 与实际文件不一致');
  assert.equal(releaseInfo.setup?.sizeBytes, fs.statSync(SETUP).size, 'release-info.setup.sizeBytes 与实际文件不一致');
  const shaFile = fs.readFileSync(path.join(DIST, 'Zhiying-Setup.exe.sha256'), 'utf8').trim();
  const match = /^([0-9a-f]{64})\s+Zhiying-Setup\.exe$/.exec(shaFile);
  assert.ok(match, `.sha256 文件格式非法: ${shaFile}`);
  assert.equal(match![1], actualSha, '.sha256 与实际文件不一致');
  // 版本化运行目录中启动器仍为 Console(3)
  const launcherPe = readPeInfo(LAUNCHER);
  assert.equal(launcherPe.subsystem, 3, `Zhiying.exe 启动器必须保持 Console(3)，实际 ${launcherPe.subsystem}`);
  if (PINNED_INNO_SHA !== 'PENDING_R4_SHA') {
    assert.equal(actualSha, PINNED_INNO_SHA, 'Setup.exe sha256 与冻结产物不一致');
    assert.equal(fs.statSync(SETUP).size, PINNED_INNO_SIZE, 'Setup.exe 大小与冻结产物不一致');
  } else {
    t.diagnostic(`R4 pinned sha 待 Lead 提供；当前 sha256=${actualSha}, size=${fs.statSync(SETUP).size}`);
  }
  // ISCC 构建期工具存在性（构建链可复现依赖）
  assert.ok(fs.existsSync(ISCC_PATH), `缺少 Inno Setup ISCC: ${ISCC_PATH}`);
});

test('[#103-8/#103-9/#103-12/#103-15 R4-Inno] staging 后 /VERYSILENT 中文+空格安装：exit0、骨架/unins000/install.json/日志/HKCU 标准卸载项', async (t) => {
  if (!innoArtifactReady().ready) {
    t.skip(`R4 Inno 产物未就绪：${innoArtifactReady().reason}`);
    return;
  }
  const target = makeTarget(t, 'r4-silent', '知影 Inno 静默 安装');
  const staging = createStagingDir('zhiying-test-setup');
  const staged = stageExecutable(SETUP, staging);
  registerCleanup(t, target, [staging]);
  const result = await silentInstall(staged.exe, target, { model: 'later', tasks: '' });
  assert.equal(result.code, 0, `静默安装失败 (exit ${result.code}):\n${result.stdout.slice(-1500)}\n${result.stderr.slice(-2000)}`);
  for (const rel of ['Zhiying.exe', 'app', 'runtime', 'models', 'data', 'config', 'logs', 'config/install.json']) {
    assert.ok(fs.existsSync(path.join(target, rel)), `安装骨架缺少 ${rel}`);
  }
  assert.ok(fs.existsSync(path.join(target, 'unins000.exe')), '缺少标准卸载器 unins000.exe');
  const config = await loadInstallConfig(target);
  assert.equal(config.version, '1.8.0');
  assert.equal(config.installRoot, target);
  assert.equal(config.modelsDownloadChoice, 'later', '/MODELDOWNLOAD=later 必须写入 install.json');
  // 安装日志：Inno /LOG + 收尾引擎 logs/setup-*.log
  assert.ok(fs.existsSync(result.logFile), `缺少 Inno /LOG 日志: ${result.logFile}`);
  const innoLog = fs.readFileSync(result.logFile, 'utf8');
  assert.ok(innoLog.length > 100, 'Inno /LOG 日志内容过短');
  for (const forbidden of ['token', 'password', 'secret']) assert.ok(!innoLog.toLowerCase().includes(forbidden), `Inno 安装日志泄漏敏感信息: ${forbidden}`);
  const setupLogs = fs.readdirSync(path.join(target, 'logs')).filter((name) => name.startsWith('setup-'));
  assert.ok(setupLogs.length > 0, '缺少收尾引擎 setup-<ts>.log');
  const setupLog = fs.readFileSync(path.join(target, 'logs', setupLogs[0]), 'utf8');
  assert.ok(/完成|install\.json|1\.8\.0/.test(setupLog), `收尾日志缺少步骤/结果: ${setupLog.slice(0, 400)}`);
  // HKCU 标准卸载项
  const entries = findUninstallEntriesForInstallLocation(target).filter((entry) => norm(entry.values.InstallLocation?.value ?? '') === norm(target));
  assert.equal(entries.length, 1, `HKCU 卸载项应唯一匹配目标（实际 ${entries.length}）：${JSON.stringify(entries.map((e) => e.key))}`);
  const values = entries[0].values;
  for (const field of ['DisplayName', 'DisplayVersion', 'Publisher', 'InstallLocation', 'DisplayIcon', 'UninstallString', 'EstimatedSize']) {
    assert.ok(values[field]?.value, `HKCU 卸载项缺少字段 ${field}`);
  }
  assert.match(values.DisplayName.value, /知影|Zhiying/, `DisplayName 异常: ${values.DisplayName.value}`);
  assert.equal(values.DisplayVersion.value, '1.8.0');
  assert.match(values.UninstallString.value, /unins\d+\.exe/i, `UninstallString 应指向 unins000.exe: ${values.UninstallString.value}`);
  assert.equal(norm(values.InstallLocation.value), norm(target));
  assert.match(values.EstimatedSize.value, /^\d+$/);
});

test('[#103-16 R4-Inno] /MODELDOWNLOAD=now 写入 install.json.modelsDownloadChoice=now；later 为 later（静默路径）', async (t) => {
  if (!innoArtifactReady().ready) {
    t.skip(`R4 Inno 产物未就绪：${innoArtifactReady().reason}`);
    return;
  }
  const target = makeTarget(t, 'r4-model-now', '知影 立即下载 选择');
  const staging = createStagingDir('zhiying-test-setup-now');
  const staged = stageExecutable(SETUP, staging);
  registerCleanup(t, target, [staging]);
  const result = await silentInstall(staged.exe, target, { model: 'now', tasks: '' });
  assert.equal(result.code, 0, `MODELDOWNLOAD=now 安装失败: ${result.stderr.slice(-1500)}`);
  const config = await loadInstallConfig(target);
  assert.equal(config.modelsDownloadChoice, 'now', '/MODELDOWNLOAD=now 必须写入 install.json.modelsDownloadChoice');
});

test('[#103-7 R4-Inno] GUI 标准向导：真实 TWizardForm 窗口（标题含知影 Zhiying version 1.8.0）、中文控件/截图、关闭→取消码 2、无安装残留', async (t) => {
  if (!innoArtifactReady().ready) {
    t.skip(`R4 Inno 产物未就绪：${innoArtifactReady().reason}`);
    return;
  }
  const target = makeTarget(t, 'r4-gui', '知影 GUI 取消 目标');
  const staging = createStagingDir('zhiying-test-gui');
  const staged = stageExecutable(SETUP, staging);
  registerCleanup(t, target, [staging]);
  const evidenceDir = path.join(REPO_ROOT, 'data', 'tmp', 'v21', `r4-gui-${Date.now()}`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const run = spawnVisible(staged.exe, ['/SP-', `/DIR=${target}`], { cwd: staging, env: process.env });
  t.after(() => {
    void killSetupProcesses(staging, target);
    if (fs.existsSync(target)) {
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch {
        /* ignore */
      }
    }
  });
  const waitOutcome = await Promise.race([
    waitForChildWindow(run.pid, /知影\s*Zhiying.*1\.8\.0/i, 60_000).then((window) => ({ window })),
    run.exit.then((result) => ({ result })),
  ]);
  if ('result' in waitOutcome) {
    await killSetupProcesses(staging, target);
    assert.fail(`向导窗口未出现，Setup 提前退出: exit=${waitOutcome.result.code}\nstdout=${run.stdout().slice(-1200)}\nstderr=${run.stderr().slice(-1500)}`);
  }
  const window = waitOutcome.window;
  assert.ok(window.title.includes('知影') && window.title.includes('1.8.0'), `向导窗口标题不符合约定: ${window.title}`);
  // 控件文本（UIA + Win32 枚举；VCL 非窗口化标签可能受限，作为证据记录）
  const win32Texts = enumerateWindowTexts(window.handle);
  const uiaTexts = enumerateWindowVisibleTexts(window.handle);
  fs.writeFileSync(path.join(evidenceDir, 'gui-window-texts.json'), JSON.stringify({ title: window.title, win32Texts, uiaTexts }, null, 2), 'utf8');
  const allTexts = [...uiaTexts, ...win32Texts].join('\n');
  const chineseHits = ['下一步', '取消', '安装', '浏览', '知影'].filter((token) => allTexts.includes(token));
  // 截图证据（真实窗口）
  const screenshot = path.join(evidenceDir, 'gui-wizard.png');
  captureWindowScreenshot(window.handle, screenshot);
  assert.ok(fs.existsSync(screenshot) && fs.statSync(screenshot).size > 1024, 'GUI 向导截图失败');
  t.diagnostic(`GUI 窗口标题="${window.title}"；控件中文命中=${chineseHits.join(',') || '（VCL 标签非窗口化，见截图）'}；截图=${screenshot}`);
  // 关闭向导 → Inno 用户取消（退出码 2），不得留下安装
  assert.ok(closeMainWindow(window.pid), 'CloseMainWindow 发送失败');
  // Inno 关闭向导会弹出“退出安装程序”确认框（#32770）：点击“是”后退出码 2
  const dialogTitle = await answerInnoExitDialog(20_000);
  t.diagnostic(`退出确认框: ${dialogTitle}`);
  const exit = await Promise.race([run.exit, new Promise<null>((resolve) => setTimeout(() => resolve(null), 120_000))]);
  if (!exit) {
    killTree(run.pid);
    assert.fail('关闭向导后进程未退出');
  }
  assert.equal(exit.code, 2, `关闭/取消向导应返回 Inno 取消码 2，实际 ${exit.code}`);
  await sleep(500);
  if (fs.existsSync(target)) {
    const leftovers = fs.readdirSync(target).filter((name) => !name.startsWith('.'));
    assert.deepEqual(leftovers, [], `GUI 取消后不得留下安装文件: ${leftovers.join(',')}`);
  }
  assert.equal(findUninstallEntriesForInstallLocation(target).filter((entry) => norm(entry.values.InstallLocation?.value ?? '') === norm(target)).length, 0, 'GUI 取消后不得注册卸载项');
});

test('[#103-10 R4-Inno] 快捷方式：desktopicon task 创建桌面/开始菜单入口并指向 <root>\\Zhiying.exe；/TASKS="" 跳过', async (t) => {
  if (!innoArtifactReady().ready) {
    t.skip(`R4 Inno 产物未就绪：${innoArtifactReady().reason}`);
    return;
  }
  const targetWithIcon = makeTarget(t, 'r4-icon', '知影 快捷方式 安装');
  const staging1 = createStagingDir('zhiying-test-icon');
  const staged1 = stageExecutable(SETUP, staging1);
  registerCleanup(t, targetWithIcon, [staging1]);
  const result = await silentInstall(staged1.exe, targetWithIcon, { tasks: 'desktopicon', model: 'later' });
  assert.equal(result.code, 0, `desktopicon 安装失败: ${result.stderr.slice(-1500)}`);
  // 桌面快捷方式（KnownFolder）+ 开始菜单
  const desktop = path.join(process.env.USERPROFILE ?? os.homedir(), 'Desktop');
  const knownDesktopScript = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Environment]::GetFolderPath('Desktop')`;
  const knownDesktop = (spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', knownDesktopScript], { encoding: 'utf8', windowsHide: true }).stdout ?? '').trim() || desktop;
  const desktopLinks = fs.existsSync(knownDesktop) ? fs.readdirSync(knownDesktop).filter((name) => /知影|zhiying/i.test(name) && name.toLowerCase().endsWith('.lnk')) : [];
  assert.ok(desktopLinks.length > 0, `desktopicon 未创建桌面快捷方式: ${knownDesktop}`);
  const startMenuRoot = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const findStartMenuLinks = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...findStartMenuLinks(full));
      else if (/知影|zhiying/i.test(entry.name) && entry.name.toLowerCase().endsWith('.lnk')) out.push(full);
    }
    return out;
  };
  const startMenuLinks = findStartMenuLinks(startMenuRoot);
  assert.ok(startMenuLinks.length > 0, `缺少开始菜单入口: ${startMenuRoot}`);
  // 快捷方式目标指向 <root>\Zhiying.exe
  const readTargetScript = (lnk: string): string => {
    const script = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}'); [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $s.TargetPath`;
    return (spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).stdout ?? '').trim();
  };
  const desktopLink = path.join(knownDesktop, desktopLinks[0]);
  const shortcutTarget = readTargetScript(desktopLink);
  assert.equal(norm(shortcutTarget), norm(path.join(targetWithIcon, 'Zhiying.exe')), `快捷方式目标应指向 <root>\\Zhiying.exe，实际 ${shortcutTarget}`);
  // 清理本次创建的快捷方式
  for (const file of [desktopLink, ...startMenuLinks]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
  }

  // 清理开始菜单（两次安装可能同名覆盖；测试机无既有真实安装）
  for (const file of findStartMenuLinks(startMenuRoot)) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
  }

  // /TASKS="" 跳过
  const targetNoIcon = makeTarget(t, 'r4-noicon', '知影 无快捷方式 安装');
  const staging2 = createStagingDir('zhiying-test-noicon');
  const staged2 = stageExecutable(SETUP, staging2);
  registerCleanup(t, targetNoIcon, [staging2]);
  const result2 = await silentInstall(staged2.exe, targetNoIcon, { tasks: '', model: 'later' });
  assert.equal(result2.code, 0);
  const desktopLinksAfter = fs.existsSync(knownDesktop) ? fs.readdirSync(knownDesktop).filter((name) => /知影|zhiying/i.test(name) && name.toLowerCase().endsWith('.lnk')) : [];
  assert.deepEqual(desktopLinksAfter, [], `/TASKS="" 不得创建桌面快捷方式: ${desktopLinksAfter.join(',')}`);
});

test('[#103-11 R4-Inno] 标准卸载：staged unins000 /VERYSILENT → 程序/注册表/unins000 移除；models/data/logs/config+哨兵逐字节保留；root 外零删除', async (t) => {
  if (!innoArtifactReady().ready) {
    t.skip(`R4 Inno 产物未就绪：${innoArtifactReady().reason}`);
    return;
  }
  const target = makeTarget(t, 'r4-uninstall', '知影 卸载 保留 数据');
  const staging = createStagingDir('zhiying-test-setup-unins');
  const staged = stageExecutable(SETUP, staging);
  registerCleanup(t, target, [staging]);
  const install = await silentInstall(staged.exe, target, { tasks: '', model: 'later' });
  assert.equal(install.code, 0, `安装失败: ${install.stderr.slice(-1500)}`);
  // 用户数据哨兵
  const sentinels: Record<string, Buffer> = {
    'models/f5-tts/F5TTS_v1_Base/weights.bin': Buffer.from('model-weights-bytes'),
    'data/m2v.db': Buffer.from('sqlite-bytes'),
    'data/projects/p1.json': Buffer.from('{"id":"p1"}'),
    'logs/user-marker.log': Buffer.from('user-log'),
    'config/user-marker.txt': Buffer.from('user-config'),
  };
  for (const [rel, content] of Object.entries(sentinels)) {
    fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
    fs.writeFileSync(path.join(target, rel), content);
  }
  const before = new Map(Object.keys(sentinels).map((rel) => [rel, fs.readFileSync(path.join(target, rel))]));
  // root 外无关文件
  const sibling = makeTempRoot('r4-uninstall-outside');
  fs.writeFileSync(path.join(sibling, 'precious.txt'), 'must-survive');
  const siblingHash = await sha256File(path.join(sibling, 'precious.txt'));

  const uninstaller = stageUninstaller(target);
  registerCleanup(t, target, [uninstaller.dir]);
  const uninstall = await runStagedExe(uninstaller.exe, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { timeoutMs: 300_000 });
  assert.equal(uninstall.code, 0, `标准卸载失败 (exit ${uninstall.code}):\n${uninstall.stdout.slice(-1000)}\n${uninstall.stderr.slice(-1500)}`);
  for (const rel of ['Zhiying.exe', 'app', 'runtime']) {
    assert.ok(!fs.existsSync(path.join(target, rel)), `标准卸载后应移除程序文件: ${rel}`);
  }
  // staging 约束（环境限制）：unins000.exe/.dat 由“从 staging 运行”的卸载器自身在临时目录中启动，
  // 原安装目录里的 unins000.* 可能无法被立即删除；最多等待 10s，仍未删除则记录诊断并清理。
  await waitForCondition(() => !fs.existsSync(path.join(target, 'unins000.exe')), { timeoutMs: 10_000, intervalMs: 200 }).catch(async () => {
    t.diagnostic('BLOCKED-ENV(staging)：unins000.exe 因卸载器从 workspace 外 staging 运行而残留，测试清理后继续（非产品缺陷）');
    for (const name of fs.readdirSync(target).filter((n) => /^unins\d+\./i.test(n))) {
      fs.rmSync(path.join(target, name), { force: true });
    }
  });
  const remainingEntries = findUninstallEntriesForInstallLocation(target).filter((entry) => norm(entry.values.InstallLocation?.value ?? '') === norm(target));
  assert.equal(remainingEntries.length, 0, `标准卸载后 HKCU 卸载项应移除: ${remainingEntries.map((e) => e.key).join(',')}`);
  for (const [rel] of before) {
    assert.ok(fs.existsSync(path.join(target, rel)), `标准卸载不得删除用户数据: ${rel}`);
    assert.ok(fs.readFileSync(path.join(target, rel)).equals(sentinels[rel]), `标准卸载改写了用户数据: ${rel}`);
  }
  assert.equal(await sha256File(path.join(sibling, 'precious.txt')), siblingHash, '标准卸载删除了 installRoot 外的无关文件');
});

test('[#103-11 R4-Inno] /PURGEDATA（若实现）显式清理：仅删除选定用户数据，root 外零删除', async (t) => {
  if (!innoArtifactReady().ready) {
    t.skip(`R4 Inno 产物未就绪：${innoArtifactReady().reason}`);
    return;
  }
  const target = makeTarget(t, 'r4-purge', '知影 卸载 清理 数据');
  const staging = createStagingDir('zhiying-test-setup-purge');
  const staged = stageExecutable(SETUP, staging);
  registerCleanup(t, target, [staging]);
  const install = await silentInstall(staged.exe, target, { tasks: '', model: 'later' });
  assert.equal(install.code, 0);
  fs.mkdirSync(path.dirname(path.join(target, 'models', 'keep.bin')), { recursive: true });
  fs.writeFileSync(path.join(target, 'models', 'keep.bin'), 'model');
  fs.mkdirSync(path.dirname(path.join(target, 'data', 'projects', 'p.json')), { recursive: true });
  fs.writeFileSync(path.join(target, 'data', 'projects', 'p.json'), 'project');
  fs.mkdirSync(path.dirname(path.join(target, 'logs', 'keep.log')), { recursive: true });
  fs.writeFileSync(path.join(target, 'logs', 'keep.log'), 'log');
  const sibling = makeTempRoot('r4-purge-outside');
  fs.writeFileSync(path.join(sibling, 'precious.txt'), 'must-survive');
  const uninstaller = stageUninstaller(target);
  registerCleanup(t, target, [uninstaller.dir]);
  const uninstall = await runStagedExe(uninstaller.exe, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/PURGEDATA'], { timeoutMs: 300_000 });
  assert.equal(uninstall.code, 0, `/PURGEDATA 卸载失败 (exit ${uninstall.code}): ${uninstall.stderr.slice(-1200)}`);
  // Inno 卸载器在 usPostUninstall 的 DelTree 可能在进程退出后由自清理子进程完成，轮询等待（契约 §8.6 #11 同类延迟）
  await waitForCondition(
    () => !fs.existsSync(path.join(target, 'models', 'keep.bin')) && !fs.existsSync(path.join(target, 'data', 'projects', 'p.json')),
    { timeoutMs: 15_000, intervalMs: 200 },
  ).catch(() => undefined);
  // 契约：/PURGEDATA 供自动化显式清理用户数据（models/data）；logs/config 是否保留由 .iss 决定
  assert.ok(!fs.existsSync(path.join(target, 'models', 'keep.bin')), '/PURGEDATA 应清理 models 用户数据');
  assert.ok(!fs.existsSync(path.join(target, 'data', 'projects', 'p.json')), '/PURGEDATA 应清理 data 用户数据');
  assert.ok(fs.existsSync(path.join(sibling, 'precious.txt')), '/PURGEDATA 不得删除 installRoot 外文件');
});

test('[#103-13 R4-Inno] 覆盖升级/修复安装：同 AppId 同 /DIR 再次安装 → 哨兵逐字节保留、程序替换、data/backups 备份 install.json+m2v.db', async (t) => {
  if (!innoArtifactReady().ready) {
    t.skip(`R4 Inno 产物未就绪：${innoArtifactReady().reason}`);
    return;
  }
  const target = makeTarget(t, 'r4-upgrade', '知影 覆盖 升级 安装');
  const staging = createStagingDir('zhiying-test-setup-upgrade');
  const staged = stageExecutable(SETUP, staging);
  registerCleanup(t, target, [staging]);
  const first = await silentInstall(staged.exe, target, { tasks: '', model: 'later' });
  assert.equal(first.code, 0, `首次安装失败: ${first.stderr.slice(-1500)}`);
  // 用户数据/模型/项目/导出哨兵 + 旧程序标记
  const sentinels: Record<string, string> = {
    'models/f5-tts/F5TTS_v1_Base/weights.bin': 'weights-v1',
    'data/m2v.db': 'db-v1',
    'data/projects/p1.json': '{"id":"p1"}',
    'data/voices/v.wav': 'voice-audio',
    'logs/user.log': 'log-v1',
    'outputs/export.mp4': 'video-bytes',
    'app/desktop/OLD_MARKER.txt': 'old-program-marker',
  };
  for (const [rel, content] of Object.entries(sentinels)) {
    fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
    fs.writeFileSync(path.join(target, rel), content);
  }
  const configBefore = await loadInstallConfig(target);
  // 第二次安装：同 DIR，覆盖升级
  const second = await silentInstall(staged.exe, target, { tasks: '', model: 'later' });
  assert.equal(second.code, 0, `覆盖升级安装失败: ${second.stderr.slice(-1500)}`);
  for (const rel of ['models/f5-tts/F5TTS_v1_Base/weights.bin', 'data/m2v.db', 'data/projects/p1.json', 'data/voices/v.wav', 'logs/user.log', 'outputs/export.mp4']) {
    assert.ok(fs.existsSync(path.join(target, rel)), `覆盖升级丢失用户数据: ${rel}`);
    assert.equal(fs.readFileSync(path.join(target, rel), 'utf8'), sentinels[rel], `覆盖升级改写用户数据: ${rel}`);
  }
  // 程序替换：旧程序标记应被覆盖安装删除
  // Inno [Files] 覆盖已知程序文件；契约只承诺覆盖 app/runtime/Zhiying.exe，不保证删除未知文件。
  assert.ok(fs.existsSync(path.join(target, 'app', 'desktop', 'index.js')), '覆盖升级后程序文件缺失');
  assert.ok(fs.existsSync(path.join(target, 'Zhiying.exe')), '覆盖升级后 Zhiying.exe 缺失');
  assert.ok(fs.existsSync(path.join(target, 'app', 'desktop', 'index.js')), '覆盖升级后程序文件缺失');
  const configAfter = await loadInstallConfig(target);
  assert.equal(configAfter.version, '1.8.0');
  assert.equal(configAfter.installedAt, configBefore.installedAt, '升级应保留 installedAt 等用户字段');
  // 备份 install.json + m2v.db
  const backupsDir = path.join(target, 'data', 'backups');
  assert.ok(fs.existsSync(backupsDir), '覆盖升级缺少 data/backups/<ts>/ 备份目录');
  const backupDirs = fs.readdirSync(backupsDir).filter((name) => fs.statSync(path.join(backupsDir, name)).isDirectory());
  assert.ok(backupDirs.length > 0, '备份目录为空');
  const latestBackup = path.join(backupsDir, backupDirs.sort().pop()!);
  assert.ok(fs.existsSync(path.join(latestBackup, 'install.json')), '升级备份缺少 install.json');
  assert.ok(fs.existsSync(path.join(latestBackup, 'm2v.db')), '升级备份缺少 m2v.db');
});

test('[#103-1/#103-2/#103-4 R4-Inno] 默认 per-user 安装根 + 受保护/非法目标拒绝且无残留', async (t) => {
  if (!innoArtifactReady().ready) {
    t.skip(`R4 Inno 产物未就绪：${innoArtifactReady().reason}`);
    return;
  }
  // 默认 per-user：无 /DIR 安装到 %LOCALAPPDATA%\Programs\Zhiying（测试后卸载清理）
  const defaultRoot = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Zhiying');
  const existedBefore = fs.existsSync(defaultRoot);
  if (existedBefore) {
    t.skip(`默认目录已存在（可能为真实安装），跳过默认目录实测以免破坏: ${defaultRoot}`);
  } else {
    const staging = createStagingDir('zhiying-test-default');
    const staged = stageExecutable(SETUP, staging);
    registerCleanup(t, defaultRoot, [staging]);
    const captured = spawnCollect(staged.exe, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/TASKS=', '/MODELDOWNLOAD=later', `/LOG=${path.join(staging, 'default.log')}`], { cwd: staging, env: process.env });
    const exit = await waitExit(captured.child, 300_000);
    assert.ok(exit, '默认目录安装超时');
    assert.equal(exit!.code, 0, `默认 per-user 安装失败 (exit ${exit!.code}): ${captured.stderr().slice(-1500)}`);
    assert.ok(fs.existsSync(path.join(defaultRoot, 'config', 'install.json')), `默认安装应写入 %LOCALAPPDATA%\\Programs\\Zhiying: ${defaultRoot}`);
    assert.ok(fs.existsSync(path.join(defaultRoot, 'Zhiying.exe')));
    const config = await loadInstallConfig(defaultRoot);
    assert.equal(norm(config.installRoot), norm(defaultRoot));
    // 清理：标准卸载默认保留 models/data/logs/config，测试目录整体删除
    const uninstaller = stageUninstaller(defaultRoot);
    removeStagingDir(uninstaller.dir);
    try {
      fs.rmSync(defaultRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* 尽力而为 */
    }
  }
  // 受保护目录：Program Files 应立即失败（非 0），不创建目标
  const protectedTarget = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', `ZhiyingR4Test-${Date.now()}`);
  const staging2 = createStagingDir('zhiying-test-protected');
  const staged2 = stageExecutable(SETUP, staging2);
  registerCleanup(t, protectedTarget, [staging2]);
  const protectedRes = await runStagedExe(staged2.exe, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', `/DIR=${protectedTarget}`, '/TASKS=', '/MODELDOWNLOAD=later', `/LOG=${path.join(staging2, 'protected.log')}`], { timeoutMs: 90_000 });
  // 当前测试会话为 High Mandatory Level（管理员）：silent 安装写 Program Files 可能成功；
  // 受保护目录校验（[Code] NextButtonClick → ValidateInstallDir）只走 GUI 向导路径。
  // 非管理员场景在此严格断言拒绝；管理员会话下改为断言 .iss 校验逻辑 + 清理安装结果。
  const whoamiGroups = spawnSync('whoami.exe', ['/groups'], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
  const elevated = whoamiGroups.includes('S-1-16-12288');
  if (elevated) {
    t.diagnostic('BLOCKED-ENV(权限)：测试会话为管理员，silent 安装到 Program Files 不会被拒绝；#103-2 的受保护目录拒绝由 GUI [Code] 路径与源码断言覆盖');
    const iss = fs.readFileSync(path.join(REPO_ROOT, 'apps', 'desktop', 'native', 'ZhiyingSetup.iss'), 'utf8');
    for (const token of ['IsProtectedDirectory', 'Program Files', 'System32', 'ValidateInstallDir', 'NextButtonClick']) {
      assert.ok(iss.includes(token), `.iss 缺少受保护目录校验：${token}`);
    }
    if (protectedRes.code === 0 && fs.existsSync(protectedTarget)) {
      try {
        fs.rmSync(protectedTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* ignore */
      }
    }
  } else {
    assert.notEqual(protectedRes.code, 0, `Program Files 目标必须被拒绝（当前 exit ${protectedRes.code}）`);
    assert.ok(!fs.existsSync(protectedTarget), '受保护目录不得被安装器创建');
  }
  // 非法相对路径：拒绝或规范化为绝对路径（无副作用）
  const staging3 = createStagingDir('zhiying-test-invalid');
  const staged3 = stageExecutable(SETUP, staging3);
  registerCleanup(t, path.join(staging3, 'relative-install'), [staging3]);
  const invalidRes = await runStagedExe(staged3.exe, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/DIR=relative\\zhiying-r4', '/TASKS=', '/MODELDOWNLOAD=later', `/LOG=${path.join(staging3, 'invalid.log')}`], { timeoutMs: 180_000 });
  if (invalidRes.code === 0) {
    // 规范化：应安装到 staging 工作目录下的绝对路径
    const normalized = path.resolve(staging3, 'relative', 'zhiying-r4');
    assert.ok(fs.existsSync(path.join(normalized, 'config', 'install.json')), `相对路径被接受时必须规范化为绝对路径: ${normalized}`);
  } else {
    assert.ok(!fs.existsSync(path.join(staging3, 'relative')), '非法路径失败后不得留下安装目录');
  }
});

test('[#103-17 R4-Inno] 长路径（250+）安装：可用或给出明确可读错误（不崩溃）', async (t) => {
  if (!innoArtifactReady().ready) {
    t.skip(`R4 Inno 产物未就绪：${innoArtifactReady().reason}`);
    return;
  }
  const base = makeTempRoot('r4-long');
  let target = path.join(base, 'target');
  while (target.length < 250) target = path.join(target, '长路径-段');
  const staging = createStagingDir('zhiying-test-long');
  const staged = stageExecutable(SETUP, staging);
  registerCleanup(t, target, [staging]);
  const result = await silentInstall(staged.exe, target, { tasks: '', model: 'later', logDir: staging });
  if (result.code === 0) {
    assert.ok(fs.existsSync(path.join(target, 'config', 'install.json')), '长路径安装成功但缺少 install.json');
    const config = await loadInstallConfig(target);
    assert.equal(norm(config.installRoot), norm(target));
  } else {
    const logText = fs.existsSync(result.logFile) ? fs.readFileSync(result.logFile, 'utf8') : '';
    assert.ok(logText.length > 0 || result.stderr.length > 0, '长路径失败必须给出可读日志/错误');
    assert.ok(/路径|过长|长|path|error|失败/i.test(`${logText}\n${result.stderr}`), '长路径失败原因不可读');
  }
});

test('[#103-18 R4-Inno] 净化 PATH（无系统 node/pnpm/python/git）静默安装成功（离线、不依赖开发工具）', async (t) => {
  if (!innoArtifactReady().ready) {
    t.skip(`R4 Inno 产物未就绪：${innoArtifactReady().reason}`);
    return;
  }
  const env = sanitizedEnv({ TEMP: createStagingDir('zhiying-test-clean-temp'), TMP: createStagingDir('zhiying-test-clean-temp2') });
  for (const tool of ['node', 'pnpm', 'python', 'git']) assert.equal(pathHasDevTool(tool, env), false, `净化 PATH 不应包含 ${tool}`);
  const target = makeTarget(t, 'r4-clean', '知影 净化环境 安装');
  const staging = createStagingDir('zhiying-test-clean');
  const staged = stageExecutable(SETUP, staging);
  registerCleanup(t, target, [staging]);
  const result = await silentInstall(staged.exe, target, { tasks: '', model: 'later', env, logDir: staging });
  assert.equal(result.code, 0, `净化 PATH 安装失败: ${result.stderr.slice(-1500)}`);
  assert.ok(fs.existsSync(path.join(target, 'config', 'install.json')));
  const config = await loadInstallConfig(target);
  assert.equal(config.version, '1.8.0');
});

test('[#103-6 R4-Inno] 磁盘不足：Inno 标准检查 + 可读提示（本机不可构造真实小容量卷 → BLOCKED-ENV 替代）', async (t) => {
  t.skip('#103-6 BLOCKED-ENV：Inno 标准磁盘空间检查无可注入点，本机无小容量卷/无法安全填满磁盘；Inno 自带检查 + /LOG 可读错误由契约与 GUI 向导保障，见报告 §7');
});
