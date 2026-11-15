/**
 * #105-20 模型管理器 CLI（§2.5 cli/model-manager-cli.ts）：
 * --print-status JSON、--download 真实下载、--port 服务模式、默认清单回退、退出码契约。
 * 真实 spawn CLI（tsx），真实 HTTP fixture 源。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempRoot, cleanupRegisteredTempDirs, REPO_ROOT, NODE_EXE } from './_helpers/temp';
import { FixtureModelSource } from './_helpers/http-source';
import { makeManifest, makeHttpEntry } from './_helpers/fixtures';
import { deterministicBytes, writeFileDeep } from './_helpers/fsx';
import { getFreePort, waitForHttp, isPortOpen } from './_helpers/ports';
import { spawnCollect, killTree, waitForCondition } from './_helpers/processes';
import { resolveInstallLayout } from '../src/install-layout';

const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_TS = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'cli', 'model-manager-cli.ts');

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], env?: NodeJS.ProcessEnv): Promise<CliResult> {
  const child = spawn(NODE_EXE, [TSX_CLI, CLI_TS, ...args], {
    env: env ?? process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<number | null>((resolve) => {
    timer = setTimeout(() => {
      killTree(child.pid ?? -1);
      resolve(null);
    }, 120_000);
    timer.unref?.();
  });
  const status = await Promise.race([exit, timeout]);
  if (timer) clearTimeout(timer);
  return { status, stdout, stderr };
}

function parseJsonOutput(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  assert.ok(start >= 0 && end > start, `CLI 未输出 JSON：${stdout.slice(0, 500)}`);
  return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
}

/** 递归查找敏感字段名（token/password/secret/apikey/credential），忽略正常文件名如 tokenizer.json。 */
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

/** 创建带完整骨架与 install.json 的安装根。 */
async function makeRoot(t: test.TestContext, label = 'cli'): Promise<string> {
  const root = makeTempRoot(label);
  const layout = resolveInstallLayout(root);
  for (const dir of [layout.config, layout.data, layout.logs, layout.modelsRoot, path.join(layout.data, 'tmp')]) fs.mkdirSync(dir, { recursive: true });
  t.after(() => cleanupRegisteredTempDirs());
  return root;
}

test('[#105-20] --print-status --json：退出码 0 且输出安装根/模型根/磁盘/模型状态', async (t) => {
  const root = await makeRoot(t, 'cli-status');
  const result = await runCli(['--install-root', root, '--print-status', '--json']);
  assert.equal(result.status, 0, `CLI 退出码错误: ${result.status} ${result.stderr}`);
  const report = parseJsonOutput(result.stdout);
  assert.equal(report.installRoot, root);
  assert.equal(report.modelsRoot, path.join(root, 'models'));
  assert.ok(report.disk && typeof (report.disk as { freeBytes: number }).freeBytes === 'number');
  assert.ok(Array.isArray(report.models), 'report.models 必须是数组');
  // 未提供 --manifest 时回退默认清单（四类模型）
  const ids = (report.models as Array<{ id: string }>).map((m) => m.id);
  for (const id of ['qwen3-4b', 'f5-tts-base', 'vocos-mel-24khz', 'align-zh-xlsr']) assert.ok(ids.includes(id), `默认清单缺少 ${id}`);
  assert.ok((report.models as Array<{ status: string }>).every((m) => m.status === 'not_installed'));
  assert.deepEqual(findSensitiveKeys(report), [], 'CLI 输出不得包含凭据字段');
});

test('[#105-20] 缺少 --install-root 且无 M2V_INSTALL_ROOT：退出码 2 + 可读错误', async (t) => {
  await makeRoot(t, 'cli-noarg');
  const env = { ...process.env };
  delete env.M2V_INSTALL_ROOT;
  const result = await runCli(['--print-status'], env);
  assert.equal(result.status, 2, `缺少安装根应退出 2，实际 ${result.status}`);
  assert.match(result.stderr, /install-root|安装目录/i, `错误信息不可读: ${result.stderr}`);
});

test('[#105-20] 非法 install-root：退出码 2 + 可读错误', async (t) => {
  await makeRoot(t, 'cli-badroot');
  const result = await runCli(['--install-root', 'relative\\path', '--print-status']);
  assert.equal(result.status, 2, `非法安装根应退出 2，实际 ${result.status}`);
  assert.match(result.stderr, /无效|非法|路径|安装/i, `错误信息不可读: ${result.stderr}`);
});

test('[#105-20] --download 真实下载：退出码 0、文件落到 models/<installDir>、状态可追溯', async (t) => {
  const root = await makeRoot(t, 'cli-download');
  const source = new FixtureModelSource();
  const server = await source.start();
  t.after(() => server.close());
  const data = deterministicBytes(64 * 1024, 'cli-download');
  source.addFile('/dl/alpha/model.bin', { data, mode: 'ok' });
  const { entry } = makeHttpEntry({
    id: 'alpha',
    name: 'Alpha',
    files: [{ path: 'model.bin', data, url: `${server.url}/dl/alpha/model.bin` }],
    baseUrl: `${server.url}/dl`,
  });
  const manifestPath = path.join(root, 'manifest.json');
  await writeFileDeep(manifestPath, JSON.stringify(makeManifest([entry]), null, 2));

  const result = await runCli(['--install-root', root, '--manifest', manifestPath, '--download', 'alpha', '--json']);
  assert.equal(result.status, 0, `下载 CLI 应退出 0: ${result.status} ${result.stderr}`);
  const target = path.join(root, 'models', 'alpha', 'model.bin');
  assert.ok(fs.existsSync(target), `模型文件未安装到 models/<installDir>: ${target}`);
  assert.equal(fs.readFileSync(target).length, data.length);
  const report = parseJsonOutput(result.stdout);
  const alpha = (report.models as Array<{ id: string; status: string; verified?: string }>).find((m) => m.id === 'alpha');
  assert.equal(alpha?.status, 'installed');
  assert.equal(alpha?.verified, 'sha256');
  // state.json 位于 models/.downloads 内
  assert.ok(fs.existsSync(path.join(root, 'models', '.downloads', 'state.json')));
});

test('[#105-20] --download 失败：退出码 4 + 可读错误，不产生假完成', async (t) => {
  const root = await makeRoot(t, 'cli-download-fail');
  const source = new FixtureModelSource();
  const server = await source.start();
  t.after(() => server.close());
  const data = deterministicBytes(16 * 1024, 'cli-fail');
  source.addFile('/dl/beta/model.bin', { data, mode: '403' });
  const { entry } = makeHttpEntry({
    id: 'beta',
    name: 'Beta',
    files: [{ path: 'model.bin', data, url: `${server.url}/dl/beta/model.bin` }],
    baseUrl: `${server.url}/dl`,
  });
  const manifestPath = path.join(root, 'manifest.json');
  await writeFileDeep(manifestPath, JSON.stringify(makeManifest([entry]), null, 2));
  const result = await runCli(['--install-root', root, '--manifest', manifestPath, '--download', 'beta', '--json']);
  assert.equal(result.status, 4, `下载失败应退出 4，实际 ${result.status}: ${result.stderr}`);
  assert.ok(!fs.existsSync(path.join(root, 'models', 'beta', 'model.bin')), '失败不得提交安装文件');
  const report = parseJsonOutput(result.stdout);
  const beta = (report.models as Array<{ id: string; status: string; error?: { message: string } }>).find((m) => m.id === 'beta');
  assert.ok(['failed', 'corrupted'].includes(beta?.status ?? ''), `失败状态错误: ${beta?.status}`);
  assert.ok((beta?.error?.message ?? '').length > 0, '失败必须给出可读错误');
});

test('[#105-20] --port 服务模式：仅绑定 127.0.0.1 并用指定端口提供 API', async (t) => {
  const root = await makeRoot(t, 'cli-server');
  const port = await getFreePort();
  const child = spawnCollect(NODE_EXE, [TSX_CLI, CLI_TS, '--install-root', root, '--port', String(port)], { env: process.env });
  t.after(() => killTree(child.pid));
  const stdout = await waitForCondition(() => (child.stdout().includes('模型管理器已启动') ? child.stdout() : null), { timeoutMs: 60_000, label: 'CLI server started' });
  const match = /模型管理器已启动：(http:\/\/127\.0\.0\.1:(\d+))/.exec(stdout);
  assert.ok(match, `CLI 未打印回环 URL: ${stdout}`);
  assert.equal(match![2], String(port), `CLI 未使用 --port 指定端口: ${match![2]}`);
  assert.ok(await isPortOpen(port), '模型管理器端口应可连接');
  const response = await waitForHttp(`http://127.0.0.1:${port}/api/models`, { timeoutMs: 15_000 });
  const payload = JSON.parse(response.body) as { modelsRoot: string };
  assert.equal(payload.modelsRoot, path.join(root, 'models'));
  // 非 --open 时不调用浏览器：代码级约束（CLI 仅在 options.open 分支调用 openBrowser）
  const cliSource = fs.readFileSync(CLI_TS, 'utf8');
  assert.match(cliSource, /if \(options\.open\)[\s\S]{0,200}openBrowser/, '仅 --open 时才应打开浏览器');
  assert.ok(!/openBrowser\(/.test(cliSource.split('if (options.open)')[0]), '--open 之前不得调用 openBrowser');
  killTree(child.pid);
  await child.exit;
});
