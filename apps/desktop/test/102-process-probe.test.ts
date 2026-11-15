/**
 * #102-6/7/9 端口与进程身份探测（§2.6 process-probe.ts）。
 * 真实子进程 + 真实监听端口；只读探测，不结束任何进程。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTempRoot, cleanupRegisteredTempDirs, NODE_EXE } from './_helpers/temp';
import { getFreePort, isPortOpen, waitForPort } from './_helpers/ports';
import { writeFakeServiceScript } from './_helpers/fake-service';
import { killTree, isAlive, waitForCondition } from './_helpers/processes';
import {
  inspectPort,
  inspectManagedProcess,
  isProcessAlive,
  readProcessInfos,
  readProcessCommandLines,
} from '../src/process-probe';

function spawnNodeWithMarker(instanceId: string): { pid: number; stop: () => void } {
  const code = `setInterval(() => {}, 1000);`;
  const child = spawn(NODE_EXE, ['-e', code, '--', `--m2v-instance=${instanceId}`], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
  return {
    pid: child.pid ?? -1,
    stop: () => killTree(child.pid ?? -1),
  };
}

test('[#102-6] inspectPort：空闲端口 open=false；被监听时 open=true 且尽量给出占用者 PID', async (t) => {
  const dir = makeTempRoot('probe-port');
  t.after(() => cleanupRegisteredTempDirs());

  const freePort = await getFreePort();
  const closed = await inspectPort(freePort);
  assert.equal(closed.open, false, '空闲端口不应被报告为 open');

  const script = writeFakeServiceScript(dir);
  const port = await getFreePort();
  const child = spawn(NODE_EXE, [script, '--port', String(port), '--role', 'probe'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => killTree(child.pid ?? -1));
  await waitForPort(port, true, { timeoutMs: 10_000 });

  const inspected = await inspectPort(port);
  assert.equal(inspected.open, true);
  // 占用者信息“可得时”必须给出，且必须是真实监听进程
  if (inspected.owner?.pid !== undefined) {
    assert.equal(inspected.owner.pid, child.pid, `占用者 PID 应为监听进程 ${child.pid}，实际 ${inspected.owner.pid}`);
  }
  if (inspected.owner?.name) {
    assert.ok(inspected.owner.name.toLowerCase().includes('node'), `占用者进程名应可读，实际 ${inspected.owner.name}`);
  }
  assert.ok(await isPortOpen(port), '探测不得关闭/影响监听端口');
  assert.ok(isAlive(child.pid ?? -1), '探测不得结束外部进程');
});

test('[#102-7/#102-9] inspectManagedProcess：只有实例标记匹配才算受管；死进程 alive=false', async (t) => {
  const id = `probe-${Date.now()}`;
  const managed = spawnNodeWithMarker(id);
  t.after(() => managed.stop());
  await waitForCondition(() => isAlive(managed.pid), { timeoutMs: 5000, label: 'managed process alive' });

  const inspection = await inspectManagedProcess(managed.pid, id);
  assert.equal(inspection.alive, true);
  assert.equal(inspection.managed, true, `带 --m2v-instance=${id} 的进程应判定为受管: ${JSON.stringify(inspection)}`);
  assert.ok((inspection.commandLine ?? '').includes(`--m2v-instance=${id}`), 'commandLine 应可读并含实例标记');

  const other = await inspectManagedProcess(managed.pid, `${id}-other`);
  assert.equal(other.alive, true);
  assert.equal(other.managed, false, '实例标记不匹配不得判定为受管（避免误杀）');

  const dead = spawn(NODE_EXE, ['-e', 'process.exit(0)'], { windowsHide: true, stdio: 'ignore' });
  await new Promise<void>((resolve) => dead.once('exit', () => resolve()));
  const deadInspection = await inspectManagedProcess(dead.pid ?? -1, id);
  assert.equal(deadInspection.alive, false);
  assert.equal(deadInspection.managed, false);
});

test('[#102-9] isProcessAlive 与 readProcessInfos/CommandLines 基础行为', async (t) => {
  assert.equal(isProcessAlive(process.pid), true, '当前进程应存活');
  assert.equal(isProcessAlive(999_999_99), false, '不存在的 PID 应判定为不存在');
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(0), false);

  const marker = `probe-info-${Date.now()}`;
  const child = spawnNodeWithMarker(marker);
  t.after(() => child.stop());
  const infos = await readProcessInfos([child.pid, process.pid]);
  assert.ok(infos.has(child.pid), 'readProcessInfos 应返回目标进程信息');
  assert.ok((infos.get(child.pid)?.commandLine ?? '').includes(marker), 'commandLine 应包含标记');
  assert.ok((infos.get(child.pid)?.name ?? '').length > 0, '进程名应可读');

  const commandLines = await readProcessCommandLines([child.pid]);
  assert.ok((commandLines.get(child.pid) ?? '').includes(marker));
});
