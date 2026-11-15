/**
 * #107-7/#102-13/#103-15/#107-8 冻结发布产物回归（R2）：
 * 校验 dist/ 中的 Zhiying-Setup.exe / release-info / 版本化运行目录 / release-manifest / components / SHA256SUMS
 * 与 Lead/impl-dev 冻结的 sha256 一致；若 dist/ 未构建则跳过（E2E 会自建同链路产物并断言）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './_helpers/temp';
import { sha256File, sha256Buffer } from './_helpers/fsx';

const FROZEN_SETUP_SHA = '60d840e1a97790da1f8de5567a85208787d913623861ab5e08a41d0579d147bc';
const FROZEN_SETUP_SIZE = 35_057_664;
const DIST = path.join(REPO_ROOT, 'dist');
const SETUP = path.join(DIST, 'Zhiying-Setup.exe');
const PRODUCT = path.join(DIST, 'desktop', 'Zhiying-1.8.0-lite');

function peVersionInfo(exe: string): Record<string, string> {
  const script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $v=(Get-Item '${exe.replace(/'/g, "''")}').VersionInfo; ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ fileVersion=$v.FileVersion; productVersion=$v.ProductVersion })`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return JSON.parse((res.stdout ?? '{}').trim() || '{}') as Record<string, string>;
}

test('[#107-7] 冻结发布产物：dist/Zhiying-Setup.exe sha256/大小/release-info/程序集版本', async (t) => {
  if (!fs.existsSync(SETUP)) {
    t.skip('dist/ 未构建（干净检出由 E2E 构建同链路产物覆盖）');
    return;
  }
  assert.equal(fs.statSync(SETUP).size, FROZEN_SETUP_SIZE, `Setup.exe 大小与冻结产物不一致: ${fs.statSync(SETUP).size}`);
  assert.equal(await sha256File(SETUP), FROZEN_SETUP_SHA, 'Setup.exe sha256 与冻结产物不一致');
  const shaFile = fs.readFileSync(path.join(DIST, 'Zhiying-Setup.exe.sha256'), 'utf8').trim();
  const match = /^([0-9a-f]{64})\s+Zhiying-Setup\.exe$/.exec(shaFile);
  assert.ok(match, `.sha256 文件格式非法: ${shaFile}`);
  assert.equal(match![1], FROZEN_SETUP_SHA, '.sha256 与冻结产物不一致');
  assert.equal(fs.readFileSync(SETUP).subarray(0, 2).toString('ascii'), 'MZ', 'Setup.exe 不是合法 PE');
  const version = peVersionInfo(SETUP);
  assert.match(version.fileVersion ?? '', /^1\.8\.0\.0$/, `Setup.exe FileVersion 应为 1.8.0.0: ${version.fileVersion}`);
  const releaseInfo = JSON.parse(fs.readFileSync(path.join(DIST, 'release-info.json'), 'utf8')) as Record<string, any>;
  assert.equal(releaseInfo.version, '1.8.0');
  assert.equal(releaseInfo.profile, 'lite');
  assert.equal(releaseInfo.assemblyVersion, '1.8.0.0');
  assert.equal(releaseInfo.setup?.sha256, FROZEN_SETUP_SHA);
  assert.equal(releaseInfo.setup?.sizeBytes, FROZEN_SETUP_SIZE);
  assert.ok(releaseInfo.payload?.embedded === true, 'lite 默认应嵌入 payload');
  assert.ok(releaseInfo.components?.components, 'release-info 缺少 components');
  assert.ok(!JSON.stringify(releaseInfo).includes(REPO_ROOT.replace(/\\/g, '\\\\')), 'release-info 泄漏本机绝对路径');
});

test('[#102-13/#107-7] 冻结版本化运行目录：Zhiying.exe(1.8.0.0)/runtime node/ release-manifest 全量哈希/SHA256SUMS/components', async (t) => {
  if (!fs.existsSync(PRODUCT)) {
    t.skip('dist/desktop 未构建（干净检出由 E2E 构建同链路产物覆盖）');
    return;
  }
  assert.equal(fs.readFileSync(path.join(PRODUCT, 'Zhiying.exe')).subarray(0, 2).toString('ascii'), 'MZ');
  const launcherVersion = peVersionInfo(path.join(PRODUCT, 'Zhiying.exe'));
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
  void sha256Buffer;
});
