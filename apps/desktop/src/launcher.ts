import { execFile, spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { appendFile, mkdir, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import {
  formatTimestamp,
  readJsonFile,
  writeInstallConfig,
  writeJsonAtomic,
} from './install-layout.js';
import type { InstallConfig, InstallLayout } from './install-layout.js';
import { assertNoReparseEscape, isPathWithin } from './model-paths.js';
import {
  inspectPort as defaultInspectPort,
  isProcessAlive,
  readProcessInfos,
} from './process-probe.js';
import type { PortInspection } from './process-probe.js';
import { buildManagedServiceEnv, resolveRuntimePath } from './service-env.js';
import { cleanInstallArtifacts } from './installer.js';

/**
 * #102 桌面启动器：受管服务规格、启动顺序、健康检查、重复启动防护、
 * 端口冲突处理、日志与安全退出（只结束本实例进程树）。
 */

const execFileAsync = promisify(execFile);

export type ServiceId = 'python' | 'web' | 'worker' | 'ollama' | 'download-manager';
export type LauncherMode = 'packaged' | 'dev';

export interface ManagedServiceSpec {
  id: ServiceId;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  health?: { url?: string; port?: number; timeoutMs: number };
  required: boolean;
}

export interface PortConflict {
  port: number;
  owner?: { pid?: number; name?: string };
  message: string;
}

export interface ManagedServiceRuntime {
  id: ServiceId;
  pid: number;
  startedAtMs: number;
  commandLine: string;
  logFile: string;
}

export interface ServiceStateFile {
  instanceId: string;
  startedAt: string;
  installRoot: string;
  version: string;
  services: ManagedServiceRuntime[];
}

export interface SupervisorOptions {
  layout: InstallLayout;
  config: InstallConfig;
  specs: ManagedServiceSpec[];
  spawnImpl?: typeof nodeSpawn;
  probeImpl?: (port: number) => Promise<PortInspection>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  openBrowserImpl?: (url: string) => Promise<void>;
  /**
   * 真实启动路径开启：健康检查后确认监听端口的进程属于本实例（PID 链 + 实例标记/命令行），
   * 防止外部监听者用 200 响应冒充受管服务。默认关闭以兼容注入 fake 的单元测试。
   */
  verifyServiceOwnership?: boolean;
}

export type StartStatus = 'started' | 'already_running' | 'failed';
export interface StartResult {
  status: StartStatus;
  url?: string;
  services: ManagedServiceRuntime[];
  conflicts: PortConflict[];
  errors: string[];
  logDir: string;
}

export interface StopResult {
  stopped: string[];
  skipped: string[];
}

export interface StatusResult {
  running: boolean;
  url?: string;
  services: Array<{ id: string; pid?: number; alive: boolean; managed: boolean; logFile?: string }>;
}

const HEALTH_TIMEOUTS: Readonly<Record<ServiceId, number>> = {
  python: 90_000,
  web: 120_000,
  worker: 60_000,
  ollama: 30_000,
  'download-manager': 30_000,
};

function isNodeExecutable(command: string): boolean {
  return ['node', 'node.exe'].includes(basename(command).toLowerCase());
}

function quoteForCommandLine(token: string): string {
  if (!token) return '""';
  return /[\s"]/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token;
}

function formatCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteForCommandLine).join(' ');
}

class ServiceOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceOwnershipError';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function normalizeCommandLine(value: string): string {
  return value.toLowerCase().replace(/"/g, '').replace(/\s+/g, ' ').trim();
}

function commandLineMatches(actual: string | undefined, recorded: string | undefined): boolean {
  if (!actual || !recorded) return false;
  const left = normalizeCommandLine(actual);
  const right = normalizeCommandLine(recorded);
  if (!left || !right) return false;
  return left.includes(right) || right.includes(left);
}

function hasInstanceMarker(commandLine: string | undefined, instanceId: string): boolean {
  if (!commandLine || !instanceId) return false;
  return commandLine.includes(`--m2v-instance=${instanceId}`) || commandLine.includes(`M2V_MANAGED_INSTANCE=${instanceId}`);
}

function findExecutableOnPath(name: string): string | undefined {
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const directory of pathValue.split(';')) {
    if (!directory.trim()) continue;
    for (const extension of extensions) {
      const candidate = join(directory.trim(), `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function prependPathEntries(env: NodeJS.ProcessEnv, directories: Array<string | undefined>): void {
  const key = Object.keys(env).find(item => item.toLowerCase() === 'path') ?? 'PATH';
  const existing = typeof env[key] === 'string' ? env[key]! : '';
  const parts = existing.split(';').filter(part => part.length > 0);
  const seen = new Set(parts.map(part => part.replace(/[\\/]+$/, '').toLowerCase()));
  const additions: string[] = [];
  for (const directory of directories) {
    if (!directory) continue;
    const normalized = directory.replace(/[\\/]+$/, '').toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    additions.push(directory);
  }
  if (additions.length > 0) env[key] = [...additions, ...parts].join(';');
}

function buildDevEnv(repoRoot: string, ffmpegDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    M2V_DEV_MODE: '1',
    M2V_DATA_DIR: join(repoRoot, 'data'),
    PYTHON_SERVICE_URL: 'http://127.0.0.1:8000',
    OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
    PORT: '3000',
  };
  const ffmpeg = ffmpegDir ?? process.env.M2V_FFMPEG_BIN ?? findExecutableOnPath('ffmpeg');
  if (ffmpeg) prependPathEntries(env, [ffmpeg]);
  return env;
}

function packagedRuntimePath(layout: InstallLayout, relative: string, label: string): string {
  const target = resolveRuntimePath(layout, relative, label);
  if (!isPathWithin(layout.installRoot, target)) throw new Error(`${label} 必须位于安装目录内`);
  return target;
}

function specHealth(
  id: ServiceId,
  url: string,
  port: number,
  timeoutMs = HEALTH_TIMEOUTS[id],
): ManagedServiceSpec['health'] {
  // port 必须提供：ServiceSupervisor.start() 依赖它做“外部进程占用端口”预检查，
  // 缺失时冲突检测会被跳过并把外部服务的 HTTP 200 误当成自己的健康响应。
  return { url, port, timeoutMs };
}

/**
 * 构建受管服务启动规格：`packaged` 走安装版产物，`dev` 保持 start.ps1 语义。
 */
export function buildServiceSpecs(input: {
  layout: InstallLayout;
  config: InstallConfig;
  mode: LauncherMode;
  repoRoot?: string;
  ffmpegDir?: string;
  nodeExe?: string;
}): ManagedServiceSpec[] {
  const { layout, config } = input;
  const ports = config.ports;
  if (input.mode === 'dev') {
    const repoRoot = input.repoRoot;
    if (!repoRoot) throw new Error('开发模式的 buildServiceSpecs 需要 repoRoot');
    const env = buildDevEnv(repoRoot, input.ffmpegDir);
    const pythonRoot = join(repoRoot, 'services', 'python');
    return [
      {
        id: 'python',
        label: 'Python 服务（开发模式）',
        command: join(pythonRoot, '.venv', 'Scripts', 'python.exe'),
        args: ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000'],
        cwd: pythonRoot,
        env,
        health: specHealth('python', 'http://127.0.0.1:8000/health', 8000, 90_000),
        required: true,
      },
      {
        id: 'web',
        label: 'Web 服务（开发模式）',
        command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        args: ['--filter', '@m2v/web', 'dev'],
        cwd: repoRoot,
        env,
        health: specHealth('web', 'http://127.0.0.1:3000/', 3000, 120_000),
        required: true,
      },
      {
        id: 'worker',
        label: '渲染 Worker（开发模式）',
        command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        args: ['--filter', '@m2v/worker', 'dev'],
        cwd: repoRoot,
        env,
        required: true,
      },
    ];
  }

  const nodeExe = input.nodeExe ?? packagedRuntimePath(layout, config.runtime.node, 'runtime.node');
  const fixtures = join(layout.app, 'fixtures');
  const managedEnv = buildManagedServiceEnv({ layout, config, baseEnv: process.env });
  const specs: ManagedServiceSpec[] = [];
  const fixtureMode = config.payloadProfile === 'lite';

  if (fixtureMode) {
    specs.push({
      id: 'python',
      label: 'Python 服务（lite fixture）',
      command: nodeExe,
      args: [join(fixtures, 'python.mjs'), `--port=${ports.python}`],
      cwd: fixtures,
      env: managedEnv,
      health: specHealth('python', `http://127.0.0.1:${ports.python}/health`, ports.python, 90_000),
      required: true,
    });
  } else {
    specs.push({
      id: 'python',
      label: 'Python 服务',
      command: packagedRuntimePath(layout, config.runtime.python ?? 'runtime\\python\\python.exe', 'runtime.python'),
      args: ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(ports.python)],
      cwd: join(layout.app, 'python'),
      env: managedEnv,
      health: specHealth('python', `http://127.0.0.1:${ports.python}/health`, ports.python, 90_000),
      required: true,
    });
  }

  if (config.managedProcesses.ollama) {
    const ollamaCommand = fixtureMode
      ? nodeExe
      : packagedRuntimePath(layout, config.runtime.ollama ?? 'runtime\\ollama\\ollama.exe', 'runtime.ollama');
    specs.push({
      id: 'ollama',
      label: fixtureMode ? '受管 Ollama（lite fixture）' : '受管 Ollama',
      command: ollamaCommand,
      args: fixtureMode ? [join(fixtures, 'ollama.mjs'), `--port=${ports.ollama}`] : ['serve'],
      cwd: fixtureMode ? fixtures : layout.runtime,
      env: { ...managedEnv, ...(fixtureMode ? {} : { OLLAMA_HOST: `127.0.0.1:${ports.ollama}` }) },
      health: specHealth('ollama', `http://127.0.0.1:${ports.ollama}/api/version`, ports.ollama, 30_000),
      required: true,
    });
  }

  specs.push({
    id: 'web',
    label: fixtureMode ? 'Web 服务（lite fixture）' : 'Web 服务',
    command: nodeExe,
    args: fixtureMode ? [join(fixtures, 'web.mjs'), `--port=${ports.web}`] : [join(layout.app, 'web', 'server.js')],
    cwd: fixtureMode ? fixtures : join(layout.app, 'web'),
    env: managedEnv,
    health: specHealth('web', `http://127.0.0.1:${ports.web}/`, ports.web, 120_000),
    required: true,
  });

  specs.push({
    id: 'worker',
    label: fixtureMode ? '渲染 Worker（lite fixture）' : '渲染 Worker',
    command: nodeExe,
    args: fixtureMode ? [join(fixtures, 'worker.mjs')] : [join(layout.app, 'worker', 'index.js')],
    cwd: fixtureMode ? fixtures : join(layout.app, 'worker'),
    env: managedEnv,
    required: true,
  });

  specs.push({
    id: 'download-manager',
    label: '模型管理器',
    command: nodeExe,
    args: [
      join(layout.app, 'desktop', 'cli', 'model-manager-cli.mjs'),
      '--install-root',
      layout.installRoot,
      '--port',
      String(ports.manager),
    ],
    cwd: join(layout.app, 'desktop'),
    env: managedEnv,
    health: specHealth('download-manager', `http://127.0.0.1:${ports.manager}/api/models`, ports.manager, 30_000),
    required: false,
  });

  return specs;
}

/** 打开系统默认浏览器（仅健康检查通过后调用）。 */
export async function openBrowser(url: string): Promise<void> {
  const child: ChildProcess =
    process.platform === 'win32'
      ? nodeSpawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
      : process.platform === 'darwin'
        ? nodeSpawn('open', [url], { detached: true, stdio: 'ignore' })
        : nodeSpawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.unref();
  await Promise.resolve();
}

async function killProcessTree(pid: number | undefined): Promise<void> {
  if (!pid || !isProcessAlive(pid)) return;
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 20_000 });
    } catch {
      /* 进程可能已自行退出。 */
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已退出。 */
    }
  }
}

/** 读取 `<root>\\data\\runtime\\services.json`；不存在或损坏返回 undefined。 */
export async function readServiceState(layout: InstallLayout): Promise<ServiceStateFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(layout.serviceStatePath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.instanceId !== 'string' || !Array.isArray(record.services)) return undefined;
  const services: ManagedServiceRuntime[] = [];
  for (const entry of record.services) {
    if (!entry || typeof entry !== 'object') return undefined;
    const service = entry as Record<string, unknown>;
    if (typeof service.id !== 'string' || typeof service.pid !== 'number') return undefined;
    services.push({
      id: service.id as ServiceId,
      pid: service.pid,
      startedAtMs: typeof service.startedAtMs === 'number' ? service.startedAtMs : Date.now(),
      commandLine: typeof service.commandLine === 'string' ? service.commandLine : '',
      logFile: typeof service.logFile === 'string' ? service.logFile : '',
    });
  }
  return {
    instanceId: record.instanceId,
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : new Date().toISOString(),
    installRoot: typeof record.installRoot === 'string' ? record.installRoot : layout.installRoot,
    version: typeof record.version === 'string' ? record.version : '',
    services,
  };
}

interface ClassifiedService {
  entry: ManagedServiceRuntime;
  alive: boolean;
  managed: boolean;
}

async function classifyServices(
  services: ManagedServiceRuntime[],
  instanceId: string,
): Promise<ClassifiedService[]> {
  const aliveServices = services.filter(service => isProcessAlive(service.pid));
  const infos = await readProcessInfos(aliveServices.map(service => service.pid));
  return services.map(entry => {
    const alive = isProcessAlive(entry.pid);
    const commandLine = infos.get(entry.pid)?.commandLine;
    const managed = alive && (hasInstanceMarker(commandLine, instanceId) || commandLineMatches(commandLine, entry.commandLine));
    return { entry, alive, managed };
  });
}

async function countUnfinishedDownloads(statePath: string): Promise<number> {
  try {
    const state = await readJsonFile<{ models?: Record<string, { status?: string }> }>(statePath);
    const models = state.models ?? {};
    return Object.values(models).filter(item => item?.status === 'downloading' || item?.status === 'paused' || item?.status === 'verifying').length;
  } catch {
    return 0;
  }
}

/**
 * 受管服务监督器：启动/健康检查/重复启动防护/端口冲突/安全停止。
 */
export class ServiceSupervisor {
  private readonly options: SupervisorOptions;
  private instanceId: string | undefined;
  private readonly children = new Map<ServiceId, ChildProcess>();
  private readonly spawnImpl: typeof nodeSpawn;
  private readonly probeImpl: (port: number) => Promise<PortInspection>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly openBrowserImpl: (url: string) => Promise<void>;
  private readonly verifyServiceOwnership: boolean;

  constructor(options: SupervisorOptions) {
    this.options = options;
    this.spawnImpl = options.spawnImpl ?? nodeSpawn;
    this.probeImpl = options.probeImpl ?? defaultInspectPort;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.openBrowserImpl = options.openBrowserImpl ?? openBrowser;
    this.verifyServiceOwnership = options.verifyServiceOwnership ?? false;
  }

  private get layout(): InstallLayout {
    return this.options.layout;
  }

  private get config(): InstallConfig {
    return this.options.config;
  }

  private webUrl(): string {
    return `http://127.0.0.1:${this.config.ports.web}`;
  }

  private async pathSafety(): Promise<void> {
    for (const directory of [this.layout.logs, join(this.layout.data, 'tmp'), this.layout.modelsRoot]) {
      await assertNoReparseEscape(this.layout.installRoot, directory);
      await mkdir(directory, { recursive: true });
    }
  }

  private async writeState(services: ManagedServiceRuntime[], instanceId: string, startedAt: string): Promise<void> {
    const state: ServiceStateFile = {
      instanceId,
      startedAt,
      installRoot: this.layout.installRoot,
      version: this.config.version,
      services,
    };
    await writeJsonAtomic(this.layout.serviceStatePath, state);
  }

  private async recordFirstRunLog(): Promise<void> {
    if (this.config.firstRunCompleted) return;
    const unfinished = await countUnfinishedDownloads(this.layout.modelStatePath);
    const logs = [
      `首次启动时间：${new Date(this.now()).toISOString()}`,
      `安装来源：${this.layout.installRoot}`,
      `程序版本：${this.config.version}`,
      `安装目录：${this.layout.installRoot}`,
      `模型根目录：${this.layout.modelsRoot}`,
      `未完成下载任务数：${unfinished}`,
    ];
    try {
      await appendFile(join(this.layout.logs, `first-run-${formatTimestamp(new Date(this.now()))}.log`), `${logs.join('\n')}\n`, 'utf8');
    } catch {
      /* 首次运行日志写入失败不阻塞启动。 */
    }
  }

  private async markFirstRunCompleted(): Promise<void> {
    if (this.config.firstRunCompleted) return;
    if (!existsSync(this.layout.installConfigPath)) return;
    try {
      await writeInstallConfig({
        ...this.config,
        firstRunCompleted: true,
        updatedAt: new Date(this.now()).toISOString(),
      });
    } catch {
      /* 配置文件只读时忽略，不阻塞启动。 */
    }
  }

  /**
   * 健康响应后确认监听端口的进程属于本实例：PID 存活 + 实例标记/记录的命令行，
   * 并允许通过父进程链匹配（dev 模式下 pnpm shell 会多一层）。
   * 外部监听者返回 HTTP 200 时不能冒充受管服务。
   */
  private async assertServiceOwnership(
    spec: ManagedServiceSpec,
    pid: number,
    instanceId: string,
    recordedCommandLine: string,
    logPath: string,
  ): Promise<void> {
    const port = spec.health?.port;
    if (port === undefined) return;
    if (!isProcessAlive(pid)) {
      throw new ServiceOwnershipError(
        `${spec.label} 的健康响应无法确认来源：本实例进程 PID ${pid} 已退出，端口 ${port} 可能被其它程序占用。日志：${logPath}`,
      );
    }
    const identityMatches = (info: { commandLine?: string } | undefined): boolean =>
      Boolean(info && (hasInstanceMarker(info.commandLine, instanceId) || commandLineMatches(info.commandLine, recordedCommandLine)));
    const inspection = await this.probeImpl(port);
    if (!inspection.open) {
      throw new ServiceOwnershipError(`${spec.label} 健康响应后端口 ${port} 已不可连接（可能被其它程序抢占）。日志：${logPath}`);
    }
    const owner = inspection.owner;
    if (!owner?.pid) {
      const infos = await readProcessInfos([pid]);
      if (!identityMatches(infos.get(pid))) {
        throw new ServiceOwnershipError(
          `${spec.label} 的健康响应无法确认来自本实例进程（PID ${pid}），端口 ${port} 可能被其它程序占用。日志：${logPath}`,
        );
      }
      return;
    }
    const visited = new Set<number>();
    let current: number | undefined = owner.pid;
    for (let depth = 0; depth < 8 && current !== undefined && !visited.has(current); depth += 1) {
      if (current === pid) return;
      visited.add(current);
      const info = (await readProcessInfos([current])).get(current);
      if (identityMatches(info)) return;
      current = info?.parentPid;
    }
    const ownerLabel = owner.name ? `${owner.name}（PID ${owner.pid}）` : `PID ${owner.pid}`;
    throw new ServiceOwnershipError(
      `端口 ${port} 已被本实例之外的进程占用：${ownerLabel}（服务：${spec.label}）。知影不会结束外部进程；请关闭占用该端口的程序，或修改 config/install.json 中的端口后重新启动。日志：${logPath}`,
    );
  }

  private async startOne(
    spec: ManagedServiceSpec,
    instanceId: string,
    stamp: string,
  ): Promise<ManagedServiceRuntime> {
    const command = spec.command;
    if (isAbsolute(command) && !existsSync(command)) {
      throw new Error(`缺少运行组件：${command}（服务：${spec.label}）。请重新安装或运行维护诊断修复安装。`);
    }
    const markerArgs = isNodeExecutable(command) ? [`--m2v-instance=${instanceId}`] : [];
    const args = [...spec.args, ...markerArgs];
    const childEnv: NodeJS.ProcessEnv = { ...spec.env, M2V_MANAGED_INSTANCE: instanceId };
    const outPath = join(this.layout.logs, `${spec.id}-${stamp}.out.log`);
    const errPath = join(this.layout.logs, `${spec.id}-${stamp}.err.log`);
    // 直接把日志文件句柄交给子进程（stdio 数字 fd），而不是通过父进程管道转发：
    // 这样启动器进程退出后子进程仍可写日志并继续运行，也不会因管道关闭而退出。
    let outFd: number;
    let errFd: number;
    try {
      outFd = openSync(outPath, 'a');
      errFd = openSync(errPath, 'a');
    } catch (error) {
      throw new Error(`无法创建服务日志文件（${outPath} / ${errPath}）：${(error as Error).message}`);
    }
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    let child: ChildProcess;
    try {
      child = this.spawnImpl(command, args, {
        cwd: spec.cwd,
        env: childEnv,
        windowsHide: true,
        // 独立进程组：启动器前台进程退出（关闭窗口）后受管服务继续运行，
        // 后续由 stop() 按实例标记安全结束；日志通过文件句柄由子进程直接写。
        detached: true,
        stdio: ['ignore', outFd, errFd],
        shell: needsShell,
      });
      child.unref();
    } catch (error) {
      closeSync(outFd);
      closeSync(errFd);
      throw new Error(`启动 ${spec.label} 失败：${(error as Error).message}（日志：${outPath}）`);
    }
    closeSync(outFd);
    closeSync(errFd);
    const pid = child.pid;
    if (!pid) {
      throw new Error(`启动 ${spec.label} 失败：子进程未获得 PID（日志：${outPath}）`);
    }
    this.children.set(spec.id, child);
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal };
    });
    child.once('error', () => {
      if (!exitInfo) exitInfo = { code: null, signal: null };
    });
    const runtime: ManagedServiceRuntime = {
      id: spec.id,
      pid,
      startedAtMs: this.now(),
      commandLine: formatCommandLine(command, args),
      logFile: outPath,
    };
    if (spec.health?.url) {
      const timeoutMs = spec.health.timeoutMs ?? HEALTH_TIMEOUTS[spec.id];
      const deadline = this.now() + timeoutMs;
      let lastError = '尚未响应';
      for (;;) {
        if (exitInfo) {
          throw new Error(
            `${spec.label} 启动后提前退出（退出码 ${exitInfo.code ?? '未知'}${exitInfo.signal ? `，信号 ${exitInfo.signal}` : ''}）。日志：${outPath} / ${errPath}`,
          );
        }
        try {
          const response = await this.fetchImpl(spec.health.url, {
            signal: AbortSignal.timeout(2000),
            cache: 'no-store',
          });
          if (response.status >= 200 && response.status < 500) {
            if (this.verifyServiceOwnership && spec.health.port !== undefined) {
              await this.assertServiceOwnership(spec, pid, instanceId, runtime.commandLine, outPath);
            }
            return runtime;
          }
          lastError = `HTTP ${response.status}`;
        } catch (error) {
          if (error instanceof ServiceOwnershipError) throw error;
          lastError = (error as Error).message;
        }
        if (this.now() >= deadline) {
          throw new Error(`${spec.label} 健康检查超时（${timeoutMs}ms，最后错误：${lastError}）。日志：${outPath}`);
        }
        await delay(300);
      }
    }
    await delay(500);
    if (exitInfo) {
      throw new Error(
        `${spec.label} 启动后提前退出（退出码 ${exitInfo.code ?? '未知'}${exitInfo.signal ? `，信号 ${exitInfo.signal}` : ''}）。日志：${outPath} / ${errPath}`,
      );
    }
    return runtime;
  }

  /**
   * 启动受管服务。先查重复实例与端口冲突，再按顺序启动并等待健康；失败回滚。
   */
  async start(): Promise<StartResult> {
    const logDir = this.layout.logs;
    const errors: string[] = [];
    const conflicts: PortConflict[] = [];
    try {
      await this.pathSafety();
    } catch (error) {
      return { status: 'failed', services: [], conflicts, errors: [(error as Error).message], logDir };
    }
    // 清理失败/中断的安装或升级遗留的 .staging-*/.old-* 目录（位于 InstallRoot 内）。
    await cleanInstallArtifacts(this.layout.installRoot).catch(() => []);
    const existing = await readServiceState(this.layout);
    if (existing) {
      const classified = await classifyServices(existing.services, existing.instanceId);
      if (classified.some(item => item.alive && item.managed)) {
        return {
          status: 'already_running',
          url: this.webUrl(),
          services: existing.services,
          conflicts: [],
          errors: [],
          logDir,
        };
      }
      await unlink(this.layout.serviceStatePath).catch(() => undefined);
    }
    for (const spec of this.options.specs) {
      const port = spec.health?.port;
      if (!port) continue;
      const inspection = await this.probeImpl(port);
      if (!inspection.open) continue;
      if (!spec.required) continue; // 可选服务（如模型管理器）已在运行时不阻塞启动。
      const owner = inspection.owner;
      const ownerText = owner?.name && owner.pid ? `${owner.name} (PID ${owner.pid})` : owner?.pid ? `PID ${owner.pid}` : '未知进程';
      conflicts.push({
        port,
        owner,
        message: `端口 ${port} 已被${ownerText}占用（服务：${spec.label}）`,
      });
    }
    if (conflicts.length > 0) {
      return {
        status: 'failed',
        services: [],
        conflicts,
        errors: conflicts.map(
          conflict =>
            `${conflict.message}。请关闭占用程序后重试，或修改 config/install.json 中的端口；知影不会结束其它程序的进程。`,
        ),
        logDir,
      };
    }
    const instanceId = randomUUID();
    this.instanceId = instanceId;
    const startedAtDate = new Date(this.now());
    const startedAt = startedAtDate.toISOString();
    const stamp = formatTimestamp(startedAtDate);
    const services: ManagedServiceRuntime[] = [];
    try {
      await writeJsonAtomic(this.layout.serviceStatePath, {
        instanceId,
        startedAt,
        installRoot: this.layout.installRoot,
        version: this.config.version,
        services,
      } satisfies ServiceStateFile);
      for (const spec of this.options.specs) {
        try {
          const runtime = await this.startOne(spec, instanceId, stamp);
          services.push(runtime);
          await this.writeState(services, instanceId, startedAt);
        } catch (error) {
          if (spec.required) throw error;
          errors.push(`${spec.label} 未能自动启动（可选服务，不影响主流程）：${(error as Error).message}`);
        }
      }
      await this.recordFirstRunLog();
      await this.markFirstRunCompleted();
      const url = this.webUrl();
      if (this.options.specs.some(spec => spec.id === 'web')) {
        try {
          await this.openBrowserImpl(url);
        } catch (error) {
          errors.push(`打开浏览器失败：${(error as Error).message}（请手动打开 ${url}）`);
        }
      }
      return { status: 'started', url, services, conflicts, errors, logDir };
    } catch (error) {
      errors.push((error as Error).message);
      for (const child of this.children.values()) await killProcessTree(child.pid);
      this.children.clear();
      await unlink(this.layout.serviceStatePath).catch(() => undefined);
      return { status: 'failed', services: [], conflicts, errors, logDir };
    }
  }

  /** 只结束本实例受管进程树；其它进程一律不动。 */
  async stop(): Promise<StopResult> {
    const stopped: string[] = [];
    const skipped: string[] = [];
    const state = await readServiceState(this.layout);
    if (!state) return { stopped, skipped };
    const classified = await classifyServices(state.services, state.instanceId);
    const remaining: ManagedServiceRuntime[] = [];
    for (const item of classified) {
      if (item.alive && item.managed) {
        await killProcessTree(item.entry.pid);
        if (isProcessAlive(item.entry.pid)) {
          remaining.push(item.entry);
          skipped.push(item.entry.id);
        } else {
          stopped.push(item.entry.id);
        }
      } else {
        skipped.push(item.entry.id);
      }
    }
    if (remaining.length > 0) {
      await this.writeState(remaining, state.instanceId, state.startedAt);
    } else {
      await unlink(this.layout.serviceStatePath).catch(() => undefined);
    }
    this.children.clear();
    this.instanceId = undefined;
    return { stopped, skipped };
  }

  /** 查询本实例状态（不结束任何进程）。 */
  async status(): Promise<StatusResult> {
    const state = await readServiceState(this.layout);
    if (!state) return { running: false, services: [] };
    const classified = await classifyServices(state.services, state.instanceId);
    const services = classified.map(item => ({
      id: item.entry.id,
      pid: item.entry.pid,
      alive: item.alive,
      managed: item.managed,
      logFile: item.entry.logFile || undefined,
    }));
    const running = services.some(service => service.alive && service.managed);
    return running ? { running, url: this.webUrl(), services } : { running, services };
  }
}


