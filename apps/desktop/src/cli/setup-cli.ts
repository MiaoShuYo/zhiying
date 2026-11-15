#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultPerUserInstallRoot,
  executeInstall,
  planInstall,
} from '../installer.js';
import type { InstallPlan } from '../installer.js';
import { loadInstallConfig } from '../install-layout.js';
import type { PayloadProfile } from '../install-layout.js';

/**
 * #103 安装器 CLI（控制台向导/静默安装）。
 *
 * 退出码：0 成功，2 用户取消，3 校验失败，4 安装失败。
 */

interface SetupOptions {
  payloadRoot?: string;
  target?: string;
  silent: boolean;
  interactive: boolean;
  downloadModels?: 'now' | 'later';
  createShortcut: boolean;
  writeRegistry: boolean;
  noLaunch: boolean;
  json: boolean;
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

export function parseSetupOptions(argv: string[]): SetupOptions {
  const options: SetupOptions = { silent: false, interactive: false, createShortcut: true, writeRegistry: true, noLaunch: false, json: false };
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
      case '--payload': {
        const value = takeValue();
        if (value) options.payloadRoot = value;
        break;
      }
      case '--target': {
        const value = takeValue();
        if (value) options.target = value;
        break;
      }
      case '--silent':
        options.silent = true;
        break;
      case '--interactive':
        options.interactive = true;
        break;
      case '--download-models': {
        const value = takeValue();
        if (value === 'now' || value === 'later') options.downloadModels = value;
        break;
      }
      case '--no-shortcut':
        options.createShortcut = false;
        break;
      case '--no-registry':
        options.writeRegistry = false;
        break;
      case '--no-launch':
        options.noLaunch = true;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        break;
    }
  }
  return options;
}

interface PayloadInfo {
  version: string;
  profile: PayloadProfile;
}

async function readPayloadInfo(payloadRoot: string): Promise<PayloadInfo> {
  let version = '1.8.0';
  let profile: PayloadProfile = 'lite';
  try {
    const manifest = JSON.parse(await readFile(join(payloadRoot, 'release-manifest.json'), 'utf8')) as Record<string, unknown>;
    if (typeof manifest.version === 'string' && manifest.version.trim()) version = manifest.version.trim();
    if (manifest.profile === 'full' || manifest.profile === 'lite') profile = manifest.profile;
  } catch {
    /* 回退到模板。 */
  }
  try {
    const template = JSON.parse(await readFile(join(payloadRoot, 'config', 'install.template.json'), 'utf8')) as Record<string, unknown>;
    if (typeof template.version === 'string' && template.version.trim()) version = template.version.trim();
    if (template.payloadProfile === 'full' || template.payloadProfile === 'lite') profile = template.payloadProfile;
  } catch {
    /* 使用默认。 */
  }
  return { version, profile };
}

interface Questioner {
  ask: (prompt: string, defaultValue?: string) => Promise<{ value: string; eof: boolean }>;
  close: () => void;
}

function createQuestioner(): Questioner {
  const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const lines: Array<string | null> = [];
  const pending: Array<(line: string | null) => void> = [];
  let closed = false;
  readline.on('line', line => {
    const resolver = pending.shift();
    if (resolver) resolver(line);
    else lines.push(line);
  });
  readline.on('close', () => {
    closed = true;
    while (pending.length > 0) {
      const resolver = pending.shift()!;
      resolver(null);
    }
  });
  return {
    ask: (prompt: string, defaultValue = '') =>
      new Promise(resolvePromise => {
        process.stdout.write(prompt);
        if (lines.length > 0) {
          const line = lines.shift()!;
          resolvePromise({ value: line.trim() || defaultValue, eof: false });
          return;
        }
        if (closed) {
          resolvePromise({ value: defaultValue, eof: true });
          return;
        }
        pending.push(line => {
          if (line === null) resolvePromise({ value: defaultValue, eof: true });
          else resolvePromise({ value: line.trim() || defaultValue, eof: false });
        });
      }),
    close: () => readline.close(),
  };
}

async function runInteractiveWizard(payloadInfo: PayloadInfo): Promise<{ target: string; downloadModels: 'now' | 'later'; createShortcut: boolean; cancelled: boolean }> {
  const questioner = createQuestioner();
  try {
    process.stdout.write('==============================================\n');
    process.stdout.write('             知影 Zhiying 安装程序\n');
    process.stdout.write('==============================================\n');
    process.stdout.write('产品名称：知影 Zhiying（本地 AI 视频工作室）\n');
    process.stdout.write(`版本：${payloadInfo.version}\n`);
    process.stdout.write('发行者：知影 / Zhiying\n');
    process.stdout.write('说明：安装知影桌面运行环境与启动器；模型不默认下载，稍后可在“设置 → 模型”中下载。\n');
    process.stdout.write('      所有知影管理的模型都会保存在安装目录的 models 文件夹内。\n\n');
    const defaultTarget = defaultPerUserInstallRoot(process.env);
    const targetAnswer = await questioner.ask(`请输入安装目录（回车使用默认 ${defaultTarget}）：`, defaultTarget);
    const target = targetAnswer.value.toLowerCase() === 'default' ? defaultTarget : targetAnswer.value;
    const shortcutAnswer = await questioner.ask('是否创建桌面快捷方式？(Y/n)：', 'Y');
    const createShortcut = !/^n/i.test(shortcutAnswer.value);
    const downloadAnswer = await questioner.ask('安装完成后是否立即下载 AI 模型？now=立即下载，later=稍后下载（默认 later）：', 'later');
    const downloadModels: 'now' | 'later' = /^now$/i.test(downloadAnswer.value) ? 'now' : 'later';
    const confirm = await questioner.ask(`确认安装到 ${target} ？(Y/n)：`, 'Y');
    if (confirm.eof || /^n/i.test(confirm.value)) {
      return { target, downloadModels, createShortcut, cancelled: true };
    }
    return { target, downloadModels, createShortcut, cancelled: false };
  } finally {
    questioner.close();
  }
}

async function launchModelManager(installRoot: string, version: string): Promise<string | undefined> {
  const nodeExe = join(installRoot, 'runtime', 'node', 'node.exe');
  const managerCli = join(installRoot, 'app', 'desktop', 'cli', 'model-manager-cli.mjs');
  if (!existsSync(nodeExe) || !existsSync(managerCli)) return undefined;
  let port = 8790;
  try {
    port = (await loadInstallConfig(installRoot)).ports.manager;
  } catch {
    /* 使用默认端口。 */
  }
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(nodeExe, [managerCli, '--install-root', installRoot, '--port', String(port), '--open'], {
    cwd: installRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  process.stdout.write(`模型管理器已启动：${url}（知影 ${version}）\n`);
  return url;
}

/** 供测试直接调用的主流程；返回进程退出码。 */
export async function runSetupCli(argv: string[]): Promise<number> {
  const options = parseSetupOptions(argv);
  if (!options.payloadRoot) {
    process.stderr.write('缺少 --payload <安装包目录> 参数。\n');
    return 3;
  }
  const payloadRoot = resolve(options.payloadRoot);
  if (!existsSync(join(payloadRoot, 'Zhiying.exe')) || !existsSync(join(payloadRoot, 'runtime'))) {
    process.stderr.write(`安装包目录不完整：${payloadRoot}\n`);
    return 3;
  }
  const payloadInfo = await readPayloadInfo(payloadRoot);
  let target = options.target?.trim();
  let createShortcut = options.createShortcut;
  let downloadModels = options.downloadModels ?? 'later';
  if (options.interactive && !options.silent) {
    const wizard = await runInteractiveWizard(payloadInfo);
    if (wizard.cancelled) {
      process.stdout.write('已取消安装，未写入任何文件。\n');
      return 2;
    }
    target = wizard.target;
    createShortcut = wizard.createShortcut;
    downloadModels = wizard.downloadModels;
  }
  let plan: InstallPlan;
  try {
    plan = await planInstall({
      payloadRoot,
      ...(target ? { targetRoot: target } : {}),
      version: payloadInfo.version,
      profile: payloadInfo.profile,
      createShortcut,
      writeRegistry: options.writeRegistry,
      downloadModels,
    });
  } catch (error) {
    process.stderr.write(`安装前校验失败：${(error as Error).message}\n`);
    return 3;
  }
  if (!options.json) {
    process.stdout.write(`准备安装知影 ${plan.version}（${plan.profile}）到 ${plan.targetRoot}\n`);
    for (const step of plan.steps) process.stdout.write(`  · ${step}\n`);
  }
  const result = await executeInstall(plan);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    if (result.warnings.length > 0) {
      for (const warning of result.warnings) process.stdout.write(`警告：${warning}\n`);
    }
    if (!result.ok) {
      process.stderr.write(`安装失败：${result.errors.join('；')}\n安装日志：${result.logPath || '（未写入）'}\n`);
    } else {
      process.stdout.write(`\n安装完成：知影 ${plan.version} 已安装到 ${plan.targetRoot}\n`);
      process.stdout.write(`安装日志：${result.logPath}\n`);
      process.stdout.write('安装完成。是否现在下载 AI 模型？\n');
      process.stdout.write(`  · 立即下载：重新运行 “Zhiying.exe” 打开模型管理器，或在“设置 → 模型”中下载\n`);
      process.stdout.write(`  · 稍后下载：可直接启动知影，模型未就绪时会给出提示\n`);
      process.stdout.write(`本次选择：${plan.downloadModels === 'now' ? '立即下载' : '稍后下载'}\n`);
    }
  }
  if (!result.ok) return 4;
  if (result.launchModelManager && !options.noLaunch) {
    const url = await launchModelManager(plan.targetRoot, plan.version);
    if (url && !options.json) process.stdout.write(`模型管理器地址：${url}\n`);
  } else if (result.launchModelManager) {
    process.stdout.write(`模型管理器命令（--no-launch 未自动启动）："${join(plan.targetRoot, 'runtime', 'node', 'node.exe')}" "${join(plan.targetRoot, 'app', 'desktop', 'cli', 'model-manager-cli.mjs')}" --install-root "${plan.targetRoot}" --port 8790\n`);
  }
  return 0;
}

if (isMainModule()) {
  runSetupCli(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(error => {
      process.stderr.write(`安装程序异常退出：${(error as Error).message}\n`);
      process.exit(4);
    });
}
