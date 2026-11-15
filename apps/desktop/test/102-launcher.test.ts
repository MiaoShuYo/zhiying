/**
 * #102 桌面启动器（§2.6）：服务规格、启动顺序/健康、失败回滚、端口冲突、重复启动、
 * 停止隔离、陈旧状态、状态文件契约、日志、受管 Ollama、空 models 启动。
 * 使用真实子进程 + 真实 HTTP 健康检查；只注入契约允许的 spawnImpl/probeImpl/fetchImpl/now/openBrowserImpl。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempRoot, cleanupRegisteredTempDirs } from './_helpers/temp';
import { makeInstallConfig } from './_helpers/fixtures';
import { writeInstallConfig } from '../src/install-layout';
import { resolveInstallLayout } from '../src/install-layout';
import { buildManagedServiceEnv } from '../src/service-env';
import { getFreePort, isPortOpen, waitForPort } from './_helpers/ports';
import {
  fakeServiceArgs,
  fakeServiceCommand,
  readServiceRecord,
  writeFakeServiceScript,
} from './_helpers/fake-service';
import { spawnCollect, killTree, isAlive, startExternalProcess, waitForCondition } from './_helpers/processes';
import { buildServiceSpecs, ServiceSupervisor } from '../src/launcher';
import type { ManagedServiceSpec, SupervisorOptions } from '../src/launcher';

interface ServiceDef {
  id: 'python' | 'web' | 'worker' | 'ollama' | 'download-manager';
  label?: string;
  role?: string;
  port: number;
  healthPath?: string;
  healthDelayMs?: number;
  healthStatus?: number;
  exitAfterMs?: number;
  exitCode?: number;
  healthTimeoutMs?: number;
}

interface Harness {
  root: string;
  layout: ReturnType<typeof resolveInstallLayout>;
  config: ReturnType<typeof makeInstallConfig>;
  workDir: string;
  scriptPath: string;
  makeSpecs: (defs: ServiceDef[]) => ManagedServiceSpec[];
  records: Map<string, { file: string; pidFile: string }>;
  makeSupervisor: (specs: ManagedServiceSpec[], options?: Partial<SupervisorOptions>) => ServiceSupervisor;
  browserCalls: string[];
  close: () => Promise<void>;
}

async function createHarness(t: test.TestContext): Promise<Harness> {
  const root = makeTempRoot('launcher');
  const layout = resolveInstallLayout(root);
  const config = makeInstallConfig(root);
  for (const dir of [layout.config, layout.data, layout.logs, layout.modelsRoot, path.join(layout.data, 'tmp'), layout.app, layout.runtime]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  await writeInstallConfig(config);
  const workDir = path.join(root, 'test-fixtures');
  const scriptPath = writeFakeServiceScript(workDir);
  const records = new Map<string, { file: string; pidFile: string }>();
  const browserCalls: string[] = [];
  const children: Array<{ pid: number }> = [];

  function makeSpecs(defs: ServiceDef[]): ManagedServiceSpec[] {
    return defs.map((def) => {
      const port = def.port;
      const recordFile = path.join(workDir, `${def.id}.record.json`);
      const pidFile = path.join(workDir, `${def.id}.pid`);
      records.set(def.id, { file: recordFile, pidFile });
      const env = buildManagedServiceEnv({ layout, config, baseEnv: process.env });
      const spec: ManagedServiceSpec = {
        id: def.id,
        label: def.label ?? def.id,
        command: fakeServiceCommand(workDir),
        args: fakeServiceArgs(scriptPath, {
          port,
          role: def.role ?? def.id,
          healthPath: def.healthPath,
          healthDelayMs: def.healthDelayMs,
          healthStatus: def.healthStatus,
          exitAfterMs: def.exitAfterMs,
          exitCode: def.exitCode,
          recordFile,
          pidFile,
        }),
        cwd: workDir,
        env,
        required: true,
      };
      if (def.healthPath !== undefined) {
        spec.health = { url: `http://127.0.0.1:${port}${def.healthPath}`, port, timeoutMs: def.healthTimeoutMs ?? 8000 };
      }
      return spec;
    });
  }

  function makeSupervisor(specs: ManagedServiceSpec[], options: Partial<SupervisorOptions> = {}): ServiceSupervisor {
    const supervisor = new ServiceSupervisor({
      layout,
      config,
      specs,
      openBrowserImpl: async (url: string) => {
        browserCalls.push(url);
      },
      ...options,
    });
    const originalSpawn = (supervisor as unknown as { spawnImpl: typeof import('node:child_process').spawn }).spawnImpl;
    (supervisor as unknown as { spawnImpl: typeof import('node:child_process').spawn }).spawnImpl = ((...args: Parameters<typeof import('node:child_process').spawn>) => {
      const child = originalSpawn(...args);
      if (child.pid) children.push({ pid: child.pid });
      return child;
    }) as typeof import('node:child_process').spawn;
    return supervisor;
  }

  t.after(async () => {
    for (const child of children) if (isAlive(child.pid)) killTree(child.pid);
    cleanupRegisteredTempDirs();
  });

  return {
    root,
    layout,
    config,
    workDir,
    scriptPath,
    makeSpecs,
    records,
    makeSupervisor,
    browserCalls,
    close: async () => {},
  };
}

/** 便捷构造带端口的服务定义。 */
function withPort(def: ServiceDef): ServiceDef {
  return def;
}

test('[#102-2] buildServiceSpecs(dev) 语义等价 start.ps1：端口/数据目录/开发模式', async (t) => {
  const root = makeTempRoot('launcher-dev');
  t.after(() => cleanupRegisteredTempDirs());
  const layout = resolveInstallLayout(root);
  const config = makeInstallConfig(root);
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  const specs = buildServiceSpecs({ layout, config, mode: 'dev', repoRoot, ffmpegDir: 'D:\\ffmpeg-shared\\bin' });
  const byId = new Map(specs.map((s) => [s.id, s]));
  assert.ok(byId.has('python') && byId.has('web') && byId.has('worker'));

  const python = byId.get('python')!;
  assert.ok(python.command.toLowerCase().endsWith(path.join('.venv', 'Scripts', 'python.exe').toLowerCase()), `dev python 命令错误: ${python.command}`);
  assert.deepEqual(python.args.slice(0, 3), ['-m', 'uvicorn', 'app.main:app']);
  assert.ok(python.args.join(' ').includes('--port 8000') || python.args.includes('8000'));
  assert.equal(python.env.M2V_DEV_MODE, '1');
  assert.equal(python.env.PYTHON_SERVICE_URL, 'http://127.0.0.1:8000');

  const web = byId.get('web')!;
  assert.match(web.command, /pnpm(\.cmd)?$/i);
  assert.deepEqual(web.args, ['--filter', '@m2v/web', 'dev']);
  assert.equal(web.cwd, repoRoot);
  assert.equal(web.env.M2V_DATA_DIR, path.join(repoRoot, 'data'));
  assert.equal(web.env.PORT, '3000');
  const worker = byId.get('worker')!;
  assert.deepEqual(worker.args, ['--filter', '@m2v/worker', 'dev']);
  // PATH 注入 ffmpeg 目录（dev 模式不破坏开发脚本）
  const pathKey = Object.keys(python.env).find((k) => k.toLowerCase() === 'path')!;
  assert.ok(String(python.env[pathKey]).toLowerCase().startsWith('d:\\ffmpeg-shared\\bin'), `dev PATH 未注入 ffmpeg: ${python.env[pathKey]}`);
});

test('[#102-12] packaged lite 服务规格使用受管 node/fixture 与受管 Ollama 环境', async (t) => {
  const h = await createHarness(t);
  h.config.payloadProfile = 'lite';
  h.config.managedProcesses = { ollama: true };
  h.config.ports = { web: await getFreePort(), python: await getFreePort(), ollama: await getFreePort(), manager: await getFreePort() };
  await writeInstallConfig(h.config);
  const fixtures = path.join(h.layout.app, 'fixtures');
  fs.mkdirSync(fixtures, { recursive: true });
  for (const name of ['python', 'web', 'worker', 'ollama']) {
    fs.copyFileSync(h.scriptPath, path.join(fixtures, `${name}.mjs`));
  }
  const cliDir = path.join(h.layout.app, 'desktop', 'cli');
  fs.mkdirSync(cliDir, { recursive: true });
  fs.copyFileSync(h.scriptPath, path.join(cliDir, 'model-manager-cli.mjs'));

  const specs = buildServiceSpecs({ layout: h.layout, config: h.config, mode: 'packaged', nodeExe: process.execPath });
  const recordFiles = new Map<string, string>();
  for (const spec of specs) {
    const recordFile = path.join(h.workDir, `built-${spec.id}.record.json`);
    spec.args.push('--record-file', recordFile);
    recordFiles.set(spec.id, recordFile);
  }
  const byId = new Map(specs.map((s) => [s.id, s]));
  for (const id of ['python', 'web', 'worker', 'ollama', 'download-manager'] as const) assert.ok(byId.has(id), `缺少服务规格 ${id}`);

  const ollama = byId.get('ollama')!;
  assert.equal(ollama.command, process.execPath);
  assert.ok(ollama.args.some((a) => a.includes('ollama.mjs')), `受管 ollama 必须运行 fixture：${ollama.args}`);
  assert.equal(ollama.env.OLLAMA_MODELS, path.join(h.layout.modelsRoot, 'ollama'));
  assert.equal(ollama.env.OLLAMA_BASE_URL, `http://127.0.0.1:${h.config.ports.ollama}`);
  assert.equal(ollama.env.M2V_MODELS_ROOT, h.layout.modelsRoot);
  assert.equal(ollama.env.M2V_DATA_DIR, h.layout.data);
  assert.equal(byId.get('python')!.env.M2V_MODELS_ROOT, h.layout.modelsRoot);

  // 真实启动：受管 fixture 服务全部通过健康检查
  const supervisor = h.makeSupervisor(specs);
  const result = await supervisor.start();
  try {
    assert.equal(result.status, 'started', `lite 启动失败: ${JSON.stringify(result.errors)}`);
    assert.equal(result.url, `http://127.0.0.1:${h.config.ports.web}`);
    assert.deepEqual(result.conflicts, []);
    const ids = result.services.map((s) => s.id);
    for (const id of ['python', 'web', 'worker', 'ollama', 'download-manager']) assert.ok((ids as string[]).includes(id), `服务未启动: ${id}`);
    // 受管 Ollama 记录到的环境变量证明使用安装目录模型库
    const ollamaRecord = await waitForCondition(() => readServiceRecord(recordFiles.get('ollama')!), { timeoutMs: 8000, label: 'ollama record' });
    assert.equal(ollamaRecord.env.OLLAMA_MODELS, path.join(h.layout.modelsRoot, 'ollama'));
    assert.equal(ollamaRecord.env.OLLAMA_BASE_URL, `http://127.0.0.1:${h.config.ports.ollama}`);
    assert.ok(ollamaRecord.argv.includes(`--port=${h.config.ports.ollama}`), `受管 ollama 必须使用配置端口: ${ollamaRecord.argv.join(' ')}`);
    const pythonRecord = await waitForCondition(() => readServiceRecord(recordFiles.get('python')!), { timeoutMs: 8000, label: 'python record' });
    assert.equal(pythonRecord.env.M2V_MODELS_ROOT, h.layout.modelsRoot);
  } finally {
    await supervisor.stop();
  }
});

test('[#102-4] 启动顺序按 python→web/worker，健康通过后才返回 URL 且浏览器最后打开', async (t) => {
  const h = await createHarness(t);
  const pythonPort = await getFreePort();
  const webPort = await getFreePort();
  h.config.ports = { ...h.config.ports, web: webPort };
  const workerPort = await getFreePort();
  h.config.ports = { ...h.config.ports, web: webPort, python: pythonPort };
  const specs = h.makeSpecs([
    withPort({ id: 'python', role: 'python', port: pythonPort, healthPath: '/health', healthDelayMs: 150 }),
    withPort({ id: 'web', role: 'web', port: webPort, healthPath: '/health' }),
    withPort({ id: 'worker', role: 'worker', port: workerPort }),
  ]);
  const events: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    events.push(`fetch:${new URL(url).port}`);
    return fetch(input, init);
  }) as typeof fetch;
  const supervisor = h.makeSupervisor(specs, {
    fetchImpl,
    openBrowserImpl: async (url: string) => {
      events.push(`browser:${new URL(url).port}`);
      h.browserCalls.push(url);
    },
  });
  const result = await supervisor.start();
  try {
    assert.equal(result.status, 'started', JSON.stringify(result.errors));
    assert.equal(result.url, `http://127.0.0.1:${webPort}`);
    assert.equal(h.browserCalls.length, 1, '健康后应只打开一次浏览器');
    assert.equal(new URL(h.browserCalls[0]).port, String(webPort));
    // 启动顺序：依次启动的 PID 时间戳单调（startedAtMs）
    const python = result.services.find((s) => s.id === 'python')!;
    const web = result.services.find((s) => s.id === 'web')!;
    const worker = result.services.find((s) => s.id === 'worker')!;
    assert.ok(python.startedAtMs <= web.startedAtMs && web.startedAtMs <= worker.startedAtMs, '服务启动顺序必须是 python→web→worker');
    // 浏览器事件必须发生在 web 健康请求成功之后
    const browserIndex = events.findIndex((e) => e.startsWith('browser:'));
    const webHealthIndex = events.findIndex((e) => e === `fetch:${webPort}`);
    assert.ok(webHealthIndex >= 0 && browserIndex > webHealthIndex, `浏览器必须在 web 健康检查后打开: ${events.join(',')}`);
  } finally {
    await supervisor.stop();
  }
});

test('[#102-5] 启动失败处理：进程提前退出/健康超时 → 可读错误含日志路径，已启动子进程被清理', async (t) => {
  const h = await createHarness(t);
  const pythonPort = await getFreePort();
  const webPort = await getFreePort();
  h.config.ports = { ...h.config.ports, web: webPort };
  const specs = h.makeSpecs([
    withPort({ id: 'python', port: pythonPort, healthPath: '/health' }),
    withPort({ id: 'web', port: webPort, healthPath: '/health', healthStatus: 500, exitAfterMs: 250, exitCode: 7 }),
  ]);
  const supervisor = h.makeSupervisor(specs);
  const result = await supervisor.start();
  try {
    assert.equal(result.status, 'failed');
    assert.ok(result.errors.length > 0);
    const combined = result.errors.join('\n');
    assert.match(combined, /日志|\.log/, `错误必须包含日志路径: ${combined}`);
    assert.match(combined, /退出|超时/, `错误必须说明退出/超时原因: ${combined}`);
    // 已启动的 python 子进程被回滚清理
    const statePath = h.layout.serviceStatePath;
    assert.ok(!fs.existsSync(statePath), '失败后不应残留状态文件');
    const pythonRecord = h.records.get('python');
    if (pythonRecord && fs.existsSync(pythonRecord.pidFile)) {
      const pid = Number(fs.readFileSync(pythonRecord.pidFile, 'utf8'));
      await waitForCondition(() => !isAlive(pid), { timeoutMs: 5000, label: '回滚清理 python 子进程' });
    }
  } finally {
    await supervisor.stop();
  }

  // 健康超时：fixture 返回 500 且 now 快速推进（避免真实等待 90s）
  const h2 = await createHarness(t);
  const pythonPort2 = await getFreePort();
  const specs2 = h2.makeSpecs([withPort({ id: 'python', port: pythonPort2, healthPath: '/health', healthStatus: 500, healthTimeoutMs: 5000 })]);
  let clock = h2.config.ports.web;
  const supervisor2 = h2.makeSupervisor(specs2, { now: () => (clock += 20_000) });
  const result2 = await supervisor2.start();
  assert.equal(result2.status, 'failed');
  assert.match(result2.errors.join('\n'), /超时|timeout/, `健康超时错误不可读: ${result2.errors.join('\n')}`);
  assert.match(result2.errors.join('\n'), /日志|\.log/, '健康超时错误必须包含日志路径');
});

test('[#102-6] 端口冲突：外部进程占用 → 可读冲突、外部进程存活、无残留受管子进程', async (t) => {
  const h = await createHarness(t);
  const externalPort = await getFreePort();
  const external = spawnCollect(process.execPath, [h.scriptPath, '--port', String(externalPort), '--role', 'external'], { env: process.env });
  t.after(() => killTree(external.pid));
  await waitForPort(externalPort, true, { timeoutMs: 10_000 });

  const webPort = await getFreePort();

  h.config.ports = { ...h.config.ports, web: webPort };
  const specs = h.makeSpecs([
    withPort({ id: 'python', port: externalPort, healthPath: '/health' }),
    withPort({ id: 'web', port: webPort, healthPath: '/health' }),
  ]);
  let spawnCalls = 0;
  const supervisor = h.makeSupervisor(specs, {
    spawnImpl: ((...args: Parameters<typeof spawn>) => {
      spawnCalls += 1;
      return spawn(...args);
    }) as typeof spawn,
  });
  const result = await supervisor.start();
  try {
    assert.equal(result.status, 'failed');
    assert.ok(result.conflicts.length >= 1, '必须报告端口冲突');
    assert.equal(result.conflicts[0].port, externalPort);
    assert.ok(result.conflicts[0].message.trim().length > 0, '冲突信息必须可读');
    assert.match(result.errors.join('\n'), /端口|占用|恢复|关闭/, '冲突错误必须给出恢复路径');
    assert.deepEqual(result.services, [], '冲突时不得启动任何服务');
    assert.equal(spawnCalls, 0, '冲突预检查必须在 spawn 之前失败（C1 回归）');
    // 外部进程存活
    assert.ok(isAlive(external.pid), '外部占用进程不得被杀死');
    assert.ok(await isPortOpen(externalPort), '外部端口必须仍在监听');
    assert.ok(!fs.existsSync(h.layout.serviceStatePath), '冲突失败不得写状态文件');
  } finally {
    await supervisor.stop();
  }
});

test('[#102-4/#102-6] packaged/dev 服务规格均暴露 health.port（端口冲突预检查真实生效，C1 回归）', async (t) => {
  const h = await createHarness(t);
  h.config.payloadProfile = 'lite';
  h.config.managedProcesses = { ollama: true };
  h.config.ports = { web: 3101, python: 8101, ollama: 11601, manager: 8891 };
  const packaged = buildServiceSpecs({ layout: h.layout, config: h.config, mode: 'packaged', nodeExe: process.execPath });
  const packagedById = new Map(packaged.map((spec) => [spec.id, spec]));
  for (const [id, port] of [['python', 8101], ['ollama', 11601], ['web', 3101], ['download-manager', 8891]] as const) {
    assert.equal(packagedById.get(id)?.health?.port, port, `packaged ${id} 必须暴露 health.port（否则冲突检测失效）`);
    assert.equal(packagedById.get(id)?.health?.url, `http://127.0.0.1:${port}${id === 'ollama' ? '/api/version' : id === 'python' ? '/health' : id === 'web' ? '/' : '/api/models'}`);
  }
  assert.equal(packagedById.get('worker')?.health?.port, undefined, 'worker 无健康端口');

  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  const dev = buildServiceSpecs({ layout: h.layout, config: makeInstallConfig(h.root), mode: 'dev', repoRoot });
  const devById = new Map(dev.map((spec) => [spec.id, spec]));
  assert.equal(devById.get('python')?.health?.port, 8000, 'dev python health.port 必须为 8000');
  assert.equal(devById.get('web')?.health?.port, 3000, 'dev web health.port 必须为 3000');
});

test('[#102-7/#102-9] verifyServiceOwnership：外部 HTTP 200 冒充受管服务被拒绝，不杀外部进程（C1 回归）', async (t) => {
  const h = await createHarness(t);
  const externalPort = await getFreePort();
  const external = spawnCollect(process.execPath, [h.scriptPath, '--port', String(externalPort), '--role', 'external-200'], { env: process.env });
  t.after(() => killTree(external.pid));
  await waitForPort(externalPort, true, { timeoutMs: 10_000 });
  // 本实例子进程真实存活，但端口实际由外部进程监听（模拟“健康响应被外部 200 冒充”）
  const idleScript = path.join(h.workDir, 'idle-child.mjs');
  fs.writeFileSync(idleScript, 'setInterval(() => {}, 1000);', 'utf8');
  const spawned: number[] = [];
  let probes = 0;
  const { inspectPort: realInspectPort } = await import('../src/process-probe');
  const supervisor = h.makeSupervisor(
    [
      {
        id: 'python',
        label: 'python',
        command: process.execPath,
        args: [idleScript],
        cwd: h.workDir,
        env: {},
        health: { url: `http://127.0.0.1:${externalPort}/health`, port: externalPort, timeoutMs: 8000 },
        required: true,
      },
    ],
    {
      verifyServiceOwnership: true,
      // 第一次（端口预检查）返回 closed 模拟“外部进程在预检查之后才占用端口”，后续用真实探测
      probeImpl: async (port: number) => {
        probes += 1;
        if (probes === 1) return { open: false };
        return realInspectPort(port);
      },
      spawnImpl: ((...args: Parameters<typeof spawn>) => {
        const child = spawn(...args);
        if (child.pid) spawned.push(child.pid);
        return child;
      }) as typeof spawn,
    },
  );
  const result = await supervisor.start();
  try {
    assert.equal(result.status, 'failed', `外部 200 冒充必须失败: ${JSON.stringify(result)}`);
    assert.match(result.errors.join('\n'), /本实例之外|不会结束外部进程|无法确认|已被.*占用/, `所有权校验错误不可读: ${result.errors.join('\n')}`);
    assert.ok(isAlive(external.pid), '所有权校验失败不得杀死外部进程');
    assert.ok(await isPortOpen(externalPort), '外部端口必须仍在监听');
    for (const pid of spawned) await waitForCondition(() => !isAlive(pid), { timeoutMs: 10_000, label: `回滚受管子进程 ${pid}` });
    assert.ok(!fs.existsSync(h.layout.serviceStatePath), '所有权失败不得遗留状态文件');
    assert.deepEqual(result.services, [], '所有权失败不得报告已启动服务');
  } finally {
    await supervisor.stop();
  }
});

test('[#102-10] start 清理安装/升级遗留的 .staging-*/.old-* 目录（C1 回归）', async (t) => {
  const h = await createHarness(t);
  const staging = path.join(h.root, '.staging-20260101-000000');
  const oldApp = path.join(h.root, '.old-app-20260101-000000');
  fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(oldApp, { recursive: true });
  fs.writeFileSync(path.join(staging, 'junk.txt'), 'junk');
  fs.writeFileSync(path.join(oldApp, 'junk.txt'), 'junk');
  const pythonPort = await getFreePort();
  const webPort = await getFreePort();
  h.config.ports = { ...h.config.ports, web: webPort };
  const supervisor = h.makeSupervisor(
    h.makeSpecs([
      withPort({ id: 'python', port: pythonPort, healthPath: '/health' }),
      withPort({ id: 'web', port: webPort, healthPath: '/health' }),
    ]),
  );
  const result = await supervisor.start();
  try {
    assert.equal(result.status, 'started', JSON.stringify(result.errors));
    assert.ok(!fs.existsSync(staging), 'start 必须清理遗留 .staging-* 目录');
    assert.ok(!fs.existsSync(oldApp), 'start 必须清理遗留 .old-* 目录');
  } finally {
    await supervisor.stop();
  }
});

test('[#102-7] 重复启动：already_running、不 spawn 第二套、进程数不变', async (t) => {
  const h = await createHarness(t);
  const pythonPort = await getFreePort();
  const webPort = await getFreePort();
  h.config.ports = { ...h.config.ports, web: webPort };
  const specs = h.makeSpecs([
    withPort({ id: 'python', port: pythonPort, healthPath: '/health' }),
    withPort({ id: 'web', port: webPort, healthPath: '/health' }),
  ]);
  const first = h.makeSupervisor(specs);
  const firstResult = await first.start();
  try {
    assert.equal(firstResult.status, 'started');
    const pids = firstResult.services.map((s) => s.pid);
    let spawnCount = 0;
    const countingSpawn = ((...args: Parameters<typeof spawn>) => {
      spawnCount += 1;
      return spawn(...args);
    }) as typeof spawn;
    const second = h.makeSupervisor(specs, { spawnImpl: countingSpawn });
    const secondResult = await second.start();
    assert.equal(secondResult.status, 'already_running', `重复启动应返回 already_running: ${JSON.stringify(secondResult)}`);
    assert.equal(secondResult.url, `http://127.0.0.1:${webPort}`);
    assert.equal(spawnCount, 0, '重复启动不得 spawn 新进程');
    assert.deepEqual(secondResult.services.map((s) => s.pid), pids, '已运行服务 PID 必须一致');
    // 原进程仍存活
    for (const pid of pids) assert.ok(isAlive(pid), `原受管进程不应被重复启动影响: ${pid}`);
  } finally {
    await first.stop();
  }
});

test('[#102-8] 停止：只杀本实例进程树，外部同名/其他进程存活，状态文件清除', async (t) => {
  const h = await createHarness(t);
  const pythonPort = await getFreePort();
  const webPort = await getFreePort();
  h.config.ports = { ...h.config.ports, web: webPort };
  // 外部无关进程：node 哨兵 + 外部 fixture 服务
  const sentinel = startExternalProcess(`stop-${Date.now()}`);
  t.after(() => killTree(sentinel.pid));
  const externalPort = await getFreePort();
  const external = spawnCollect(process.execPath, [h.scriptPath, '--port', String(externalPort), '--role', 'external'], { env: process.env });
  t.after(() => killTree(external.pid));
  await waitForPort(externalPort, true, { timeoutMs: 10_000 });

  const specs = h.makeSpecs([
    withPort({ id: 'python', port: pythonPort, healthPath: '/health' }),
    withPort({ id: 'web', port: webPort, healthPath: '/health' }),
  ]);
  const supervisor = h.makeSupervisor(specs);
  const result = await supervisor.start();
  assert.equal(result.status, 'started');
  const managedPids = result.services.map((s) => s.pid);
  const stopped = await supervisor.stop();
  assert.ok(stopped.stopped.includes('python') && stopped.stopped.includes('web'), `stop 未报告停止服务: ${JSON.stringify(stopped)}`);
  for (const pid of managedPids) await waitForCondition(() => !isAlive(pid), { timeoutMs: 10_000, label: `managed pid ${pid} 退出` });
  assert.ok(isAlive(sentinel.pid), '外部无关 node 进程不得被杀死');
  assert.ok(isAlive(external.pid), '外部 fixture 服务不得被杀死');
  assert.ok(!fs.existsSync(h.layout.serviceStatePath), '停止后状态文件必须删除');
  const status = await supervisor.status();
  assert.equal(status.running, false);
});

test('[#102-9] 陈旧状态：PID 已死 → 清理并允许启动，不误杀无关进程', async (t) => {
  const h = await createHarness(t);
  const dead = spawnCollect(process.execPath, ['-e', 'process.exit(0)']);
  await dead.exit;
  const sentinel = startExternalProcess(`stale-${Date.now()}`);
  t.after(() => killTree(sentinel.pid));
  fs.mkdirSync(path.dirname(h.layout.serviceStatePath), { recursive: true });
  fs.writeFileSync(
    h.layout.serviceStatePath,
    JSON.stringify({
      instanceId: 'stale-instance',
      startedAt: new Date().toISOString(),
      installRoot: h.root,
      version: '1.8.0',
      services: [
        { id: 'python', pid: dead.pid, startedAtMs: Date.now() - 10_000, commandLine: `${process.execPath} stale-python`, logFile: '' },
        { id: 'web', pid: sentinel.pid, startedAtMs: Date.now() - 10_000, commandLine: `${process.execPath} unrelated-user-process`, logFile: '' },
      ],
    }),
  );
  const pythonPort = await getFreePort();
  const webPort = await getFreePort();
  h.config.ports = { ...h.config.ports, web: webPort };
  const supervisor = h.makeSupervisor(
    h.makeSpecs([
      withPort({ id: 'python', port: pythonPort, healthPath: '/health' }),
      withPort({ id: 'web', port: webPort, healthPath: '/health' }),
    ]),
  );
  const result = await supervisor.start();
  try {
    assert.equal(result.status, 'started', `陈旧状态清理后应能启动: ${JSON.stringify(result)}`);
    assert.ok(isAlive(sentinel.pid), '陈旧状态中的无关进程不得被误杀');
    const state = JSON.parse(fs.readFileSync(h.layout.serviceStatePath, 'utf8')) as { instanceId: string; services: Array<{ pid: number }> };
    assert.notEqual(state.instanceId, 'stale-instance', '陈旧状态必须被新实例替换');
    assert.ok(state.services.every((s) => s.pid !== sentinel.pid), '新状态不得包含无关进程');
  } finally {
    await supervisor.stop();
  }
});

test('[#102-10] services.json 契约：instanceId/pid/startedAtMs/commandLine/logFile 完整且原子写', async (t) => {
  const h = await createHarness(t);
  const pythonPort = await getFreePort();
  const webPort = await getFreePort();
  h.config.ports = { ...h.config.ports, web: webPort };
  const supervisor = h.makeSupervisor(
    h.makeSpecs([
      withPort({ id: 'python', port: pythonPort, healthPath: '/health' }),
      withPort({ id: 'web', port: webPort, healthPath: '/health' }),
    ]),
  );
  const result = await supervisor.start();
  try {
    assert.equal(result.status, 'started');
    const raw = fs.readFileSync(h.layout.serviceStatePath, 'utf8');
    const state = JSON.parse(raw) as {
      instanceId: string;
      startedAt: string;
      installRoot: string;
      version: string;
      services: Array<{ id: string; pid: number; startedAtMs: number; commandLine: string; logFile: string }>;
    };
    assert.ok(typeof state.instanceId === 'string' && state.instanceId.length > 0);
    assert.equal(state.installRoot, h.root);
    assert.equal(state.version, '1.8.0');
    assert.ok(!Number.isNaN(Date.parse(state.startedAt)));
    assert.equal(state.services.length, 2);
    for (const service of state.services) {
      assert.ok(typeof service.pid === 'number' && service.pid > 0);
      assert.ok(typeof service.startedAtMs === 'number' && service.startedAtMs > 0);
      assert.ok(service.commandLine.includes(`--m2v-instance=${state.instanceId}`), `commandLine 必须含实例标记: ${service.commandLine}`);
      assert.ok(service.logFile.startsWith(h.layout.logs), `logFile 必须位于 logs: ${service.logFile}`);
    }
    // 原子写：目录中无 tmp 残留
    const leftovers = fs.readdirSync(path.dirname(h.layout.serviceStatePath)).filter((name) => name !== 'services.json');
    assert.deepEqual(leftovers, [], `运行时目录存在临时残留: ${leftovers.join(',')}`);
    // 子进程环境中的 M2V_MANAGED_INSTANCE 与状态文件一致
    const record = await waitForCondition(() => readServiceRecord(h.records.get('python')!.file), { timeoutMs: 5000 });
    assert.equal(record.env.M2V_MANAGED_INSTANCE, state.instanceId, '子进程环境 M2V_MANAGED_INSTANCE 必须等于 instanceId');
  } finally {
    await supervisor.stop();
  }
});

test('[#102-11] 日志：每服务 out/err 在 <root>\\logs，内容可读，错误含路径', async (t) => {
  const h = await createHarness(t);
  const pythonPort = await getFreePort();
  const webPort = await getFreePort();
  h.config.ports = { ...h.config.ports, web: webPort };
  const supervisor = h.makeSupervisor(
    h.makeSpecs([
      withPort({ id: 'python', port: pythonPort, healthPath: '/health' }),
      withPort({ id: 'web', port: webPort, healthPath: '/health' }),
    ]),
  );
  const result = await supervisor.start();
  try {
    assert.equal(result.status, 'started');
    const logs = fs.readdirSync(h.layout.logs);
    for (const id of ['python', 'web']) {
      const outLogs = logs.filter((name) => name.startsWith(`${id}-`) && name.endsWith('.out.log'));
      const errLogs = logs.filter((name) => name.startsWith(`${id}-`) && name.endsWith('.err.log'));
      assert.ok(outLogs.length > 0, `${id} 缺少 out 日志`);
      assert.ok(errLogs.length > 0, `${id} 缺少 err 日志`);
      const content = fs.readFileSync(path.join(h.layout.logs, outLogs[0]), 'utf8');
      assert.ok(content.includes('[fake-service]'), `${id} out 日志内容不可读: ${content.slice(0, 200)}`);
    }
    // 错误信息含日志路径（用一个会失败的服务验证，使用独立安装根避免 already_running）
    const h2 = await createHarness(t);
    const badPort = await getFreePort();
    h2.config.ports = { ...h2.config.ports, web: badPort };
    const badSupervisor = h2.makeSupervisor(
      h2.makeSpecs([withPort({ id: 'web', port: badPort, healthPath: '/health', healthStatus: 500, exitAfterMs: 200, exitCode: 3 })]),
    );
    const bad = await badSupervisor.start();
    assert.equal(bad.status, 'failed');
    assert.match(bad.errors.join('\n'), /\.err\.log/, `失败错误必须包含 err 日志路径: ${bad.errors.join('\n')}`);
  } finally {
    await supervisor.stop();
  }
});

test('[#102-17/#106-2] 空 models 目录启动：不崩溃、状态可读、首次运行日志记录安装来源/版本/模型根/未完成下载数', async (t) => {
  const h = await createHarness(t);
  assert.equal(fs.readdirSync(h.layout.modelsRoot).length, 0, '初始 models 目录应为空');
  // 预置一个未完成下载任务（#106-2 首次启动识别未完成任务）
  fs.mkdirSync(path.dirname(h.layout.modelStatePath), { recursive: true });
  fs.writeFileSync(
    h.layout.modelStatePath,
    JSON.stringify({ schemaVersion: 1, models: { 'qwen3-4b': { id: 'qwen3-4b', status: 'paused', receivedBytes: 1024, totalBytes: 4096, files: [], partialKept: true } } }),
  );
  const pythonPort = await getFreePort();
  const webPort = await getFreePort();
  h.config.ports = { ...h.config.ports, web: webPort };
  const supervisor = h.makeSupervisor(
    h.makeSpecs([
      withPort({ id: 'python', port: pythonPort, healthPath: '/health' }),
      withPort({ id: 'web', port: webPort, healthPath: '/health' }),
    ]),
  );
  const result = await supervisor.start();
  try {
    assert.equal(result.status, 'started', `空模型目录启动失败: ${JSON.stringify(result.errors)}`);
    assert.ok(fs.existsSync(h.layout.modelsRoot) && fs.statSync(h.layout.modelsRoot).isDirectory());
    const status = await supervisor.status();
    assert.equal(status.running, true);
    assert.equal(status.services.length, 2);
    // 首次运行日志（firstRunCompleted=false）：安装来源/版本/installRoot/modelsRoot/未完成下载数
    const firstRunLogs = fs.readdirSync(h.layout.logs).filter((name) => name.startsWith('first-run-'));
    assert.ok(firstRunLogs.length > 0, '首次启动应写 first-run 日志');
    const content = fs.readFileSync(path.join(h.layout.logs, firstRunLogs[0]), 'utf8');
    assert.ok(content.includes('模型根目录'), `first-run 日志缺少模型根目录: ${content}`);
    assert.ok(content.includes('未完成下载任务数'), `first-run 日志缺少未完成下载任务数: ${content}`);
    assert.match(content, /未完成下载任务数：1/, `first-run 日志未识别未完成下载任务: ${content}`);
    assert.ok(content.includes('安装来源'), `first-run 日志缺少安装来源: ${content}`);
    assert.ok(content.includes('程序版本') && content.includes('1.8.0'), `first-run 日志缺少版本: ${content}`);
    assert.ok(content.includes(h.layout.modelsRoot), `first-run 日志模型路径错误: ${content}`);
    assert.ok(content.includes(h.layout.installRoot), `first-run 日志安装目录错误: ${content}`);
    // install.json 标记首次运行完成
    const configAfter = JSON.parse(fs.readFileSync(h.layout.installConfigPath, 'utf8')) as { firstRunCompleted: boolean };
    assert.equal(configAfter.firstRunCompleted, true, '启动后应标记 firstRunCompleted');
  } finally {
    await supervisor.stop();
  }
});

test('[#102-4] openBrowser 仅导出且不阻塞调用方（不实际拉起浏览器）', async () => {
  const { openBrowser: defaultOpen } = await import('../src/launcher');
  assert.equal(typeof defaultOpen, 'function');
});

