/**
 * #106-18 维护 CLI（§2.8 maintenance-cli.ts）：诊断/修复/升级/卸载/退出码契约。
 * 真实 spawn CLI（tsx），真实安装目录、真实 fixture HTTP 源修复下载。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempRoot, cleanupRegisteredTempDirs, REPO_ROOT, NODE_EXE } from './_helpers/temp';
import { createPayloadTree, makeManifest, makeHttpEntry } from './_helpers/fixtures';
import { deterministicBytes, sha256Buffer, writeFileDeep } from './_helpers/fsx';
import { killTree } from './_helpers/processes';
import { FixtureModelSource } from './_helpers/http-source';
import { executeInstall, planInstall } from '../src/installer';
import { loadInstallConfig } from '../src/install-layout';

const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_TS = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'cli', 'maintenance-cli.ts');

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runMaintenanceCli(args: string[], env?: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(NODE_EXE, [TSX_CLI, CLI_TS, ...args], { env: env ?? process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    let timer: NodeJS.Timeout | undefined;
    timer = setTimeout(() => {
      killTree(child.pid ?? -1);
      resolve({ status: null, stdout, stderr: `${stderr}\n[timeout]` });
    }, 180_000);
    timer.unref?.();
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: `${stderr}\n${err.message}` });
    });
  });
}

function parseJson(stdout: string): Record<string, any> {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  assert.ok(start >= 0 && end > start, `CLI 未输出 JSON: ${stdout.slice(0, 800)}`);
  return JSON.parse(stdout.slice(start, end + 1));
}

async function makeInstalled(t: test.TestContext, label: string, version = '1.8.0'): Promise<{ root: string; payload: string }> {
  const base = makeTempRoot(label);
  t.after(() => cleanupRegisteredTempDirs());
  const payload = path.join(base, 'payload');
  await createPayloadTree(payload, { version });
  const root = path.join(base, 'install');
  const plan = await planInstall({ payloadRoot: payload, targetRoot: root, version, profile: 'lite' });
  const result = await executeInstall(plan, { createShortcut: async () => undefined, writeRegistry: async () => undefined });
  assert.equal(result.ok, true, result.errors.join('|'));
  return { root, payload };
}

test('[#106-18] --version / 无操作参数 / 缺少/非法 install-root 的退出码契约', async (t) => {
  t.after(() => cleanupRegisteredTempDirs());
  const version = await runMaintenanceCli(['--version']);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /1\.8\.0/);

  const noArgs = await runMaintenanceCli([], (() => {
    const env = { ...process.env };
    delete env.M2V_INSTALL_ROOT;
    return env;
  })());
  assert.equal(noArgs.status, 2, `无操作参数应 exit 2，实际 ${noArgs.status}`);

  const missingRoot = await runMaintenanceCli(['--diagnostics'], (() => {
    const env = { ...process.env };
    delete env.M2V_INSTALL_ROOT;
    return env;
  })());
  assert.equal(missingRoot.status, 2, `缺少 install-root 应 exit 2，实际 ${missingRoot.status}`);
  assert.match(missingRoot.stderr, /install-root|安装目录/i);

  const invalidRoot = await runMaintenanceCli(['--install-root', 'relative\\path', '--diagnostics']);
  assert.equal(invalidRoot.status, 2);
  assert.match(invalidRoot.stderr, /无效|安装目录|路径/);
});

test('[#106-18] --diagnostics --json：健康安装 exit 0 + 完整报告；配置损坏 exit 3', async (t) => {
  const { root } = await makeInstalled(t, 'cli-diag');
  const healthy = await runMaintenanceCli(['--install-root', root, '--diagnostics', '--json']);
  assert.equal(healthy.status, 0, `健康诊断应 exit 0，实际 ${healthy.status}: ${healthy.stderr}`);
  const report = parseJson(healthy.stdout);
  assert.equal(report.version, '1.8.0');
  assert.ok(Array.isArray(report.checks) && report.checks.length > 5);
  assert.ok(report.summary && typeof report.summary.ok === 'number');
  assert.ok(!JSON.stringify(report).includes('password'), '诊断输出不得包含凭据');

  // 配置损坏 → summary.fail>0 → exit 3
  fs.writeFileSync(path.join(root, 'config', 'install.json'), '{ broken json');
  const broken = await runMaintenanceCli(['--install-root', root, '--diagnostics', '--json']);
  assert.equal(broken.status, 3, `配置损坏诊断应 exit 3，实际 ${broken.status}: ${broken.stderr}`);
  const brokenReport = parseJson(broken.stdout);
  assert.ok(brokenReport.summary.fail > 0);
  assert.ok(brokenReport.checks.some((check: { status: string; fix?: string }) => check.status === 'fail' && check.fix && check.fix.length > 0));
});

test('[#106-18/#106-6] --repair：未 --yes 只给建议 exit 3；--yes 按清单真实修复缺失模型（fixture 源）', async (t) => {
  const { root } = await makeInstalled(t, 'cli-repair');
  const source = new FixtureModelSource();
  const server = await source.start();
  t.after(() => server.close());
  const goodData = deterministicBytes(4096, 'good');
  const missingData = deterministicBytes(8192, 'missing');
  source.addFile('/dl/good/model.bin', { data: goodData, mode: 'ok' });
  source.addFile('/dl/missing/model.bin', { data: missingData, mode: 'ok' });
  const good = makeHttpEntry({ id: 'good', name: 'Good', files: [{ path: 'model.bin', data: goodData, url: `${server.url}/dl/good/model.bin` }], baseUrl: `${server.url}/dl` });
  const missing = makeHttpEntry({ id: 'missing', name: 'Missing', files: [{ path: 'model.bin', data: missingData, url: `${server.url}/dl/missing/model.bin` }], baseUrl: `${server.url}/dl` });
  const manifest = makeManifest([good.entry, missing.entry]);
  await writeFileDeep(path.join(root, 'models', '.downloads', 'manifest.json'), JSON.stringify(manifest, null, 2));
  // good 已安装
  await writeFileDeep(path.join(root, 'models', 'good', 'model.bin'), goodData);
  const goodHashBefore = sha256Buffer(fs.readFileSync(path.join(root, 'models', 'good', 'model.bin')));

  const suggestion = await runMaintenanceCli(['--install-root', root, '--repair']);
  assert.equal(suggestion.status, 3, `未确认的 repair 应 exit 3，实际 ${suggestion.status}: ${suggestion.stderr}`);
  assert.match(suggestion.stdout, /修复动作|建议|确认/i);
  assert.ok(!fs.existsSync(path.join(root, 'models', 'missing', 'model.bin')), '未确认不得下载模型');
  assert.equal(sha256Buffer(fs.readFileSync(path.join(root, 'models', 'good', 'model.bin'))), goodHashBefore);

  const repaired = await runMaintenanceCli(['--install-root', root, '--repair', '--yes', '--json']);
  assert.equal(repaired.status, 0, `--repair --yes 应 exit 0，实际 ${repaired.status}: ${repaired.stdout.slice(-1200)}\n${repaired.stderr.slice(-1200)}`);
  const missingFile = path.join(root, 'models', 'missing', 'model.bin');
  assert.ok(fs.existsSync(missingFile), '修复后缺失模型应下载到 models/<installDir>');
  assert.equal(sha256Buffer(fs.readFileSync(missingFile)), sha256Buffer(missingData));
  assert.equal(sha256Buffer(fs.readFileSync(path.join(root, 'models', 'good', 'model.bin'))), goodHashBefore, '修复不得重下/改写已校验模型');
});

test('[#106-18/#106-8] --upgrade：dry-run 不改动；真实升级更新版本并保留用户数据', async (t) => {
  const { root } = await makeInstalled(t, 'cli-upgrade', '1.8.0');
  await writeFileDeep(path.join(root, 'data', 'projects', 'p1.json'), '{"id":"p1"}');
  await writeFileDeep(path.join(root, 'data', 'm2v.db'), 'db-bytes');
  await writeFileDeep(path.join(root, 'models', 'keep.bin'), 'model-keep');
  const v2base = makeTempRoot('cli-upgrade-v2');
  await createPayloadTree(path.join(v2base, 'payload'), { version: '1.8.1' });
  const payloadV2 = path.join(v2base, 'payload');
  t.after(() => cleanupRegisteredTempDirs());

  const dry = await runMaintenanceCli(['--install-root', root, '--upgrade', '--payload', payloadV2, '--dry-run', '--json']);
  assert.equal(dry.status, 0, `${dry.stderr}`);
  const dryResult = parseJson(dry.stdout);
  assert.equal(dryResult.ok, true);
  assert.equal(dryResult.toVersion, '1.8.1');
  assert.equal((await loadInstallConfig(root)).version, '1.8.0', 'dry-run 不得修改版本');

  const upgraded = await runMaintenanceCli(['--install-root', root, '--upgrade', '--payload', payloadV2, '--json']);
  assert.equal(upgraded.status, 0, `${upgraded.stderr}`);
  const result = parseJson(upgraded.stdout);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.fromVersion, '1.8.0');
  assert.equal(result.toVersion, '1.8.1');
  assert.equal((await loadInstallConfig(root)).version, '1.8.1');
  assert.ok(fs.existsSync(path.join(root, 'data', 'projects', 'p1.json')), '升级丢失项目数据');
  assert.equal(fs.readFileSync(path.join(root, 'data', 'm2v.db'), 'utf8'), 'db-bytes');
  assert.equal(fs.readFileSync(path.join(root, 'models', 'keep.bin'), 'utf8'), 'model-keep');
});

test('[#106-18/#106-1/#106-3] C2 回归：--diagnostics/--repair 真实哈希校验 corrupted 模型；repair 未确认 JSON exit 3，--yes 修复', async (t) => {
  const { root } = await makeInstalled(t, 'cli-hash');
  const source = new FixtureModelSource();
  const server = await source.start();
  t.after(() => server.close());
  const goodData = deterministicBytes(4096, 'good-hash');
  const corruptedData = deterministicBytes(4096, 'corrupted'); // 同大小、错误内容
  source.addFile('/dl/good/model.bin', { data: goodData, mode: 'ok' });
  const { entry } = makeHttpEntry({
    id: 'good',
    name: 'Good',
    files: [{ path: 'model.bin', data: goodData, url: `${server.url}/dl/good/model.bin` }],
    baseUrl: `${server.url}/dl`,
  });
  const manifest = makeManifest([entry]);
  const manifestPath = path.join(root, 'models', '.downloads', 'manifest.json');
  await writeFileDeep(manifestPath, JSON.stringify(manifest, null, 2));
  // 目标文件“同大小、错误内容”，但 state 声称 installed（验收 C2 场景）
  const targetFile = path.join(root, 'models', entry.installDir, 'model.bin');
  await writeFileDeep(targetFile, corruptedData);
  await writeFileDeep(
    path.join(root, 'models', '.downloads', 'state.json'),
    JSON.stringify({ schemaVersion: 1, models: { good: { id: 'good', status: 'installed', receivedBytes: goodData.length, totalBytes: goodData.length, percent: 100, files: [], partialKept: false, verified: 'sha256' } } }),
  );
  assert.notEqual(sha256Buffer(fs.readFileSync(targetFile)), sha256Buffer(goodData));

  // --diagnostics：真实哈希校验应识别 corrupted；corrupted 计入 warn 而非 fail → exit 0
  const diagnostics = await runMaintenanceCli(['--install-root', root, '--diagnostics', '--json']);
  assert.equal(diagnostics.status, 0, `corrupted 为 warn 桶应 exit 0，实际 ${diagnostics.status}: ${diagnostics.stderr}`);
  const report = parseJson(diagnostics.stdout) as { checks: Array<{ id: string; status: string; detail: string }>; summary: { fail: number; warn: number } };
  const modelCheck = report.checks.find((check) => check.id === 'model:good');
  assert.equal(modelCheck?.status, 'corrupted', `同大小错误哈希必须识别 corrupted: ${JSON.stringify(modelCheck)}`);
  assert.match(modelCheck?.detail ?? '', /哈希|校验|不完整/, `corrupted detail 不可读: ${modelCheck?.detail}`);
  assert.equal(report.summary.fail, 0, 'corrupted 不应计入 fail');

  // --repair（未 --yes）：exit 3 + 纯 JSON + requiresConfirmation + verify_models 动作
  const suggested = await runMaintenanceCli(['--install-root', root, '--repair', '--json']);
  assert.equal(suggested.status, 3, `未确认 repair 应 exit 3，实际 ${suggested.status}: ${suggested.stderr}`);
  const suggestion = parseJson(suggested.stdout) as { actions: Array<{ kind: string; modelIds?: string[] }>; requiresConfirmation: boolean; executed: boolean };
  assert.equal(suggestion.requiresConfirmation, true, 'repair JSON 必须标记 requiresConfirmation');
  assert.equal(suggestion.executed, false);
  const verifyAction = suggestion.actions.find((action) => action.kind === 'verify_models');
  assert.ok(verifyAction, `corrupted 应建议 verify_models: ${JSON.stringify(suggestion.actions)}`);
  assert.deepEqual(verifyAction!.modelIds, ['good']);
  assert.notEqual(sha256Buffer(fs.readFileSync(targetFile)), sha256Buffer(goodData), '未确认 repair 不得改动损坏文件');

  // --repair --yes：重新下载并修复（fixture 源），后续诊断 ok
  const repaired = await runMaintenanceCli(['--install-root', root, '--repair', '--yes', '--json']);
  assert.equal(repaired.status, 0, `--repair --yes 应 exit 0，实际 ${repaired.status}: ${repaired.stdout.slice(-1200)}\n${repaired.stderr.slice(-1200)}`);
  assert.equal(sha256Buffer(fs.readFileSync(targetFile)), sha256Buffer(goodData), '修复后文件内容必须正确');
  const after = await runMaintenanceCli(['--install-root', root, '--diagnostics', '--json']);
  assert.equal(after.status, 0);
  const afterReport = parseJson(after.stdout) as { checks: Array<{ id: string; status: string }> };
  assert.equal(afterReport.checks.find((check) => check.id === 'model:good')?.status, 'ok', '修复后诊断应为 ok');
});

test('[#106-18/#106-12/#106-13] C3 回归：默认 --uninstall 无需 --yes 即移除程序保留数据；purge 仍需 --yes；dry-run 只列', async (t) => {
  // A. 默认卸载（Windows 标准卸载入口 UninstallString 带 --yes，但 CLI 本身不需要 --yes）
  const a = await makeInstalled(t, 'cli-uninstall-a');
  await writeFileDeep(path.join(a.root, 'data', 'projects', 'p.json'), 'project');
  await writeFileDeep(path.join(a.root, 'models', 'm.bin'), 'model');
  const dry = await runMaintenanceCli(['--install-root', a.root, '--uninstall', '--dry-run', '--json']);
  assert.equal(dry.status, 0, dry.stderr);
  const dryResult = parseJson(dry.stdout);
  assert.equal(dryResult.executed, false);
  assert.ok(dryResult.plan.targets.some((target: { kind: string }) => target.kind === 'program'));
  assert.ok(fs.existsSync(path.join(a.root, 'app')), 'dry-run 不得删除程序');
  assert.ok(fs.existsSync(path.join(a.root, 'data', 'projects', 'p.json')), 'dry-run 不得删除数据');

  const defaultUninstall = await runMaintenanceCli(['--install-root', a.root, '--uninstall', '--json']);
  assert.equal(defaultUninstall.status, 0, `默认卸载（无 --yes）应 exit 0，实际 ${defaultUninstall.status}: ${defaultUninstall.stderr}`);
  const defaultResult = parseJson(defaultUninstall.stdout);
  assert.equal(defaultResult.ok, true, JSON.stringify(defaultResult.errors));
  assert.ok(!fs.existsSync(path.join(a.root, 'app')), '默认卸载应删除 app');
  assert.ok(!fs.existsSync(path.join(a.root, 'runtime')), '默认卸载应删除 runtime');
  assert.ok(!fs.existsSync(path.join(a.root, 'Zhiying.exe')), '默认卸载应删除 Zhiying.exe');
  assert.ok(fs.existsSync(path.join(a.root, 'data', 'projects', 'p.json')), '默认卸载必须保留 data');
  assert.ok(fs.existsSync(path.join(a.root, 'models', 'm.bin')), '默认卸载必须保留 models');

  // B. 服务运行中拒绝（无需 --yes 也拒绝）
  const b = await makeInstalled(t, 'cli-uninstall-b');
  await writeFileDeep(path.join(b.root, 'data', 'runtime', 'services.json'), JSON.stringify({ instanceId: 'i', startedAt: new Date().toISOString(), installRoot: b.root, version: '1.8.0', services: [{ id: 'web', pid: process.pid, startedAtMs: Date.now(), commandLine: `${process.execPath} --m2v-instance=i`, logFile: '' }] }));
  const running = await runMaintenanceCli(['--install-root', b.root, '--uninstall']);
  assert.equal(running.status, 3, `服务运行中卸载应 exit 3，实际 ${running.status}`);
  assert.match(running.stderr, /正在运行|先.*stop/i);
  fs.rmSync(path.join(b.root, 'data', 'runtime', 'services.json'), { force: true });

  // C. purge-data 未 --yes → exit 3 + JSON requiresConfirmation，且不删除任何东西
  const c = await makeInstalled(t, 'cli-uninstall-c');
  await writeFileDeep(path.join(c.root, 'data', 'projects', 'p.json'), 'project');
  await writeFileDeep(path.join(c.root, 'models', 'm.bin'), 'model');
  const denied = await runMaintenanceCli(['--install-root', c.root, '--uninstall', '--purge-data', '--json']);
  assert.equal(denied.status, 3, `purge-data 未 --yes 应 exit 3，实际 ${denied.status}`);
  const deniedJson = parseJson(denied.stdout) as { requiresConfirmation: boolean; executed: boolean; plan: { targets: Array<{ kind: string }> } };
  assert.equal(deniedJson.requiresConfirmation, true, 'purge 未确认 JSON 必须标记 requiresConfirmation');
  assert.equal(deniedJson.executed, false);
  assert.ok(deniedJson.plan.targets.some((target) => target.kind === 'data'), 'purge 计划应列出 data');
  assert.ok(fs.existsSync(path.join(c.root, 'app')), '未确认 purge 不得删除程序');
  assert.ok(fs.existsSync(path.join(c.root, 'data', 'projects', 'p.json')), '未确认 purge 不得删除数据');
  // purge-data --yes → 只删 data，保留 models（程序一并移除）
  const purged = await runMaintenanceCli(['--install-root', c.root, '--uninstall', '--purge-data', '--yes', '--json']);
  assert.equal(purged.status, 0, purged.stderr);
  assert.ok(!fs.existsSync(path.join(c.root, 'data', 'projects', 'p.json')), 'purge-data --yes 应删除用户数据');
  assert.ok(fs.existsSync(path.join(c.root, 'models', 'm.bin')), 'purge-data 不得删除模型');
});

test('[#106-18] --open-logs：日志目录不存在时 exit 3（不启动资源管理器）', async (t) => {
  const { root } = await makeInstalled(t, 'cli-openlogs');
  fs.rmSync(path.join(root, 'logs'), { recursive: true, force: true });
  const res = await runMaintenanceCli(['--install-root', root, '--open-logs']);
  assert.equal(res.status, 3, `日志目录缺失应 exit 3，实际 ${res.status}: ${res.stderr}`);
  assert.match(res.stderr, /日志目录不存在/);
});
