/**
 * #105-3..16/21/22 + #104-15/16 模型下载器行为测试（§2.5）。
 * 真实 HTTP fixture 源（Content-Length/Range/429/5xx/无 CL/中断/慢速）+ 真实文件系统；
 * 只注入契约允许的边界（fetchImpl/spawnImpl/diskFreeBytes/hashFile），不 mock 被测模块。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeTempRoot, cleanupRegisteredTempDirs, TMP_ROOT } from './_helpers/temp';
import { FixtureModelSource } from './_helpers/http-source';
import type { FixtureSourceServer } from './_helpers/http-source';
import type { SourceMode } from './_helpers/http-source';
import { makeManifest, makeHttpEntry, installModelFiles, modelFileSha } from './_helpers/fixtures';
import type { ModelManifestEntryLike } from './_helpers/fixtures';
import { sha256Buffer, deterministicBytes, writeFileDeep, readJson, listTree } from './_helpers/fsx';
import { snapshotEnv, diffEnv } from './_helpers/env';
import { killTree, readJsonLines } from './_helpers/processes';
import { resolveInstallLayout } from '../src/install-layout';
import { createModelDirectoryResolver } from '../src/model-paths';
import { ModelDownloadManager } from '../src/downloader';

type ManagerOptions = ConstructorParameters<typeof ModelDownloadManager>[0];

interface FileDef {
  path: string;
  data: Buffer;
  mode?: SourceMode;
  failCount?: number;
  chunkDelayMs?: number;
  chunkSize?: number;
}

interface ModelDef {
  id: string;
  files: FileDef[];
  installDir?: string;
  integrity?: 'sha256' | 'size' | 'ollama-digest';
  /** 覆盖声明哈希（用于损坏/篡改测试） */
  declaredShaOverrides?: Record<string, string>;
  declaredSizeOverrides?: Record<string, number>;
  license?: ModelManifestEntryLike['license'];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | Promise<T>, label: string, timeoutMs = 30_000, intervalMs = 25): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timeout: ${label}${last instanceof Error ? `: ${last.message}` : ''}`);
}

interface Harness {
  root: string;
  modelsRoot: string;
  downloads: string;
  statePath: string;
  resolver: ReturnType<typeof createModelDirectoryResolver>;
  source: FixtureModelSource;
  sourceServer: FixtureSourceServer;
  serverUrl: string;
  manifest: ReturnType<typeof makeManifest>;
  addModel: (def: ModelDef) => ModelManifestEntryLike;
  makeManager: (options?: Partial<ManagerOptions>) => ModelDownloadManager;
  close: () => Promise<void>;
}

async function createHarness(t: test.TestContext): Promise<Harness> {
  const root = makeTempRoot('dl');
  const layout = resolveInstallLayout(root);
  const resolver = createModelDirectoryResolver(layout);
  await resolver.ensureModelDirectories();
  const source = new FixtureModelSource();
  const server = await source.start();
  const manifest = makeManifest([]);
  const statePath = path.join(root, 'models', '.downloads', 'state.json');
  const managers: ModelDownloadManager[] = [];

  function addModel(def: ModelDef): ModelManifestEntryLike {
    const fileInputs = def.files.map((f) => ({
      path: f.path,
      data: f.data,
      sha256: def.declaredShaOverrides?.[f.path] ?? sha256Buffer(f.data),
      url: `${server.url}/dl/${def.id}/${f.path}`,
      sizeBytes: def.declaredSizeOverrides?.[f.path] ?? f.data.length,
    }));
    const { entry } = makeHttpEntry({
      id: def.id,
      files: fileInputs,
      baseUrl: `${server.url}/dl`,
      installDir: def.installDir ?? def.id,
      integrity: def.integrity ?? 'sha256',
      license: def.license,
    });
    for (const f of def.files) {
      source.addFile(`/dl/${def.id}/${f.path}`, {
        data: f.data,
        mode: f.mode ?? 'ok',
        failCount: f.failCount,
        chunkDelayMs: f.chunkDelayMs,
        chunkSize: f.chunkSize,
      });
    }
    manifest.models.push(entry);
    return entry;
  }

  function makeManager(options: Partial<ManagerOptions> = {}): ModelDownloadManager {
    const manager = new ModelDownloadManager({
      manifest: manifest as ManagerOptions['manifest'],
      resolver,
      statePath,
      ...options,
    } as ManagerOptions);
    managers.push(manager);
    return manager;
  }

  t.after(async () => {
    for (const m of managers) {
      try {
        await m.dispose();
      } catch {
        /* ignore */
      }
    }
    await server.close().catch(() => {});
    cleanupRegisteredTempDirs();
  });

  return {
    root,
    modelsRoot: path.join(root, 'models'),
    downloads: path.join(root, 'models', '.downloads'),
    statePath,
    resolver,
    source,
    sourceServer: server,
    serverUrl: server.url,
    manifest,
    addModel,
    makeManager,
    close: async () => server.close(),
  };
}

async function startSettled(manager: ModelDownloadManager, ids: string[]): Promise<void> {
  try {
    await manager.start(ids);
  } catch {
    // 失败状态通过 get()/state.json 表达；这里吞掉以保证断言针对状态机
  }
}

async function waitTerminal(manager: ModelDownloadManager, id: string, timeoutMs = 30_000): Promise<{ status: string; receivedBytes: number; error?: { code: string; message: string } }> {
  return waitFor(() => {
    const state = manager.get(id);
    if (['installed', 'failed', 'corrupted'].includes(state.status)) return state as unknown as { status: string; receivedBytes: number; error?: { code: string; message: string } };
    return null;
  }, `${id} terminal`, timeoutMs);
}

function captureProgress(manager: ModelDownloadManager): { samples: Array<Array<{ id: string; status: string; phase: string; percent?: number; receivedBytes: number; totalBytes?: number; speedBps?: number; etaSeconds?: number }>>; stop: () => void } {
  const samples: Array<Array<{ id: string; status: string; phase: string; percent?: number; receivedBytes: number; totalBytes?: number; speedBps?: number; etaSeconds?: number }>> = [];
  const stop = manager.onProgress((states) => {
    samples.push(structuredClone(states) as unknown as (typeof samples)[number]);
  });
  return { samples, stop };
}

function partFile(downloads: string, id: string, rel: string): string {
  return path.join(downloads, id, `${rel}.part`);
}

function installedFile(modelsRoot: string, installDir: string, rel: string): string {
  return path.join(modelsRoot, installDir, rel);
}

// ---------------------------------------------------------------------------
// 初始状态 / 复用 / 损坏检测
// ---------------------------------------------------------------------------

test('[#105-3] 初始状态：未安装 → not_installed；已存在完整校验文件 → installed 且不重复下载', async (t) => {
  const h = await createHarness(t);
  h.addModel({ id: 'alpha', files: [{ path: 'model.bin', data: deterministicBytes(8 * 1024, 'alpha') }] });
  const manager = h.makeManager();
  assert.equal(manager.get('alpha').status, 'not_installed');
  assert.equal(manager.list().length, 1);

  // 预置完整文件（模拟已安装）
  const entry = h.manifest.models[0];
  const data = deterministicBytes(8 * 1024, 'alpha');
  await installModelFiles(h.modelsRoot, entry.installDir, new Map([['model.bin', data]]));

  const manager2 = h.makeManager();
  await manager2.recover();
  const state = manager2.get('alpha');
  assert.equal(state.status, 'installed', `已装模型应复用为 installed，实际 ${state.status}`);
  // 不重复下载
  await startSettled(manager2, ['alpha']);
  assert.equal(h.source.requestsFor('/dl/alpha/model.bin').length, 0, '已校验模型不应再次下载');
});

test('[#104-16] 损坏检测：已存在文件哈希不符 → corrupted，不标记 installed，不破坏旧文件', async (t) => {
  const h = await createHarness(t);
  h.addModel({ id: 'corrupt-pre', files: [{ path: 'model.bin', data: deterministicBytes(4096, 'good') }] });
  const entry = h.manifest.models[0];
  await installModelFiles(h.modelsRoot, entry.installDir, new Map([['model.bin', Buffer.from('tampered-tampered-tampered')]]));

  const manager = h.makeManager();
  await manager.recover();
  const state = manager.get('corrupt-pre');
  assert.notEqual(state.status, 'installed', '损坏文件不得标记 installed');
  assert.ok(['corrupted', 'failed', 'not_installed'].includes(state.status), `损坏状态不应为 ${state.status}`);
  assert.ok(
    (state.error?.message ?? '').length > 0 || state.status === 'not_installed',
    '损坏检测应给出可读错误（或明确未安装）',
  );
});

// ---------------------------------------------------------------------------
// 进度
// ---------------------------------------------------------------------------

test('[#105-4] 真实进度：Content-Length 下载 percent/received/total/speed 真实且单调', async (t) => {
  const h = await createHarness(t);
  const data = deterministicBytes(64 * 1024, 'progress');
  h.addModel({ id: 'progress', files: [{ path: 'model.bin', data, mode: 'drip', chunkSize: 2048, chunkDelayMs: 20 }] });
  const manager = h.makeManager();
  const cap = captureProgress(manager);
  await startSettled(manager, ['progress']);
  const finalState = await waitTerminal(manager, 'progress');
  cap.stop();
  assert.equal(finalState.status, 'installed');

  const downloading = cap.samples.flat().filter((s) => s.id === 'progress' && s.status === 'downloading');
  assert.ok(downloading.length > 0, '未收到任何下载进度事件');
  const midSamples = downloading.filter((s) => s.receivedBytes > 0 && (s.totalBytes ?? 0) > s.receivedBytes);
  assert.ok(midSamples.length > 0, '未观察到中间进度（进度可能是伪造的 0/100）');
  for (const s of midSamples) {
    assert.equal(s.totalBytes, data.length, 'totalBytes 应等于真实文件长度');
    assert.ok(s.percent !== undefined && s.percent > 0 && s.percent < 100, `中间 percent 非法: ${s.percent}`);
    assert.ok(Math.abs((s.percent ?? 0) - (s.receivedBytes / data.length) * 100) < 0.5, `percent 与 bytes 不一致: ${s.percent} vs ${s.receivedBytes}/${data.length}`);
  }
  const speeds = downloading.map((s) => s.speedBps).filter((v): v is number => typeof v === 'number');
  assert.ok(speeds.some((v) => v > 0), '下载过程中应提供 speedBps > 0');
  const state = manager.get('progress');
  assert.equal(state.receivedBytes, data.length);
  assert.equal(state.percent, 100);
  assert.equal(state.verified, 'sha256');
});

test('[#105-4] computeOverall 按字节加权，不按模型数量平均', () => {
  const overall = ModelDownloadManager.computeOverall([
    { id: 'a', status: 'downloading', phase: 'download', receivedBytes: 300, totalBytes: 1000, files: [], partialKept: false },
    { id: 'b', status: 'downloading', phase: 'download', receivedBytes: 500, totalBytes: 1000, files: [], partialKept: false },
  ] as never);
  assert.equal(overall.receivedBytes, 800);
  assert.equal(overall.totalBytes, 2000);
  assert.equal(overall.percent, 40, '总体进度必须按字节加权（此处 800/2000=40%，而非 50%）');
  assert.equal(overall.indeterminate, false);

  const indeterminate = ModelDownloadManager.computeOverall([{ id: 'x', status: 'downloading', phase: 'download', receivedBytes: 100, files: [], partialKept: false }] as never);
  assert.equal(indeterminate.percent, undefined, '总大小未知时 percent 必须 undefined');
  assert.equal(indeterminate.indeterminate, true);
});

test('[#105-5] 无 Content-Length：percent=undefined 且不伪造 100%', async (t) => {
  const h = await createHarness(t);
  const data = deterministicBytes(32 * 1024, 'nocl');
  h.addModel({ id: 'nocl', files: [{ path: 'model.bin', data, mode: 'no-content-length', chunkSize: 1024, chunkDelayMs: 3 }] });
  const manager = h.makeManager();
  const cap = captureProgress(manager);
  await startSettled(manager, ['nocl']);
  const final = await waitTerminal(manager, 'nocl');
  cap.stop();
  assert.equal(final.status, 'installed', `无 CL 下载应能成功: ${JSON.stringify(final)}`);
  const downloading = cap.samples.flat().filter((s) => s.id === 'nocl' && (s.phase === 'download' || s.status === 'downloading'));
  assert.ok(downloading.length > 0);
  for (const s of downloading) {
    assert.equal(s.percent, undefined, `无 Content-Length 时 percent 必须 undefined，实际 ${s.percent}`);
    assert.equal(s.totalBytes, undefined, '无 Content-Length 时 totalBytes 应不可知');
  }
  assert.equal(manager.get('nocl').receivedBytes, data.length, 'receivedBytes 仍应累计真实字节');
});

// ---------------------------------------------------------------------------
// 暂停 / 恢复 / 取消
// ---------------------------------------------------------------------------

test('[#105-6] 暂停：传输中止、partial 保留、status=paused、字节不丢', async (t) => {
  const h = await createHarness(t);
  const data = deterministicBytes(96 * 1024, 'pausable');
  h.addModel({ id: 'pausable', files: [{ path: 'model.bin', data, mode: 'drip', chunkSize: 1024, chunkDelayMs: 10 }] });
  const manager = h.makeManager();
  const startPromise = manager.start(['pausable']).catch(() => {});
  const progressed = await waitFor(() => {
    const s = manager.get('pausable');
    return s.status === 'downloading' && s.receivedBytes > 0 ? s : null;
  }, 'download progress');
  const beforePause = progressed.receivedBytes;
  await manager.pause('pausable');
  await startPromise;
  const paused = manager.get('pausable');
  assert.equal(paused.status, 'paused');
  assert.ok(paused.receivedBytes >= beforePause, '暂停不得丢失已接收字节');
  const part = partFile(h.downloads, 'pausable', 'model.bin');
  assert.ok(fs.existsSync(part), `暂停后 partial 必须保留: ${part}`);
  assert.ok(fs.statSync(part).size > 0, 'partial 文件必须包含已接收字节');
  assert.ok(!fs.existsSync(installedFile(h.modelsRoot, 'pausable', 'model.bin')), '暂停时不得出现已安装文件');
  // 字节不继续增长
  const bytesAtPause = paused.receivedBytes;
  await sleep(250);
  assert.equal(manager.get('pausable').receivedBytes, bytesAtPause, '暂停后不应继续接收字节');
});

test('[#105-7] 恢复：Range 续传，完成后文件逐字节一致且校验通过', async (t) => {
  const h = await createHarness(t);
  const data = deterministicBytes(128 * 1024, 'resumable');
  h.addModel({ id: 'resumable', files: [{ path: 'model.bin', data, mode: 'drip', chunkSize: 2048, chunkDelayMs: 8 }] });
  const manager = h.makeManager();
  void manager.start(['resumable']).catch(() => {});
  const progressed = await waitFor(() => {
    const s = manager.get('resumable');
    return s.status === 'downloading' && s.receivedBytes > 16384 ? s : null;
  }, 'progress before pause');
  await manager.pause('resumable');
  const partialBytes = manager.get('resumable').receivedBytes;
  assert.ok(partialBytes > 0);

  await manager.resume('resumable');
  const final = await waitTerminal(manager, 'resumable');
  assert.equal(final.status, 'installed');
  const requests = h.source.requestsFor('/dl/resumable/model.bin');
  const ranged = requests.filter((r) => r.range && /bytes=\d+-/.test(r.range));
  assert.ok(ranged.length > 0, `恢复下载必须携带 Range 头，实际请求: ${JSON.stringify(requests.map((r) => r.range))}`);
  const startOffset = Number(/bytes=(\d+)-/.exec(ranged[0].range ?? '')?.[1]);
  assert.ok(startOffset > 0, `Range 起点必须 > 0（不得从 0 重下），实际 ${ranged[0].range}`);
  assert.ok(startOffset <= partialBytes, `Range 起点不得大于已接收字节: ${startOffset} > ${partialBytes}`);
  // If-Range 若存在，必须是 ETag
  for (const r of ranged) {
    if (r.ifRange) assert.match(r.ifRange, /^"?[0-9a-f]+"?$/, `If-Range 非法: ${r.ifRange}`);
  }
  const committed = installedFile(h.modelsRoot, 'resumable', 'model.bin');
  assert.ok(fs.existsSync(committed), '恢复完成后应原子提交到 models/<installDir>');
  assert.equal(sha256Buffer(fs.readFileSync(committed)), sha256Buffer(data), '最终文件必须逐字节一致');
  assert.equal(manager.get('resumable').verified, 'sha256');
  assert.ok(!fs.existsSync(partFile(h.downloads, 'resumable', 'model.bin')), '完成后不应残留 .part');
});

test('[#105-8] 取消：keepPartial 保留/清理两种语义；其他已装模型不受影响', async (t) => {
  const h = await createHarness(t);
  const keepData = deterministicBytes(64 * 1024, 'cancel-keep');
  const dropData = deterministicBytes(64 * 1024, 'cancel-drop');
  h.addModel({ id: 'cancel-keep', files: [{ path: 'model.bin', data: keepData, mode: 'drip', chunkSize: 1024, chunkDelayMs: 10 }] });
  h.addModel({ id: 'cancel-drop', files: [{ path: 'model.bin', data: dropData, mode: 'drip', chunkSize: 1024, chunkDelayMs: 10 }] });
  h.addModel({ id: 'bystander', files: [{ path: 'model.bin', data: deterministicBytes(2048, 'bystander') }] });
  // 预装 bystander（合法）
  const bystander = h.manifest.models.find((m) => m.id === 'bystander')!;
  await installModelFiles(h.modelsRoot, bystander.installDir, new Map([['model.bin', deterministicBytes(2048, 'bystander')]]));
  const manager = h.makeManager();
  await manager.recover();
  assert.equal(manager.get('bystander').status, 'installed');

  void manager.start(['cancel-keep']).catch(() => {});
  await waitFor(() => manager.get('cancel-keep').receivedBytes > 4096, 'cancel-keep progress');
  await manager.cancel('cancel-keep', { keepPartial: true });
  await sleep(150);
  const kept = manager.get('cancel-keep');
  assert.notEqual(kept.status, 'downloading', '取消后不得仍在下载');
  assert.equal(kept.partialKept, true, 'keepPartial=true 时 partialKept 必须为 true');
  assert.ok(fs.existsSync(partFile(h.downloads, 'cancel-keep', 'model.bin')), 'keepPartial=true 必须保留 .part');
  assert.ok(!fs.existsSync(installedFile(h.modelsRoot, 'cancel-keep', 'model.bin')), '取消不得提交安装文件');

  void manager.start(['cancel-drop']).catch(() => {});
  await waitFor(() => manager.get('cancel-drop').receivedBytes > 4096, 'cancel-drop progress');
  await manager.cancel('cancel-drop', { keepPartial: false });
  await sleep(150);
  const dropped = manager.get('cancel-drop');
  assert.equal(dropped.partialKept, false, 'keepPartial=false 时 partialKept 必须为 false');
  assert.ok(!fs.existsSync(partFile(h.downloads, 'cancel-drop', 'model.bin')), 'keepPartial=false 必须清理 .part');

  // 其他已装模型文件不受影响
  assert.equal(manager.get('bystander').status, 'installed');
  const bystanderFile = installedFile(h.modelsRoot, bystander.installDir, 'model.bin');
  assert.ok(fs.existsSync(bystanderFile));
  assert.equal(sha256Buffer(fs.readFileSync(bystanderFile)), sha256Buffer(deterministicBytes(2048, 'bystander')));
});

// ---------------------------------------------------------------------------
// 重试 / 断网 / 完整性 / 原子提交 / 空间 / 写盘
// ---------------------------------------------------------------------------

test('[#105-9] 429/5xx 受限退避重试；403/404 不重试且报可读错误', async (t) => {
  const h = await createHarness(t);
  const data = deterministicBytes(16 * 1024, 'retry');
  h.addModel({ id: 'retry-429', files: [{ path: 'model.bin', data, mode: '429-then-ok', failCount: 2 }] });
  const manager = h.makeManager();
  const startedAt = Date.now();
  await startSettled(manager, ['retry-429']);
  const ok = await waitTerminal(manager, 'retry-429');
  assert.equal(ok.status, 'installed', `429 后应重试成功: ${JSON.stringify(ok)}`);
  const reqs = h.source.requestsFor('/dl/retry-429/model.bin');
  assert.equal(reqs.length, 3, `2 次 429 后应共 3 次请求，实际 ${reqs.length}`);
  assert.ok(Date.now() - startedAt >= 400, '重试必须有可观退避间隔（0.5s/1s 量级）');

  // 5xx
  h.addModel({ id: 'retry-500', files: [{ path: 'model.bin', data, mode: '500-then-ok', failCount: 1 }] });
  const manager2 = h.makeManager();
  await startSettled(manager2, ['retry-500']);
  assert.equal((await waitTerminal(manager2, 'retry-500')).status, 'installed');
  assert.equal(h.source.requestsFor('/dl/retry-500/model.bin').length, 2);

  // 403：不重试
  h.addModel({ id: 'forbidden', files: [{ path: 'model.bin', data: deterministicBytes(1024, 'forbidden'), mode: '403' }] });
  const manager3 = h.makeManager();
  await startSettled(manager3, ['forbidden']);
  const forbidden = await waitTerminal(manager3, 'forbidden');
  assert.notEqual(forbidden.status, 'installed', '403 不得成功');
  assert.equal(h.source.requestsFor('/dl/forbidden/model.bin').length, 1, '403 必须不重试');
  assert.ok(forbidden.error && forbidden.error.message.trim().length > 0, '403 错误信息必须可读');

  // 404：不重试
  h.addModel({ id: 'missing', files: [{ path: 'model.bin', data: deterministicBytes(1024, 'missing'), mode: '404' }] });
  const manager4 = h.makeManager();
  await startSettled(manager4, ['missing']);
  const missing = await waitTerminal(manager4, 'missing');
  assert.notEqual(missing.status, 'installed');
  assert.equal(h.source.requestsFor('/dl/missing/model.bin').length, 1, '404 必须不重试');
});

test('[#105-9] always-429 有界重试（≤3 次重试）后失败，不无限重试', async (t) => {
  const h = await createHarness(t);
  h.addModel({ id: 'always-429', files: [{ path: 'model.bin', data: deterministicBytes(4096, 'always429'), mode: 'always-429' }] });
  const manager = h.makeManager();
  await startSettled(manager, ['always-429']);
  const final = await waitTerminal(manager, 'always-429', 40_000);
  assert.notEqual(final.status, 'installed');
  const attempts = h.source.requestsFor('/dl/always-429/model.bin').length;
  assert.ok(attempts >= 2, `至少应有 1 次重试，实际请求 ${attempts}`);
  assert.ok(attempts <= 4, `重试次数必须受限（初始+≤3 次重试），实际请求 ${attempts}`);
  assert.ok(final.error && /429|限制|请求|retry|too many/i.test(final.error.message), `429 错误不可读: ${JSON.stringify(final.error)}`);
});

test('[#105-10] 断网/中途中断：不产生假完成，恢复后可得到完整正确文件', async (t) => {
  const h = await createHarness(t);
  const data = deterministicBytes(48 * 1024, 'flaky');
  h.addModel({ id: 'flaky', files: [{ path: 'model.bin', data, mode: 'abort-mid' }] });
  const manager = h.makeManager();
  await startSettled(manager, ['flaky']);
  const failed = await waitTerminal(manager, 'flaky', 40_000);
  assert.notEqual(failed.status, 'installed', '中断不得产生假完成');
  assert.ok(!fs.existsSync(installedFile(h.modelsRoot, 'flaky', 'model.bin')), '中断时不得提交安装文件');
  assert.ok(h.source.requestsFor('/dl/flaky/model.bin').length >= 2, '网络错误应触发有限重试');

  // 源恢复后重试修复
  h.source.setMode('/dl/flaky/model.bin', 'ok');
  try {
    await manager.retry('flaky');
  } catch {
    /* 状态断言 */
  }
  const fixed = await waitTerminal(manager, 'flaky');
  assert.equal(fixed.status, 'installed', `源恢复后应能修复: ${JSON.stringify(fixed)}`);
  assert.equal(sha256Buffer(fs.readFileSync(installedFile(h.modelsRoot, 'flaky', 'model.bin'))), sha256Buffer(data));
});

test('[#105-11] 完整性：错误 sha256/size → corrupted、不 mark installed、可重试修复', async (t) => {
  const h = await createHarness(t);
  const data = deterministicBytes(8192, 'integrity');
  const wrongSha = sha256Buffer(Buffer.from('different-content'));
  h.addModel({ id: 'bad-sha', files: [{ path: 'model.bin', data }], declaredShaOverrides: { 'model.bin': wrongSha } });
  const manager = h.makeManager();
  await startSettled(manager, ['bad-sha']);
  const bad = await waitTerminal(manager, 'bad-sha');
  assert.equal(bad.status, 'corrupted', `错误 sha256 必须标记 corrupted，实际 ${bad.status}`);
  assert.ok(bad.error && bad.error.message.trim().length > 0, 'corrupted 必须有可读错误');
  assert.ok(!fs.existsSync(installedFile(h.modelsRoot, 'bad-sha', 'model.bin')), '校验失败不得提交安装文件');
  assert.ok(fs.existsSync(partFile(h.downloads, 'bad-sha', 'model.bin')), '校验失败必须保留 partial 便于排查/重试');

  // 修正声明哈希后重试修复
  const entry = h.manifest.models.find((m) => m.id === 'bad-sha')!;
  entry.files[0].sha256 = sha256Buffer(data);
  try {
    await manager.retry('bad-sha');
  } catch {
    /* ignore */
  }
  const fixed = await waitTerminal(manager, 'bad-sha');
  assert.equal(fixed.status, 'installed', `修正哈希后应可修复: ${JSON.stringify(fixed)}`);

  // size 完整性不匹配（源站无 Content-Length，避免“源大小不一致”提前失败，专门验证 size 校验）
  const data2 = deterministicBytes(4096, 'size');
  h.addModel({ id: 'bad-size', files: [{ path: 'model.bin', data: data2, mode: 'no-content-length' }], integrity: 'size', declaredSizeOverrides: { 'model.bin': 4097 } });
  const manager2 = h.makeManager();
  await startSettled(manager2, ['bad-size']);
  const badSize = await waitTerminal(manager2, 'bad-size');
  assert.equal(badSize.status, 'corrupted');
  assert.ok(!fs.existsSync(installedFile(h.modelsRoot, 'bad-size', 'model.bin')));
});

test('[#105-12] 原子提交：下载/暂停期间目标文件不存在，仅校验通过后出现', async (t) => {
  const h = await createHarness(t);
  const data = deterministicBytes(64 * 1024, 'atomic');
  h.addModel({ id: 'atomic', files: [{ path: 'model.bin', data, mode: 'drip', chunkSize: 1024, chunkDelayMs: 8 }] });
  const manager = h.makeManager();
  const target = installedFile(h.modelsRoot, 'atomic', 'model.bin');
  void manager.start(['atomic']).catch(() => {});
  await waitFor(() => manager.get('atomic').receivedBytes > 8192, 'atomic progress');
  assert.ok(!fs.existsSync(target), '下载过程中不得出现目标已安装文件（非原子提交）');
  await manager.pause('atomic');
  assert.ok(!fs.existsSync(target), '暂停后目标文件仍不得出现');
  await manager.resume('atomic');
  const final = await waitTerminal(manager, 'atomic');
  assert.equal(final.status, 'installed');
  assert.ok(fs.existsSync(target), '校验通过后目标文件必须出现');
  assert.equal(sha256Buffer(fs.readFileSync(target)), sha256Buffer(data));
});

test('[#105-13] 空间不足：insufficient_space 可读错误、不开始写盘/下载', async (t) => {
  const h = await createHarness(t);
  const data = deterministicBytes(1024 * 1024, 'space');
  h.addModel({ id: 'nospace', files: [{ path: 'model.bin', data }] });
  const manager = h.makeManager({ diskFreeBytes: async () => 1024 });
  await startSettled(manager, ['nospace']);
  const final = await waitTerminal(manager, 'nospace');
  assert.equal(final.status, 'failed', `空间不足应为 failed，实际 ${final.status}`);
  assert.equal(final.error?.code, 'insufficient_space', `错误码应为 insufficient_space，实际 ${JSON.stringify(final.error)}`);
  assert.ok(/空间|磁盘|不足|space/i.test(final.error?.message ?? ''), `空间错误必须可读: ${final.error?.message}`);
  assert.equal(h.source.requestsFor('/dl/nospace/model.bin').length, 0, '空间不足时不得开始下载');
  assert.ok(!fs.existsSync(installedFile(h.modelsRoot, 'nospace', 'model.bin')));
  const leftoverParts: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.part')) leftoverParts.push(p);
    }
  };
  walk(h.downloads);
  assert.deepEqual(leftoverParts, [], '空间不足时不得写盘产生 partial');
});

test('[#105-14] 写盘/校验失败：failed + 可读错误、不产生损坏安装', async (t) => {
  const h = await createHarness(t);
  const data = deterministicBytes(8192, 'iofail');
  h.addModel({ id: 'iofail', files: [{ path: 'model.bin', data }] });
  const manager = h.makeManager({
    hashFile: async () => {
      const err = new Error('EACCES: permission denied, open ...') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    },
  });
  await startSettled(manager, ['iofail']);
  const final = await waitTerminal(manager, 'iofail');
  assert.notEqual(final.status, 'installed', '校验 I/O 失败不得标记 installed');
  assert.ok(['failed', 'corrupted'].includes(final.status));
  assert.ok(final.error && final.error.message.trim().length > 0, '写盘/校验失败必须给出可读错误');
  assert.ok(!fs.existsSync(installedFile(h.modelsRoot, 'iofail', 'model.bin')), '失败不得提交损坏安装');
});

test('[#105-15] 崩溃恢复：子进程被杀后 state.json 仍为合法 JSON，recover() → paused 保留字节', async (t) => {
  const h = await createHarness(t);
  const data = deterministicBytes(512 * 1024, 'crash');
  h.addModel({ id: 'crash', files: [{ path: 'model.bin', data, mode: 'drip', chunkSize: 4096, chunkDelayMs: 6 }] });
  const manifestPath = path.join(h.root, 'manifest.json');
  await writeFileDeep(manifestPath, JSON.stringify(h.manifest, null, 2));
  const progressFile = path.join(h.root, 'child-progress.json');
  const scriptPath = path.join(h.root, 'crash-child.mjs');
  const srcDir = path.resolve(import.meta.dirname, '..', 'src');
  fs.writeFileSync(
    scriptPath,
    `import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.DL_ROOT;
const manifest = JSON.parse(fs.readFileSync(process.env.DL_MANIFEST, 'utf8'));
const { createModelDirectoryResolver } = await import(pathToFileURL(path.join(process.env.DL_SRC, 'model-paths.ts')).href);
const { ModelDownloadManager } = await import(pathToFileURL(path.join(process.env.DL_SRC, 'downloader.ts')).href);
const resolver = createModelDirectoryResolver(root);
const manager = new ModelDownloadManager({ manifest, resolver, statePath: path.join(root, 'models', '.downloads', 'state.json') });
manager.onProgress((states) => {
  try { fs.writeFileSync(process.env.DL_PROGRESS, JSON.stringify(states)); } catch {}
});
manager.start(['crash']).catch(() => {});
setInterval(() => {}, 1000);
`,
    'utf8',
  );
  const child = spawnCrashChild(scriptPath, {
    DL_ROOT: h.root,
    DL_MANIFEST: manifestPath,
    DL_PROGRESS: progressFile,
    DL_SRC: srcDir,
  });
  try {
    // 等到 state.json 中已持久化 downloading + 字节 > 0
    try {
      await waitFor(() => {
        try {
          const raw = fs.readFileSync(h.statePath, 'utf8');
          const parsed = JSON.parse(raw) as {
            models?: Record<string, { id: string; status: string; receivedBytes: number }> | Array<{ id: string; status: string; receivedBytes: number }>;
          };
          const models = parsed.models;
          const state = Array.isArray(models) ? models.find((s) => s.id === 'crash') : models?.['crash'];
          return state && state.status === 'downloading' && state.receivedBytes > 0 ? state : null;
        } catch {
          return null;
        }
      }, 'persisted state.json with bytes', 30_000, 50);
    } catch (error) {
      const stateSnapshot = fs.existsSync(h.statePath) ? fs.readFileSync(h.statePath, 'utf8').slice(0, 1500) : '(missing)';
      throw new Error(`${(error as Error).message}; childOutput=${child.output().slice(0, 2000)}; state=${stateSnapshot}`);
    }
  } finally {
    if (child.pid && child.pid > 0) killTree(child.pid);
    await child.exit.catch(() => {});
  }
  // 崩溃后状态文件必须是合法 JSON（原子写）
  const rawAfterCrash = fs.readFileSync(h.statePath, 'utf8');
  const parsedAfterCrash = JSON.parse(rawAfterCrash) as { models?: unknown[]; states?: unknown[] };
  assert.ok(parsedAfterCrash && typeof parsedAfterCrash === 'object', '崩溃后 state.json 必须是合法 JSON');

  const manager = h.makeManager();
  await manager.recover();
  const recovered = manager.get('crash');
  assert.ok(recovered.receivedBytes > 0, `recover() 必须保留已下载字节，实际 ${recovered.receivedBytes}`);
  assert.ok(['paused', 'downloading'].includes(recovered.status), `崩溃后重启状态应为 paused，实际 ${recovered.status}`);
  assert.notEqual(recovered.status, 'installed', '崩溃后不得出现假完成');

  try {
    await manager.resume('crash');
  } catch {
    /* 状态断言 */
  }
  const final = await waitTerminal(manager, 'crash', 40_000);
  assert.equal(final.status, 'installed', `崩溃恢复后应能续传完成: ${JSON.stringify(final)}`);
  assert.equal(sha256Buffer(fs.readFileSync(installedFile(h.modelsRoot, 'crash', 'model.bin'))), sha256Buffer(data));
  const ranged = h.source.requestsFor('/dl/crash/model.bin').filter((r) => r.range);
  assert.ok(ranged.length > 0, '崩溃恢复后续传应发送 Range 请求');
});

test('[#105-16] 并发上限：默认 2、显式 1 时严格串行、上限 4', async (t) => {
  // 以源站观测到的真实并行请求数为准（queue 中排队任务状态可能已是 downloading）
  const slow = (id: string): FileDef[] => [{ path: 'model.bin', data: deterministicBytes(24 * 1024, id), mode: 'drip', chunkSize: 1024, chunkDelayMs: 15 }];

  const h = await createHarness(t);
  for (const id of ['c1', 'c2', 'c3']) h.addModel({ id, files: slow(id) });
  const manager = h.makeManager({ concurrency: 1 });
  await startSettled(manager, ['c1', 'c2', 'c3']);
  for (const id of ['c1', 'c2', 'c3']) assert.equal((await waitTerminal(manager, id, 60_000)).status, 'installed', `${id} 应完成`);
  assert.ok(h.sourceServer.maxConcurrentRequests() <= 1, `concurrency=1 时必须严格串行，观测最大并行 ${h.sourceServer.maxConcurrentRequests()}`);

  const h2 = await createHarness(t);
  for (const id of ['d1', 'd2']) h2.addModel({ id, files: slow(id) });
  const manager2 = h2.makeManager();
  await startSettled(manager2, ['d1', 'd2']);
  for (const id of ['d1', 'd2']) assert.equal((await waitTerminal(manager2, id, 60_000)).status, 'installed');
  assert.ok(h2.sourceServer.maxConcurrentRequests() >= 2, `默认 concurrency=2 时应出现并行下载，观测最大并行 ${h2.sourceServer.maxConcurrentRequests()}`);

  const h3 = await createHarness(t);
  const ids = ['e1', 'e2', 'e3', 'e4', 'e5'];
  for (const id of ids) h3.addModel({ id, files: [{ path: 'model.bin', data: deterministicBytes(16 * 1024, id), mode: 'drip', chunkSize: 1024, chunkDelayMs: 12 }] });
  const manager3 = h3.makeManager({ concurrency: 10 });
  await startSettled(manager3, ids);
  for (const id of ids) assert.equal((await waitTerminal(manager3, id, 60_000)).status, 'installed');
  const maxParallel = h3.sourceServer.maxConcurrentRequests();
  assert.ok(maxParallel <= 4, `并发上限必须 ≤4，观测 ${maxParallel}`);
  assert.ok(maxParallel >= 2, `5 个模型时应出现并行，观测 ${maxParallel}`);
});

// ---------------------------------------------------------------------------
// 持久化 / 续传 / 数据落点
// ---------------------------------------------------------------------------

test('[#105-21] 进程重启续传：新 manager 读取 state+partial，不从头开始', async (t) => {
  const h = await createHarness(t);
  const data = deterministicBytes(96 * 1024, 'restart');
  h.addModel({ id: 'restart', files: [{ path: 'model.bin', data, mode: 'drip', chunkSize: 2048, chunkDelayMs: 8 }] });
  const manager1 = h.makeManager();
  void manager1.start(['restart']).catch(() => {});
  await waitFor(() => manager1.get('restart').receivedBytes > 16384, 'manager1 progress');
  await manager1.pause('restart');
  const partialBytes = manager1.get('restart').receivedBytes;
  await manager1.dispose();

  const manager2 = h.makeManager();
  await manager2.recover();
  const recovered = manager2.get('restart');
  assert.equal(recovered.status, 'paused', `重启后应为 paused，实际 ${recovered.status}`);
  assert.ok(recovered.receivedBytes >= partialBytes - 65536, `重启后应保留 partial 字节: ${recovered.receivedBytes} vs ${partialBytes}`);
  await manager2.resume('restart');
  const final = await waitTerminal(manager2, 'restart', 40_000);
  assert.equal(final.status, 'installed');
  const ranged = h.source.requestsFor('/dl/restart/model.bin').filter((r) => r.range && /bytes=\d+-/.test(r.range));
  assert.ok(ranged.length > 0, '新 manager 续传必须发送 Range 请求');
});

test('[#105-22] 全部受管数据位于 <root>\\models，下载期间不写 AppData/用户目录', async (t) => {
  const h = await createHarness(t);
  const fakeUser = path.join(h.root, 'fake-user');
  fs.mkdirSync(fakeUser, { recursive: true });
  const hkcuBefore = snapshotEnv();
  const saved = {
    USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
  };
  process.env.USERPROFILE = fakeUser;
  process.env.LOCALAPPDATA = path.join(fakeUser, 'AppData', 'Local');
  process.env.APPDATA = path.join(fakeUser, 'AppData', 'Roaming');
  try {
    h.addModel({
      id: 'local',
      files: [
        { path: 'model.bin', data: deterministicBytes(16 * 1024, 'local') },
        { path: 'config.json', data: Buffer.from('{"ok":true}') },
      ],
    });
    const manager = h.makeManager();
    await startSettled(manager, ['local']);
    assert.equal((await waitTerminal(manager, 'local')).status, 'installed');
    // 目标文件在 models/<installDir>
    const installDir = h.manifest.models[0].installDir;
    for (const rel of ['model.bin', 'config.json']) {
      assert.ok(fs.existsSync(installedFile(h.modelsRoot, installDir, rel)), `${rel} 必须位于 models/<installDir>`);
    }
    // state.json 与 .downloads 均位于 models 下
    assert.equal(path.resolve(h.statePath).toLowerCase(), path.join(h.modelsRoot, '.downloads', 'state.json').toLowerCase());
    assert.ok(fs.existsSync(path.join(h.modelsRoot, '.downloads')));
    // 用户目录不应产生受管模型/下载数据
    const userFiles = fs.existsSync(fakeUser) ? listTree(fakeUser) : [];
    await waitFor(async () => (await listTree(fakeUser)).length === 0 && fs.readdirSync(fakeUser).length === 0, 'fake user dir stays empty', 3000).catch(() => {});
    assert.deepEqual(await listTree(fakeUser), [], `下载期间写入了用户目录: ${JSON.stringify(userFiles)}`);
    // 下载完成后 .part 不残留
    assert.ok(!fs.existsSync(partFile(h.downloads, 'local', 'model.bin')));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  // 不修改无关进程环境
  assert.deepEqual(diffEnv(hkcuBefore, snapshotEnv()), [], '下载过程修改了 process.env');
  // 记录测试用临时数据位置
  assert.ok(h.root.toLowerCase().startsWith(TMP_ROOT.toLowerCase()), '测试临时目录必须位于 data/tmp/v21');
});

// ---------- 子进程崩溃测试辅助 ----------
import { spawn } from 'node:child_process';
import { NODE_EXE } from './_helpers/temp';

function spawnCrashChild(scriptPath: string, env: Record<string, string>): { pid: number; exit: Promise<unknown>; output: () => string } {
  const child = spawn(NODE_EXE, [path.resolve(import.meta.dirname, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), scriptPath], {
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (d: Buffer) => {
    output += d.toString();
  });
  child.stderr?.on('data', (d: Buffer) => {
    output += d.toString();
  });
  const exit = new Promise((resolve) => child.once('exit', resolve));
  return { pid: child.pid ?? -1, exit, output: () => output };
}
