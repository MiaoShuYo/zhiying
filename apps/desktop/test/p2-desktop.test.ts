/**
 * P2 desktop regressions: #134 IPv6 manager URL, #135 managed PATH order, #136 /api/pull progress,
 * #127 corrupt install.json, #128 refusing an unmanaged Ollama listener.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { makeTempRoot, cleanupRegisteredTempDirs, REPO_ROOT, NODE_EXE } from './_helpers/temp';
import { makeInstallConfig, makeManifest } from './_helpers/fixtures';
import { resolveInstallLayout } from '../src/install-layout';
import { buildManagedServiceEnv } from '../src/service-env';
import { createModelDirectoryResolver } from '../src/model-paths';
import { ModelDownloadManager } from '../src/downloader';
import { createModelManagerServer } from '../src/download-server';
import { OllamaPullRunner } from '../src/ollama-pull';
import { verifyManagedOllama } from '../src/managed-ollama';

const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_TS = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'cli', 'model-manager-cli.ts');

function listen(server: http.Server, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve((server.address() as AddressInfo).port));
  });
}

/** A fake Ollama server streaming /api/pull NDJSON like the real server does. */
async function fakePullServer(lines: Array<Record<string, unknown>>, delayMs = 5) {
  const requests: Array<{ model?: string; stream?: boolean }> = [];
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/pull') { response.writeHead(404).end(); return; }
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', async () => {
      requests.push(JSON.parse(raw));
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (const line of lines) {
        if (response.destroyed) return;
        response.write(`${JSON.stringify(line)}\n`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      response.end();
    });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, port, requests, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test('[#135] managed runtime directories are moved to the front of PATH', t => {
  const root = makeTempRoot('p2-path');
  t.after(() => cleanupRegisteredTempDirs());
  const layout = resolveInstallLayout(root);
  const config = makeInstallConfig(root) as never;
  const managedFfmpeg = path.join(root, 'runtime', 'ffmpeg');
  const env = buildManagedServiceEnv({ layout, config, baseEnv: { PATH: `C:\\global\\ffmpeg;${managedFfmpeg}\\;C:\\other` } });
  const parts = String(env.PATH).split(';');
  const managedIndexes = parts.flatMap((part, index) => part.replace(/[\\/]+$/, '').toLowerCase() === managedFfmpeg.toLowerCase() ? [index] : []);
  assert.equal(managedIndexes.length, 1, `受管目录只出现一次：${env.PATH}`);
  assert.ok(managedIndexes[0] < parts.indexOf('C:\\global\\ffmpeg'), '受管 FFmpeg 排在全局 FFmpeg 之前');
  assert.ok(parts.includes('C:\\other'));
});

test('[#134] the manager accepts ::1 and advertises a bracketed URL', async t => {
  const root = makeTempRoot('p2-ipv6');
  t.after(() => cleanupRegisteredTempDirs());
  const layout = resolveInstallLayout(root);
  const resolver = createModelDirectoryResolver(layout);
  await resolver.ensureModelDirectories();
  const manager = new ModelDownloadManager({ manifest: makeManifest([]) as never, resolver, statePath: path.join(resolver.resolveTempDownloadPath(), 'state.json') });
  let server: Awaited<ReturnType<typeof createModelManagerServer>>;
  try {
    server = await createModelManagerServer({ manager, resolver, installRoot: root, port: 0, host: '::1' });
  } catch (error) {
    t.skip(`本机不支持 IPv6 回环：${(error as Error).message}`);
    await manager.dispose();
    return;
  }
  t.after(async () => { await server.close(); await manager.dispose(); });
  assert.match(server.url, /^http:\/\/\[::1\]:\d+$/);
  const response = await fetch(`${server.url}/api/models`);
  assert.equal(response.status, 200);
});

test('[#136] Ollama progress is read from the streaming /api/pull response', async t => {
  const fake = await fakePullServer([
    { status: 'pulling manifest' },
    { status: 'pulling abc', digest: 'sha256:abc', total: 1000, completed: 0 },
    { status: 'pulling abc', digest: 'sha256:abc', total: 1000, completed: 600 },
    { status: 'pulling abc', digest: 'sha256:abc', total: 1000, completed: 1000 },
    { status: 'verifying sha256 digest' },
    { status: 'writing manifest' },
    { status: 'success' },
  ]);
  t.after(() => fake.close());
  const events: Array<{ phase: string; completed?: number }> = [];
  const runner = new OllamaPullRunner({ exe: 'unused', model: 'qwen3:4b', baseUrl: fake.url, onEvent: event => events.push({ phase: event.phase, completed: event.completed }) });
  const result = await runner.pull();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.digest, 'sha256:abc');
  assert.deepEqual(fake.requests, [{ model: 'qwen3:4b', stream: true }]);
  assert.ok(events.some(event => event.completed === 600), '中间进度被解析');
  assert.equal(events.at(-1)?.phase, 'verify');

  const failing = await fakePullServer([{ status: 'pulling manifest' }, { error: 'pull model manifest: file does not exist' }]);
  t.after(() => failing.close());
  const missing = await new OllamaPullRunner({ exe: 'unused', model: 'nope:1b', baseUrl: failing.url }).pull();
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? '', /不存在模型 nope:1b/);

  const slow = await fakePullServer(Array.from({ length: 200 }, (_, index) => ({ status: 'pulling x', digest: 'sha256:x', total: 200, completed: index })), 20);
  t.after(() => slow.close());
  const abortable = new OllamaPullRunner({ exe: 'unused', model: 'qwen3:4b', baseUrl: slow.url });
  const pending = abortable.pull();
  await new Promise(resolve => setTimeout(resolve, 100));
  await abortable.abort();
  const aborted = await pending;
  assert.equal(aborted.aborted, true, '暂停/取消会中断 HTTP 请求');
});

test('[#128] a pull is refused when the configured port is free or held by another program', async t => {
  const root = makeTempRoot('p2-ollama-owner');
  t.after(() => cleanupRegisteredTempDirs());
  const layout = resolveInstallLayout(root);
  fs.mkdirSync(path.dirname(layout.serviceStatePath), { recursive: true });
  const free = http.createServer();
  const freePort = await listen(free);
  await new Promise<void>(resolve => free.close(() => resolve()));
  assert.match((await verifyManagedOllama(layout, freePort)) ?? '', /未运行/);

  const foreign = http.createServer((_request, response) => response.end('ollama'));
  const foreignPort = await listen(foreign);
  t.after(() => new Promise<void>(resolve => foreign.close(() => resolve())));
  assert.match((await verifyManagedOllama(layout, foreignPort)) ?? '', /拒绝下载/, '没有启动器状态时拒绝');
  fs.writeFileSync(layout.serviceStatePath, JSON.stringify({ instanceId: 'inst-1', startedAt: new Date().toISOString(), installRoot: root, version: '1.8.0', services: [{ id: 'ollama', pid: 999999, startedAtMs: Date.now(), commandLine: 'C:\\x\\ollama.exe serve', logFile: 'x.log' }] }));
  assert.match((await verifyManagedOllama(layout, foreignPort)) ?? '', /拒绝下载/, '占用者不是记录的受管进程时拒绝');
});

test('[#127] an existing but corrupt install.json is a configuration error', async t => {
  const root = makeTempRoot('p2-corrupt-config');
  t.after(() => cleanupRegisteredTempDirs());
  const layout = resolveInstallLayout(root);
  fs.mkdirSync(path.dirname(layout.installConfigPath), { recursive: true });
  fs.writeFileSync(layout.installConfigPath, '{ not json');
  const child = spawn(NODE_EXE, [TSX_CLI, CLI_TS, '--install-root', root, '--print-status'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
  assert.equal(code, 2, stderr);
  assert.match(stderr, /安装配置/);
});
