import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLocalLlmConfig, withLocalLlmSlot } from '../src/lib/local-llm-config';

test('local LLM settings expose safe defaults and reject out-of-range resource values', () => {
  const defaults = readLocalLlmConfig({});
  assert.equal(defaults.model, 'qwen3:4b');
  assert.equal(defaults.keepAlive, '30m');
  assert.equal(defaults.numCtx, 4096);
  assert.equal(defaults.stream, true);
  assert.equal(defaults.maxConcurrency, 1);

  const bounded = readLocalLlmConfig({ OLLAMA_NUM_CTX: '999999', OLLAMA_KEEP_ALIVE: 'forever', OLLAMA_STREAM: 'maybe', LLM_MAX_CONCURRENCY: '0' });
  assert.equal(bounded.numCtx, 4096);
  assert.equal(bounded.keepAlive, '30m');
  assert.equal(bounded.stream, true);
  assert.equal(bounded.maxConcurrency, 1);
  assert.equal(bounded.warnings.length, 4);
});

test('local LLM slot serializes parallel callers through shared lock files', async () => {
  const lockDir = await mkdtemp(join(tmpdir(), 'm2v-ollama-slots-'));
  const config = readLocalLlmConfig({ OLLAMA_LOCK_DIR: lockDir, LLM_MAX_CONCURRENCY: '1' });
  let active = 0;
  let peak = 0;
  try {
    await Promise.all(Array.from({ length: 4 }, () => withLocalLlmSlot(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 20));
      active -= 1;
    }, config)));
    assert.equal(peak, 1);
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
});

test('[#194] stale slot of a dead owner is reclaimed, a live or guarded slot is never deleted', async () => {
  const lockDir = await mkdtemp(join(tmpdir(), 'm2v-ollama-reclaim-'));
  const config = readLocalLlmConfig({ OLLAMA_LOCK_DIR: lockDir, LLM_MAX_CONCURRENCY: '1' });
  const slot = join(lockDir, 'slot-0.lock');
  const deadPid = 2 ** 22 + 12345;
  try {
    // Dead owner, older than 5 s: reclaimed and the operation runs.
    await writeFile(slot, JSON.stringify({ token: 'dead', pid: deadPid, createdAt: Date.now() - 60_000 }));
    assert.equal(await withLocalLlmSlot(async () => 'ran', config), 'ran');

    // A live owner (this process) is never reclaimed, however old its lock is.
    await writeFile(slot, JSON.stringify({ token: 'live', pid: process.pid, createdAt: Date.now() - 60_000 }));
    const waitingForLive = withLocalLlmSlot(async () => 'ran', config);
    const blocked = await Promise.race([waitingForLive, new Promise(resolve => setTimeout(() => resolve('blocked'), 400))]);
    assert.equal(blocked, 'blocked');
    assert.equal(JSON.parse(await readFile(slot, 'utf8')).token, 'live', 'live lock must survive');
    await rm(slot, { force: true });
    assert.equal(await waitingForLive, 'ran', 'released slot is acquired');

    // While another reclaimer holds the guard, a stale slot is left alone.
    await writeFile(slot, JSON.stringify({ token: 'dead', pid: deadPid, createdAt: Date.now() - 60_000 }));
    await writeFile(join(lockDir, 'slot-0.reclaim'), '');
    const waitingForGuard = withLocalLlmSlot(async () => 'ran', config);
    const guarded = await Promise.race([waitingForGuard, new Promise(resolve => setTimeout(() => resolve('blocked'), 400))]);
    assert.equal(guarded, 'blocked');
    assert.equal(JSON.parse(await readFile(slot, 'utf8')).token, 'dead');
    // An abandoned guard (> 30 s) is cleared and reclamation resumes.
    const old = new Date(Date.now() - 60_000);
    await utimes(join(lockDir, 'slot-0.reclaim'), old, old);
    assert.equal(await waitingForGuard, 'ran');
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
});
