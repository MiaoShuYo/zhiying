#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PORTS,
  loadInstallConfig,
  resolveInstallLayout,
} from '../install-layout.js';
import type { InstallConfig, InstallLayout } from '../install-layout.js';
import { createModelDirectoryResolver, resolveWithinRoot } from '../model-paths.js';
import { defaultModelManifest, loadModelManifest } from '../model-manifest.js';
import type { ModelManifest } from '../model-manifest.js';
import { ModelDownloadManager } from '../downloader.js';
import { createModelManagerServer } from '../download-server.js';
import { openBrowser } from '../launcher.js';
import { verifyManagedOllama } from '../managed-ollama.js';

/**
 * #105 模型管理器 CLI。
 *
 * 退出码：0 成功/已就绪，2 参数或配置错误，4 下载失败。
 */

export interface CliOptions {
  installRoot?: string;
  manifest?: string;
  port?: number;
  open: boolean;
  printStatus: boolean;
  download: string[];
  json: boolean;
  sourceBaseUrl?: string;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = { open: false, printStatus: false, download: [], json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const equals = raw.indexOf('=');
    const key = equals >= 0 ? raw.slice(0, equals) : raw;
    const inlineValue = equals >= 0 ? raw.slice(equals + 1) : undefined;
    const takeValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        index += 1;
        return next;
      }
      return undefined;
    };
    switch (key) {
      case '--install-root': {
        const value = takeValue();
        if (value) options.installRoot = value;
        break;
      }
      case '--manifest': {
        const value = takeValue();
        if (value) options.manifest = value;
        break;
      }
      case '--port': {
        const value = takeValue();
        if (value) options.port = Number(value);
        break;
      }
      case '--download': {
        const value = takeValue();
        if (value) options.download.push(...value.split(',').map(item => item.trim()).filter(Boolean));
        break;
      }
      case '--source-base-url': {
        const value = takeValue();
        if (value) options.sourceBaseUrl = value;
        break;
      }
      case '--open':
        options.open = true;
        break;
      case '--no-open':
        options.open = false;
        break;
      case '--print-status':
        options.printStatus = true;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        // 未知参数（如启动器附加的 --m2v-instance=...）忽略，保持启动器兼容。
        break;
    }
  }
  return options;
}

function inferInstallRoot(): string | undefined {
  try {
    const modulePath = fileURLToPath(import.meta.url);
    const cliDir = dirname(modulePath);
    const desktopDir = dirname(cliDir);
    const appDir = dirname(desktopDir);
    if (desktopDir.endsWith('desktop') && appDir.endsWith('app')) return resolve(appDir, '..');
  } catch {
    /* 无法推断。 */
  }
  return process.env.M2V_INSTALL_ROOT;
}

function buildDefaultConfig(layout: InstallLayout): InstallConfig {
  return {
    schemaVersion: 1,
    product: 'zhiying',
    version: '1.8.0',
    installRoot: layout.installRoot,
    installedAt: new Date().toISOString(),
    perUser: true,
    payloadProfile: 'lite',
    runtime: { node: join('runtime', 'node', 'node.exe'), python: join('runtime', 'python', 'python.exe'), ffmpegDir: join('runtime', 'ffmpeg'), ollama: join('runtime', 'ollama', 'ollama.exe') },
    ports: { ...DEFAULT_PORTS },
    managedProcesses: { ollama: true },
    modelManifest: join('models', '.downloads', 'manifest.json'),
    firstRunCompleted: false,
  };
}

async function resolveManifest(options: CliOptions, layout: InstallLayout, config: InstallConfig): Promise<ModelManifest> {
  if (options.manifest) return loadModelManifest(resolve(options.manifest));
  const configured = join(layout.installRoot, config.modelManifest);
  if (existsSync(configured)) return loadModelManifest(configured);
  return defaultModelManifest();
}

async function buildStatusReport(
  manager: ModelDownloadManager,
  layout: InstallLayout,
  config: InstallConfig,
): Promise<Record<string, unknown>> {
  const resolver = createModelDirectoryResolver(layout);
  const manifest = manager.getManifest();
  const states = manager.list();
  const disk = await resolver.describe();
  return {
    installRoot: layout.installRoot,
    modelsRoot: resolver.resolveModelsRoot(),
    version: config.version,
    disk,
    overall: ModelDownloadManager.computeOverall(states),
    models: states.map(state => {
      const entry = manifest.models.find(model => model.id === state.id);
      return {
        ...state,
        name: entry?.name ?? state.id,
        purpose: entry?.purpose ?? 'unknown',
        required: entry?.required ?? false,
        sizeBytes: entry?.totalBytes ?? 0,
        installPath: entry ? resolver.resolveModelInstallPath(entry.installDir) : '',
        license: entry?.license,
      };
    }),
  };
}

/** 供 E2E/测试直接调用的主流程；返回进程退出码。 */
export async function runModelManagerCli(argv: string[]): Promise<number> {
  const options = parseCliOptions(argv);
  const installRoot = options.installRoot ?? inferInstallRoot();
  if (!installRoot) {
    process.stderr.write('缺少 --install-root <安装目录> 参数（也可设置 M2V_INSTALL_ROOT）。\n');
    return 2;
  }
  let layout: InstallLayout;
  let config: InstallConfig;
  try {
    layout = resolveInstallLayout(installRoot);
    // #127: the defaults are only for an installation without config/install.json. An existing file
    // that cannot be read or validated is a configuration error, not a reason to use default ports.
    config = existsSync(layout.installConfigPath) ? await loadInstallConfig(installRoot) : buildDefaultConfig(layout);
  } catch (error) {
    process.stderr.write(`安装目录或安装配置无效：${(error as Error).message}\n`);
    return 2;
  }
  let manifest: ModelManifest;
  try {
    manifest = await resolveManifest(options, layout, config);
  } catch (error) {
    process.stderr.write(`模型清单加载失败：${(error as Error).message}\n`);
    return 2;
  }
  const resolver = createModelDirectoryResolver(layout);
  await resolver.ensureModelDirectories();
  const sourceBaseUrl = options.sourceBaseUrl ?? process.env.M2V_MODEL_SOURCE_BASE;
  // 受管 Ollama 隔离：pull 必须指向 config 中的受管端口/模型目录，而不是系统 11434/全局缓存。
  const ollamaEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OLLAMA_MODELS: resolver.resolveOllamaStore(),
    OLLAMA_HOST: `127.0.0.1:${config.ports.ollama}`,
    OLLAMA_BASE_URL: `http://127.0.0.1:${config.ports.ollama}`,
  };
  let ollamaCommand: string | undefined;
  if (config.runtime.ollama) {
    try {
      ollamaCommand = resolveWithinRoot(layout.installRoot, config.runtime.ollama);
    } catch {
      ollamaCommand = undefined;
    }
  }
  const manager = new ModelDownloadManager({
    manifest,
    resolver,
    statePath: layout.modelStatePath,
    ollamaEnv,
    ...(ollamaCommand ? { ollamaCommand } : {}),
    ...(sourceBaseUrl ? { sourceBaseUrl } : {}),
    // #136 / #128: pull through the managed server's /api/pull, and only after verifying that the
    // listener on the configured port is the Ollama the Zhiying launcher started.
    ollamaBaseUrl: `http://127.0.0.1:${config.ports.ollama}`,
    ensureOllamaReady: () => verifyManagedOllama(layout, config.ports.ollama),
  });
  await manager.recover();
  const port = Number.isInteger(options.port) && (options.port as number) >= 0 ? (options.port as number) : config.ports.manager ?? 8790;

  const printReport = async (): Promise<void> => {
    const report = await buildStatusReport(manager, layout, config);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    const overall = report.overall as { percent?: number; indeterminate: boolean };
    process.stdout.write(`安装目录：${layout.installRoot}\n模型目录：${resolver.resolveModelsRoot()}\n`);
    process.stdout.write(`总进度：${overall.indeterminate || overall.percent === undefined ? '不确定' : `${overall.percent}%`}\n`);
    for (const model of report.models as Array<Record<string, unknown>>) {
      const percent = typeof model.percent === 'number' ? ` ${model.percent}%` : '';
      process.stdout.write(`  - ${model.id}：${model.status}${percent}\n`);
      if (model.error && typeof model.error === 'object') {
        process.stdout.write(`    ${(model.error as { message?: string }).message ?? ''}\n`);
      }
    }
  };

  if (options.printStatus) {
    await printReport();
    await manager.dispose();
    return 0;
  }

  if (options.download.length > 0) {
    try {
      await manager.start(options.download);
      await manager.whenIdle();
    } catch (error) {
      process.stderr.write(`下载失败：${(error as Error).message}\n`);
      await manager.dispose();
      return 4;
    }
    const failed = manager.list().filter(state => state.status === 'failed' || state.status === 'corrupted');
    await printReport();
    if (failed.length > 0) {
      await manager.dispose();
      return 4;
    }
    if (!options.open) {
      await manager.dispose();
      return 0;
    }
  }

  // 服务模式：常驻并推送 SSE，直到收到 SIGINT/SIGTERM。
  let server;
  try {
    server = await createModelManagerServer({
      manager,
      resolver,
      installRoot: layout.installRoot,
      port,
    });
  } catch (error) {
    process.stderr.write(`启动模型管理器服务失败：${(error as Error).message}\n`);
    await manager.dispose();
    return 2;
  }
  process.stdout.write(`模型管理器已启动：${server.url}\n`);
  if (options.open) {
    try {
      await openBrowser(server.url);
    } catch (error) {
      process.stderr.write(`打开浏览器失败：${(error as Error).message}\n`);
    }
  }
  await new Promise<void>(resolvePromise => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    process.once('SIGHUP', finish);
  });
  await server.close();
  await manager.dispose();
  return 0;
}

if (isMainModule()) {
  runModelManagerCli(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(error => {
      process.stderr.write(`模型管理器异常退出：${(error as Error).message}\n`);
      process.exit(2);
    });
}

