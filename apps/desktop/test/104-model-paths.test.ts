/**
 * #104 统一模型路径解析与路径安全（§2.4）。
 * 覆盖：modelsRoot 恒定、安全 installDir、CWD 无关、installPath 校验、可写/空间探测、
 * 长路径（300 字符）、junction 越界保护、ensureModelDirectories 幂等、describe 无凭据、数据/模型解耦。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempRoot, makeChineseSpaceDir, cleanupRegisteredTempDirs } from './_helpers/temp';
import { createInstallLayoutDirs } from './_helpers/fixtures';
import { snapshotEnv, diffEnv } from './_helpers/env';
import {
  createModelDirectoryResolver,
  validateInstallPath,
  isPathWithin,
  assertSafeRelativePath,
  toExtendedLengthPath,
  probeWritableDirectory,
  assertNoReparseEscape,
  PROTECTED_DIRS,
} from '../src/model-paths';
import { resolveInstallLayout } from '../src/install-layout';

function norm(p: string): string {
  return path.resolve(p).toLowerCase();
}

const SECRET_KEYS = ['token', 'password', 'secret', 'apikey', 'api_key', 'credential', 'auth'];

test('[#104-1] resolveModelsRoot 恒为 <root>\\models 且子目录精确符合 §2.2', async (t) => {
  const root = makeTempRoot('paths-root');
  t.after(() => cleanupRegisteredTempDirs());
  const resolver = createModelDirectoryResolver(root);
  assert.equal(resolver.modelsRoot, path.join(root, 'models'));
  assert.equal(norm(resolver.resolveModelsRoot()), norm(path.join(root, 'models')));
  assert.equal(norm(resolver.resolveOllamaStore()), norm(path.join(root, 'models', 'ollama')));
  assert.equal(norm(resolver.resolveF5TtsRoot()), norm(path.join(root, 'models', 'f5-tts', 'F5TTS_v1_Base')));
  assert.equal(norm(resolver.resolveVocosRoot()), norm(path.join(root, 'models', 'f5-tts', 'vocos-mel-24khz')));
  assert.equal(norm(resolver.resolveHfCache()), norm(path.join(root, 'models', 'huggingface')));
  assert.equal(norm(resolver.resolveTempDownloadPath()), norm(path.join(root, 'models', '.downloads')));
  // 传入 InstallLayout 结果必须一致
  const fromLayout = createModelDirectoryResolver(resolveInstallLayout(root));
  assert.equal(norm(fromLayout.modelsRoot), norm(resolver.modelsRoot));
  assert.equal(norm(fromLayout.resolveOllamaStore()), norm(resolver.resolveOllamaStore()));
});

test('[#104-1] 中文+空格安装根：resolver 所有路径保留原始字符且都在 modelsRoot 内', async (t) => {
  const base = makeTempRoot('paths-cn');
  const root = makeChineseSpaceDir(base, '模型 路径 测试');
  t.after(() => cleanupRegisteredTempDirs());
  const resolver = createModelDirectoryResolver(root);
  for (const p of [resolver.resolveModelsRoot(), resolver.resolveOllamaStore(), resolver.resolveF5TtsRoot(), resolver.resolveVocosRoot(), resolver.resolveHfCache(), resolver.resolveTempDownloadPath()]) {
    assert.ok(p.includes('模型 路径 测试'), `路径丢失中文字符: ${p}`);
    assert.ok(isPathWithin(resolver.modelsRoot, p), `路径越出 modelsRoot: ${p}`);
  }
});

test('[#104-2] resolveModelInstallPath 拒绝穿越/绝对/UNC/ADS，接受安全相对目录', async (t) => {
  const root = makeTempRoot('paths-install');
  t.after(() => cleanupRegisteredTempDirs());
  const resolver = createModelDirectoryResolver(root);

  for (const good of ['f5-tts/F5TTS_v1_Base', 'vocos', 'huggingface/models--org--repo', 'a/b/c.bin']) {
    const p = resolver.resolveModelInstallPath(good);
    assert.ok(path.isAbsolute(p), `installPath 必须绝对: ${p}`);
    assert.ok(isPathWithin(resolver.modelsRoot, p), `installPath 越界: ${p}`);
    assert.ok(p.toLowerCase().startsWith(resolver.modelsRoot.toLowerCase() + path.sep), `installPath 不在 modelsRoot 下: ${p}`);
  }

  const bad = [
    '..',
    '../evil',
    '..\\evil',
    'a/../../evil',
    'a\\..\\..\\evil',
    `${root}\\evil`,
    'C:\\Windows\\System32',
    '\\\\server\\share\\model',
    '\\\\?\\C:\\model',
    'a:b',
    'file.bin:stream',
    'CON',
    'nul',
    '',
  ];
  for (const input of bad) {
    assert.throws(() => resolver.resolveModelInstallPath(input), (err: unknown) => {
      assert.ok(err instanceof Error && err.message.trim().length > 0, `非法 installDir 报错不可读: ${input}`);
      return true;
    }, `resolveModelInstallPath 错误接受了: ${JSON.stringify(input)}`);
  }
});

test('[#104-3] 解析结果不依赖 CWD 与环境变量（切换 CWD 后不变）', async (t) => {
  const root = makeTempRoot('paths-cwd');
  const elsewhere = makeTempRoot('paths-cwd2');
  t.after(() => cleanupRegisteredTempDirs());
  const resolver = createModelDirectoryResolver(root);
  const pathsBefore = [resolver.resolveModelsRoot(), resolver.resolveModelsRoot(), resolver.resolveOllamaStore(), resolver.resolveF5TtsRoot()];
  const envBefore = snapshotEnv();
  const originalCwd = process.cwd();
  try {
    process.chdir(elsewhere);
    const resolver2 = createModelDirectoryResolver(root);
    assert.deepEqual(
      [resolver2.resolveModelsRoot(), resolver2.resolveModelsRoot(), resolver2.resolveOllamaStore(), resolver2.resolveF5TtsRoot()],
      pathsBefore,
    );
  } finally {
    process.chdir(originalCwd);
  }
  assert.deepEqual(diffEnv(envBefore, snapshotEnv()), [], '解析过程修改了 process.env');
});

test('[#104-4] validateInstallPath 拒绝相对/盘符根/受保护/穿越/不存在盘/非法字符/ADS', async (t) => {
  const root = makeTempRoot('paths-validate');
  const outside = makeTempRoot('paths-validate-outside');
  t.after(() => cleanupRegisteredTempDirs());

  // 合法路径（中文 + 空格 + 可写）
  const good = await validateInstallPath(path.join(root, '知影 安装'));
  assert.equal(good.ok, true, `合法可写路径被拒绝: ${JSON.stringify(good)}`);
  assert.ok(good.normalized && path.isAbsolute(good.normalized), 'normalized 必须是绝对路径');

  const illegalRoots = [
    'relative\\dir',
    '..',
    'C:\\',
    'C:\\Windows\\Zhiying',
    'C:\\Windows\\System32\\Zhiying',
    'C:\\Program Files\\Zhiying',
    path.join(outside, 'bad<name>'),
    path.join(outside, 'bad|name'),
    path.join(outside, 'bad"name'),
    path.join(outside, 'file.txt:evilstream'),
    '\\\\server\\share\\zhiying',
    '\\\\?\\C:\\zhiying',
  ];
  for (const bad of illegalRoots) {
    const result = await validateInstallPath(bad);
    assert.equal(result.ok, false, `非法路径被接受: ${bad}`);
    assert.ok(result.errors.length > 0 && result.errors.every((e) => typeof e === 'string' && e.trim().length > 0), `错误信息不可读: ${bad}`);
  }

  // 不存在的盘符
  const used = new Set(['C', 'D']);
  const freeLetters = 'EFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((l) => !used.has(l));
  const nonexistentDrive = `${freeLetters[0]}:\\Zhiying`;
  const result = await validateInstallPath(nonexistentDrive);
  assert.equal(result.ok, false, `不存在的盘被接受: ${nonexistentDrive}`);
  assert.ok(result.errors.length > 0);

  // PROTECTED_DIRS 内容（System32 由 Windows 父目录覆盖，行为断言见上方 illegalRoots）
  assert.ok(PROTECTED_DIRS.some((d) => /windows/i.test(d)), 'PROTECTED_DIRS 应含 Windows');
  assert.ok(PROTECTED_DIRS.some((d) => /program files/i.test(d)), 'PROTECTED_DIRS 应含 Program Files');
  assert.ok(PROTECTED_DIRS.some((d) => /programdata/i.test(d)), 'PROTECTED_DIRS 应含 ProgramData');
});

test('[#104-5] 可写性与剩余空间探测与真实权限一致', async (t) => {
  const root = makeTempRoot('paths-writable');
  const denied = makeTempRoot('paths-denied');
  t.after(() => cleanupRegisteredTempDirs());

  assert.equal(await probeWritableDirectory(root), true, '正常目录必须可写');

  // 用 ACL 显式拒绝当前用户写权限；以“实际能否写”为真值断言探测函数
  const user = process.env.USERNAME ?? os.userInfo().username;
  const domain = process.env.USERDOMAIN;
  const account = domain ? `${domain}\\${user}` : user;
  const deny = spawnSync('icacls.exe', [denied, '/deny', `${account}:(OI)(CI)(W)`], { encoding: 'utf8', windowsHide: true });
  try {
    let actuallyWritable = true;
    try {
      fs.writeFileSync(path.join(denied, 'probe.txt'), 'x');
    } catch {
      actuallyWritable = false;
    }
    const probed = await probeWritableDirectory(denied);
    assert.equal(probed, actuallyWritable, `probeWritableDirectory=${probed} 与真实可写=${actuallyWritable} 不一致 (icacls status ${deny.status})`);
    if (!actuallyWritable) {
      const validation = await validateInstallPath(denied, { requireWritable: true });
      assert.equal(validation.ok, false, '不可写目录在 requireWritable 时必须被拒绝');
      assert.ok(validation.errors.length > 0);
    }
  } finally {
    spawnSync('icacls.exe', [denied, '/remove:d', account], { encoding: 'utf8', windowsHide: true });
  }

  // 空间探测
  const resolver = createModelDirectoryResolver(root);
  const desc = await resolver.describe();
  assert.ok(desc.freeBytes > 0, `freeBytes 应大于 0，实际 ${desc.freeBytes}`);
  assert.equal(typeof desc.writable, 'boolean');
  assert.equal(norm(desc.modelsRoot), norm(path.join(root, 'models')));
});

test('[#104-6] 300 字符长路径经扩展长度路径可创建/读取，resolver 不崩溃', async (t) => {
  const base = makeTempRoot('paths-long');
  t.after(() => cleanupRegisteredTempDirs());
  // 构造 > 260 字符的安装根
  let longRoot = path.join(base, 'longroot');
  while (longRoot.length < 300) longRoot = path.join(longRoot, `段落-${'x'.repeat(20)}`);
  const extended = toExtendedLengthPath(longRoot);
  assert.ok(extended.startsWith('\\\\?\\'), `>240 字符必须加 \\\\?\\ 前缀: ${extended}`);
  // 短路径不加前缀
  const short = path.join(base, 'short');
  assert.equal(toExtendedLengthPath(short), short, '短路径不应加 \\\\?\\ 前缀');
  assert.ok(longRoot.length >= 300);

  // 用扩展长度路径创建
  fs.mkdirSync(extended, { recursive: true });
  const file = path.join(extended, 'probe.txt');
  fs.writeFileSync(file, 'long-path-ok');
  assert.equal(fs.readFileSync(file, 'utf8'), 'long-path-ok');

  // resolver 在长路径安装根下工作
  const resolver = createModelDirectoryResolver(longRoot);
  assert.equal(norm(resolver.resolveModelsRoot()), norm(path.join(longRoot, 'models')));
  await resolver.ensureModelDirectories();
  const checkPath = toExtendedLengthPath(path.join(longRoot, 'models', '.downloads'));
  assert.ok(fs.existsSync(checkPath), '长路径下 models/.downloads 应创建成功');
});

test('[#104-7] reparse/junction 越界保护：modelsRoot 内链接指向外部必须拒绝', async (t) => {
  const root = makeTempRoot('paths-junction');
  const outside = makeTempRoot('paths-junction-outside');
  t.after(() => cleanupRegisteredTempDirs());
  const modelsRoot = path.join(root, 'models');
  fs.mkdirSync(path.join(modelsRoot, 'ollama'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.bin'), 'external');

  const junction = path.join(modelsRoot, 'escape');
  const res = spawnSync('cmd.exe', ['/d', '/c', 'mklink', '/J', junction, outside], { encoding: 'utf8', windowsHide: true });
  assert.equal(res.status, 0, `junction 创建失败（环境问题）: ${res.stderr || res.stdout}`);
  try {
    await assert.rejects(() => assertNoReparseEscape(root, junction), (err: unknown) => {
      assert.ok(err instanceof Error && err.message.trim().length > 0);
      return true;
    }, '指向 modelsRoot 外的 junction 必须被拒绝');

    // 指向 root 内部的 junction 不应被拒绝
    const insideTarget = path.join(root, 'models', 'real-inside');
    fs.mkdirSync(insideTarget, { recursive: true });
    const insideLink = path.join(root, 'models', 'inside-link');
    const res2 = spawnSync('cmd.exe', ['/d', '/c', 'mklink', '/J', insideLink, insideTarget], { encoding: 'utf8', windowsHide: true });
    assert.equal(res2.status, 0, `内部 junction 创建失败: ${res2.stderr || res2.stdout}`);
    await assert.doesNotReject(() => assertNoReparseEscape(root, insideLink), 'root 内部 junction 不应被拒绝');
  } finally {
    // junction 先移除链接，避免递归删除外部目标
    for (const link of [junction, path.join(root, 'models', 'inside-link')]) {
      try {
        fs.rmSync(link, { recursive: false, force: true });
      } catch {
        spawnSync('cmd.exe', ['/d', '/c', 'rmdir', link], { windowsHide: true });
      }
    }
  }
});

test('[#104-8] ensureModelDirectories 创建全部模型目录且幂等', async (t) => {
  const root = makeTempRoot('paths-ensure');
  t.after(() => cleanupRegisteredTempDirs());
  const resolver = createModelDirectoryResolver(root);
  await resolver.ensureModelDirectories();
  const dirs = [
    resolver.resolveModelsRoot(),
    resolver.resolveOllamaStore(),
    path.join(root, 'models', 'f5-tts'),
    resolver.resolveF5TtsRoot(),
    resolver.resolveVocosRoot(),
    resolver.resolveHfCache(),
    path.join(root, 'models', 'huggingface', 'hub'),
    resolver.resolveTempDownloadPath(),
  ];
  for (const dir of dirs) assert.ok(fs.existsSync(dir) && fs.statSync(dir).isDirectory(), `目录未创建: ${dir}`);
  await assert.doesNotReject(() => resolver.ensureModelDirectories(), 'ensureModelDirectories 必须幂等');
});

test('[#104-9] describe() 仅返回路径/可写/空间元数据，无凭据', async (t) => {
  const root = makeTempRoot('paths-describe');
  t.after(() => cleanupRegisteredTempDirs());
  const resolver = createModelDirectoryResolver(root);
  await resolver.ensureModelDirectories();
  const desc = await resolver.describe();
  assert.equal(norm(desc.modelsRoot), norm(path.join(root, 'models')));
  assert.equal(typeof desc.writable, 'boolean');
  assert.equal(typeof desc.freeBytes, 'number');
  const json = JSON.stringify(desc).toLowerCase();
  for (const key of SECRET_KEYS) {
    assert.ok(!json.includes(key), `describe() 泄漏敏感键: ${key}`);
  }
  assert.ok(Object.keys(desc).length <= 6, `describe() 返回字段过多: ${Object.keys(desc).join(',')}`);
});

test('[#104-11] 路径解析不修改全局环境变量', async (t) => {
  const root = makeTempRoot('paths-env');
  t.after(() => cleanupRegisteredTempDirs());
  const before = snapshotEnv();
  const resolver = createModelDirectoryResolver(root);
  await resolver.ensureModelDirectories();
  await resolver.describe();
  await validateInstallPath(root);
  assert.deepEqual(diffEnv(before, snapshotEnv()), [], '路径解析/探测修改了 process.env');
});

test('[#104-17] 数据与模型解耦：不同 installRoot 只经配置解析，无全局 env 依赖', async (t) => {
  const rootA = makeTempRoot('paths-decouple-a');
  const rootB = makeTempRoot('paths-decouple-b');
  t.after(() => cleanupRegisteredTempDirs());
  const layoutA = resolveInstallLayout(rootA);
  const layoutB = resolveInstallLayout(rootB);
  assert.notEqual(norm(layoutA.modelsRoot), norm(layoutB.modelsRoot));
  assert.notEqual(norm(layoutA.data), norm(layoutB.data));
  assert.ok(!isPathWithin(layoutA.modelsRoot, layoutA.data), 'data 不得位于 modelsRoot 内');
  assert.ok(!isPathWithin(layoutB.modelsRoot, layoutB.data), 'data 不得位于 modelsRoot 内');
  // 环境变量不含任何全局模型路径依赖
  assert.equal(process.env.OLLAMA_MODELS, undefined, '测试进程不应依赖外部 OLLAMA_MODELS');
  assert.equal(process.env.F5TTS_MODEL_DIR, undefined, '测试进程不应依赖外部 F5TTS_MODEL_DIR');
});

test('[#104-4] assertSafeRelativePath 规范：拒绝空段/穿越/绝对/ADS/保留名，接受安全相对路径', async (t) => {
  const good = ['f5-tts/F5TTS_v1_Base', 'models/file.bin', 'a/b/c/d.bin', 'vocos-mel-24khz'];
  for (const rel of good) {
    assert.equal(typeof assertSafeRelativePath(rel), 'string');
  }
  const bad = ['', '..', '../x', 'a/../b', '/abs', 'C:\\abs', '\\\\srv\\share', 'a:b', 'file.txt:ads', 'CON', 'NUL', 'aux', 'a//b', 'a/./b'];
  for (const rel of bad) {
    assert.throws(() => assertSafeRelativePath(rel), (err: unknown) => err instanceof Error && err.message.length > 0, `assertSafeRelativePath 错误接受: ${JSON.stringify(rel)}`);
  }
});

test('[#104-4] isPathWithin 包含性判断健壮（同前缀但不同目录不算包含）', async () => {
  assert.equal(isPathWithin('C:\\A\\B', 'C:\\A\\B\\c'), true);
  assert.equal(isPathWithin('C:\\A\\B', 'C:\\A\\B'), true);
  assert.equal(isPathWithin('C:\\A\\B', 'C:\\A\\Bab'), false, '前缀相同的兄弟目录不得视为包含');
  assert.equal(isPathWithin('C:\\A\\B', 'C:\\A'), false);
  assert.equal(isPathWithin('C:\\A\\B', 'C:\\A\\B\\..\\..\\evil'), false);
});
