/**
 * #103-7/#103-8/#103-16 安装 CLI（setup-cli.ts）：silent/交互向导/取消/完成页下载选择/退出码。
 * 真实 spawn CLI（tsx），真实安装到临时目录；快捷方式/注册表默认跳过以避免污染。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempRoot, cleanupRegisteredTempDirs, REPO_ROOT, NODE_EXE } from './_helpers/temp';
import { createPayloadTree } from './_helpers/fixtures';
import { killTree } from './_helpers/processes';
import { loadInstallConfig } from '../src/install-layout';

const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_TS = path.join(REPO_ROOT, 'apps', 'desktop', 'src', 'cli', 'setup-cli.ts');

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runSetupCli(args: string[], opts: { stdin?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(NODE_EXE, [TSX_CLI, CLI_TS, ...args], {
      env: opts.env ?? process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
      resolve({ status: null, stdout, stderr: `${stderr}\n[timeout 120s]` });
    }, 120_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: `${stderr}\n${err.message}` });
    });
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    else child.stdin?.end();
  });
}

function parseJson(stdout: string): Record<string, any> {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  assert.ok(start >= 0 && end > start, `CLI 未输出 JSON: ${stdout.slice(0, 600)}`);
  return JSON.parse(stdout.slice(start, end + 1));
}

async function makePayload(t: test.TestContext, label: string): Promise<string> {
  const payload = path.join(makeTempRoot(label), 'payload');
  await createPayloadTree(payload, { version: '1.8.0' });
  t.after(() => cleanupRegisteredTempDirs());
  return payload;
}

test('[#103-8] silent 安装：exit 0，完整骨架 + install.json', async (t) => {
  const payload = await makePayload(t, 'setup-silent');
  const base = makeTempRoot('setup-silent-root');
  t.after(() => cleanupRegisteredTempDirs());
  const target = path.join(base, '知影 安装');
  const result = await runSetupCli(['--payload', payload, '--target', target, '--silent', '--no-shortcut', '--no-registry', '--json']);
  assert.equal(result.status, 0, `silent 安装失败: ${result.stderr}\n${result.stdout.slice(0, 800)}`);
  const parsed = parseJson(result.stdout);
  assert.equal(parsed.ok, true, `安装结果 ok=false: ${JSON.stringify(parsed.errors)}`);
  assert.equal(path.resolve(parsed.plan.targetRoot), path.resolve(target));
  assert.ok(fs.existsSync(parsed.logPath), '安装日志不存在');
  for (const rel of ['Zhiying.exe', 'app', 'runtime', 'models', 'data', 'config', 'install.json'.replace('install.json', 'config/install.json'), 'logs']) {
    assert.ok(fs.existsSync(path.join(target, rel)), `骨架缺少 ${rel}`);
  }
  const config = await loadInstallConfig(target);
  assert.equal(config.version, '1.8.0');
  assert.equal(config.installRoot, target);
});

test('[#103-7] 交互向导：显示产品名/版本/发行者/说明，stdin 驱动选择目录并完成安装', async (t) => {
  const payload = await makePayload(t, 'setup-interactive');
  const base = makeTempRoot('setup-interactive-root');
  t.after(() => cleanupRegisteredTempDirs());
  const target = path.join(base, '交互 安装 目录');
  // 回答：目录、快捷方式 n、下载选择 later、确认 Y
  const stdin = `${target}\nn\nlater\nY\n`;
  const result = await runSetupCli(['--payload', payload, '--interactive', '--no-registry'], { stdin });
  assert.equal(result.status, 0, `交互安装失败: ${result.stderr}\n${result.stdout.slice(0, 1200)}`);
  for (const text of ['产品名称', '版本', '发行者', '说明', '安装目录']) {
    assert.ok(result.stdout.includes(text), `向导缺少 ${text} 展示: ${result.stdout.slice(0, 800)}`);
  }
  assert.ok(fs.existsSync(path.join(target, 'config', 'install.json')), '交互安装未写入 config/install.json');
  const config = await loadInstallConfig(target);
  assert.equal(config.modelsDownloadChoice, 'later');
});

test('[#103-7] 交互向导取消：exit 2，无安装残留', async (t) => {
  const payload = await makePayload(t, 'setup-cancel');
  const base = makeTempRoot('setup-cancel-root');
  t.after(() => cleanupRegisteredTempDirs());
  const target = path.join(base, '取消 目录');
  const stdin = `${target}\nn\nlater\nn\n`; // 最后确认答 n → 取消
  const result = await runSetupCli(['--payload', payload, '--interactive', '--no-registry'], { stdin });
  assert.equal(result.status, 2, `取消应 exit 2，实际 ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /已取消/);
  assert.ok(!fs.existsSync(target) || fs.readdirSync(target).length === 0, `取消后不得留下安装文件: ${fs.existsSync(target) ? fs.readdirSync(target).join(',') : 'not-exists'}`);
});

test('[#103-16] 完成页选择：--download-models now 记录并打印管理器命令（--no-launch 不启动），later 正常完成', async (t) => {
  const payload = await makePayload(t, 'setup-choice');
  const base = makeTempRoot('setup-choice-root');
  t.after(() => cleanupRegisteredTempDirs());

  const targetNow = path.join(base, 'target-now');
  const now = await runSetupCli(['--payload', payload, '--target', targetNow, '--silent', '--no-shortcut', '--no-registry', '--download-models', 'now', '--no-launch']);
  assert.equal(now.status, 0, now.stderr);
  assert.match(now.stdout, /模型管理器命令/, `--no-launch 应打印管理器命令: ${now.stdout.slice(-800)}`);
  assert.match(now.stdout, /--port 8790/, '管理器命令应含默认端口 8790');
  assert.match(now.stdout, /--install-root/, '管理器命令应含 install-root');
  const configNow = await loadInstallConfig(targetNow);
  assert.equal(configNow.modelsDownloadChoice, 'now');

  // JSON 模式：launchModelManager=true
  const targetJson = path.join(base, 'target-json');
  const jsonRes = await runSetupCli(['--payload', payload, '--target', targetJson, '--silent', '--no-shortcut', '--no-registry', '--download-models', 'now', '--no-launch', '--json']);
  assert.equal(jsonRes.status, 0, jsonRes.stderr);
  const parsed = parseJson(jsonRes.stdout);
  assert.equal(parsed.launchModelManager, true, 'downloadModels=now 时 launchModelManager 必须为 true');

  // later：正常完成、无管理器命令
  const targetLater = path.join(base, 'target-later');
  const later = await runSetupCli(['--payload', payload, '--target', targetLater, '--silent', '--no-shortcut', '--no-registry', '--download-models', 'later']);
  assert.equal(later.status, 0, later.stderr);
  assert.ok(!later.stdout.includes('模型管理器命令'), 'later 不应启动/打印模型管理器命令');
  const configLater = await loadInstallConfig(targetLater);
  assert.equal(configLater.modelsDownloadChoice, 'later');
});

test('[#103-8] 安装前校验失败：受保护目录/缺 payload/不完整 payload → exit 3 且无安装', async (t) => {
  const payload = await makePayload(t, 'setup-bad');
  const base = makeTempRoot('setup-bad-root');
  t.after(() => cleanupRegisteredTempDirs());

  const protectedTarget = 'C:\\Program Files\\Zhiying';
  const result = await runSetupCli(['--payload', payload, '--target', protectedTarget, '--silent', '--no-shortcut', '--no-registry']);
  assert.equal(result.status, 3, `受保护目录应 exit 3，实际 ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /安装前校验失败|受保护|可写|目录不可用/);
  assert.ok(!fs.existsSync('C:\\Program Files\\Zhiying'), '受保护目录不得被创建');

  const missingPayload = await runSetupCli(['--payload', path.join(base, 'no-such-payload'), '--target', path.join(base, 't1'), '--silent']);
  assert.equal(missingPayload.status, 3);
  assert.match(missingPayload.stderr, /安装包|payload|不完整/);

  const incomplete = path.join(base, 'incomplete-payload');
  fs.mkdirSync(incomplete, { recursive: true });
  fs.writeFileSync(path.join(incomplete, 'version.txt'), '1.8.0');
  const incompleteRes = await runSetupCli(['--payload', incomplete, '--target', path.join(base, 't2'), '--silent']);
  assert.equal(incompleteRes.status, 3);
  assert.match(incompleteRes.stderr, /安装包|不完整/);
});

test('[#103-14] 安装过程失败：exit 4 + 可读错误 + 安装日志（回滚）', async (t) => {
  const payload = await makePayload(t, 'setup-fail');
  const base = makeTempRoot('setup-fail-root');
  t.after(() => cleanupRegisteredTempDirs());
  const target = path.join(base, 'target-with-file-models');
  fs.mkdirSync(target, { recursive: true });
  // 用同名文件阻塞 models 目录创建 → 安装阶段失败（非校验阶段）
  fs.writeFileSync(path.join(target, 'models'), 'blocked');
  const result = await runSetupCli(['--payload', payload, '--target', target, '--silent', '--no-shortcut', '--no-registry']);
  assert.equal(result.status, 4, `安装阶段失败应 exit 4，实际 ${result.status}: ${result.stderr}\n${result.stdout.slice(0, 800)}`);
  assert.match(result.stderr, /安装失败/);
  assert.match(result.stderr, /安装日志/, '失败必须输出日志路径');
  assert.ok(!fs.existsSync(path.join(target, 'config', 'install.json')), '失败后不得留下 install.json');
});
