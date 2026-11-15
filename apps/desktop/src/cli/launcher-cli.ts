#!/usr/bin/env node
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORTS, loadInstallConfig, resolveInstallLayout } from '../install-layout.js';
import type { InstallConfig, InstallLayout } from '../install-layout.js';
import { buildServiceSpecs, openBrowser, readServiceState, ServiceSupervisor } from '../launcher.js';

/**
 * #102 桌面启动器 CLI。
 *
 * 退出码：0 成功/已运行，2 配置错误，3 启动失败，4 停止失败。
 */

interface LauncherOptions {
  installRoot?: string;
  dev: boolean;
  status: boolean;
  stop: boolean;
  noBrowser: boolean;
  json: boolean;
  exitAfterStart: boolean;
  repoRoot?: string;
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

export function parseLauncherOptions(argv: string[]): LauncherOptions {
  const options: LauncherOptions = { dev: false, status: false, stop: false, noBrowser: false, json: false, exitAfterStart: false };
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
      case '--repo-root': {
        const value = takeValue();
        if (value) options.repoRoot = value;
        break;
      }
      case '--dev':
        options.dev = true;
        break;
      case '--status':
        options.status = true;
        break;
      case '--stop':
        options.stop = true;
        break;
      case '--no-browser':
        options.noBrowser = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--exit-after-start':
        options.exitAfterStart = true;
        break;
      default:
        // 忽略额外参数（启动器会附加 --m2v-instance=... 等）。
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
    /* 忽略。 */
  }
  return process.env.M2V_INSTALL_ROOT;
}

function buildDevConfig(layout: InstallLayout): InstallConfig {
  return {
    schemaVersion: 1,
    product: 'zhiying',
    version: '1.8.0',
    installRoot: layout.installRoot,
    installedAt: new Date().toISOString(),
    perUser: true,
    payloadProfile: 'lite',
    runtime: { node: process.execPath, python: 'runtime\\python\\python.exe' },
    ports: { ...DEFAULT_PORTS },
    managedProcesses: { ollama: false },
    modelManifest: 'models\\.downloads\\manifest.json',
    firstRunCompleted: false,
  };
}

function printServices(services: Array<{ id: string; pid?: number; alive?: boolean; logFile?: string }>): void {
  for (const service of services) {
    process.stdout.write(`  · ${service.id}${service.pid ? `（PID ${service.pid}）` : ''}${service.alive === false ? '（未运行）' : ''}\n`);
    if (service.logFile) process.stdout.write(`    日志：${service.logFile}\n`);
  }
}

function waitForStopSignal(layout: InstallLayout): Promise<void> {
  return new Promise(resolvePromise => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      resolvePromise();
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    process.once('SIGHUP', finish);
    // 另一个启动器实例执行 --stop 后会删除状态文件；此时退出前台进程。
    timer = setInterval(() => {
      void readServiceState(layout).then(state => {
        if (!state) finish();
      });
    }, 1500);
    timer.unref?.();
  });
}

/** 供测试直接调用的主流程；返回进程退出码。 */
export async function runLauncherCli(argv: string[]): Promise<number> {
  const options = parseLauncherOptions(argv);
  let layout: InstallLayout;
  let config: InstallConfig;
  let specs;
  try {
    if (options.dev) {
      const repoRoot = resolve(options.repoRoot ?? process.cwd());
      layout = resolveInstallLayout(options.installRoot ?? repoRoot);
      config = buildDevConfig(layout);
      specs = buildServiceSpecs({ layout, config, mode: 'dev', repoRoot });
    } else {
      const installRoot = options.installRoot ?? inferInstallRoot();
      if (!installRoot) {
        process.stderr.write('缺少 --install-root <安装目录> 参数（或设置 M2V_INSTALL_ROOT）。\n');
        return 2;
      }
      layout = resolveInstallLayout(installRoot);
      config = await loadInstallConfig(installRoot);
      specs = buildServiceSpecs({ layout, config, mode: 'packaged' });
    }
  } catch (error) {
    process.stderr.write(`启动配置无效：${(error as Error).message}\n`);
    return 2;
  }
  const supervisor = new ServiceSupervisor({
    layout,
    config,
    specs,
    openBrowserImpl: options.noBrowser ? async () => undefined : openBrowser,
    // 真实启动路径：健康响应后校验监听端口属于本实例，外部监听者不能冒充受管服务。
    verifyServiceOwnership: true,
  });

  if (options.status) {
    try {
      const status = await supervisor.status();
      if (options.json) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      else {
        process.stdout.write(status.running ? `知影正在运行：${status.url ?? ''}\n` : '知影当前未运行。\n');
        printServices(status.services);
      }
      return status.running ? 0 : 3;
    } catch (error) {
      process.stderr.write(`读取运行状态失败：${(error as Error).message}\n`);
      return 3;
    }
  }

  if (options.stop) {
    try {
      const result = await supervisor.stop();
      if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(`已停止 ${result.stopped.length} 个知影服务${result.skipped.length ? `；跳过 ${result.skipped.join('、')}` : ''}。\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`停止知影服务失败：${(error as Error).message}\n`);
      return 4;
    }
  }

  let result;
  try {
    result = await supervisor.start();
  } catch (error) {
    process.stderr.write(`启动失败：${(error as Error).message}\n`);
    return 3;
  }
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    if (result.status === 'already_running') process.stdout.write(`知影已在运行：${result.url ?? ''}\n`);
    else if (result.status === 'started') {
      process.stdout.write(`知影已启动：${result.url ?? ''}\n`);
      printServices(result.services);
      process.stdout.write(`日志目录：${result.logDir}\n`);
    }
    for (const warning of result.errors) process.stderr.write(`警告：${warning}\n`);
    for (const conflict of result.conflicts) process.stderr.write(`端口冲突：${conflict.message}\n`);
  }
  if (result.status === 'failed') {
    for (const error of result.errors) process.stderr.write(`错误：${error}\n`);
    return 3;
  }
  if (result.status === 'already_running' || options.exitAfterStart) return 0;
  // 前台保持运行：关闭窗口/Ctrl+C/另一实例 --stop 后停止本实例服务。
  await waitForStopSignal(layout);
  try {
    await supervisor.stop();
  } catch {
    return 4;
  }
  return 0;
}

if (isMainModule()) {
  runLauncherCli(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(error => {
      process.stderr.write(`启动器异常退出：${(error as Error).message}\n`);
      process.exit(3);
    });
}
