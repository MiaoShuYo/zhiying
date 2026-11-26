import { dirname, extname, join, resolve } from 'node:path';
import { assertSafeRelativePath, isPathWithin } from './model-paths.js';
import type { InstallConfig, InstallLayout } from './install-layout.js';

/**
 * #102/#104 受管子进程环境注入。
 *
 * 只返回全新的环境对象：绝不修改 `process.env`，不写注册表、不 `setx`。
 * 所有模型/数据/临时路径均指向 `<InstallRoot>` 内部，Windows 路径用 `\\`，
 * URL 与 `file:` 用 `/`。
 */

export interface ServiceEnvInput {
  layout: InstallLayout;
  config: InstallConfig;
  baseEnv?: NodeJS.ProcessEnv;
  browserExecutable?: string;
  serviceUrl?: { python?: string; ollama?: string };
}

function resolvePathWithinRoot(layout: InstallLayout, relative: string, label: string): string {
  const safe = assertSafeRelativePath(relative);
  const target = resolve(layout.installRoot, safe);
  if (!isPathWithin(layout.installRoot, target)) {
    throw new Error(`${label} 必须位于安装目录内：${target}`);
  }
  return target;
}

/** 解析 `runtime.*` 配置为 `<InstallRoot>` 内的绝对路径。 */
export function resolveRuntimePath(layout: InstallLayout, relative: string, label = '运行时路径'): string {
  return resolvePathWithinRoot(layout, relative, label);
}

function resolveNodeDirectory(layout: InstallLayout, config: InstallConfig): string {
  const target = resolveRuntimePath(layout, config.runtime.node, 'runtime.node');
  return extname(target).toLowerCase() === '.exe' ? dirname(target) : target;
}

function resolveFfmpegDirectory(layout: InstallLayout, config: InstallConfig): string | undefined {
  if (!config.runtime.ffmpegDir) return undefined;
  return resolveRuntimePath(layout, config.runtime.ffmpegDir, 'runtime.ffmpegDir');
}

function findPathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
}

function prependPath(env: NodeJS.ProcessEnv, directories: Array<string | undefined>): void {
  const key = findPathKey(env);
  const existing = typeof env[key] === 'string' ? env[key]! : '';
  // #135: the managed directories always come first. Copies already present in the inherited PATH
  // are removed instead of being left where they were (behind a global FFmpeg, for example).
  const additions: string[] = [];
  const managed = new Set<string>();
  for (const directory of directories) {
    if (!directory) continue;
    const normalized = normalizePathForCompare(directory);
    if (managed.has(normalized)) continue;
    managed.add(normalized);
    additions.push(directory);
  }
  if (additions.length === 0) return;
  const parts = existing.split(';').filter(part => part.length > 0 && !managed.has(normalizePathForCompare(part)));
  env[key] = [...additions, ...parts].join(';');
}

function normalizePathForCompare(value: string): string {
  return value.replace(/[\\/]+$/, '').toLowerCase();
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * 构建受管服务（Python/Web/Worker/Ollama/模型管理器）的完整子进程环境。
 */
export function buildManagedServiceEnv(input: ServiceEnvInput): NodeJS.ProcessEnv {
  const { layout, config } = input;
  const base = input.baseEnv ?? process.env;
  const env: NodeJS.ProcessEnv = { ...base };
  const modelsRoot = layout.modelsRoot;
  const huggingFaceRoot = join(modelsRoot, 'huggingface');
  const dataRoot = layout.data;
  const tmpRoot = join(dataRoot, 'tmp');
  const pythonUrl = input.serviceUrl?.python ?? `http://127.0.0.1:${config.ports.python}`;
  const ollamaUrl = input.serviceUrl?.ollama ?? `http://127.0.0.1:${config.ports.ollama}`;

  env.M2V_INSTALL_ROOT = layout.installRoot;
  env.M2V_MODELS_ROOT = modelsRoot;
  env.M2V_DATA_DIR = dataRoot;
  env.OLLAMA_MODELS = join(modelsRoot, 'ollama');
  env.OLLAMA_BASE_URL = ollamaUrl;
  env.HF_HOME = huggingFaceRoot;
  env.HF_HUB_CACHE = join(huggingFaceRoot, 'hub');
  env.TRANSFORMERS_CACHE = join(huggingFaceRoot, 'hub');
  env.F5TTS_MODEL_DIR = join(modelsRoot, 'f5-tts', 'F5TTS_v1_Base');
  env.F5TTS_VOCODER_DIR = join(modelsRoot, 'f5-tts', 'vocos-mel-24khz');
  env.PYTHON_SERVICE_URL = pythonUrl;
  env.PORT = String(config.ports.web);
  env.NODE_ENV = 'production';
  env.DATABASE_URL = `file:${toPosixPath(join(dataRoot, 'm2v.db'))}`;
  env.TMP = tmpRoot;
  env.TEMP = tmpRoot;
  prependPath(env, [resolveNodeDirectory(layout, config), resolveFfmpegDirectory(layout, config)]);
  if (input.browserExecutable) env.REMOTION_BROWSER_EXECUTABLE = input.browserExecutable;
  return env;
}
