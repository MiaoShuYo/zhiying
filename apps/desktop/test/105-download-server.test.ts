/**
 * #105-18 模型管理器 HTTP API + SSE（§2.5 download-server.ts）。
 * 真实 HTTP 服务 + 真实下载（fixture 源），验证路由契约、操作生效、SSE 推送、仅绑定回环。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { makeTempRoot, cleanupRegisteredTempDirs } from './_helpers/temp';
import { FixtureModelSource } from './_helpers/http-source';
import type { SourceMode } from './_helpers/http-source';
import { makeManifest, makeHttpEntry } from './_helpers/fixtures';
import type { ModelManifestEntryLike } from './_helpers/fixtures';
import { deterministicBytes } from './_helpers/fsx';
import { getFreePort, waitForHttp } from './_helpers/ports';
import { resolveInstallLayout } from '../src/install-layout';
import { createModelDirectoryResolver } from '../src/model-paths';
import { ModelDownloadManager } from '../src/downloader';
import { createModelManagerServer } from '../src/download-server';
import type { ModelManagerServer } from '../src/download-server';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | Promise<T>, label: string, timeoutMs = 40_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await sleep(50);
  }
  throw new Error(`waitFor timeout: ${label}${last instanceof Error ? `: ${last.message}` : ''}`);
}

interface Harness {
  root: string;
  modelsRoot: string;
  resolver: ReturnType<typeof createModelDirectoryResolver>;
  source: FixtureModelSource;
  manifest: ReturnType<typeof makeManifest>;
  readonly manager: ModelDownloadManager;
  readonly server: ModelManagerServer;
  addModel: (def: { id: string; data?: Buffer; mode?: SourceMode; integrity?: 'sha256' | 'size'; required?: boolean }) => ModelManifestEntryLike;
  start: () => Promise<void>;
  getJson: (path: string) => Promise<{ status: number; body: any }>;
  post: (path: string, body?: unknown) => Promise<{ status: number; body: any }>;
}

async function createHarness(t: test.TestContext): Promise<Harness> {
  const root = makeTempRoot('dl-server');
  const layout = resolveInstallLayout(root);
  const resolver = createModelDirectoryResolver(layout);
  await resolver.ensureModelDirectories();
  const source = new FixtureModelSource();
  const fixtureServer = await source.start();
  const manifest = makeManifest([]);
  const statePath = path.join(layout.downloads, 'state.json');
  const state: { manager?: ModelDownloadManager; server?: ModelManagerServer } = {};
  t.after(async () => {
    await state.server?.close().catch(() => {});
    await state.manager?.dispose().catch(() => {});
    await fixtureServer.close().catch(() => {});
    cleanupRegisteredTempDirs();
  });

  function addModel(def: { id: string; data?: Buffer; mode?: SourceMode; integrity?: 'sha256' | 'size'; required?: boolean }): ModelManifestEntryLike {
    const data = def.data ?? deterministicBytes(8 * 1024, def.id);
    const { entry } = makeHttpEntry({
      id: def.id,
      name: `模型 ${def.id}`,
      purpose: 'tts',
      files: [{ path: 'model.bin', data, url: `${fixtureServer.url}/dl/${def.id}/model.bin` }],
      baseUrl: `${fixtureServer.url}/dl`,
      integrity: def.integrity,
      required: def.required ?? true,
    });
    source.addFile(`/dl/${def.id}/model.bin`, { data, mode: def.mode ?? 'ok', chunkSize: 1024, chunkDelayMs: 10 });
    manifest.models.push(entry);
    return entry;
  }

  const request = async (method: string, pathname: string, body?: unknown): Promise<{ status: number; body: any }> => {
    if (!state.server) throw new Error('server 尚未 start()');
    const response = await fetch(`${state.server.url}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* HTML */
    }
    return { status: response.status, body: parsed };
  };

  return {
    root,
    modelsRoot: layout.modelsRoot,
    resolver,
    source,
    manifest,
    get manager() {
      if (!state.manager) throw new Error('manager 尚未 start()');
      return state.manager;
    },
    get server() {
      if (!state.server) throw new Error('server 尚未 start()');
      return state.server;
    },
    addModel,
    start: async () => {
      state.manager = new ModelDownloadManager({ manifest: manifest as never, resolver, statePath });
      state.server = await createModelManagerServer({ manager: state.manager, resolver, installRoot: root, port: 0 });
    },
    getJson: (p: string) => request('GET', p),
    post: (p: string, body?: unknown) => request('POST', p, body),
  };
}
test('[#105-18] GET / 返回自包含 HTML；GET /api/models 返回完整契约字段', async (t) => {
  const h = await createHarness(t);
  h.addModel({ id: 'alpha' });
  h.addModel({ id: 'beta', required: false });
  await h.start();

  const html = await h.getJson('/');
  assert.equal(html.status, 200);
  assert.equal(typeof html.body, 'string');
  assert.match(html.body, /<!doctype html>/i);
  assert.match(html.body, /保存位置/);
  assert.match(html.body, /<script>/);

  const models = await h.getJson('/api/models');
  assert.equal(models.status, 200);
  assert.equal(models.body.installRoot, h.root);
  assert.equal(models.body.modelsRoot, path.join(h.root, 'models'));
  assert.ok(models.body.disk && typeof models.body.disk.freeBytes === 'number', '缺少 disk.freeBytes');
  assert.ok(models.body.overall && typeof models.body.overall.indeterminate === 'boolean');
  assert.equal(models.body.models.length, 2);
  const alpha = models.body.models.find((m: any) => m.id === 'alpha');
  assert.ok(alpha, '缺少模型 alpha');
  assert.equal(alpha.name, '模型 alpha');
  assert.equal(alpha.purpose, 'tts');
  assert.equal(alpha.required, true);
  assert.ok(alpha.sizeBytes > 0);
  assert.equal(alpha.installPath, path.join(h.modelsRoot, 'alpha'));
  assert.ok(alpha.license && alpha.license.name, '缺少许可证信息');
  assert.equal(alpha.status, 'not_installed');
  // 不得泄漏凭据
  const raw = JSON.stringify(models.body).toLowerCase();
  for (const secret of ['token', 'password', 'secret', 'api_key']) assert.ok(!raw.includes(secret), `API 泄漏敏感字段 ${secret}`);
});

test('[#105-18] POST start/pause/resume/retry/cancel 生效，状态机真实推进', async (t) => {
  const h = await createHarness(t);
  h.addModel({ id: 'fast' });
  h.addModel({ id: 'slow', mode: 'drip' });
  h.addModel({ id: 'denied', mode: '403' });
  h.addModel({ id: 'cancelled', mode: 'drip' });
  await h.start();

  // start（fast）
  const started = await h.post('/api/models/fast/start');
  assert.equal(started.status, 200);
  assert.equal(started.body.ok, true);
  await waitFor(async () => (await h.getJson('/api/models')).body.models.find((m: any) => m.id === 'fast').status === 'installed', 'fast installed');
  assert.ok(fs.existsSync(path.join(h.modelsRoot, 'fast', 'model.bin')), '安装文件必须落在 models/<installDir>');

  // pause/resume（slow）
  await h.post('/api/models/slow/start');
  await waitFor(async () => {
    const state = (await h.getJson('/api/models')).body.models.find((m: any) => m.id === 'slow');
    return state.receivedBytes > 0 && state.status === 'downloading';
  }, 'slow downloading');
  const paused = await h.post('/api/models/slow/pause');
  assert.equal(paused.status, 200);
  assert.equal(paused.body.model.status, 'paused');
  assert.equal(paused.body.model.partialKept, true);
  const resumed = await h.post('/api/models/slow/resume');
  assert.equal(resumed.status, 200);
  await waitFor(async () => (await h.getJson('/api/models')).body.models.find((m: any) => m.id === 'slow').status === 'installed', 'slow installed');

  // retry（denied 403 → 修好源后重试）
  await h.post('/api/models/denied/start');
  await waitFor(async () => (await h.getJson('/api/models')).body.models.find((m: any) => m.id === 'denied').status === 'failed', 'denied failed');
  h.source.setMode('/dl/denied/model.bin', 'ok');
  const retried = await h.post('/api/models/denied/retry');
  assert.equal(retried.status, 200);
  await waitFor(async () => (await h.getJson('/api/models')).body.models.find((m: any) => m.id === 'denied').status === 'installed', 'denied installed after retry');

  // cancel：keepPartial=false 清理后回到 not_installed
  await h.post('/api/models/cancelled/start');
  await waitFor(async () => (await h.getJson('/api/models')).body.models.find((m: any) => m.id === 'cancelled').receivedBytes > 0, 'cancelled downloading');
  const cancel = await h.post('/api/models/cancelled/cancel', { keepPartial: false });
  assert.equal(cancel.status, 200);
  assert.notEqual(cancel.body.model.status, 'downloading');
  await waitFor(async () => (await h.getJson('/api/models')).body.models.find((m: any) => m.id === 'cancelled').status === 'not_installed', 'cancelled reset');
});

test('[#105-18] 错误处理：未知模型 404、非法操作 400、未知路由 404、非回环 host 拒绝', async (t) => {
  const h = await createHarness(t);
  await h.start();
  const unknown = await h.post('/api/models/no-such/start');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.ok, false);
  const badAction = await h.post('/api/models/whatever/explode');
  assert.equal(badAction.status, 400);
  const unknownRoute = await h.getJson('/nope');
  assert.equal(unknownRoute.status, 404);

  await assert.rejects(
    () => createModelManagerServer({ manager: h.manager, resolver: h.resolver, installRoot: h.root, port: 0, host: '0.0.0.0' }),
    /回环|loopback|127\.0\.0\.1/i,
    '模型管理器必须拒绝绑定非回环地址',
  );
  assert.match(h.server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('[#105-18] GET /api/events SSE：推送 event: progress + JSON 快照', async (t) => {
  const h = await createHarness(t);
  h.addModel({ id: 'sse', mode: 'drip' });
  await h.start();
  const url = `${h.server.url}/api/events`;
  const result = await new Promise<{ event: string; payload: string }>((resolve, reject) => {
    const req = http.get(url, (res) => {
      assert.equal(res.statusCode, 200);
      assert.match(String(res.headers['content-type']), /text\/event-stream/);
      let buffer = '';
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error('SSE 首次事件超时'));
      }, 10_000);
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const match = /event: progress\ndata: (.+)\n\n/.exec(buffer);
        if (match) {
          clearTimeout(timer);
          resolve({ event: 'progress', payload: match[1] });
          req.destroy();
        }
      });
      res.on('error', () => undefined);
    });
    req.on('error', (err) => reject(err));
  });
  assert.equal(result.event, 'progress');
  const parsed = JSON.parse(result.payload) as { installRoot: string; models: Array<{ id: string }> };
  assert.equal(parsed.installRoot, h.root);
  assert.ok(Array.isArray(parsed.models) && parsed.models.some((m) => m.id === 'sse'));
});