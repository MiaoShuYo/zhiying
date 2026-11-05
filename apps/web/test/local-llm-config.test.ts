import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
