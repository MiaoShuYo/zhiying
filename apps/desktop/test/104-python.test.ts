/**
 * #104-12/#104-13 Python 端统一模型根与 HF 缓存（services/python/app/main.py 向后兼容补丁）。
 * 真实 .venv Python 导入 app.main + 真实 uvicorn 启动 /health 验证；不 mock。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempRoot, cleanupRegisteredTempDirs, REPO_ROOT } from './_helpers/temp';
import { getFreePort, waitForHttp } from './_helpers/ports';
import { killTree, spawnCollect, waitForCondition } from './_helpers/processes';
import { resolveInstallLayout } from '../src/install-layout';

const PYTHON_ROOT = path.join(REPO_ROOT, 'services', 'python');
const PYTHON_EXE = path.join(PYTHON_ROOT, '.venv', 'Scripts', 'python.exe');

function hasVenv(): boolean {
  return fs.existsSync(PYTHON_EXE);
}

function norm(p: string): string {
  return path.resolve(p).toLowerCase();
}

/** 构造不继承开发机模型环境变量的 env（避免污染断言）。 */
function cleanPythonEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  for (const key of ['M2V_MODELS_ROOT', 'F5TTS_MODEL_DIR', 'F5TTS_VOCODER_DIR', 'HF_HOME', 'HF_HUB_CACHE', 'TRANSFORMERS_CACHE', 'OLLAMA_MODELS']) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runPythonJson(script: string, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_EXE, ['-c', script], { cwd: PYTHON_ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
      reject(new Error(`python 脚本超时: ${stderr.slice(-1000)}`));
    }, 120_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`python 退出码 ${code}: ${stderr.slice(-2000)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '{}') as Record<string, unknown>);
      } catch (error) {
        reject(new Error(`python 输出不是 JSON: ${stdout.slice(-800)}；stderr=${stderr.slice(-800)}`));
      }
    });
  });
}

const IMPORT_PROBE = `
import json, os
import app.main as main
payload = {
  'hfHome': os.environ.get('HF_HOME'),
  'hfHubCache': os.environ.get('HF_HUB_CACHE'),
  'transformersCache': os.environ.get('TRANSFORMERS_CACHE'),
  'modelsRoot': str(getattr(main, 'MODELS_ROOT', '')),
  'f5ttsModelDir': str(main.F5TTS_MODEL_DIR),
  'f5ttsVocoderDir': str(main.F5TTS_VOCODER_DIR),
}
print(json.dumps(payload))
`;

test('[#104-12] M2V_MODELS_ROOT：F5/Vocos/HF 默认从 models 根派生，HF 环境变量在导入时设置', async (t) => {
  if (!hasVenv()) {
    t.skip('缺少 services/python/.venv，跳过 Python 集成测试');
    return;
  }
  const base = makeTempRoot('py-models');
  t.after(() => cleanupRegisteredTempDirs());
  const modelsRoot = path.join(base, 'models');
  fs.mkdirSync(modelsRoot, { recursive: true });
  const result = await runPythonJson(IMPORT_PROBE, cleanPythonEnv({ M2V_MODELS_ROOT: modelsRoot, M2V_DATA_DIR: path.join(base, 'data') }));

  assert.equal(norm(String(result.modelsRoot)), norm(modelsRoot), `MODELS_ROOT 未指向 M2V_MODELS_ROOT: ${result.modelsRoot}`);
  assert.equal(norm(String(result.f5ttsModelDir)), norm(path.join(modelsRoot, 'f5-tts', 'F5TTS_v1_Base')), `F5 默认目录未从 models 根派生: ${result.f5ttsModelDir}`);
  assert.equal(norm(String(result.f5ttsVocoderDir)), norm(path.join(modelsRoot, 'f5-tts', 'vocos-mel-24khz')), `Vocos 默认目录未从 models 根派生: ${result.f5ttsVocoderDir}`);
  assert.equal(norm(String(result.hfHome)), norm(path.join(modelsRoot, 'huggingface')), `HF_HOME 未指向 models/huggingface: ${result.hfHome}`);
  assert.equal(norm(String(result.hfHubCache)), norm(path.join(modelsRoot, 'huggingface', 'hub')), `HF_HUB_CACHE 未指向 models/huggingface/hub: ${result.hfHubCache}`);
  // 契约 Python 侧只要求 HF_HOME/HF_HUB_CACHE；TRANSFORMERS_CACHE 若设置则必须指向 hub
  if (result.transformersCache) {
    assert.equal(norm(String(result.transformersCache)), norm(path.join(modelsRoot, 'huggingface', 'hub')), `TRANSFORMERS_CACHE 若设置必须指向 models/huggingface/hub: ${result.transformersCache}`);
  }
});

test('[#104-12] 显式 F5TTS_* 优先于 M2V_MODELS_ROOT 派生默认值', async (t) => {
  if (!hasVenv()) {
    t.skip('缺少 services/python/.venv，跳过 Python 集成测试');
    return;
  }
  const base = makeTempRoot('py-override');
  t.after(() => cleanupRegisteredTempDirs());
  const modelsRoot = path.join(base, 'models');
  const customF5 = path.join(base, 'custom-f5');
  const customVocos = path.join(base, 'custom-vocos');
  const result = await runPythonJson(
    IMPORT_PROBE,
    cleanPythonEnv({ M2V_MODELS_ROOT: modelsRoot, F5TTS_MODEL_DIR: customF5, F5TTS_VOCODER_DIR: customVocos }),
  );
  assert.equal(norm(String(result.f5ttsModelDir)), norm(customF5), '显式 F5TTS_MODEL_DIR 未优先');
  assert.equal(norm(String(result.f5ttsVocoderDir)), norm(customVocos), '显式 F5TTS_VOCODER_DIR 未优先');
});

test('[#104-13] 开发模式兼容：无 M2V_MODELS_ROOT 时默认仍为 DATA/models，且不改写 HF 环境变量', async (t) => {
  if (!hasVenv()) {
    t.skip('缺少 services/python/.venv，跳过 Python 集成测试');
    return;
  }
  const base = makeTempRoot('py-dev');
  t.after(() => cleanupRegisteredTempDirs());
  const dataDir = path.join(base, 'data');
  const sentinelHf = path.join(base, 'sentinel-hf');
  const result = await runPythonJson(IMPORT_PROBE, cleanPythonEnv({ M2V_DATA_DIR: dataDir, HF_HOME: sentinelHf }));
  assert.equal(norm(String(result.modelsRoot)), norm(path.join(dataDir, 'models')), `开发模式 MODELS_ROOT 应默认 DATA/models: ${result.modelsRoot}`);
  assert.equal(norm(String(result.f5ttsModelDir)), norm(path.join(dataDir, 'models', 'f5-tts', 'F5TTS_v1_Base')), '开发模式 F5 默认目录不符 V1.7.0 行为');
  assert.equal(norm(String(result.f5ttsVocoderDir)), norm(path.join(dataDir, 'models', 'f5-tts', 'vocos-mel-24khz')));
  assert.equal(norm(String(result.hfHome)), norm(sentinelHf), '开发模式不得改写显式 HF_HOME');
});

test('[#104-12] venv 真实启动 uvicorn：/health 追加 modelsRoot/f5ttsModelDir/vocoderDir/hfCache 且保留既有字段', async (t) => {
  if (!hasVenv()) {
    t.skip('缺少 services/python/.venv，跳过 Python 集成测试');
    return;
  }
  const base = makeTempRoot('py-health');
  t.after(() => cleanupRegisteredTempDirs());
  const modelsRoot = path.join(base, 'models');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(modelsRoot, { recursive: true });
  const port = await getFreePort();
  const env = cleanPythonEnv({ M2V_MODELS_ROOT: modelsRoot, M2V_DATA_DIR: dataDir });
  const child = spawnCollect(PYTHON_EXE, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)], { cwd: PYTHON_ROOT, env });
  t.after(() => killTree(child.pid));
  try {
    const response = await waitForHttp(`http://127.0.0.1:${port}/health`, { timeoutMs: 120_000, intervalMs: 300 });
    assert.equal(response.status, 200);
    const health = JSON.parse(response.body) as Record<string, unknown>;
    assert.equal(health.ok, true, `health.ok 应为 true: ${response.body}`);
    // 追加字段
    assert.equal(norm(String(health.modelsRoot)), norm(modelsRoot), `health.modelsRoot 错误: ${health.modelsRoot}`);
    assert.equal(norm(String(health.f5ttsModelDir)), norm(path.join(modelsRoot, 'f5-tts', 'F5TTS_v1_Base')), `health.f5ttsModelDir 错误: ${health.f5ttsModelDir}`);
    assert.equal(norm(String(health.vocoderDir)), norm(path.join(modelsRoot, 'f5-tts', 'vocos-mel-24khz')), `health.vocoderDir 错误: ${health.vocoderDir}`);
    assert.equal(norm(String(health.hfCache)), norm(path.join(modelsRoot, 'huggingface', 'hub')), `health.hfCache 错误: ${health.hfCache}`);
    // 既有字段保持
    for (const key of ['python', 'pdf', 'ttsModels', 'tts', 'torchcodec', 'ffmpeg', 'ffprobe']) {
      assert.ok(key in health, `health 丢失既有字段: ${key}`);
    }
    assert.match(String(health.python), /^\d+\.\d+\.\d+/, 'health.python 字段异常');
    // 安装版不在用户目录创建模型副本
    assert.ok(!fs.existsSync(path.join(dataDir, 'models')), '安装版不得在 data/models 生成第二份模型目录');
  } finally {
    killTree(child.pid);
    await child.exit;
  }
});

test('[#104-12] venv 真实启动 dev 模式 uvicorn：/health 的 modelsRoot 指向 DATA/models', async (t) => {
  if (!hasVenv()) {
    t.skip('缺少 services/python/.venv，跳过 Python 集成测试');
    return;
  }
  const base = makeTempRoot('py-health-dev');
  t.after(() => cleanupRegisteredTempDirs());
  const dataDir = path.join(base, 'data');
  const port = await getFreePort();
  const env = cleanPythonEnv({ M2V_DATA_DIR: dataDir });
  const child = spawnCollect(PYTHON_EXE, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)], { cwd: PYTHON_ROOT, env });
  t.after(() => killTree(child.pid));
  try {
    const response = await waitForHttp(`http://127.0.0.1:${port}/health`, { timeoutMs: 120_000, intervalMs: 300 });
    const health = JSON.parse(response.body) as Record<string, unknown>;
    assert.equal(health.ok, true);
    assert.equal(norm(String(health.modelsRoot)), norm(path.join(dataDir, 'models')), `dev 模式 health.modelsRoot 错误: ${health.modelsRoot}`);
    assert.equal(norm(String(health.f5ttsModelDir)), norm(path.join(dataDir, 'models', 'f5-tts', 'F5TTS_v1_Base')));
  } finally {
    killTree(child.pid);
    await child.exit;
  }
});
