/**
 * #102 启动器 CLI（§2.6 cli/launcher-cli.ts）：退出码契约、--status/--stop、packaged 启动/停止闭环。
 * 真实安装目录 + 真实子进程（fixture 服务）；端口使用临时端口避免与系统 Ollama 冲突。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, spawn as spawnAsync } from 'node:child_process';
import { makeTempRoot, cleanupRegisteredTempDirs, REPO_ROOT, NODE_EXE } from './_helpers/temp';
import { createPayloadTree } from './_helpers/fixtures';
import { writeFakeServiceScript } from './_helpers/fake-service';
import { getFreePorts } from './_helpers/ports';
import { killTree, waitForCondition, isAlive } from './_helpers/processes';
import { resolveInstallLayout, loadInstallConfig, writeInstallConfig } from '../src/install-layout';
import { executeInstall, planInstall } from '../src/installer';
import { parseLauncherOptions } from '../src/cli/launcher-cli';

const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_TS = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'cli', 'launcher-cli.ts');

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runLauncherCli(args: string[], env?: NodeJS.ProcessEnv, timeoutMs = 120_000): Promise<CliResult> {
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
    const timer = setTimeout(() => {
      killTree(child.pid ?? -1);
      resolve({ status: null, stdout, stderr: `${stderr}\n[timeout ${timeoutMs}ms]` });
    }, timeoutMs);
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
  assert.ok(start >= 0 && end > start, `CLI 未输出 JSON: ${stdout.slice(0, 600)}`);
  return JSON.parse(stdout.slice(start, end + 1));
}

interface InstalledRoot {
  root: string;
  layout: ReturnType<typeof resolveInstallLayout>;
}

/** 安装 lite payload 并把 fixtures/node 换成真实可执行文件。 */
async function installLite(t: test.TestContext, label: string): Promise<InstalledRoot> {
  const base = makeTempRoot(label);
  t.after(() => cleanupRegisteredTempDirs());
  const payload = path.join(base, 'payload');
  await createPayloadTree(payload, { version: '1.8.0' });
  const root = path.join(base, 'install 目录');
  const plan = await planInstall({ payloadRoot: payload, targetRoot: root, version: '1.8.0', profile: 'lite' });
  const result = await executeInstall(plan, { createShortcut: async () => undefined, writeRegistry: async () => undefined });
  assert.equal(result.ok, true, `安装 fixture 失败: ${result.errors.join('|')}`);
  const layout = resolveInstallLayout(root);
  // 真实 node（hardlink，跨卷失败则复制）
  const nodeTarget = path.join(layout.runtime, 'node', 'node.exe');
  fs.rmSync(nodeTarget, { force: true });
  try {
    fs.linkSync(process.execPath, nodeTarget);
  } catch {
    fs.copyFileSync(process.execPath, nodeTarget);
  }
  // 可执行的 fixture 服务
  const work = path.join(base, 'fixture-work');
  const script = writeFakeServiceScript(work);
  for (const name of ['python', 'web', 'worker', 'ollama']) {
    fs.copyFileSync(script, path.join(layout.app, 'fixtures', `${name}.mjs`));
  }
  fs.copyFileSync(script, path.join(layout.app, 'desktop', 'cli', 'model-manager-cli.mjs'));
  // 临时端口，避免与系统 Ollama/3000 端口冲突
  const [web, python, ollama, manager] = await getFreePorts(4);
  const config = await loadInstallConfig(root);
  config.ports = { web, python, ollama, manager };
  await writeInstallConfig(config);
  return { root, layout };
}

async function stopIfRunning(root: string): Promise<void> {
  const layout = resolveInstallLayout(root);
  try {
    const state = JSON.parse(fs.readFileSync(layout.serviceStatePath, 'utf8')) as { services?: Array<{ pid: number }> };
    for (const service of state.services ?? []) killTree(service.pid);
  } catch {
    /* 无状态 */
  }
}

test('[#102-14] parseLauncherOptions：--status/--stop/--no-browser/--json/--install-root 解析', () => {
  const options = parseLauncherOptions(['--install-root', 'D:\\Zhiying', '--status', '--json', '--no-browser', '--stop']);
  assert.equal(options.installRoot, 'D:\\Zhiying');
  assert.equal(options.status, true);
  assert.equal(options.stop, true);
  assert.equal(options.json, true);
  assert.equal(options.noBrowser, true);
  assert.equal(parseLauncherOptions(['--dev', '--repo-root', 'D:\\repo']).dev, true);
});

test('[#102-14/#102-16] packaged CLI 启动→--status→--stop 闭环（exit 0，fixture health 通过）', async (t) => {
  const { root } = await installLite(t, 'cli-start');
  t.after(() => stopIfRunning(root));
  const started = await runLauncherCli(['--install-root', root, '--no-browser', '--exit-after-start', '--json']);
  assert.equal(started.status, 0, `CLI 启动失败: ${started.status} ${started.stderr}\n${started.stdout.slice(0, 800)}`);
  const result = parseJson(started.stdout);
  assert.equal(result.status, 'started', `启动结果错误: ${JSON.stringify(result)}`);
  assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const ids = (result.services as Array<{ id: string }>).map((s) => s.id);
  for (const id of ['python', 'web', 'worker']) assert.ok(ids.includes(id), `服务未启动: ${id}`);

  // --status --json：exit 0 + running
  const status = await runLauncherCli(['--install-root', root, '--status', '--json']);
  assert.equal(status.status, 0, `--status 应 exit 0: ${status.stderr}`);
  const statusJson = parseJson(status.stdout);
  assert.equal(statusJson.running, true);
  assert.ok((statusJson.services as Array<{ alive: boolean }>).every((s) => s.alive === true), '所有服务应存活');

  // --stop --json：exit 0 + 清理状态
  const stopped = await runLauncherCli(['--install-root', root, '--stop', '--json']);
  assert.equal(stopped.status, 0, `--stop 应 exit 0: ${stopped.stderr}`);
  const stoppedJson = parseJson(stopped.stdout);
  assert.ok((stoppedJson.stopped as string[]).length >= 1, `stop 未报告停止服务: ${JSON.stringify(stoppedJson)}`);
  const layout = resolveInstallLayout(root);
  await waitForCondition(() => !fs.existsSync(layout.serviceStatePath), { timeoutMs: 10_000, label: 'state file removed' });

  // 停止后 --status：未运行 → exit 3
  const after = await runLauncherCli(['--install-root', root, '--status', '--json']);
  assert.equal(after.status, 3, `停止后 --status 应 exit 3，实际 ${after.status}`);
  assert.equal(parseJson(after.stdout).running, false);
});

test('[#102-14] 配置错误：无 install.json/相对路径 → exit 2；空状态 --stop → exit 0', async (t) => {
  const base = makeTempRoot('cli-config');
  t.after(() => cleanupRegisteredTempDirs());
  // 无 install.json（目录存在）
  const emptyRoot = path.join(base, 'empty-install');
  fs.mkdirSync(emptyRoot, { recursive: true });
  const noConfig = await runLauncherCli(['--install-root', emptyRoot, '--status']);
  assert.equal(noConfig.status, 2, `缺少 install.json 应 exit 2，实际 ${noConfig.status}: ${noConfig.stderr}`);
  assert.match(noConfig.stderr, /配置|install\.json|无效/i);

  // 相对路径
  const badRoot = await runLauncherCli(['--install-root', 'relative\\root', '--status']);
  assert.equal(badRoot.status, 2);
  assert.match(badRoot.stderr, /无效|配置|安装|路径/i);

  // 空状态 --stop 幂等
  const { root } = await installLite(t, 'cli-stop-empty');
  const stopEmpty = await runLauncherCli(['--install-root', root, '--stop', '--json']);
  assert.equal(stopEmpty.status, 0, stopEmpty.stderr);
  assert.deepEqual(parseJson(stopEmpty.stdout), { stopped: [], skipped: [] });
});
