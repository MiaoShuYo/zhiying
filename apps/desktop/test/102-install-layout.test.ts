/**
 * #102-1 / #103-4 / #103-9 安装布局与 config/install.json 契约测试（§2.2）。
 * 使用真实文件系统（中文+空格路径），验证路径全部绝对且在 <root> 内、CWD 无关、校验拒绝非法 root、原子写与 load 回读。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, makeChineseSpaceDir, cleanupRegisteredTempDirs } from './_helpers/temp';
import { makeInstallConfig, writeInstallConfigRaw, VERSION } from './_helpers/fixtures';
import { isPathWithin } from '../src/model-paths';
import {
  resolveInstallLayout,
  validateInstallConfig,
  loadInstallConfig,
  writeInstallConfig,
} from '../src/install-layout';

function norm(p: string): string {
  return path.resolve(p).toLowerCase();
}

test('[#102-1] resolveInstallLayout 对中文+空格路径返回全部绝对、落在 root 内的目录', async (t) => {
  const base = makeTempRoot('layout');
  const root = makeChineseSpaceDir(base, '知影 安装 目录');
  t.after(() => cleanupRegisteredTempDirs());

  const layout = resolveInstallLayout(root);
  const expected = {
    installRoot: root,
    app: path.join(root, 'app'),
    runtime: path.join(root, 'runtime'),
    modelsRoot: path.join(root, 'models'),
    data: path.join(root, 'data'),
    config: path.join(root, 'config'),
    logs: path.join(root, 'logs'),
    modelsOllama: path.join(root, 'models', 'ollama'),
    modelsF5Tts: path.join(root, 'models', 'f5-tts', 'F5TTS_v1_Base'),
    modelsVocos: path.join(root, 'models', 'f5-tts', 'vocos-mel-24khz'),
    modelsHuggingFace: path.join(root, 'models', 'huggingface'),
    downloads: path.join(root, 'models', '.downloads'),
    installConfigPath: path.join(root, 'config', 'install.json'),
    serviceStatePath: path.join(root, 'data', 'runtime', 'services.json'),
    modelStatePath: path.join(root, 'models', '.downloads', 'state.json'),
  };
  for (const [key, value] of Object.entries(expected)) {
    const actual = (layout as unknown as Record<string, string>)[key];
    assert.equal(typeof actual, 'string', `layout.${key} 必须是字符串`);
    assert.equal(norm(actual), norm(value), `layout.${key} 路径错误`);
    assert.ok(path.isAbsolute(actual), `layout.${key} 必须是绝对路径`);
    assert.ok(isPathWithin(root, actual), `layout.${key} 必须在 installRoot 内`);
    // 不得依赖仓库/CWD 相对路径
    assert.ok(!actual.includes(`apps${path.sep}desktop${path.sep}src`), `layout.${key} 泄漏仓库源路径`);
  }
});

test('[#102-1] resolveInstallLayout 不依赖 CWD（切换目录后结果不变）', async (t) => {
  const root = makeTempRoot('layout-cwd');
  const elsewhere = makeTempRoot('layout-cwd-elsewhere');
  t.after(() => cleanupRegisteredTempDirs());
  const before = resolveInstallLayout(root);
  const originalCwd = process.cwd();
  try {
    process.chdir(elsewhere);
    const after = resolveInstallLayout(root);
    assert.deepEqual(after, before);
  } finally {
    process.chdir(originalCwd);
  }
});

test('[#102-1] validateInstallConfig 接受合法配置（version=1.8.0 结构完整）', async (t) => {
  const root = makeTempRoot('layout-valid');
  t.after(() => cleanupRegisteredTempDirs());
  const config = makeInstallConfig(root, { version: VERSION });
  const result = validateInstallConfig(config);
  assert.equal(result.ok, true, `合法配置被拒绝: ${JSON.stringify(result)}`);
  if (result.ok) {
    assert.equal(result.config.version, '1.8.0');
    assert.equal(result.config.product, 'zhiying');
    assert.equal(result.config.installRoot, path.resolve(root));
  }
});

test('[#102-1] validateInstallConfig 拒绝相对/穿越/UNC/设备/盘符根/受保护 installRoot 且错误可读', async (t) => {
  const root = makeTempRoot('layout-invalid');
  t.after(() => cleanupRegisteredTempDirs());
  const protectedRoots = [
    'relative\\path',
    '..\\..\\evil-root',
    'C:\\',
    'C:\\Windows\\Zhiying',
    'C:\\Windows\\System32\\Zhiying',
    'C:\\Program Files\\Zhiying',
    'C:\\Program Files (x86)\\Zhiying',
    '\\\\server\\share\\zhiying',
    '\\\\?\\C:\\zhiying',
    '\\\\.\\C:\\zhiying',
  ];
  for (const bad of protectedRoots) {
    const config = makeInstallConfig(root, { installRoot: bad });
    const result = validateInstallConfig(config);
    assert.equal(result.ok, false, `非法 installRoot 被接受: ${bad}`);
    if (!result.ok) {
      assert.ok(Array.isArray(result.errors) && result.errors.length > 0, `installRoot=${bad} 缺少可读 errors`);
      assert.ok(
        result.errors.every((e) => typeof e === 'string' && e.trim().length > 0),
        `installRoot=${bad} errors 含空串`,
      );
    }
  }

  // 结构字段错误
  const structural: Array<Record<string, unknown>> = [
    { ...makeInstallConfig(root), schemaVersion: 2 },
    { ...makeInstallConfig(root), product: 'other' },
    { ...makeInstallConfig(root), version: '' },
    { ...makeInstallConfig(root), payloadProfile: 'huge' },
    { ...makeInstallConfig(root), ports: { web: 'x', python: 8000, ollama: 11434, manager: 8790 } },
    { ...makeInstallConfig(root), runtime: { node: 123 } },
    null,
    'not-an-object',
  ];
  for (const bad of structural) {
    const result = validateInstallConfig(bad);
    assert.equal(result.ok, false, `非法配置被接受: ${JSON.stringify(bad)}`);
    if (!result.ok) assert.ok(result.errors.length > 0);
  }
});

test('[#103-9] writeInstallConfig 原子写 + loadInstallConfig 回读一致，无 tmp 残留', async (t) => {
  const root = makeTempRoot('layout-write');
  t.after(() => cleanupRegisteredTempDirs());
  const config = makeInstallConfig(root);
  await writeInstallConfig(config);

  const loaded = await loadInstallConfig(root);
  assert.equal(loaded.schemaVersion, 1);
  assert.equal(loaded.product, 'zhiying');
  assert.equal(loaded.version, '1.8.0');
  assert.equal(norm(loaded.installRoot), norm(root));
  assert.equal(loaded.payloadProfile, 'lite');
  assert.deepEqual(loaded.ports, { web: 3000, python: 8000, ollama: 11434, manager: 8790 });
  assert.equal(loaded.modelManifest, 'models/.downloads/manifest.json');
  assert.equal(loaded.firstRunCompleted, false);

  const configDir = path.join(root, 'config');
  const leftovers = fs.readdirSync(configDir).filter((n) => n !== 'install.json');
  assert.deepEqual(leftovers, [], `config 目录存在临时残留: ${leftovers.join(',')}`);

  // 再次写入（升级场景）必须成功替换且可读
  const upgraded = { ...config, version: '1.8.1', updatedAt: '2026-11-16T00:00:00.000Z' };
  await writeInstallConfig(upgraded);
  const loaded2 = await loadInstallConfig(root);
  assert.equal(loaded2.version, '1.8.1');
  assert.equal(loaded2.updatedAt, '2026-11-16T00:00:00.000Z');
});

test('[#102-1] loadInstallConfig 对缺失/损坏/结构非法返回可读错误', async (t) => {
  const root = makeTempRoot('layout-load');
  t.after(() => cleanupRegisteredTempDirs());

  await assert.rejects(() => loadInstallConfig(root), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.ok(/install\.json|配置|不存在|missing|not found/i.test(err.message), `缺失错误不可读: ${err.message}`);
    return true;
  });

  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  await writeInstallConfigRaw(root, '{ this is not json');
  await assert.rejects(() => loadInstallConfig(root), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.ok(/json|解析|parse|损坏|invalid/i.test(err.message), `JSON 损坏错误不可读: ${err.message}`);
    return true;
  });

  await writeInstallConfigRaw(root, { schemaVersion: 1, product: 'zhiying' });
  await assert.rejects(() => loadInstallConfig(root), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.ok(err.message.trim().length > 0);
    return true;
  });
});

test('[#102-1] validateInstallConfig 对未知字段向前兼容（忽略而不报错）', async (t) => {
  const root = makeTempRoot('layout-future');
  t.after(() => cleanupRegisteredTempDirs());
  const config = { ...makeInstallConfig(root), futureFeature: { enabled: true }, extraNumber: 42 } as unknown;
  const result = validateInstallConfig(config);
  assert.equal(result.ok, true, `未知字段导致校验失败: ${JSON.stringify(result)}`);
});
