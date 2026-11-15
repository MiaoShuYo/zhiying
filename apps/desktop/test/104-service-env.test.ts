/**
 * #102-3 / #104-10 / #104-11 / #104-14 / #104-17 子进程环境注入（§2.4 buildManagedServiceEnv）。
 * 真实构造 layout/config，验证所有模型/数据变量、URL、PATH、TMP/TEMP 精确值；
 * 断言只返回新对象、不修改 process.env、不写 HKCU\Environment（等价“无 setx”）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeTempRoot, makeChineseSpaceDir, cleanupRegisteredTempDirs } from './_helpers/temp';
import { makeInstallConfig, DEFAULT_PORTS } from './_helpers/fixtures';
import { snapshotEnv, diffEnv } from './_helpers/env';
import { readRegistryValues } from './_helpers/registry';
import { resolveInstallLayout } from '../src/install-layout';
import { buildManagedServiceEnv } from '../src/service-env';

function norm(p: string): string {
  return path.resolve(p).toLowerCase();
}

/** Windows 环境变量名大小写不敏感；spread 后的普通对象按原键名保存（可能是 Path）。 */
function envGet(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const actual = Object.keys(env).find((k) => k.toLowerCase() === key.toLowerCase());
  return actual ? env[actual] : undefined;
}

test('[#102-3] buildManagedServiceEnv 设置全部受管模型/数据路径与 URL（精确值）', async (t) => {
  const base = makeTempRoot('env');
  const root = makeChineseSpaceDir(base, '知影 运行 环境');
  t.after(() => cleanupRegisteredTempDirs());
  const layout = resolveInstallLayout(root);
  const config = makeInstallConfig(root, { ports: { ...DEFAULT_PORTS } });

  const env = buildManagedServiceEnv({ layout, config, baseEnv: { PATH: 'C:\\base\\path' } });
  const rootModels = path.join(root, 'models');
  const expected: Record<string, string> = {
    M2V_INSTALL_ROOT: root,
    M2V_MODELS_ROOT: rootModels,
    M2V_DATA_DIR: path.join(root, 'data'),
    OLLAMA_MODELS: path.join(rootModels, 'ollama'),
    OLLAMA_BASE_URL: `http://127.0.0.1:${DEFAULT_PORTS.ollama}`,
    HF_HOME: path.join(rootModels, 'huggingface'),
    HF_HUB_CACHE: path.join(rootModels, 'huggingface', 'hub'),
    TRANSFORMERS_CACHE: path.join(rootModels, 'huggingface', 'hub'),
    F5TTS_MODEL_DIR: path.join(rootModels, 'f5-tts', 'F5TTS_v1_Base'),
    F5TTS_VOCODER_DIR: path.join(rootModels, 'f5-tts', 'vocos-mel-24khz'),
    PYTHON_SERVICE_URL: `http://127.0.0.1:${DEFAULT_PORTS.python}`,
    PORT: String(DEFAULT_PORTS.web),
    NODE_ENV: 'production',
    TMP: path.join(root, 'data', 'tmp'),
    TEMP: path.join(root, 'data', 'tmp'),
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(env[key], value, `env.${key} 期望 ${value}，实际 ${env[key]}`);
  }
  assert.ok(env.DATABASE_URL, '缺少 DATABASE_URL');
  assert.equal(env.DATABASE_URL, `file:${path.join(root, 'data', 'm2v.db').split(path.sep).join('/')}`, 'DATABASE_URL 必须用正斜杠');
  assert.ok(!env.DATABASE_URL.includes('\\'), 'DATABASE_URL 不得包含反斜杠');
  assert.equal(env.REMOTION_BROWSER_EXECUTABLE, undefined, '未传 browserExecutable 时不应设置');

  // Windows 路径统一用反斜杠（安装根含中文/空格）
  for (const key of ['M2V_INSTALL_ROOT', 'M2V_MODELS_ROOT', 'OLLAMA_MODELS', 'HF_HOME', 'F5TTS_MODEL_DIR']) {
    assert.ok(env[key]!.includes('\\'), `env.${key} 应使用 Windows 反斜杠: ${env[key]}`);
    assert.ok(!env[key]!.includes('/'), `env.${key} 不应包含正斜杠: ${env[key]}`);
  }
});

test('[#102-3] PATH 前插受管 ffmpeg 与 node 目录，保留 base PATH 在后', async (t) => {
  const root = makeTempRoot('env-path');
  t.after(() => cleanupRegisteredTempDirs());
  const layout = resolveInstallLayout(root);
  const config = makeInstallConfig(root);
  const env = buildManagedServiceEnv({ layout, config, baseEnv: { PATH: 'C:\\base\\path;C:\\Windows\\System32' } });
  const parts = envGet(env, 'PATH')!.split(';').filter(Boolean);
  const ffmpegDir = path.join(root, 'runtime', 'ffmpeg');
  const nodeDir = path.join(root, 'runtime', 'node');
  assert.ok(parts.includes(ffmpegDir), `PATH 缺少受管 ffmpeg 目录: ${envGet(env, 'PATH')}`);
  assert.ok(parts.includes(nodeDir), `PATH 缺少受管 node 目录: ${envGet(env, 'PATH')}`);
  assert.ok(parts.indexOf(ffmpegDir) < parts.indexOf('C:\\base\\path'), '受管目录必须前插到 base PATH 之前');
  assert.ok(parts.indexOf(nodeDir) < parts.indexOf('C:\\base\\path'), '受管目录必须前插到 base PATH 之前');
  // 受管目录必须来自 installRoot，不是开发机路径
  assert.ok(ffmpegDir.toLowerCase().startsWith(root.toLowerCase()));
});

test('[#104-10] 自定义端口与 runtime 相对路径正确注入', async (t) => {
  const root = makeTempRoot('env-custom');
  t.after(() => cleanupRegisteredTempDirs());
  const layout = resolveInstallLayout(root);
  const config = makeInstallConfig(root, {
    ports: { web: 3100, python: 8100, ollama: 11500, manager: 8890 },
    runtime: { node: 'runtime\\node\\node.exe', ffmpegDir: 'runtime\\custom-ffmpeg' },
  });
  const env = buildManagedServiceEnv({ layout, config });
  assert.equal(env.OLLAMA_BASE_URL, 'http://127.0.0.1:11500');
  assert.equal(env.PYTHON_SERVICE_URL, 'http://127.0.0.1:8100');
  assert.equal(env.PORT, '3100');
  const parts = envGet(env, 'PATH')!.split(';');
  assert.ok(parts.includes(path.join(root, 'runtime', 'custom-ffmpeg')), `自定义 ffmpegDir 未注入 PATH: ${envGet(env, 'PATH')}`);
  assert.ok(parts.includes(path.join(root, 'runtime', 'node')), 'node 目录未注入 PATH');
});

test('[#104-10] browserExecutable 注入 REMOTION_BROWSER_EXECUTABLE', async (t) => {
  const root = makeTempRoot('env-browser');
  t.after(() => cleanupRegisteredTempDirs());
  const layout = resolveInstallLayout(root);
  const config = makeInstallConfig(root);
  const browser = path.join(root, 'runtime', 'chromium', 'chrome.exe');
  const env = buildManagedServiceEnv({ layout, config, browserExecutable: browser });
  assert.equal(env.REMOTION_BROWSER_EXECUTABLE, browser);
});

test('[#104-11] 不修改 process.env、不写用户环境变量注册表、返回全新对象', async (t) => {
  const root = makeTempRoot('env-nomutate');
  t.after(() => cleanupRegisteredTempDirs());
  const layout = resolveInstallLayout(root);
  const config = makeInstallConfig(root);
  const envBefore = snapshotEnv();
  const hkcuEnvBefore = readRegistryValues('HKCU\\Environment');

  const env = buildManagedServiceEnv({ layout, config });
  assert.notEqual(env, process.env, '必须返回新对象而非 process.env');
  assert.deepEqual(diffEnv(envBefore, snapshotEnv()), [], 'buildManagedServiceEnv 修改了 process.env');
  assert.deepEqual(readRegistryValues('HKCU\\Environment'), hkcuEnvBefore, 'buildManagedServiceEnv 写入了 HKCU\\Environment（setx 行为）');
  assert.equal(process.env.OLLAMA_MODELS, undefined);
  assert.equal(process.env.M2V_MODELS_ROOT, undefined);

  // baseEnv 也必须是只读语义（不得被原地修改）
  const baseEnv = { PATH: 'C:\\base', CUSTOM: 'keep' };
  const copy = { ...baseEnv };
  buildManagedServiceEnv({ layout, config, baseEnv });
  assert.deepEqual(baseEnv, copy, 'buildManagedServiceEnv 修改了传入的 baseEnv');
});

test('[#104-14] 受管 Ollama 隔离：仅使用配置端口与安装目录内模型库', async (t) => {
  const root = makeTempRoot('env-ollama');
  t.after(() => cleanupRegisteredTempDirs());
  const layout = resolveInstallLayout(root);
  const config = makeInstallConfig(root, { ports: { web: 3000, python: 8000, ollama: 11999, manager: 8790 } });
  const env = buildManagedServiceEnv({ layout, config, baseEnv: { OLLAMA_HOST: 'http://127.0.0.1:11434' } });
  assert.equal(env.OLLAMA_BASE_URL, 'http://127.0.0.1:11999');
  assert.notEqual(env.OLLAMA_MODELS, process.env.OLLAMA_MODELS);
  assert.equal(norm(env.OLLAMA_MODELS!), norm(path.join(root, 'models', 'ollama')));
  // 不连接外部 Ollama：受管 URL 端口必须与外部默认 11434 不同
  assert.ok(!env.OLLAMA_BASE_URL.includes(':11434'), '受管 OLLAMA_BASE_URL 不应指向外部默认端口');
});

test('[#104-17] M2V_DATA_DIR 与模型根解耦，全部受管数据路径在安装根内', async (t) => {
  const root = makeTempRoot('env-decouple');
  t.after(() => cleanupRegisteredTempDirs());
  const layout = resolveInstallLayout(root);
  const config = makeInstallConfig(root);
  const env = buildManagedServiceEnv({ layout, config });
  const modelsRoot = path.join(root, 'models');
  const dataDir = path.join(root, 'data');
  assert.equal(env.M2V_MODELS_ROOT, modelsRoot);
  assert.equal(env.M2V_DATA_DIR, dataDir);
  assert.ok(!norm(env.M2V_DATA_DIR!).startsWith(norm(modelsRoot) + path.sep), 'M2V_DATA_DIR 不得位于 modelsRoot 内');
  for (const key of ['OLLAMA_MODELS', 'HF_HOME', 'HF_HUB_CACHE', 'TRANSFORMERS_CACHE', 'F5TTS_MODEL_DIR', 'F5TTS_VOCODER_DIR']) {
    assert.ok(norm(env[key]!).startsWith(norm(modelsRoot) + path.sep), `env.${key} 必须位于 modelsRoot 内: ${env[key]}`);
  }
  for (const key of ['M2V_DATA_DIR', 'TMP', 'TEMP']) {
    const value = norm(env[key]!);
    const withinData = value === norm(dataDir) || value.startsWith(norm(dataDir) + path.sep);
    assert.ok(withinData, `env.${key} 必须位于 data 目录内: ${env[key]}`);
  }
});
