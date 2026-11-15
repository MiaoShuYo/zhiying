/**
 * #106 维护（§2.8 maintenance.ts）：诊断覆盖/状态分类、修复计划、升级备份与保留、
 * 卸载默认保留/显式清理/安全边界、未完成下载处理、版本分别记录、安装文档。
 * 使用真实安装目录与真实文件系统；外部进程用哨兵验证不被误杀。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempRoot, cleanupRegisteredTempDirs, REPO_ROOT } from './_helpers/temp';
import { createPayloadTree, makeInstallConfig, makeManifest, makeHttpEntry } from './_helpers/fixtures';
import type { ModelManifestEntryLike } from './_helpers/fixtures';
import { deterministicBytes, sha256Buffer, writeFileDeep, writeJson, listTree, createJunction } from './_helpers/fsx';
import { startExternalProcess, killTree, isAlive } from './_helpers/processes';
import { startSimpleServer } from './_helpers/ports';
import {
  runDiagnostics,
  planRepairs,
  upgradeInstall,
  planUninstall,
  uninstall,
} from '../src/maintenance';
import type { DiagnosticReport } from '../src/maintenance';
import { executeInstall, planInstall } from '../src/installer';
import { loadInstallConfig, resolveInstallLayout, writeInstallConfig, writeJsonAtomic } from '../src/install-layout';

interface Installed {
  root: string;
  layout: ReturnType<typeof resolveInstallLayout>;
  config: ReturnType<typeof makeInstallConfig>;
  payload: string;
}

async function makeInstalled(t: test.TestContext, label: string, version = '1.8.0'): Promise<Installed> {
  const base = makeTempRoot(label);
  t.after(() => cleanupRegisteredTempDirs());
  const payload = path.join(base, 'payload');
  await createPayloadTree(payload, { version });
  const root = path.join(base, 'install');
  const plan = await planInstall({ payloadRoot: payload, targetRoot: root, version, profile: 'lite' });
  const result = await executeInstall(plan, { createShortcut: async () => undefined, writeRegistry: async () => undefined });
  assert.equal(result.ok, true, `fixture 安装失败: ${result.errors.join('|')}`);
  const layout = resolveInstallLayout(root);
  const config = await loadInstallConfig(root);
  return { root, layout, config, payload };
}

/** 写入 manifest + 已安装模型文件 + 可选 state。 */
async function writeModels(
  installed: Installed,
  entries: Array<{ entry: ModelManifestEntryLike; contents: Map<string, Buffer> }>,
  options: { install?: boolean; state?: Record<string, unknown> } = {},
): Promise<void> {
  const manifest = makeManifest(entries.map((e) => e.entry));
  await writeFileDeep(path.join(installed.layout.installRoot, installed.config.modelManifest), JSON.stringify(manifest, null, 2));
  if (options.install !== false) {
    for (const { entry, contents } of entries) {
      for (const [rel, data] of contents) {
        await writeFileDeep(path.join(installed.layout.modelsRoot, entry.installDir, rel), data);
      }
    }
  }
  if (options.state) await writeJson(installed.layout.modelStatePath, options.state);
}

function makeModel(id: string, size = 4096, overrides: Partial<ModelManifestEntryLike> = {}): { entry: ModelManifestEntryLike; contents: Map<string, Buffer> } {
  const data = deterministicBytes(size, id);
  const { entry, contents } = makeHttpEntry({
    id,
    name: `模型 ${id}`,
    purpose: 'tts',
    files: [{ path: 'model.bin', data }],
    baseUrl: 'http://fixture.invalid/dl',
  });
  return { entry: { ...entry, ...overrides }, contents };
}

function findSensitiveKeys(value: unknown, prefix = ''): string[] {
  const sensitive = /^(token|access_?token|refresh_?token|password|passwd|secret|api_?key|credential|authorization|cookie)$/i;
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...findSensitiveKeys(item, `${prefix}[${index}]`)));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (sensitive.test(key)) found.push(prefix ? `${prefix}.${key}` : key);
      found.push(...findSensitiveKeys(child, prefix ? `${prefix}.${key}` : key));
    }
  }
  return found;
}

test('[#106-1] 诊断报告：配置/版本/运行时/模型/磁盘/数据目录/未完成下载覆盖完整，状态分类正确，无凭据', async (t) => {
  const installed = await makeInstalled(t, 'maint-diag');
  const model = makeModel('alpha');
  await writeModels(installed, [model], { state: { schemaVersion: 1, models: { alpha: { id: 'alpha', status: 'installed', receivedBytes: 4096, totalBytes: 4096, files: [], partialKept: false, verified: 'sha256' } } } });
  // 一个 paused 未完成任务
  await writeJson(installed.layout.modelStatePath, {
    schemaVersion: 1,
    models: {
      alpha: { id: 'alpha', status: 'installed', receivedBytes: 4096, totalBytes: 4096, files: [], partialKept: false },
      beta: { id: 'beta', status: 'paused', receivedBytes: 100, totalBytes: 200, files: [], partialKept: true },
    },
  });
  const report = await runDiagnostics({ installRoot: installed.root, probeServices: false, deps: { diskFreeBytes: async () => 20 * 1024 * 1024 * 1024 } });
  assert.equal(report.version, '1.8.0');
  assert.equal(path.resolve(report.installRoot).toLowerCase(), path.resolve(installed.root).toLowerCase());
  assert.ok(!Number.isNaN(Date.parse(report.generatedAt)));
  const ids = report.checks.map((c) => c.id);
  for (const required of ['install-config', 'program-version', 'runtime-node', 'model-manifest', 'model:alpha', 'downloads-unfinished', 'disk-space', 'data-writable']) {
    assert.ok(ids.includes(required), `诊断缺少检查项 ${required}: ${ids.join(',')}`);
  }
  assert.equal(new Set(ids).size, ids.length, '诊断检查项 id 必须唯一');
  for (const check of report.checks) {
    assert.ok(['ok', 'warn', 'fail', 'missing', 'corrupted', 'unknown'].includes(check.status), `非法状态 ${check.status}`);
    assert.ok(check.label.trim().length > 0 && check.detail.trim().length > 0, `检查项 ${check.id} 文案不完整`);
  }
  assert.equal(ids.filter((id) => id.startsWith('model:')).length, 1, '应只报告清单中的模型');
  const modelCheck = report.checks.find((c) => c.id === 'model:alpha')!;
  assert.equal(modelCheck.status, 'ok', `已安装模型状态错误: ${JSON.stringify(modelCheck)}`);
  const unfinished = report.checks.find((c) => c.id === 'downloads-unfinished')!;
  assert.equal(unfinished.status, 'warn');
  assert.ok(unfinished.detail.includes('beta'), `未完成任务未列出 beta: ${unfinished.detail}`);
  assert.equal(report.checks.find((c) => c.id === 'disk-space')?.status, 'ok');
  const disk = report.checks.find((c) => c.id === 'disk-space')!;
  assert.match(disk.detail, /GB|MB/);
  // summary 与 checks 一致
  const okCount = report.checks.filter((c) => c.status === 'ok').length;
  const failCount = report.checks.filter((c) => c.status === 'fail').length;
  assert.deepEqual(report.summary, { ok: okCount, warn: report.checks.length - okCount - failCount, fail: failCount });
  assert.deepEqual(findSensitiveKeys(report), [], '诊断报告含敏感字段');
});

test('[#106-3] 缺失/损坏模型诊断与修复动作（download_models / verify_models）准确', async (t) => {
  const installed = await makeInstalled(t, 'maint-models');
  const healthy = makeModel('healthy');
  const missing = makeModel('missing');
  const corrupt = makeModel('corrupt');
  const corruptData = Buffer.from('short');
  await writeModels(installed, [
    healthy,
    missing,
    { entry: corrupt.entry, contents: new Map([['model.bin', corruptData]]) },
  ], { install: false });
  // 只安装 healthy
  for (const [rel, data] of healthy.contents) await writeFileDeep(path.join(installed.layout.modelsRoot, healthy.entry.installDir, rel), data);
  // corrupt：同大小但内容错误（大小校验通过、哈希不符）
  await writeFileDeep(path.join(installed.layout.modelsRoot, corrupt.entry.installDir, 'model.bin'), deterministicBytes(4096, 'tampered'));
  const report = await runDiagnostics({ installRoot: installed.root, probeServices: false, probeModels: true, deps: { diskFreeBytes: async () => 10 * 1024 * 1024 * 1024 } });
  assert.equal(report.checks.find((c) => c.id === 'model:healthy')?.status, 'ok');
  assert.equal(report.checks.find((c) => c.id === 'model:missing')?.status, 'missing');
  assert.equal(report.checks.find((c) => c.id === 'model:corrupt')?.status, 'corrupted');
  const corruptCheck = report.checks.find((c) => c.id === 'model:corrupt')!;
  assert.ok(corruptCheck.fix && corruptCheck.fix.length > 0, '损坏模型必须给出修复建议');

  const { actions } = planRepairs(report);
  const download = actions.find((a) => a.kind === 'download_models');
  const verify = actions.find((a) => a.kind === 'verify_models');
  assert.ok(download, `缺少 download_models 动作: ${JSON.stringify(actions)}`);
  assert.ok(download!.modelIds?.includes('missing'), 'download_models 未包含缺失模型');
  assert.ok(!download!.modelIds?.includes('healthy'), 'download_models 不得包含已校验模型');
  assert.ok(verify, '缺少 verify_models 动作');
  assert.deepEqual(verify!.modelIds, ['corrupt']);
  // 只给建议，不自动下载（无网络副作用）
  assert.ok(actions.every((a) => typeof a.description === 'string' && a.description.length > 0));
  void sha256Buffer;
});

test('[#106-4] 运行时缺失诊断：可读 detail/fix，不崩溃（lite/full 场景）', async (t) => {
  const installed = await makeInstalled(t, 'maint-runtime');
  // 伪造 full profile 且 runtime 缺失
  const config = await loadInstallConfig(installed.root);
  config.payloadProfile = 'full';
  config.runtime = { node: 'runtime\\node\\node.exe', python: 'runtime\\python\\python.exe', ffmpegDir: 'runtime\\ffmpeg', ollama: 'runtime\\ollama\\ollama.exe' };
  await writeInstallConfig(config);
  fs.rmSync(path.join(installed.root, 'runtime', 'python'), { recursive: true, force: true });
  fs.rmSync(path.join(installed.root, 'runtime', 'ffmpeg'), { recursive: true, force: true });
  const report = await runDiagnostics({ installRoot: installed.root, probeServices: false, deps: { diskFreeBytes: async () => 10 * 1024 * 1024 * 1024 } });
  const pythonCheck = report.checks.find((c) => c.id === 'runtime-python');
  const ffmpegCheck = report.checks.find((c) => c.id === 'runtime-ffmpeg');
  assert.ok(pythonCheck && pythonCheck.status === 'missing', `缺少 Python 运行时未被诊断: ${JSON.stringify(pythonCheck)}`);
  assert.ok(ffmpegCheck && ffmpegCheck.status === 'missing', `缺少 FFmpeg 未被诊断: ${JSON.stringify(ffmpegCheck)}`);
  for (const check of [pythonCheck!, ffmpegCheck!]) {
    assert.ok(check.fix && /安装|修复|runtime|FFmpeg/i.test(check.fix), `运行时缺失 fix 不可读: ${check.fix}`);
  }
  const { actions } = planRepairs(report);
  assert.ok(actions.some((a) => a.kind === 'repair_install'), '运行时缺失应建议修复安装');
});

test('[#106-1] 端口占用/服务状态诊断：监听端口报告 ok，未监听报告 warn 与修复路径', async (t) => {
  const installed = await makeInstalled(t, 'maint-port');
  const server = await startSimpleServer();
  t.after(() => server.close());
  const config = await loadInstallConfig(installed.root);
  config.ports = { web: server.port, python: (await import('./_helpers/ports')).getFreePort ? await (await import('./_helpers/ports')).getFreePort() : 0, ollama: 0, manager: 0 } as never;
  // 使用 4 个有效端口，避免 0 端口导致 inspectPort 异常
  const { getFreePorts } = await import('./_helpers/ports');
  const [pythonFree, ollamaFree, managerFree] = await getFreePorts(3);
  config.ports = { web: server.port, python: pythonFree, ollama: ollamaFree, manager: managerFree };
  await writeInstallConfig(config);
  const report = await runDiagnostics({ installRoot: installed.root, deps: { diskFreeBytes: async () => 10 * 1024 * 1024 * 1024 } });
  const web = report.checks.find((c) => c.id === 'service-web')!;
  assert.equal(web.status, 'ok', `占用端口应报告 ok: ${JSON.stringify(web)}`);
  const pythonCheck = report.checks.find((c) => c.id === 'service-python')!;
  assert.equal(pythonCheck.status, 'warn', `未监听服务应报告 warn: ${JSON.stringify(pythonCheck)}`);
  assert.ok(pythonCheck.fix && /启动|日志|Zhiying/.test(pythonCheck.fix), `未监听服务缺少修复路径: ${pythonCheck.fix}`);
});

test('[#106-5] planRepairs 只生成建议动作，不偷偷下载/修改系统环境（无副作用）', async (t) => {
  const installed = await makeInstalled(t, 'maint-plan');
  const model = makeModel('missing-model');
  await writeModels(installed, [model], { install: false });
  const config = await loadInstallConfig(installed.root);
  const before = await listTree(installed.root);
  const report = await runDiagnostics({ installRoot: installed.root, probeServices: false, deps: { diskFreeBytes: async () => 10 * 1024 * 1024 * 1024 } });
  const { actions } = planRepairs(report);
  assert.ok(actions.length > 0);
  assert.ok(actions.every((a) => ['download_models', 'verify_models', 'restart_services', 'open_logs', 'repair_install'].includes(a.kind)));
  // 计划阶段不得写盘/改配置
  const after = await listTree(installed.root);
  assert.deepEqual(after, before, 'planRepairs 不得产生文件副作用');
  const configAfter = await loadInstallConfig(installed.root);
  assert.deepEqual(configAfter, config, 'planRepairs 不得修改 install.json');
  // 系统环境变量不变（无 setx/注册表）
  const envBefore = JSON.stringify(process.env);
  planRepairs(report);
  assert.equal(JSON.stringify(process.env), envBefore);
});

test('[#106-6/#106-7] 模型修复只针对缺失/损坏；模型移除展示空间/路径、需确认', async (t) => {
  const installed = await makeInstalled(t, 'maint-repair');
  const healthy = makeModel('ok-model');
  const missing = makeModel('missing');
  await writeModels(installed, [healthy, missing], { install: false });
  for (const [rel, data] of healthy.contents) await writeFileDeep(path.join(installed.layout.modelsRoot, healthy.entry.installDir, rel), data);
  const report = await runDiagnostics({ installRoot: installed.root, probeServices: false, deps: { diskFreeBytes: async () => 10 * 1024 * 1024 * 1024 } });
  const { actions } = planRepairs(report);
  const downloadIds = actions.filter((a) => a.kind === 'download_models').flatMap((a) => a.modelIds ?? []);
  assert.deepEqual(downloadIds, ['missing'], '只应修复缺失模型，保留已校验模型');
  const healthyFile = path.join(installed.layout.modelsRoot, healthy.entry.installDir, 'model.bin');
  const healthyHash = sha256Buffer(fs.readFileSync(healthyFile));
  assert.ok(healthyHash.length === 64);

  // 模型移除计划：显示空间/路径，需确认；不触碰外部 Ollama/HF 缓存
  const plan = await planUninstall({ installRoot: installed.root, purgeModels: true });
  const modelsTarget = plan.targets.find((target) => target.kind === 'models');
  assert.ok(modelsTarget, 'purgeModels 计划必须包含 models 目标');
  assert.equal(path.resolve(modelsTarget!.path).toLowerCase(), path.resolve(installed.layout.modelsRoot).toLowerCase());
  assert.ok(modelsTarget!.bytes > 0, '模型移除计划必须显示占用字节');
  assert.ok(plan.preserved.some((p) => p.toLowerCase().endsWith('data')), 'purgeModels 应保留 data');
  const unconfirmed = await uninstall({ installRoot: installed.root, purgeModels: true, confirm: false, dryRun: false, deps: { removeTree: async () => undefined, removeRegistry: async () => undefined, removeShortcut: async () => undefined } });
  assert.equal(unconfirmed.ok, false, '未确认不得删除模型');
  assert.match(unconfirmed.errors.join('|'), /确认|--yes|confirm/i);
  assert.ok(fs.existsSync(healthyFile), '未确认时模型文件必须保留');
});

test('[#106-8/#106-11] 升级 v1→v2：数据/SQLite/模型保留、install.json 更新、备份、程序与模型版本分别记录', async (t) => {
  const installed = await makeInstalled(t, 'maint-upgrade', '1.8.0');
  // 用户数据与模型哨兵
  const sentinels = {
    'data/m2v.db': 'sqlite-db-bytes',
    'data/projects/p1.json': '{"id":"p1"}',
    'data/audio/a.wav': 'audio-bytes',
    'models/f5-tts/F5TTS_v1_Base/model_1250000.safetensors': 'weights',
    'logs/user.log': 'log-line',
  };
  for (const [rel, content] of Object.entries(sentinels)) await writeFileDeep(path.join(installed.root, rel), content);
  await writeJson(installed.layout.modelStatePath, { schemaVersion: 1, models: { qwen3: { id: 'qwen3', status: 'installed', receivedBytes: 10, totalBytes: 10, files: [], partialKept: false } } });
  const modelWeightsPath = path.join(installed.root, 'models', 'f5-tts', 'F5TTS_v1_Base', 'model_1250000.safetensors');
  const modelFileBefore = sha256Buffer(fs.readFileSync(modelWeightsPath));
  const stateBefore = fs.readFileSync(installed.layout.modelStatePath, 'utf8');
  const configBefore = await loadInstallConfig(installed.root);
  // v2 payload
  const v2base = makeTempRoot('maint-upgrade-v2');
  const payloadV2 = path.join(v2base, 'payload');
  await createPayloadTree(payloadV2, { version: '1.8.1' });
  const result = await upgradeInstall({ installRoot: installed.root, payloadRoot: payloadV2, version: '1.8.1' });
  assert.equal(result.ok, true, `升级失败: ${result.errors.join('|')}`);
  assert.equal(result.fromVersion, '1.8.0');
  assert.equal(result.toVersion, '1.8.1');
  assert.deepEqual(result.preserved, ['models', 'data', 'logs', 'config']);
  // 用户数据保留
  for (const [rel, content] of Object.entries(sentinels)) {
    const file = path.join(installed.root, rel);
    assert.ok(fs.existsSync(file), `升级后丢失用户文件: ${rel}`);
    assert.equal(fs.readFileSync(file, 'utf8'), content, `升级后用户文件被改写: ${rel}`);
  }
  // 模型不被强制重下
  assert.equal(fs.readFileSync(installed.layout.modelStatePath, 'utf8'), stateBefore, '升级不得重置模型下载状态');
  assert.equal(sha256Buffer(fs.readFileSync(modelWeightsPath)), modelFileBefore);
  // install.json 更新且保留用户字段
  const configAfter = await loadInstallConfig(installed.root);
  assert.equal(configAfter.version, '1.8.1');
  assert.equal(configAfter.installedAt, configBefore.installedAt);
  assert.deepEqual(configAfter.ports, configBefore.ports);
  assert.ok(configAfter.updatedAt);
  // 备份 install.json + SQLite
  assert.ok(result.backupPath && fs.existsSync(result.backupPath), '缺少升级备份目录');
  assert.ok(fs.existsSync(path.join(result.backupPath!, 'install.json')), '备份缺少 install.json');
  assert.equal(fs.readFileSync(path.join(result.backupPath!, 'm2v.db'), 'utf8'), 'sqlite-db-bytes', '备份缺少 m2v.db');
  // 程序与模型版本分别记录
  const versions = JSON.parse(fs.readFileSync(path.join(installed.layout.data, 'runtime', 'versions.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(versions.programVersion, '1.8.1');
  assert.equal(versions.previousProgramVersion, '1.8.0');
  assert.ok(typeof versions.modelManifestVersion === 'string' && (versions.modelManifestVersion as string).length > 0, '缺少模型清单版本记录');
  // 升级日志
  const upgradeLogs = fs.readdirSync(installed.layout.logs).filter((name) => name.startsWith('upgrade-'));
  assert.ok(upgradeLogs.length > 0, '缺少升级日志');
});

test('[#106-9] 服务运行时升级被安全拒绝，不损坏 DB', async (t) => {
  const installed = await makeInstalled(t, 'maint-busy');
  await writeFileDeep(path.join(installed.root, 'data', 'm2v.db'), 'db-before');
  await writeJsonAtomic(installed.layout.serviceStatePath, {
    instanceId: 'running-instance',
    startedAt: new Date().toISOString(),
    installRoot: installed.root,
    version: '1.8.0',
    services: [{ id: 'web', pid: process.pid, startedAtMs: Date.now(), commandLine: `${process.execPath} --m2v-instance=running-instance`, logFile: '' }],
  });
  const v2base = makeTempRoot('maint-busy-v2');
  const payloadV2 = path.join(v2base, 'payload');
  await createPayloadTree(payloadV2, { version: '1.8.1' });
  const result = await upgradeInstall({ installRoot: installed.root, payloadRoot: payloadV2, version: '1.8.1' });
  assert.equal(result.ok, false, '服务运行中升级必须被拒绝');
  assert.match(result.errors.join('|'), /正在运行|先.*stop|停止/i, `拒绝原因不可读: ${result.errors.join('|')}`);
  assert.equal(fs.readFileSync(path.join(installed.root, 'data', 'm2v.db'), 'utf8'), 'db-before', '拒绝升级不得改动 DB');
  assert.equal((await loadInstallConfig(installed.root)).version, '1.8.0', '拒绝升级不得修改版本');
});

test('[#106-10] 升级失败回滚：保留可用安装；离线升级可行（无网络依赖）', async (t) => {
  const installed = await makeInstalled(t, 'maint-rollback', '1.8.0');
  await writeFileDeep(path.join(installed.root, 'app', 'desktop', 'old-marker.txt'), 'old-app');
  const v2base = makeTempRoot('maint-rollback-v2');
  const payloadV2 = path.join(v2base, 'payload');
  await createPayloadTree(payloadV2, { version: '1.8.1' });
  let copies = 0;
  const result = await upgradeInstall({
    installRoot: installed.root,
    payloadRoot: payloadV2,
    version: '1.8.1',
    deps: {
      copyTree: async (from: string, to: string) => {
        copies += 1;
        if (copies >= 2) throw new Error('EIO: simulated upgrade copy failure');
        await fs.promises.cp(from, to, { recursive: true, force: true });
      },
    },
  });
  assert.equal(result.ok, false, '升级失败必须返回 ok=false');
  assert.ok(result.errors.length > 0 && result.errors[0].trim().length > 0);
  // 原安装仍可用
  const config = await loadInstallConfig(installed.root);
  assert.equal(config.version, '1.8.0', '失败后版本不得变化');
  assert.ok(fs.existsSync(path.join(installed.root, 'app', 'desktop', 'old-marker.txt')), '失败后旧程序文件必须保留');
  const leftovers = fs.readdirSync(installed.root).filter((name) => /^\.(upgrade|old)-/.test(name));
  assert.deepEqual(leftovers, [], `失败后残留临时目录: ${leftovers.join(',')}`);
  // 升级日志记录失败
  const logs = fs.readdirSync(installed.layout.logs).filter((name) => name.startsWith('upgrade-'));
  assert.ok(logs.length > 0 && fs.readFileSync(path.join(installed.layout.logs, logs[0]), 'utf8').includes('失败'), '失败日志缺失');
  // dry-run 不修改任何东西
  const dry = await upgradeInstall({ installRoot: installed.root, payloadRoot: payloadV2, version: '1.8.1', dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal((await loadInstallConfig(installed.root)).version, '1.8.0');
});

test('[#106-12] 卸载默认只移除程序：保留 models/data/logs/config，ok=true', async (t) => {
  const installed = await makeInstalled(t, 'maint-uninstall');
  await writeFileDeep(path.join(installed.layout.modelsRoot, 'keep.bin'), 'model');
  await writeFileDeep(path.join(installed.layout.data, 'projects', 'p.json'), 'project');
  await writeFileDeep(path.join(installed.layout.logs, 'keep.log'), 'log');
  await writeFileDeep(path.join(installed.layout.config, 'custom.txt'), 'config');
  let registryRemoved = 0;
  let shortcutRemoved = 0;
  const result = await uninstall({
    installRoot: installed.root,
    confirm: true,
    deps: {
      removeTree: async (target: string) => fs.promises.rm(target, { recursive: true, force: true }),
      removeRegistry: async () => {
        registryRemoved += 1;
      },
      removeShortcut: async () => {
        shortcutRemoved += 1;
      },
    },
  });
  assert.equal(result.ok, true, `默认卸载失败: ${result.errors.join('|')}`);
  for (const rel of ['Zhiying.exe', 'app', 'runtime']) assert.ok(!fs.existsSync(path.join(installed.root, rel)), `默认卸载未删除程序文件 ${rel}`);
  for (const rel of ['models/keep.bin', 'data/projects/p.json', 'logs/keep.log', 'config/custom.txt', 'config/install.json']) {
    assert.ok(fs.existsSync(path.join(installed.root, rel)), `默认卸载误删用户数据 ${rel}`);
  }
  assert.equal(registryRemoved, 1);
  assert.equal(shortcutRemoved, 1);
  // 卸载日志保留
  assert.ok(fs.readdirSync(installed.layout.logs).some((name) => name.startsWith('uninstall-')), '缺少卸载日志');
});

test('[#106-13] purge-data/purge-models：需显式 confirm；dry-run 只列路径与字节；只删选定目标', async (t) => {
  const a = await makeInstalled(t, 'maint-purge-a');
  await writeFileDeep(path.join(a.layout.modelsRoot, 'm.bin'), 'model');
  await writeFileDeep(path.join(a.layout.data, 'projects', 'p.json'), 'project');
  // dry-run：不删除
  const dry = await uninstall({ installRoot: a.root, purgeData: true, purgeModels: true, confirm: true, dryRun: true, deps: { removeTree: async () => undefined, removeRegistry: async () => undefined, removeShortcut: async () => undefined } });
  assert.equal(dry.ok, true, dry.errors.join('|'));
  assert.ok(dry.plan.targets.some((target) => target.kind === 'data'));
  assert.ok(dry.plan.targets.some((target) => target.kind === 'models'));
  assert.ok(dry.plan.targets.every((target) => target.bytes >= 0));
  assert.ok(fs.existsSync(path.join(a.root, 'data', 'projects', 'p.json')), 'dry-run 不得删除数据');
  assert.ok(fs.existsSync(path.join(a.layout.modelsRoot, 'm.bin')), 'dry-run 不得删除模型');
  // 未 confirm：拒绝
  const denied = await uninstall({ installRoot: a.root, purgeData: true, confirm: false, deps: { removeTree: async () => undefined, removeRegistry: async () => undefined, removeShortcut: async () => undefined } });
  assert.equal(denied.ok, false);
  assert.ok(fs.existsSync(path.join(a.root, 'data', 'projects', 'p.json')));
  // 只 purge-data：只删 data，保留 models
  const purged = await uninstall({ installRoot: a.root, purgeData: true, confirm: true, deps: { removeTree: async (target) => fs.promises.rm(target, { recursive: true, force: true }), removeRegistry: async () => undefined, removeShortcut: async () => undefined } });
  assert.equal(purged.ok, true, purged.errors.join('|'));
  assert.ok(!fs.existsSync(path.join(a.root, 'data', 'projects', 'p.json')), 'purge-data 未删除用户数据');
  assert.ok(fs.existsSync(path.join(a.layout.modelsRoot, 'm.bin')), 'purge-data 不得删除模型');
  // 另一个 root 只 purge-models
  const b = await makeInstalled(t, 'maint-purge-b');
  await writeFileDeep(path.join(b.layout.modelsRoot, 'm.bin'), 'model');
  await writeFileDeep(path.join(b.layout.data, 'projects', 'p.json'), 'project');
  const purgeModels = await uninstall({ installRoot: b.root, purgeModels: true, confirm: true, deps: { removeTree: async (target) => fs.promises.rm(target, { recursive: true, force: true }), removeRegistry: async () => undefined, removeShortcut: async () => undefined } });
  assert.equal(purgeModels.ok, true, purgeModels.errors.join('|'));
  assert.ok(!fs.existsSync(path.join(b.layout.modelsRoot, 'm.bin')), 'purge-models 未删除模型');
  assert.ok(fs.existsSync(path.join(b.layout.data, 'projects', 'p.json')), 'purge-models 不得删除用户数据');
});

test('[#106-14] 卸载安全：不删 installRoot 外、不跟随 reparse 删外部目标、无关用户数据完好', async (t) => {
  const installed = await makeInstalled(t, 'maint-safe');
  const outside = makeTempRoot('maint-safe-outside');
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'must-survive');
  fs.mkdirSync(path.join(installed.layout.data, 'external-link-parent'), { recursive: true });
  // data 内 junction 指向外部（reparse）
  createJunction(path.join(installed.layout.data, 'escape'), outside);
  // installRoot 外的另一目录（不得被删）
  const sibling = makeTempRoot('maint-safe-sibling');
  fs.writeFileSync(path.join(sibling, 'sibling.txt'), 'sibling-data');
  const result = await uninstall({
    installRoot: installed.root,
    purgeData: true,
    confirm: true,
    deps: {
      removeTree: async (target: string) => fs.promises.rm(target, { recursive: true, force: true }),
      removeRegistry: async () => undefined,
      removeShortcut: async () => undefined,
    },
  });
  assert.equal(fs.existsSync(path.join(outside, 'precious.txt')), true, '卸载跟随 junction 删除了外部目标（安全缺陷）');
  assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'must-survive');
  assert.ok(fs.existsSync(path.join(sibling, 'sibling.txt')), '卸载删除了 installRoot 外的无关目录');
  assert.ok(isPathInside(installed.root, installed.root) && !installed.root.endsWith(path.sep));
  void result;

  function isPathInside(parent: string, child: string): boolean {
    const p = path.resolve(parent).toLowerCase();
    const c = path.resolve(child).toLowerCase();
    return c === p || c.startsWith(p + path.sep);
  }
});

test('[#106-15] 卸载处理未完成下载（标记 paused）、不杀外部 ollama、保留日志', async (t) => {
  const installed = await makeInstalled(t, 'maint-unfinished');
  await writeJson(installed.layout.modelStatePath, {
    schemaVersion: 1,
    models: { qwen: { id: 'qwen', status: 'downloading', receivedBytes: 1024, totalBytes: 4096, files: [], partialKept: true } },
  });
  const external = startExternalProcess(`ollama-${Date.now()}`);
  t.after(() => external.stop());
  let removeRegistryCalls = 0;
  const result = await uninstall({
    installRoot: installed.root,
    confirm: true,
    deps: {
      removeTree: async (target: string) => fs.promises.rm(target, { recursive: true, force: true }),
      removeRegistry: async () => {
        removeRegistryCalls += 1;
      },
      removeShortcut: async () => undefined,
    },
  });
  assert.equal(result.ok, true, result.errors.join('|'));
  assert.equal(removeRegistryCalls, 1);
  assert.ok(isAlive(external.pid), '卸载不得结束外部 Ollama/无关进程');
  assert.ok(fs.existsSync(installed.layout.modelStatePath), '默认卸载应保留下载状态文件');
  const state = JSON.parse(fs.readFileSync(installed.layout.modelStatePath, 'utf8')) as { models: Record<string, { status: string }> };
  assert.equal(state.models.qwen.status, 'paused', '未完成下载应被安全标记为 paused');
  assert.ok(fs.readdirSync(installed.layout.logs).some((name) => name.startsWith('uninstall-')), '卸载日志必须保留');
});

test('[#106-16] 卸载后重装可复用保留模型（不强制重下）', async (t) => {
  const installed = await makeInstalled(t, 'maint-reuse');
  const model = makeModel('reuse-model');
  await writeModels(installed, [model], { state: { schemaVersion: 1, models: { 'reuse-model': { id: 'reuse-model', status: 'installed', receivedBytes: 4096, totalBytes: 4096, files: [], partialKept: false } } } });
  const modelFile = path.join(installed.layout.modelsRoot, model.entry.installDir, 'model.bin');
  const hash = sha256Buffer(fs.readFileSync(modelFile));
  // 默认卸载
  await uninstall({ installRoot: installed.root, confirm: true, deps: { removeTree: async (target) => fs.promises.rm(target, { recursive: true, force: true }), removeRegistry: async () => undefined, removeShortcut: async () => undefined } });
  assert.ok(fs.existsSync(modelFile), '卸载后保留的模型文件不见了');
  // 重装（同 payload）
  const plan = await planInstall({ payloadRoot: installed.payload, targetRoot: installed.root, version: '1.8.0', profile: 'lite' });
  const result = await executeInstall(plan, { createShortcut: async () => undefined, writeRegistry: async () => undefined });
  assert.equal(result.ok, true, result.errors.join('|'));
  assert.equal(sha256Buffer(fs.readFileSync(modelFile)), hash, '重装后模型文件被改写');
  // 诊断识别为已安装，修复计划不要求重下
  const report = await runDiagnostics({ installRoot: installed.root, probeServices: false, deps: { diskFreeBytes: async () => 10 * 1024 * 1024 * 1024 } });
  assert.equal(report.checks.find((c) => c.id === 'model:reuse-model')?.status, 'ok');
  const { actions } = planRepairs(report);
  const downloadIds = actions.filter((a) => a.kind === 'download_models').flatMap((a) => a.modelIds ?? []);
  assert.ok(!downloadIds.includes('reuse-model'), '已校验模型不得要求重新下载');
});

test('[#106-17] 安装文档存在且包含安装/系统需求/模型与许可/离线/修复卸载/SHA-256', async () => {
  const docPath = path.join(REPO_ROOT, 'doc', 'V1.8.0_install.md');
  assert.ok(fs.existsSync(docPath), `缺少安装文档: ${docPath}`);
  const doc = fs.readFileSync(docPath, 'utf8');
  assert.match(doc, /系统要求|系统需求/, '安装文档缺少系统要求章节');
  for (const keyword of ['安装', '模型', '许可', '离线', '修复', '卸载', 'SHA-256']) {
    assert.ok(doc.includes(keyword), `安装文档缺少关键字: ${keyword}`);
  }
  assert.match(doc, /1\.8\.0/, '安装文档未写明版本');
});
