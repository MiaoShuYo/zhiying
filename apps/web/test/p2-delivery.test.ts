/**
 * P2 #274: delivery file names stay within the ZIP entry limits.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedFileBaseName } from '../src/lib/job-video';

test('[#274] an 80-character Chinese project name fits every delivery entry', () => {
  const base = boundedFileBaseName('知'.repeat(80));
  for (const suffix of ['-项目备份-20240131-0930.m2v', '-交付包-20240131-0930.zip', '-封面-20240131-0930.jpeg']) {
    const name = `${base}${suffix}`;
    assert.ok(Buffer.byteLength(name, 'utf8') <= 255, `${name.length} chars`);
    assert.ok([...name].length <= 200);
  }
  assert.equal(boundedFileBaseName('短名字'), '短名字');
  assert.equal(boundedFileBaseName('🎬'.repeat(60)).length % 2, 0, '不切开代理对');
});
