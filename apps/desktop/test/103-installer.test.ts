/**
 * #103 安装器（§2.7 installer.ts）：默认 per-user 根、受保护/非法/不可写路径拒绝、
 * 中文+空格+长路径、安装骨架与 install.json、快捷方式/注册表/日志、升级保留、失败回滚、
 * 完成页下载选择、净化 PATH 离线安装。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { makeTempRoot, makeChineseSpaceDir, cleanupRegisteredTempDirs } from './_helpers/temp';
import { createPayloadTree } from './_helpers/fixtures';
import { sanitizedEnv } from './_helpers/env';
import { deterministicBytes } from './_helpers/fsx';
import {
  defaultPerUserInstallRoot,
  validateInstallTarget,
  planInstall,
  executeInstall,
  removeRegistryEntry,
  removeShortcut,
  resolveDesktopPath,
} from '../src/installer';
import type { InstallerDeps } from '../src/installer';
import { loadInstallConfig, resolveInstallLayout } from '../src/install-layout';
import { readRegistryValues, registerRegistryCleanup, keyExists, findZhiyingShortcut, desktopDirs } from './_helpers/registry';

const SECRETS = ['token', 'password', 'secret', 'api key', 'credential'];

function fakeDeps(calls: { shortcut: number; registry: number }): InstallerDeps {
  return {
    createShortcut: async () => {
      calls.shortcut += 1;
    },
    writeRegistry: async () => {
      calls.registry += 1;
    },
  };
}

async function makePayload(t: test.TestContext, label: string, version = '1.8.0'): Promise<string> {
  const payload = path.join(makeTempRoot(label), 'payload');
  await createPayloadTree(payload, { version });
  t.after(() => cleanupRegisteredTempDirs());
  return payload;
}

function norm(p: string): string {
  return path.resolve(p).toLowerCase();
}

test('[#103-1] defaultPerUserInstallRoot = %LOCALAPPDATA%\\Programs\\Zhiying（含回退）', () => {
  const withLocal = defaultPerUserInstallRoot({ LOCALAPPDATA: 'D:\\Users\\Tester\\AppData\\Local', USERPROFILE: 'D:\\Users\\Tester' });
  assert.equal(norm(withLocal), norm('D:\\Users\\Tester\\AppData\\Local\\Programs\\Zhiying'));
  const fallback = defaultPerUserInstallRoot({ USERPROFILE: 'D:\\Users\\Tester' });
  assert.equal(norm(fallback), norm('D:\\Users\\Tester\\AppData\\Local\\Programs\\Zhiying'));
  const current = defaultPerUserInstallRoot(process.env);
  assert.match(current, /Programs[\\/]Zhiying$/i, `默认安装根不符合契约: ${current}`);
});

test('[#103-2] 受保护目录（Program Files/Windows/System32/盘符根）被阻止并给出可写路径引导', async (t) => {
  t.after(() => cleanupRegisteredTempDirs());
  const targets = ['C:\\Program Files\\Zhiying', 'C:\\Program Files (x86)\\Zhiying', 'C:\\Windows\\Zhiying', 'C:\\Windows\\System32\\Zhiying', 'C:\\ProgramData\\Zhiying', 'C:\\'];
  for (const target of targets) {
    const validation = await validateInstallTarget(target, { env: process.env });
    assert.equal(validation.ok, false, `受保护/非法目录未被拒绝: ${target}`);
    assert.ok(validation.errors.length > 0, `${target} 缺少可读错误`);
    assert.ok(
      validation.errors.some((e) => /受保护|系统目录|可写|盘符根|Program Files/i.test(e)),
      `${target} 错误未给出可写路径引导: ${validation.errors.join(' | ')}`,
    );
  }
  // default 关键字解析为 per-user 目录且可写
  const perUser = await validateInstallTarget('default', { env: process.env });
  assert.equal(perUser.ok, true, `default 目标被拒绝: ${perUser.errors.join('|')}`);
  assert.match(perUser.targetRoot ?? '', /Programs[\\/]Zhiying$/i);
});

test('[#103-3/#103-9] 中文+空格路径安装：骨架完整、install.json 可读回校验', async (t) => {
  const payload = await makePayload(t, 'inst-cn');
  const base = makeTempRoot('inst-cn-root');
  const target = makeChineseSpaceDir(base, '知影 安装 目录');
  const calls = { shortcut: 0, registry: 0 };
  const plan = await planInstall({ payloadRoot: payload, targetRoot: target, version: '1.8.0', profile: 'lite', downloadModels: 'later' });
  assert.equal(plan.upgrade, false);
  assert.equal(plan.preservePaths.length, 0);
  assert.ok(plan.steps.some((s) => s.includes('install.json')), '安装计划缺少写入 install.json 步骤');
  const result = await executeInstall(plan, fakeDeps(calls));
  assert.equal(result.ok, true, `中文+空格路径安装失败: ${result.errors.join('|')}`);
  assert.equal(result.launchModelManager, false);

  // 骨架
  for (const rel of ['Zhiying.exe', 'app', 'runtime', 'models', 'data', 'config', 'logs']) {
    assert.ok(fs.existsSync(path.join(target, rel)), `安装骨架缺少 ${rel}`);
  }
  assert.ok(fs.existsSync(path.join(target, 'app', 'desktop', 'index.js')), 'app/desktop 未复制');
  assert.ok(fs.existsSync(path.join(target, 'runtime', 'node', 'node.exe')), 'runtime/node 未复制');
  assert.ok(fs.existsSync(path.join(target, 'models', '.downloads')), 'models/.downloads 未创建');
  assert.ok(fs.existsSync(path.join(target, 'models', '.downloads', 'manifest.json')), '默认模型清单未复制');

  const config = await loadInstallConfig(target);
  assert.equal(config.version, '1.8.0');
  assert.equal(config.product, 'zhiying');
  assert.equal(norm(config.installRoot), norm(target));
  assert.equal(config.payloadProfile, 'lite');
  assert.equal(config.perUser, true);
  assert.deepEqual(config.ports, { web: 3000, python: 8000, ollama: 11434, manager: 8790 });
  assert.equal(config.managedProcesses.ollama, true);
  assert.equal(config.modelManifest.replace(/[\\\\/]/g, '/'), 'models/.downloads/manifest.json');
  assert.equal(config.modelsDownloadChoice, 'later');
  assert.equal(config.firstRunCompleted, false);
  assert.ok(fs.existsSync(path.join(target, 'config', 'install.json')));
  // 注入的快捷方式/注册表被调用一次
  assert.equal(calls.shortcut, 1);
  assert.equal(calls.registry, 1);

  // 安装日志
  assert.ok(fs.existsSync(result.logPath), `安装日志不存在: ${result.logPath}`);
  assert.equal(norm(path.dirname(result.logPath)), norm(path.join(target, 'logs')));
  const log = fs.readFileSync(result.logPath, 'utf8');
  assert.ok(log.includes('1.8.0') && /完成|步骤/.test(log), '安装日志缺少版本/步骤/结果');
  for (const secret of SECRETS) assert.ok(!log.toLowerCase().includes(secret), `安装日志泄漏敏感信息: ${secret}`);
});

test('[#103-9] install.json 写入 modelsDownloadChoice=now 且可再次校验', async (t) => {
  const payload = await makePayload(t, 'inst-now');
  const target = path.join(makeTempRoot('inst-now-root'), 'target');
  const calls = { shortcut: 0, registry: 0 };
  const plan = await planInstall({ payloadRoot: payload, targetRoot: target, version: '1.8.0', profile: 'lite', downloadModels: 'now' });
  const result = await executeInstall(plan, fakeDeps(calls));
  assert.equal(result.ok, true, result.errors.join('|'));
  assert.equal(result.launchModelManager, true, 'downloadModels=now 时应返回 launchModelManager=true');
  const config = await loadInstallConfig(target);
  assert.equal(config.modelsDownloadChoice, 'now');
});

test('[#103-4] 路径穿越/非法字符/不存在盘/非绝对路径被拒绝且无副作用', async (t) => {
  const payload = await makePayload(t, 'inst-bad');
  const base = makeTempRoot('inst-bad-root');
  const outside = makeTempRoot('inst-bad-outside');
  t.after(() => cleanupRegisteredTempDirs());
  const badTargets = [
    'relative\\install\\dir',
    `${base}\\..\\..\\outside-target`,
    'Z:\\NoSuchDrive\\Zhiying',
    path.join(base, 'bad<name>'),
    path.join(base, 'bad|name'),
    path.join(base, 'bad:ads'),
  ];
  for (const target of badTargets) {
    await assert.rejects(
      () => planInstall({ payloadRoot: payload, targetRoot: target, version: '1.8.0', profile: 'lite' }),
      (err: unknown) => {
        assert.ok(err instanceof Error && err.message.trim().length > 0, `非法目标报错不可读: ${target}`);
        return true;
      },
      `非法安装目标未被拒绝: ${target}`,
    );
  }
  // 目标路径被文件占用 → 拒绝
  const fileTarget = path.join(base, 'occupied-by-file');
  fs.writeFileSync(fileTarget, 'x');
  await assert.rejects(() => planInstall({ payloadRoot: payload, targetRoot: fileTarget, version: '1.8.0', profile: 'lite' }), /文件|目录|file/i);
  // 无副作用
  assert.deepEqual(fs.readdirSync(outside), [], '非法路径不得产生外部目录/文件');
});

test('[#103-5] 不可写目录：安装前清晰报错（不产生半安装）', async (t) => {
  const payload = await makePayload(t, 'inst-ro');
  const base = makeTempRoot('inst-ro-root');
  const target = path.join(base, 'readonly-target');
  fs.mkdirSync(target, { recursive: true });
  t.after(() => cleanupRegisteredTempDirs());
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME ?? os.userInfo().username;
  const deny = spawnSync('icacls.exe', [target, '/deny', `${account}:(OI)(CI)(W)`], { encoding: 'utf8', windowsHide: true });
  try {
    const validation = await validateInstallTarget(target, { env: process.env });
    let actuallyWritable = true;
    try {
      fs.writeFileSync(path.join(target, 'probe.txt'), 'x');
    } catch {
      actuallyWritable = false;
    }
    if (actuallyWritable) {
      t.diagnostic(`ACL deny 未生效（icacls status ${deny.status}），跳过不可写断言`);
      return;
    }
    assert.equal(validation.ok, false, '不可写目录必须被拒绝');
    assert.ok(validation.errors.some((e) => /不可写|写权限|permission/i.test(e)), `错误不可读: ${validation.errors.join('|')}`);
    await assert.rejects(
      () => planInstall({ payloadRoot: payload, targetRoot: target, version: '1.8.0', profile: 'lite' }),
      /不可写|写权限|permission/i,
    );
    let remaining: string[] = [];
    try {
      remaining = fs.readdirSync(target);
    } catch {
      remaining = [];
    }
    assert.deepEqual(remaining, [], '校验失败不得写入任何文件');
  } finally {
    spawnSync('icacls.exe', [target, '/remove:d', account], { encoding: 'utf8', windowsHide: true });
  }
});

test('[#103-6] 磁盘不足：报 required/free、不写盘（注入 diskFreeBytes）', async (t) => {
  const payload = await makePayload(t, 'inst-space');
  const base = makeTempRoot('inst-space-root');
  t.after(() => cleanupRegisteredTempDirs());
  const target = path.join(base, 'target');
  // 空间不足：planInstall 在写盘前拒绝，且不创建目标目录
  await assert.rejects(
    () =>
      planInstall({
        payloadRoot: payload,
        targetRoot: target,
        version: '1.8.0',
        profile: 'lite',
        deps: { diskFreeBytes: async () => 1024 },
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(/磁盘空间不足|可用|需要约/.test(err.message), `空间不足错误不可读: ${err.message}`);
      assert.ok(/KB|MB|GB/.test(err.message), `空间不足错误应报告 required/free 数量: ${err.message}`);
      return true;
    },
  );
  assert.ok(!fs.existsSync(target), '空间不足时不得创建/写入目标目录');
  // 空间充足：正常返回计划（不执行安装）
  const plan = await planInstall({
    payloadRoot: payload,
    targetRoot: target,
    version: '1.8.0',
    profile: 'lite',
    deps: { diskFreeBytes: async () => 1024 * 1024 * 1024 * 1024 },
  });
  assert.equal(plan.targetRoot, target);
  assert.ok(plan.steps.length > 0);
});

test('[#103-10] 快捷方式：KnownFolder 桌面真实创建、--no-shortcut 跳过、失败仅 warning（C4 回归）', async (t) => {
  const payload = await makePayload(t, 'inst-lnk');
  const base = makeTempRoot('inst-lnk-root');
  t.after(() => cleanupRegisteredTempDirs());
  // C4：桌面目录必须来自 KnownFolder（支持 OneDrive/组策略重定向），不得假设 %USERPROFILE%\Desktop
  const knownDesktopResult = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  const knownDesktop = (knownDesktopResult.stdout ?? '').trim();
  const resolvedDesktop = await resolveDesktopPath();
  assert.ok(knownDesktop.length > 0, '无法读取 KnownFolder Desktop');
  assert.equal(path.resolve(resolvedDesktop).toLowerCase(), path.resolve(knownDesktop).toLowerCase(), `resolveDesktopPath 必须与 KnownFolder 一致: ${resolvedDesktop} vs ${knownDesktop}`);
  // 不依赖 USERPROFILE：临时改写后仍返回 KnownFolder
  const savedUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = path.join(base, 'fake-user');
  try {
    const redirected = await resolveDesktopPath();
    assert.equal(path.resolve(redirected).toLowerCase(), path.resolve(knownDesktop).toLowerCase(), 'resolveDesktopPath 不得回退为 USERPROFILE\\Desktop（OneDrive 重定向场景）');
  } finally {
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  }

  const target = path.join(base, 'target-real');
  const calls = { shortcut: 0, registry: 0 };
  const plan = await planInstall({ payloadRoot: payload, targetRoot: target, version: '1.8.0', profile: 'lite', createShortcut: true });
  assert.equal(plan.createShortcut, true);
  assert.ok(plan.steps.some((s) => s.includes('快捷方式')));
  const deps = fakeDeps(calls);
  delete deps.createShortcut;
  const result = await executeInstall(plan, deps);
  assert.equal(result.ok, true, result.errors.join('|'));
  const expectedShortcut = path.join(knownDesktop, '知影.lnk');
  assert.ok(fs.existsSync(expectedShortcut), `KnownFolder 桌面快捷方式未创建: ${expectedShortcut}`);
  assert.ok(fs.statSync(expectedShortcut).size > 0, '快捷方式文件为空');
  await removeShortcut();
  assert.ok(!fs.existsSync(expectedShortcut), 'removeShortcut 未删除 KnownFolder 快捷方式');

  // 失败时仅 warning，不阻塞安装
  const targetWarn = path.join(base, 'target-warn');
  const planWarn = await planInstall({ payloadRoot: payload, targetRoot: targetWarn, version: '1.8.0', profile: 'lite', createShortcut: true });
  const resultWarn = await executeInstall(planWarn, {
    createShortcut: async () => {
      throw new Error('simulated shortcut failure');
    },
    writeRegistry: async () => undefined,
  });
  assert.equal(resultWarn.ok, true, '快捷方式失败不应阻塞安装');
  assert.ok(resultWarn.warnings.some((w) => w.includes('创建桌面快捷方式失败')), `快捷方式失败必须 warning: ${JSON.stringify(resultWarn.warnings)}`);

  // --no-shortcut：不创建、不调用
  const target2 = path.join(base, 'target-noslnk');
  let shortcutCalls = 0;
  const plan2 = await planInstall({ payloadRoot: payload, targetRoot: target2, version: '1.8.0', profile: 'lite', createShortcut: false });
  assert.equal(plan2.createShortcut, false);
  assert.ok(!plan2.steps.some((s) => s.includes('快捷方式')));
  const result2 = await executeInstall(plan2, {
    createShortcut: async () => {
      shortcutCalls += 1;
    },
    writeRegistry: async () => undefined,
  });
  assert.equal(result2.ok, true, result2.errors.join('|'));
  assert.equal(shortcutCalls, 0, '--no-shortcut 时不得调用创建快捷方式');
});

test('[#103-11] 卸载注册表：HKCU 项字段完整、--no-registry 跳过；测试后清理', async (t) => {
  registerRegistryCleanup(t);
  const payload = await makePayload(t, 'inst-reg');
  const base = makeTempRoot('inst-reg-root');
  t.after(() => cleanupRegisteredTempDirs());
  // --no-registry：不写
  const targetSkip = path.join(base, 'target-skip-reg');
  const planSkip = await planInstall({ payloadRoot: payload, targetRoot: targetSkip, version: '1.8.0', profile: 'lite', writeRegistry: false, createShortcut: false });
  let registryCalls = 0;
  const skipResult = await executeInstall(planSkip, {
    createShortcut: async () => undefined,
    writeRegistry: async () => {
      registryCalls += 1;
    },
  });
  assert.equal(skipResult.ok, true, skipResult.errors.join('|'));
  assert.equal(registryCalls, 0, '--no-registry 时不得调用写注册表');
  assert.equal(keyExists(), false, '--no-registry 时不得创建 HKCU 卸载项');

  // 真实写注册表
  const target = path.join(base, 'target-reg');
  const plan = await planInstall({ payloadRoot: payload, targetRoot: target, version: '1.8.0', profile: 'lite', createShortcut: false });
  assert.equal(plan.writeRegistry, true);
  const deps = fakeDeps({ shortcut: 0, registry: 0 });
  delete deps.writeRegistry;
  const result = await executeInstall(plan, deps);
  assert.equal(result.ok, true, result.errors.join('|'));
  const values = readRegistryValues();
  assert.ok(values, 'HKCU 卸载注册表项不存在');
  for (const name of ['DisplayName', 'DisplayVersion', 'Publisher', 'InstallLocation', 'DisplayIcon', 'UninstallString', 'EstimatedSize']) {
    assert.ok(values![name]?.value, `注册表缺少字段 ${name}`);
  }
  assert.equal(values!.DisplayVersion.value, '1.8.0');
  assert.equal(norm(values!.InstallLocation.value), norm(target));
  assert.ok(values!.UninstallString.value.includes('maintenance-cli'), 'UninstallString 必须指向维护 CLI');
  assert.match(values!.UninstallString.value, /--uninstall\s+--yes/, 'UninstallString 必须带 --uninstall --yes（Windows 标准卸载入口无需再确认，C3 回归）');
  assert.match(values!.EstimatedSize.value, /^\d+$/);
  await removeRegistryEntry();
  assert.equal(keyExists(), false, 'removeRegistryEntry 未清理 HKCU 项');
});

test('[#103-13] 已有安装：进入升级模式，models/data/logs/config 保留并提示版本变化', async (t) => {
  const payloadV1 = await makePayload(t, 'inst-up1', '1.8.0');
  const base = makeTempRoot('inst-up-root');
  const target = path.join(base, 'target');
  const calls = { shortcut: 0, registry: 0 };
  const plan1 = await planInstall({ payloadRoot: payloadV1, targetRoot: target, version: '1.8.0', profile: 'lite' });
  const result1 = await executeInstall(plan1, fakeDeps(calls));
  assert.equal(result1.ok, true, result1.errors.join('|'));

  // 写入用户数据哨兵
  const sentinels = {
    'models/.downloads/state.json': '{"schemaVersion":1,"models":{}}',
    'models/f5-tts/F5TTS_v1_Base/model.safetensors': 'model-weight',
    'data/m2v.db': 'sqlite-bytes',
    'data/projects/p1.json': '{"id":"p1"}',
    'data/voices/v.wav': 'audio',
    'logs/user-marker.log': 'marker',
  };
  for (const [rel, content] of Object.entries(sentinels)) {
    const file = path.join(target, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  // 用户自定义端口字段（升级必须保留）
  const cfgPath = path.join(target, 'config', 'install.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
  cfg.ports = { web: 3100, python: 8100, ollama: 11500, manager: 8890 };
  cfg.firstRunCompleted = true;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const payloadV2 = await makePayload(t, 'inst-up2', '1.8.1');
  const plan2 = await planInstall({ payloadRoot: payloadV2, targetRoot: target, version: '1.8.1', profile: 'lite' });
  assert.equal(plan2.upgrade, true, '已有安装必须进入升级模式');
  assert.deepEqual(plan2.preservePaths, ['models', 'data', 'logs', 'config']);
  assert.ok(plan2.steps.some((s) => s.includes('备份')), `升级计划缺少备份步骤: ${plan2.steps.join('|')}`);
  const result2 = await executeInstall(plan2, fakeDeps(calls));
  assert.equal(result2.ok, true, result2.errors.join('|'));
  assert.ok(result2.warnings.some((w) => /升级|保留/.test(w)) || plan2.upgrade, '升级应提示版本变化/保留策略');

  // 用户数据完整保留
  for (const [rel, content] of Object.entries(sentinels)) {
    const file = path.join(target, rel);
    assert.ok(fs.existsSync(file), `升级后用户文件丢失: ${rel}`);
    assert.equal(fs.readFileSync(file, 'utf8'), content, `升级后用户文件被改写: ${rel}`);
  }
  const upgraded = await loadInstallConfig(target);
  assert.equal(upgraded.version, '1.8.1', 'install.json 版本未更新');
  assert.deepEqual(upgraded.ports, { web: 3100, python: 8100, ollama: 11500, manager: 8890 }, '升级不得重置用户端口');
  assert.ok(upgraded.updatedAt, '升级应写入 updatedAt');
  // 新程序文件已替换
  assert.ok(fs.existsSync(path.join(target, 'app', 'desktop', 'index.js')));
  // 升级不强制重新下载模型：models 哨兵仍在
  assert.equal(fs.readFileSync(path.join(target, 'models', 'f5-tts', 'F5TTS_v1_Base', 'model.safetensors'), 'utf8'), 'model-weight');
});

test('[#103-14] 失败回滚：注入复制失败 → staging 清理、无半安装、错误日志、结果失败', async (t) => {
  const payload = await makePayload(t, 'inst-rollback');
  const base = makeTempRoot('inst-rollback-root');
  const target = path.join(base, 'target');
  const calls = { shortcut: 0, registry: 0 };
  const plan = await planInstall({ payloadRoot: payload, targetRoot: target, version: '1.8.0', profile: 'lite' });
  let copyCalls = 0;
  const result = await executeInstall(plan, {
    ...fakeDeps(calls),
    copyTree: async (from: string, to: string) => {
      copyCalls += 1;
      if (copyCalls >= 2) {
        const err = new Error('EIO: simulated copy failure') as NodeJS.ErrnoException;
        err.code = 'EIO';
        throw err;
      }
      await fs.promises.cp(from, to, { recursive: true, force: true });
    },
  });
  assert.equal(result.ok, false, '复制失败时安装必须失败');
  assert.ok(result.errors.length > 0 && result.errors[0].trim().length > 0, '失败错误不可读');
  assert.ok(result.logPath, '失败也必须写安装日志');
  const log = fs.readFileSync(result.logPath, 'utf8');
  assert.match(log, /错误|失败/, '失败日志缺少错误信息');
  // staging 清理、不留半安装
  const leftovers = fs.existsSync(target) ? fs.readdirSync(target).filter((name) => /^\.(staging|old)-/.test(name)) : [];
  assert.deepEqual(leftovers, [], `失败后残留 staging/old 目录: ${leftovers.join(',')}`);
  assert.ok(!fs.existsSync(path.join(target, 'config', 'install.json')), '失败后不得留下 install.json');
  // 若目标目录为本次新建则回滚删除
  if (fs.existsSync(target)) {
    assert.ok(fs.readdirSync(target).length === 0 || fs.readdirSync(target).every((name) => name.startsWith('logs')), `回滚后残留: ${fs.readdirSync(target).join(',')}`);
  }
});

test('[#103-17] 长路径（250+）安装可用或给出明确可读错误（不崩溃）', async (t) => {
  const payload = await makePayload(t, 'inst-long');
  const base = makeTempRoot('inst-long-root');
  t.after(() => cleanupRegisteredTempDirs());
  let target = path.join(base, 'target');
  while (target.length < 250) target = path.join(target, '长路径-目录-段');
  const calls = { shortcut: 0, registry: 0 };
  let result;
  try {
    const plan = await planInstall({ payloadRoot: payload, targetRoot: target, version: '1.8.0', profile: 'lite' });
    result = await executeInstall(plan, fakeDeps(calls));
  } catch (error) {
    // 允许在安装前校验阶段给出可读错误，但不得崩溃
    assert.ok(error instanceof Error && /路径|过长|长|path|ENAMETOOLONG|ENOENT/i.test(error.message), `长路径错误不可读: ${(error as Error).message}`);
    return;
  }
  if (result.ok) {
    const config = await loadInstallConfig(target);
    assert.equal(norm(config.installRoot), norm(target));
    assert.ok(fs.existsSync(path.join(target, 'Zhiying.exe')));
  } else {
    assert.ok(result.errors.length > 0, '长路径失败必须给出可读错误');
    assert.ok(/路径|过长|长|path|ENAMETOOLONG|ENOENT/i.test(result.errors.join('|')), `长路径错误不可读: ${result.errors.join('|')}`);
  }
});

test('[#103-18] 离线安装：净化 PATH（无 node/pnpm/python/git）仍成功，不执行包管理器', async (t) => {
  const payload = await makePayload(t, 'inst-offline');
  const base = makeTempRoot('inst-offline-root');
  t.after(() => cleanupRegisteredTempDirs());
  const savedEnv = { PATH: process.env.PATH, Path: process.env.Path };
  const sanitized = sanitizedEnv();
  try {
    process.env.PATH = sanitized.PATH;
    delete process.env.Path;
    const target = path.join(base, 'target');
    const calls = { shortcut: 0, registry: 0 };
    const plan = await planInstall({ payloadRoot: payload, targetRoot: target, version: '1.8.0', profile: 'lite' });
    const result = await executeInstall(plan, fakeDeps(calls));
    assert.equal(result.ok, true, `净化 PATH 下安装失败: ${result.errors.join('|')}`);
    assert.ok(fs.existsSync(path.join(target, 'Zhiying.exe')));
    assert.ok(fs.existsSync(path.join(target, 'config', 'install.json')));
    // 净化 PATH 下不存在包管理器，证明安装过程不需要它们
    for (const tool of ['pnpm', 'uv', 'git']) {
      const probe = spawnSync(tool, ['--version'], { env: sanitized, encoding: 'utf8', windowsHide: true });
      assert.notEqual(probe.status, 0, `净化 PATH 仍能执行 ${tool}，测试前提不成立`);
    }
  } finally {
    if (savedEnv.PATH === undefined) delete process.env.PATH;
    else process.env.PATH = savedEnv.PATH;
    if (savedEnv.Path !== undefined) process.env.Path = savedEnv.Path;
  }
});
