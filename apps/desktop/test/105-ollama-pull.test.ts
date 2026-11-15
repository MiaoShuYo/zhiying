/**
 * #105-17 Ollama 适配（§2.5）：NDJSON 流解析（status/digest/total/completed）、
 * 阶段映射 download/verify、暂停终止子进程、恢复重新 pull、成功 installed。
 * 使用真实 spawn 的 fake ollama 脚本，经 ModelDownloadManager 的公开路径验证（只注入 spawnImpl）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { makeTempRoot, cleanupRegisteredTempDirs } from './_helpers/temp';
import { makeManifest } from './_helpers/fixtures';
import type { ModelManifestEntryLike } from './_helpers/fixtures';
import { readFakeOllamaCalls, makeFakeOllamaSpawn, writeFakeOllamaScript } from './_helpers/fake-ollama';
import { isAlive, waitForCondition } from './_helpers/processes';
import { resolveInstallLayout } from '../src/install-layout';
import { createModelDirectoryResolver } from '../src/model-paths';
import { ModelDownloadManager } from '../src/downloader';
import { parseOllamaPullLine } from '../src/ollama-pull';

type ManagerOptions = ConstructorParameters<typeof ModelDownloadManager>[0];

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

function makeOllamaEntry(overrides: Partial<ModelManifestEntryLike> = {}): ModelManifestEntryLike {
  return {
    id: 'qwen3-4b',
    name: 'Qwen3 4B',
    purpose: 'llm',
    required: true,
    source: { kind: 'ollama', ollamaModel: 'qwen3:4b' },
    installDir: 'ollama/qwen3-4b',
    integrity: 'ollama-digest',
    files: [],
    totalBytes: 1_000_000,
    license: { name: 'Apache-2.0', notes: 'fixture', commercialUse: 'allowed' },
    ...overrides,
  };
}

interface Harness {
  root: string;
  statePath: string;
  modelsRoot: string;
  resolver: ReturnType<typeof createModelDirectoryResolver>;
  manifest: ReturnType<typeof makeManifest>;
  recordFile: string;
  scriptPath: string;
  makeManager: (options: Partial<ManagerOptions>) => ModelDownloadManager;
}

async function createHarness(t: test.TestContext, mode: 'success' | 'fail' | 'hang' | 'error-exit' | 'slow' = 'success'): Promise<Harness> {
  const root = makeTempRoot('ollama');
  const layout = resolveInstallLayout(root);
  const resolver = createModelDirectoryResolver(layout);
  await resolver.ensureModelDirectories();
  const workDir = path.join(root, 'fake-ollama');
  const scriptPath = writeFakeOllamaScript(workDir);
  const recordFile = path.join(workDir, 'calls.jsonl');
  const manifest = makeManifest([makeOllamaEntry()]);
  const statePath = path.join(resolver.resolveTempDownloadPath(), 'state.json');
  const managers: ModelDownloadManager[] = [];
  t.after(async () => {
    for (const manager of managers) await manager.dispose().catch(() => {});
    cleanupRegisteredTempDirs();
  });
  return {
    root,
    statePath,
    modelsRoot: resolver.resolveModelsRoot(),
    resolver,
    manifest,
    recordFile,
    scriptPath,
    makeManager: (options: Partial<ManagerOptions>) => {
      const spawnImpl = makeFakeOllamaSpawn(scriptPath, recordFile, {
        mode,
        total: 1_000_000,
        steps: 5,
        delayMs: mode === 'slow' ? 120 : 10,
      });
      const manager = new ModelDownloadManager({
        manifest: manifest as ManagerOptions['manifest'],
        resolver,
        statePath,
        spawnImpl,
        ollamaCommand: 'ollama-fixture',
        ollamaEnv: {},
        ...options,
      } as ManagerOptions);
      managers.push(manager);
      return manager;
    },
  };
}

const TERMINAL = ['installed', 'failed', 'corrupted'];
async function waitTerminal(manager: ModelDownloadManager, timeoutMs = 40_000): Promise<ReturnType<ModelDownloadManager['get']>> {
  return waitFor(() => {
    const state = manager.get('qwen3-4b');
    return TERMINAL.includes(state.status) ? state : null;
  }, 'ollama terminal state', timeoutMs);
}

test('[#105-17] parseOllamaPullLine：解析 status/digest/total/completed 并映射阶段', () => {
  const download = parseOllamaPullLine('{"status":"downloading","digest":"sha256:abc","total":1000,"completed":100}');
  assert.ok(download);
  assert.equal(download!.status, 'downloading');
  assert.equal(download!.phase, 'download');
  assert.equal(download!.digest, 'sha256:abc');
  assert.equal(download!.total, 1000);
  assert.equal(download!.completed, 100);

  const verifying = parseOllamaPullLine('{"status":"verifying sha256 digest"}');
  assert.equal(verifying?.phase, 'verify');
  const writing = parseOllamaPullLine('{"status":"writing manifest"}');
  assert.equal(writing?.phase, 'verify');
  const success = parseOllamaPullLine('{"status":"success"}');
  assert.equal(success?.phase, 'verify');

  assert.equal(parseOllamaPullLine(''), undefined);
  assert.equal(parseOllamaPullLine('not json'), undefined);
  assert.equal(parseOllamaPullLine('{"noStatus":true}'), undefined);
  assert.equal(parseOllamaPullLine('{"status":""}'), undefined);
  // completed/total 非法类型忽略
  const invalidCounts = parseOllamaPullLine('{"status":"downloading","total":"x","completed":-5}');
  assert.ok(invalidCounts);
  assert.equal(invalidCounts!.total, undefined);
  assert.equal(invalidCounts!.completed, undefined);
});

test('[#105-17] ollama pull 成功：真实 spawn、NDJSON 进度、阶段映射、installed 与受管模型目录', async (t) => {
  // 使用慢速流以便可靠观测 download → verify 阶段（进度事件有 120ms 节流）
  const h = await createHarness(t, 'slow');
  const manager = h.makeManager({});
  const progress: Array<Array<{ id: string; phase: string; status: string; receivedBytes: number; totalBytes?: number; percent?: number }>> = [];
  const stop = manager.onProgress((states) => progress.push(structuredClone(states) as never));
  try {
    await manager.start(['qwen3-4b']);
    const final = await waitTerminal(manager);
    assert.equal(final.status, 'installed', `ollama pull 应成功: ${JSON.stringify(final)}`);
    assert.equal(final.verified, 'ollama-digest');
    assert.equal(final.percent, 100);

    // 子进程真实被 spawn，参数为 pull <model>
    const calls = readFakeOllamaCalls(h.recordFile);
    assert.equal(calls.length, 1, '应只 spawn 一次 ollama pull');
    assert.deepEqual(calls[0].argv, ['pull', 'qwen3:4b'], `ollama 调用参数错误: ${JSON.stringify(calls[0].argv)}`);
    // 受管模型目录环境变量注入
    assert.ok((calls[0].ollamaModels ?? '').toLowerCase().endsWith(path.join('models', 'ollama').toLowerCase()), `OLLAMA_MODELS 必须指向安装目录 models\\ollama: ${calls[0].ollamaModels}`);

    // 阶段映射：出现 download 与 verify；下载中间进度来自 NDJSON total/completed
    const phases = new Set(progress.flat().filter((s) => s.id === 'qwen3-4b').map((s) => s.phase));
    assert.ok(phases.has('download'), `应出现 download 阶段: ${[...phases]}`);
    assert.ok(phases.has('verify'), `应出现 verify 阶段: ${[...phases]}`);
    const downloadStates = progress.flat().filter((s) => s.id === 'qwen3-4b' && s.phase === 'download' && s.receivedBytes > 0);
    assert.ok(downloadStates.length > 0, '应解析出真实完成字节');
    assert.ok(downloadStates.some((s) => s.totalBytes === 1_000_000), '应解析出 NDJSON total');
  } finally {
    stop();
  }
});

test('[#105-17] ollama pull 失败：exit code 非 0 → failed + 可读错误（不假完成）', async (t) => {
  const h = await createHarness(t, 'fail');
  const manager = h.makeManager({});
  await manager.start(['qwen3-4b']);
  const final = await waitTerminal(manager);
  assert.equal(final.status, 'failed', `失败 pull 不得标记 installed: ${JSON.stringify(final)}`);
  assert.ok(final.error && final.error.message.trim().length > 0, '失败必须有可读错误');
  assert.match(final.error!.message, /ollama|pull|失败/i);
  assert.notEqual(final.verified, 'ollama-digest');
});

test('[#105-17] ollama 模型不存在：可读错误提示模型不存在', async (t) => {
  const h = await createHarness(t, 'error-exit');
  const manager = h.makeManager({});
  await manager.start(['qwen3-4b']);
  const final = await waitTerminal(manager);
  assert.equal(final.status, 'failed');
  assert.ok(final.error && final.error.message.trim().length > 0);
  assert.match(final.error!.message, /模型|ollama|not found|不存在/i, `模型不存在错误不可读: ${final.error!.message}`);
});

test('[#105-17] 暂停终止 ollama 子进程、恢复重新 pull 并成功', async (t) => {
  const h = await createHarness(t, 'hang');
  const manager = h.makeManager({});
  void manager.start(['qwen3-4b']).catch(() => {});
  const progressed = await waitFor(() => {
    const state = manager.get('qwen3-4b');
    return state.status === 'downloading' && state.receivedBytes > 0 ? state : null;
  }, 'ollama progress before pause');
  assert.ok(progressed.receivedBytes > 0);
  const firstCalls = readFakeOllamaCalls(h.recordFile);
  assert.equal(firstCalls.length, 1);
  const childPid = firstCalls[0].pid;
  assert.ok(isAlive(childPid), 'pull 子进程应在运行');

  await manager.pause('qwen3-4b');
  const paused = manager.get('qwen3-4b');
  assert.equal(paused.status, 'paused', `暂停后应为 paused: ${JSON.stringify(paused)}`);
  assert.equal(paused.partialKept, true);
  await waitForCondition(() => !isAlive(childPid), { timeoutMs: 10_000, label: '暂停必须终止 ollama 子进程' });

  // 恢复：使用 success 模式的 spawnImpl 新建 manager（同一 state 目录），重新 pull
  const successSpawn = makeFakeOllamaSpawn(h.scriptPath, h.recordFile, { mode: 'success', total: 1_000_000, steps: 5, delayMs: 10 });
  const resumed = h.makeManager({ spawnImpl: successSpawn });
  await resumed.recover();
  await resumed.resume('qwen3-4b');
  const final = await waitTerminal(resumed);
  assert.equal(final.status, 'installed', `恢复后应成功: ${JSON.stringify(final)}`);
  const calls = readFakeOllamaCalls(h.recordFile);
  assert.ok(calls.length >= 2, `恢复应重新执行 ollama pull，调用次数 ${calls.length}`);
  assert.deepEqual(calls[calls.length - 1].argv, ['pull', 'qwen3:4b']);
});
