#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadInstallConfig, resolveInstallLayout } from '../install-layout.js';
import { createModelDirectoryResolver, resolveWithinRoot } from '../model-paths.js';
import { defaultModelManifest, loadModelManifest } from '../model-manifest.js';
import { ModelDownloadManager } from '../downloader.js';
import { readServiceState } from '../launcher.js';
import { isProcessAlive } from '../process-probe.js';
import { logsDirectory, planRepairs, planUninstall, runDiagnostics, uninstall, upgradeInstall } from '../maintenance.js';

/**
 * #106 维护 CLI：诊断/修复/升级/卸载/打开日志。
 *
 * 退出码：0 成功，2 参数/配置错误，3 诊断 fail 或操作失败。
 */

const execFileAsync = promisify(execFile);

interface MaintenanceOptions {
  installRoot?: string;
  diagnostics: boolean;
  repair: boolean;
  upgrade: boolean;
  payload?: string;
  uninstall: boolean;
  purgeData: boolean;
  purgeModels: boolean;
  yes: boolean;
  dryRun: boolean;
  openLogs: boolean;
  json: boolean;
  version: boolean;
  help: boolean;
  deferredUninstall: boolean;
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

export function parseMaintenanceOptions(argv: string[]): MaintenanceOptions {
  const options: MaintenanceOptions = {
    diagnostics: false,
    repair: false,
    upgrade: false,
    uninstall: false,
    purgeData: false,
    purgeModels: false,
    yes: false,
    dryRun: false,
    openLogs: false,
    json: false,
    version: false,
    help: false,
    deferredUninstall: false,
  };
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
      case '--diagnostics':
        options.diagnostics = true;
        break;
      case '--repair':
        options.repair = true;
        break;
      case '--upgrade':
        options.upgrade = true;
        break;
      case '--payload': {
        const value = takeValue();
        if (value) options.payload = value;
        break;
      }
      case '--uninstall':
        options.uninstall = true;
        break;
      case '--purge-data':
        options.purgeData = true;
        break;
      case '--purge-models':
        options.purgeModels = true;
        break;
      case '--yes':
        options.yes = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--open-logs':
        options.openLogs = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--version':
        options.version = true;
        break;
      case '--help':
        options.help = true;
        break;
      case '--deferred-uninstall':
        options.deferredUninstall = true;
        break;
      default:
        break;
    }
  }
  return options;
}

function inferInstallRoot(): string | undefined {
  try {
    const modulePath = fileURLToPath(import.meta.url);
    const cliDir = resolve(modulePath, '..');
    const desktopDir = resolve(cliDir, '..');
    const appDir = resolve(desktopDir, '..');
    if (desktopDir.endsWith('desktop') && appDir.endsWith('app')) return resolve(appDir, '..');
  } catch {
    /* 忽略。 */
  }
  return process.env.M2V_INSTALL_ROOT;
}

function desktopVersion(): string {
  try {
    const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: string };
    return typeof parsed.version === 'string' ? parsed.version : '1.8.0';
  } catch {
    return '1.8.0';
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      '知影维护工具（诊断 / 修复 / 升级 / 卸载）',
      '',
      '用法：node app/desktop/cli/maintenance-cli.mjs --install-root <安装目录> [操作]',
      '  --diagnostics [--json]                 运行完整环境诊断',
      '  --repair [--yes]                       生成修复建议；--yes 时执行模型下载/校验修复',
      '  --upgrade --payload <目录> [--dry-run]  使用新发行包原地升级（保留用户数据）',
      '  --uninstall [--purge-data] [--purge-models] [--yes] [--dry-run]',
      '                                         卸载；默认仅移除程序并保留数据',
      '  --open-logs                            打开日志目录',
      '  --version                              显示版本',
      '',
      '退出码：0 成功，2 参数/配置错误，3 诊断失败或操作失败。',
      '',
    ].join('\n'),
  );
}

function printDiagnostics(report: Awaited<ReturnType<typeof runDiagnostics>>): void {
  const mark: Record<string, string> = { ok: '✔', warn: '!', fail: '✖', missing: '-', corrupted: '✖', unknown: '?' };
  process.stdout.write(`知影 ${report.version} 诊断（${report.installRoot}）\n`);
  for (const check of report.checks) {
    process.stdout.write(`  ${mark[check.status] ?? '?'} [${check.status}] ${check.label}：${check.detail}\n`);
    if (check.status !== 'ok' && check.fix) process.stdout.write(`      修复建议：${check.fix}\n`);
  }
  process.stdout.write(`汇总：ok=${report.summary.ok} warn=${report.summary.warn} fail=${report.summary.fail}\n`);
}

async function executeRepairActions(
  installRoot: string,
  actions: ReturnType<typeof planRepairs>['actions'],
  json = false,
): Promise<{ code: number; executed: string[] }> {
  const layout = resolveInstallLayout(installRoot);
  const config = await loadInstallConfig(installRoot);
  const resolver = createModelDirectoryResolver(layout);
  const manifestPath = join(layout.installRoot, config.modelManifest);
  const manifest = existsSync(manifestPath) ? await loadModelManifest(manifestPath) : defaultModelManifest();
  // 与 model-manager-cli 一致：受管 Ollama 的模型目录/端口必须来自安装配置。
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
  });
  try {
    await manager.recover();
    let failures = 0;
    const executed: string[] = [];
    for (const action of actions) {
      if (action.kind === 'verify_models' && action.modelIds) {
        for (const id of action.modelIds) {
          if (!json) process.stdout.write(`重新校验模型 ${id}…\n`);
          let repaired = await manager.verify(id);
          if (!repaired) {
            // 校验失败后必须等待重新下载真正完成，否则 dispose() 会中止任务并造成“假修复”。
            await manager.start([id]);
            await manager.whenIdle();
            repaired = manager.get(id).status === 'installed';
            if (!json) process.stdout.write(`  重新下载结果：${manager.get(id).status}${manager.get(id).error ? `（${manager.get(id).error!.message}）` : ''}\n`);
          }
          executed.push(`verify_models:${id}:${manager.get(id).status}`);
          if (!repaired) failures += 1;
        }
      }
      if (action.kind !== 'verify_models' && action.kind !== 'download_models') {
        if (!json) process.stdout.write(`需要用户手动执行：[${action.kind}] ${action.description}\n`);
        executed.push(`${action.kind}:manual`);
      }
      if (action.kind === 'download_models' && action.modelIds) {
        if (!json) process.stdout.write(`开始下载模型：${action.modelIds.join('、')}…\n`);
        await manager.start(action.modelIds);
        await manager.whenIdle();
        for (const id of action.modelIds) {
          const state = manager.get(id);
          if (!json) process.stdout.write(`  ${id}：${state.status}${state.error ? `（${state.error.message}）` : ''}\n`);
          executed.push(`download_models:${id}:${state.status}`);
          if (state.status === 'failed' || state.status === 'corrupted') failures += 1;
        }
      }
    }
    return { code: failures > 0 ? 3 : 0, executed };
  } finally {
    await manager.dispose();
  }
}

/** 供测试直接调用的主流程；返回进程退出码。 */
export async function runMaintenanceCli(argv: string[]): Promise<number> {
  const options = parseMaintenanceOptions(argv);
  if (options.version) {
    process.stdout.write(`知影维护工具 ${desktopVersion()}\n`);
    return 0;
  }
  if (options.help || (!options.diagnostics && !options.repair && !options.upgrade && !options.uninstall && !options.openLogs)) {
    printHelp();
    return options.help ? 0 : 2;
  }
  const installRoot = options.installRoot ?? inferInstallRoot();
  if (!installRoot) {
    process.stderr.write('缺少 --install-root <安装目录> 参数（或设置 M2V_INSTALL_ROOT）。\n');
    return 2;
  }
  try {
    resolveInstallLayout(installRoot);
  } catch (error) {
    process.stderr.write(`安装目录无效：${(error as Error).message}\n`);
    return 2;
  }

  if (options.openLogs) {
    const logs = logsDirectory(installRoot);
    if (!logs || !existsSync(logs)) {
      process.stderr.write(`日志目录不存在：${logs ?? installRoot}\n`);
      return 3;
    }
    process.stdout.write(`日志目录：${logs}\n`);
    try {
      await execFileAsync('explorer.exe', [logs], { windowsHide: true, timeout: 10_000 });
    } catch {
      /* 资源管理器启动失败不影响退出码。 */
    }
    return 0;
  }

  if (options.diagnostics) {
    const report = await runDiagnostics({ installRoot, probeModels: true });
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printDiagnostics(report);
    return report.summary.fail > 0 ? 3 : 0;
  }

  if (options.repair) {
    const report = await runDiagnostics({ installRoot, probeModels: true });
    const { actions } = planRepairs(report);
    if (!options.json) printDiagnostics(report);
    if (actions.length === 0) {
      if (options.json) process.stdout.write(`${JSON.stringify({ report, actions, executed: false, message: '未发现需要修复的问题。' }, null, 2)}\n`);
      else process.stdout.write('未发现需要修复的问题。\n');
      return report.summary.fail > 0 ? 3 : 0;
    }
    if (!options.yes) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ report, actions, executed: false, requiresConfirmation: true }, null, 2)}\n`);
      } else {
        process.stdout.write('建议的修复动作：\n');
        for (const action of actions) process.stdout.write(`  · [${action.kind}] ${action.description}\n`);
        process.stdout.write('修复动作需要用户确认：请添加 --yes 后重新运行（不会在未确认时下载模型或修改系统环境变量）。\n');
      }
      return 3;
    }
    if (!options.json) {
      process.stdout.write('建议的修复动作：\n');
      for (const action of actions) process.stdout.write(`  · [${action.kind}] ${action.description}\n`);
    }
    const repaired = await executeRepairActions(installRoot, actions, options.json);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ report, actions, executed: true, results: repaired.executed, code: repaired.code }, null, 2)}\n`);
    }
    return repaired.code;
  }

  if (options.upgrade) {
    if (!options.payload) {
      process.stderr.write('--upgrade 需要 --payload <新发行目录>。\n');
      return 2;
    }
    let version = desktopVersion();
    try {
      const descriptor = JSON.parse(readFileSync(join(resolve(options.payload), 'release-manifest.json'), 'utf8')) as { version?: string };
      if (typeof descriptor.version === 'string' && descriptor.version.trim()) version = descriptor.version.trim();
    } catch {
      /* 使用当前版本号。 */
    }
    const result = await upgradeInstall({ installRoot, payloadRoot: resolve(options.payload), version, dryRun: options.dryRun });
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      if (result.ok) {
        process.stdout.write(`升级${result.fromVersion === result.toVersion ? '修复' : '完成'}：${result.fromVersion} → ${result.toVersion}\n`);
        process.stdout.write(`保留目录：${result.preserved.join('、')}\n`);
        if (result.backupPath) process.stdout.write(`升级前备份：${result.backupPath}\n`);
      } else {
        process.stderr.write(`升级失败：${result.errors.join('；')}\n`);
      }
    }
    return result.ok ? 0 : 3;
  }

  // 卸载
  const running = await readServiceState(resolveInstallLayout(installRoot));
  if (running && running.services.some(service => isProcessAlive(service.pid))) {
    process.stderr.write('知影服务正在运行，请先执行 Zhiying.exe --stop 停止后再卸载。\n');
    return 3;
  }
  const plan = await planUninstall({ installRoot, purgeData: options.purgeData, purgeModels: options.purgeModels });
  const purgeRequested = Boolean(options.purgeData || options.purgeModels);
  // 契约 §2.8：默认卸载仅移除程序（保留 models/data/logs/config），是安全的“仅移除程序”操作，
  // Windows 设置/控制面板的标准卸载入口可直接调用；只有 --purge-* 删除用户数据时才必须 --yes 二次确认。
  if (options.dryRun) {
    if (options.json) process.stdout.write(`${JSON.stringify({ plan, executed: false }, null, 2)}\n`);
    else {
      process.stdout.write(`卸载计划（安装目录：${plan.installRoot}）\n`);
      for (const target of plan.targets) process.stdout.write(`  删除 [${target.kind}] ${target.path}（${target.bytes} 字节）\n`);
      for (const preserved of plan.preserved) process.stdout.write(`  保留 ${preserved}\n`);
      process.stdout.write('--dry-run：未删除任何文件。\n');
    }
    return plan.errors.length > 0 ? 3 : 0;
  }
  if (purgeRequested && !options.yes) {
    if (options.json) process.stdout.write(`${JSON.stringify({ plan, executed: false, requiresConfirmation: true }, null, 2)}\n`);
    else {
      process.stdout.write(`卸载计划（安装目录：${plan.installRoot}）\n`);
      for (const target of plan.targets) process.stdout.write(`  删除 [${target.kind}] ${target.path}（${target.bytes} 字节）\n`);
      for (const preserved of plan.preserved) process.stdout.write(`  保留 ${preserved}\n`);
      process.stdout.write('删除模型或用户数据需要显式确认：请添加 --yes 后重新运行（不带 --purge-* 的默认卸载只移除程序，无需 --yes）。\n');
    }
    return 3;
  }
  if (!options.json) {
    process.stdout.write(`卸载知影${purgeRequested ? '（同时清理用户数据/模型）' : '（仅移除程序，保留 models/data/logs/config）'}…\n`);
    for (const preserved of plan.preserved) process.stdout.write(`  保留 ${preserved}\n`);
  }
  // 安装版运行时（node.exe）位于 <root>\runtime\node 时，uninstall() 会把锁定中的 runtime
  // 目录移动到安装目录同级并在本进程退出后由 cmd 删除。
  const result = await uninstall({
    installRoot,
    purgeData: options.purgeData,
    purgeModels: options.purgeModels,
    confirm: options.yes,
    dryRun: false,
  });
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (result.ok) {
    process.stdout.write('卸载完成。\n');
    for (const preserved of result.plan.preserved) process.stdout.write(`已保留：${preserved}\n`);
  } else {
    process.stderr.write(`卸载未完全成功：${result.errors.join('；')}\n`);
  }
  return result.ok ? 0 : 3;
}

if (isMainModule()) {
  runMaintenanceCli(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(error => {
      process.stderr.write(`维护工具异常退出：${(error as Error).message}\n`);
      process.exit(3);
    });
}




