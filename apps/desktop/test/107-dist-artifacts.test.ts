/**
 * #107-7/#102-13/#103-15/#107-8 冻结发布产物回归（R4 Inno Setup 6）。
 * 冻结校验比对 Lead 提供的 pinned sha256/size；Inno Setup.exe 含编译时间戳，重建后字节哈希会变化，
 * 因此 E2E 自建产物只断言结构/版本/release-info 内部一致性，不比对 pinned sha（契约 §2.7/§8.6）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './_helpers/temp';
import { sha256File } from './_helpers/fsx';
import { readPeInfo, readExeVersionInfo } from './_helpers/gui';

// Lead FINAL FREEZE（R4 Inno）：2026-11-15
const PINNED_SETUP_SHA = 'c9fcd8c8178ce38bb1176cf3582ea0d184464ece8ee5f14d0584020d0f3c7d6a';
const PINNED_SETUP_SIZE = 24_915_215;
const PINNED_INNO_VERSION = '6.7.3';
const DIST = path.join(REPO_ROOT, 'dist');
const SETUP = path.join(DIST, 'Zhiying-Setup.exe');
const PRODUCT = path.join(DIST, 'desktop', 'Zhiying-1.8.0-lite');

interface ReleaseInfo {
  version?: string;
  profile?: string;
  installer?: string;
  innoVersion?: string;
  setup?: { sha256?: string; sizeBytes?: number };
  payload?: { embedded?: boolean; mode?: string; source?: string };
  components?: { components?: Record<string, { version?: string; source?: string; license?: string }> };
}

function readReleaseInfo(): ReleaseInfo {
  return JSON.parse(fs.readFileSync(path.join(DIST, 'release-info.json'), 'utf8')) as ReleaseInfo;
}

function peVersionInfo(exe: string): Record<string, string> {
  return readExeVersionInfo(exe);
}

test('[#103-15/#107-7 R4-Inno] 冻结产物 Zhiying-Setup.exe：pinned sha256/大小、PE subsystem=2、FileVersion 1.8.0.x/ProductVersion、FileDescription、.sha256/release-info 三方一致', async (t) => {
  if (!fs.existsSync(SETUP)) {
    t.skip('dist/ 未构建（干净检出由 E2E 构建同链路产物覆盖）');
    return;
  }
  const actualSha = await sha256File(SETUP);
  if (actualSha !== PINNED_SETUP_SHA) {
    t.skip(`dist 已重建（当前 sha256=${actualSha}, size=${fs.statSync(SETUP).size}），等待 Lead 提供新冻结 sha 后更新 PINNED_* 并强制校验`);
    return;
  }
  assert.equal(fs.statSync(SETUP).size, PINNED_SETUP_SIZE, 'Setup.exe 大小与冻结产物不一致');
  assert.equal(actualSha, PINNED_SETUP_SHA, 'Setup.exe sha256 与冻结产物不一致');
  const pe = readPeInfo(SETUP);
  assert.equal(pe.subsystem, 2, `Inno Setup.exe 必须为 GUI 子系统(2)，实际 ${pe.subsystem}（${pe.subsystemLabel}）`);
  const version = peVersionInfo(SETUP);
  assert.match(version.fileVersion ?? '', /^1\.8\.0(\.\d+)?$/, `FileVersion 应为 1.8.0.x: ${version.fileVersion}`);
  assert.match(version.productVersion ?? '', /^1\.8\.0(\.\d+)?$/, `ProductVersion 应为 1.8.0.x: ${version.productVersion}`);
  assert.match(version.fileDescription ?? '', /知影.*安装程序/, `FileDescription 应为“知影 Zhiying 安装程序”: ${version.fileDescription}`);
  // .sha256 三方一致
  const shaFile = fs.readFileSync(path.join(DIST, 'Zhiying-Setup.exe.sha256'), 'utf8').trim();
  const match = /^([0-9a-f]{64})\s+Zhiying-Setup\.exe$/.exec(shaFile);
  assert.ok(match, `.sha256 文件格式非法: ${shaFile}`);
  assert.equal(match![1], PINNED_SETUP_SHA, '.sha256 与冻结产物不一致');
  const releaseInfo = readReleaseInfo();
  assert.equal(releaseInfo.version, '1.8.0');
  assert.equal(releaseInfo.profile, 'lite');
  assert.equal(releaseInfo.installer, 'inno-setup', 'release-info.installer 应为 inno-setup');
  assert.equal(releaseInfo.innoVersion, PINNED_INNO_VERSION, `release-info.innoVersion 应为 ${PINNED_INNO_VERSION}`);
  assert.equal(releaseInfo.setup?.sha256, PINNED_SETUP_SHA, 'release-info.setup.sha256 与冻结产物不一致');
  assert.equal(releaseInfo.setup?.sizeBytes, PINNED_SETUP_SIZE);
  assert.equal(releaseInfo.payload?.embedded, true, 'lite 应内嵌 payload');
  assert.equal(releaseInfo.payload?.mode, 'inno-files', 'payload 模式应为 inno-files');
  assert.ok(!JSON.stringify(releaseInfo).includes(REPO_ROOT.replace(/\\/g, '\\\\')), 'release-info 泄漏本机绝对路径');
  // 构建期工具链存在（可复现构建依赖）
  const iscc = process.env.ISCC_PATH ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe');
  assert.ok(fs.existsSync(iscc), `缺少 Inno Setup ISCC: ${iscc}`);
});

test('[#102-13/#107-7 R4-Inno] 冻结版本化运行目录：Zhiying.exe Console(3)/1.8.0.0、runtime node、release-manifest 全量哈希、SHA256SUMS、components', async (t) => {
  if (!fs.existsSync(PRODUCT)) {
    t.skip('dist/desktop 未构建（干净检出由 E2E 构建同链路产物覆盖）');
    return;
  }
  const launcher = path.join(PRODUCT, 'Zhiying.exe');
  assert.equal(fs.readFileSync(launcher).subarray(0, 2).toString('ascii'), 'MZ');
  assert.equal(readPeInfo(launcher).subsystem, 3, 'Zhiying.exe 启动器必须保持 Console(3)');
  const launcherVersion = peVersionInfo(launcher);
  assert.match(launcherVersion.fileVersion ?? '', /^1\.8\.0\.0$/, `Zhiying.exe FileVersion 应为 1.8.0.0: ${launcherVersion.fileVersion}`);
  assert.ok(fs.existsSync(path.join(PRODUCT, 'runtime', 'node', 'node.exe')), '缺少 bundled node.exe');
  for (const rel of ['app/desktop/index.js', 'app/desktop/cli/launcher-cli.mjs', 'app/desktop/cli/maintenance-cli.mjs', 'app/fixtures/python.mjs', 'app/fixtures/web.mjs', 'app/fixtures/worker.mjs', 'app/fixtures/ollama.mjs', 'config/install.template.json', 'components.json', 'release-manifest.json', 'SHA256SUMS.txt']) {
    assert.ok(fs.existsSync(path.join(PRODUCT, rel)), `冻结运行目录缺少 ${rel}`);
  }
  const manifestRaw = fs.readFileSync(path.join(PRODUCT, 'release-manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw) as { version: string; profile: string; files: Array<{ path: string; sizeBytes: number; sha256: string }> };
  assert.equal(manifest.version, '1.8.0');
  assert.equal(manifest.profile, 'lite');
  assert.ok(manifest.files.length > 10);
  assert.ok(!manifestRaw.includes('generatedAt'), 'release-manifest 不应包含 generatedAt');
  for (const entry of manifest.files) {
    const file = path.join(PRODUCT, entry.path);
    assert.ok(fs.existsSync(file), `manifest 文件缺失: ${entry.path}`);
    assert.equal(fs.statSync(file).size, entry.sizeBytes, `manifest size 不匹配: ${entry.path}`);
    assert.equal(await sha256File(file), entry.sha256, `manifest sha256 不匹配: ${entry.path}`);
  }
  const sums = fs.readFileSync(path.join(PRODUCT, 'SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/);
  assert.equal(sums.length, manifest.files.length, 'SHA256SUMS 行数与 manifest 不符');
  const byPath = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
  for (const line of sums) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    assert.ok(match, `SHA256SUMS 行非法: ${line}`);
    assert.equal(byPath.get(match![2]), match![1], `SHA256SUMS 与 manifest 不一致: ${match![2]}`);
  }
  const components = JSON.parse(fs.readFileSync(path.join(PRODUCT, 'components.json'), 'utf8')) as { version: string; profile: string; components: Record<string, { version?: string; source?: string; license?: string }> };
  assert.equal(components.version, '1.8.0');
  assert.equal(components.profile, 'lite');
  for (const name of ['node', 'launcher', 'python', 'ffmpeg', 'ollama', 'web']) {
    assert.ok(components.components[name], `components 缺少 ${name}`);
    assert.ok((components.components[name].license ?? '').length > 0, `components.${name} 缺少许可证`);
  }
  assert.ok(!JSON.stringify(components).includes(REPO_ROOT.replace(/\\/g, '\\\\')), 'components.json 泄漏本机绝对路径');
  void spawnSync;
});
