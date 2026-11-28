/**
 * #133 安装器启动壳临时目录选择：权限被拒时的集成测试（真实 Zhiying-Setup.exe，不 mock）。
 *
 * 使用启动壳的测试专用探针（仅当同时设置 ZHIYING_BOOTSTRAP_PROBE=1 与 ZHIYING_BOOTSTRAP_STAGING_ROOTS
 * 时生效）：只执行 staging 选择、输出 JSON、清理自己创建的目录后退出，不解出也不启动内嵌安装器。
 * 所有 exe 与候选目录都放在 %TEMP%（workspace 外），避免仓库目录的 Low 完整性标签影响结果。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './_helpers/temp';
import { createStagingDir, stageExecutable, removeStagingDir } from './_helpers/gui';

const SETUP = path.join(REPO_ROOT, 'dist', 'Zhiying-Setup.exe');

interface ProbeResult {
  ok: boolean;
  selected: string | null;
  selectedRoot: string | null;
  childTemp: string | null;
  childTmp: string | null;
  parentTemp: string | null;
  parentEnvUnchanged: boolean;
  cleaned: boolean;
  roots: string[];
  failures: string[];
}

const norm = (value: string | null | undefined) => path.resolve(value ?? '').replace(/[\\/]+$/, '').toLowerCase();
const account = (() => {
  const user = process.env.USERNAME ?? os.userInfo().username;
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
})();

/**
 * Gives a test candidate root the ACL of a real LocalAppData folder: not inherited, owned by the
 * current user, full control only for the current user, SYSTEM and Administrators. Directories
 * created under %TEMP% inherit its ACL, which can grant other accounts rights to replace entries;
 * the bootstrapper rightly refuses such roots (#124), so without this every candidate would fail
 * for that reason instead of the permission case under test.
 */
function makePrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const run = (args: string[]) => {
    const result = spawnSync('icacls.exe', [dir, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, `icacls ${args.join(' ')} 失败：${result.stdout}${result.stderr}`);
  };
  run(['/setowner', account]);
  run(['/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']);
}

function denyWrite(dir: string): boolean {
  spawnSync('icacls.exe', [dir, '/deny', `${account}:(OI)(CI)(W)`], { encoding: 'utf8', windowsHide: true });
  try {
    fs.mkdirSync(path.join(dir, `probe-${Date.now()}`));
    return false; // 拒绝写入没有生效（例如环境不允许修改 ACL）
  } catch {
    return true;
  }
}

function restore(dir: string): void {
  spawnSync('icacls.exe', [dir, '/remove:d', account], { encoding: 'utf8', windowsHide: true });
}

function runDirs(dir: string): string[] {
  try { return fs.readdirSync(dir).filter(name => name.startsWith('run-')); } catch { return []; }
}

function setup(t: test.TestContext): { exe: string; base: string } | undefined {
  if (process.platform !== 'win32') { t.skip('仅 Windows'); return undefined; }
  if (!fs.existsSync(SETUP)) { t.skip('dist/Zhiying-Setup.exe 未构建（pnpm build:installer）'); return undefined; }
  // 旧版启动壳没有探针：直接运行会启动真实安装器。探针变量名作为 .NET 字符串常量以 UTF-16LE 存在于 exe 中，
  // 找不到就说明安装包没有用当前源码重建，此时失败并提示，绝不运行它。
  assert.ok(fs.readFileSync(SETUP).includes(Buffer.from('ZHIYING_BOOTSTRAP_PROBE', 'utf16le')),
    'dist/Zhiying-Setup.exe 是旧版启动壳（不含 #133 探针），请先运行 pnpm build:installer 重建安装包');
  const staging = createStagingDir('zhiying-133-exe');
  const { exe } = stageExecutable(SETUP, staging);
  const base = createStagingDir('zhiying-133-roots');
  t.after(() => { removeStagingDir(staging); removeStagingDir(base); });
  return { exe, base };
}

function probe(exe: string, roots: string[], base: string): { status: number | null; result: ProbeResult; stderr: string } {
  const out = path.join(base, `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  const run = spawnSync(exe, [], {
    env: { ...process.env, ZHIYING_BOOTSTRAP_PROBE: '1', ZHIYING_BOOTSTRAP_STAGING_ROOTS: roots.join(';'), ZHIYING_BOOTSTRAP_PROBE_OUT: out },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  assert.ok(fs.existsSync(out), `探针未输出结果（status=${run.status} error=${run.error?.message ?? ''}）：${run.stdout}${run.stderr}`);
  return { status: run.status, result: JSON.parse(fs.readFileSync(out, 'utf8')) as ProbeResult, stderr: run.stderr };
}

test('[#133] TEMP/TMP 被拒、LocalAppData 可写：选中 LocalAppData，只改子进程 TEMP/TMP，并清理目录', t => {
  const ctx = setup(t);
  if (!ctx) return;
  const localAppData = path.join(ctx.base, 'LocalAppData', 'Zhiying', 'InstallerStaging');
  const temp = path.join(ctx.base, 'Temp');
  makePrivate(localAppData);
  makePrivate(temp);
  t.after(() => restore(temp));
  if (!denyWrite(temp)) { t.skip('当前环境无法通过 ACL 拒绝写入'); return; }
  const parentTemp = process.env.TEMP;
  const { status, result } = probe(ctx.exe, [localAppData, temp], ctx.base);
  assert.equal(status, 0, `探针未选中目录：${JSON.stringify(result, null, 2)}`);
  assert.equal(result.ok, true);
  assert.equal(norm(result.selectedRoot), norm(localAppData));
  assert.equal(norm(result.childTemp), norm(result.selected), '子进程 TEMP 指向私有 staging');
  assert.equal(norm(result.childTmp), norm(result.selected), '子进程 TMP 指向私有 staging');
  assert.equal(result.parentEnvUnchanged, true, '启动壳自身的 TEMP/TMP 不变');
  assert.equal(norm(result.parentTemp), norm(parentTemp), '父进程环境未被修改');
  assert.equal(result.cleaned, true);
  assert.deepEqual(runDirs(localAppData), [], '不残留 run-* 目录');
  assert.equal(process.env.TEMP, parentTemp, '测试进程环境未被修改');
});

test('[#133] LocalAppData staging 被拒、TEMP 可写：回退到 TEMP 并记录失败原因', t => {
  const ctx = setup(t);
  if (!ctx) return;
  const localAppData = path.join(ctx.base, 'LocalAppData', 'Zhiying', 'InstallerStaging');
  const temp = path.join(ctx.base, 'Temp');
  makePrivate(localAppData);
  makePrivate(temp);
  t.after(() => restore(localAppData));
  if (!denyWrite(localAppData)) { t.skip('当前环境无法通过 ACL 拒绝写入'); return; }
  const { status, result } = probe(ctx.exe, [localAppData, temp], ctx.base);
  assert.equal(status, 0, `探针未选中目录：${JSON.stringify(result, null, 2)}`);
  assert.equal(result.ok, true);
  assert.equal(norm(result.selectedRoot), norm(temp), '回退到可写的 TEMP');
  assert.equal(result.failures.length, 1, JSON.stringify(result.failures));
  assert.ok(result.failures[0].toLowerCase().startsWith(norm(localAppData)), `失败记录指明被拒的目录：${result.failures[0]}`);
  assert.equal(norm(result.childTemp), norm(result.selected));
  assert.equal(result.cleaned, true);
  assert.deepEqual(runDirs(temp), []);
  assert.deepEqual(runDirs(localAppData), []);
});

test('[#133] 所有候选目录都被拒：退出码 5、列出全部失败、不残留目录、不启动安装器', t => {
  const ctx = setup(t);
  if (!ctx) return;
  const roots = ['LocalAppData', 'Temp', 'Tmp'].map(name => path.join(ctx.base, name));
  for (const root of roots) makePrivate(root);
  t.after(() => { for (const root of roots) restore(root); });
  for (const root of roots) if (!denyWrite(root)) { t.skip('当前环境无法通过 ACL 拒绝写入'); return; }
  const before = spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq Zhiying-Setup-Payload.exe', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout;
  const { status, result } = probe(ctx.exe, roots, ctx.base);
  assert.equal(status, 5);
  assert.equal(result.ok, false);
  assert.equal(result.selected, null);
  assert.equal(result.failures.length, roots.length, JSON.stringify(result.failures));
  for (const root of roots) assert.deepEqual(runDirs(root), [], `不残留 run-*：${root}`);
  const after = spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq Zhiying-Setup-Payload.exe', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout;
  assert.equal(/Zhiying-Setup-Payload\.exe/i.test(after), /Zhiying-Setup-Payload\.exe/i.test(before), '探针模式不启动内嵌安装器');
});
