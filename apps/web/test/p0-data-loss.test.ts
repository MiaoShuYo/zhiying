import test from 'node:test';
import assert from 'node:assert/strict';
import { withKeyedLock } from '../src/lib/keyed-mutex';
import { narrationFingerprint, PronunciationRuleSchema } from '@m2v/schema';

test('[#188 #281] keyed lock runs read-modify-write sequences one after another', async () => {
  let store: number[] = [];
  const append = (value: number) => withKeyedLock('test:store', async () => {
    const read = [...store];
    await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
    store = [...read, value];
  });
  await Promise.all(Array.from({ length: 25 }, (_, index) => append(index)));
  assert.equal(store.length, 25, 'no acknowledged append may be lost');
  assert.deepEqual([...store].sort((a, b) => a - b), Array.from({ length: 25 }, (_, index) => index));
});

test('[#188] different keys do not wait for each other, and a failure releases the lock', async () => {
  const order: string[] = [];
  let release!: () => void;
  const slow = withKeyedLock('test:a', () => new Promise<void>(resolve => { release = resolve; }).then(() => { order.push('a'); }));
  await withKeyedLock('test:b', async () => { order.push('b'); });
  release();
  await slow;
  assert.deepEqual(order, ['b', 'a']);
  await assert.rejects(withKeyedLock('test:a', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await withKeyedLock('test:a', async () => 'next'), 'next');
});

test('[#330] occurrence rules carry the fingerprint of the narration they were made for', () => {
  assert.equal(narrationFingerprint('银行的行长'), narrationFingerprint('银行的行长'));
  assert.notEqual(narrationFingerprint('银行的行长'), narrationFingerprint('银行的行长。'));
  assert.match(narrationFingerprint(''), /^[a-f0-9]{8}$/);
  const rule = PronunciationRuleSchema.parse({ text: '行', pinyin: ['hang2'], occurrence: 1, narrationHash: narrationFingerprint('银行') });
  assert.equal(rule.narrationHash, narrationFingerprint('银行'));
  assert.equal(PronunciationRuleSchema.safeParse({ text: '行', pinyin: ['hang2'], narrationHash: 'xyz' }).success, false);
});
