/**
 * P1 render/cache regressions: #231 segment cache budget, #234 intro/outro cache key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SceneSchema, StoryboardSchema, segmentPlan } from '../../../packages/schema/src/index';
import { pruneSegmentCache } from '../src/segment-cache';

test('[#231] the byte budget evicts whole pairs, older kept renders before the current plan', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm2v-segments-'));
  try {
    const write = async (name: string, bytes: number, ageSeconds: number) => {
      for (const ext of ['mp4', 'json']) {
        const file = join(dir, `${name}.${ext}`);
        await writeFile(file, Buffer.alloc(ext === 'mp4' ? bytes : 10));
        const at = new Date(Date.now() - ageSeconds * 1000);
        await utimes(file, at, at);
      }
    };
    await write('scene-a-oldfp', 600, 300);
    await write('scene-b-currentfp', 600, 100);
    const keep = new Set(['oldfp', 'currentfp']);
    const result = await pruneSegmentCache(dir, keep, 1000, new Set(['currentfp']));
    const left = (await readdir(dir)).sort();
    assert.deepEqual(left, ['scene-b-currentfp.json', 'scene-b-currentfp.mp4'], '先淘汰旧渲染的片段，且成对删除');
    assert.ok(result.bytes <= 1000);
    // Even the current plan alone above the budget is trimmed instead of growing forever.
    await write('scene-c-currentfp2', 900, 50);
    const trimmed = await pruneSegmentCache(dir, new Set(['currentfp', 'currentfp2']), 1000, new Set(['currentfp', 'currentfp2']));
    assert.ok(trimmed.bytes <= 1000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('[#234] an outro never reuses a cached intro with the same fingerprint', () => {
  const card = { enabled: true, title: '同样的卡片', duration: 3 };
  const scene = SceneSchema.parse({ id: 'a', type: 'title', narration: '旁白', visual: {}, duration: 4 });
  const introOnly = StoryboardSchema.parse({ title: '片名', styleId: 'minimal-tech', scenes: [scene], intro: card });
  const first = segmentPlan({ storyboard: introOnly, cached: [] });
  const cached = first.segments.map(segment => ({ key: segment.key, kind: segment.kind, fingerprint: segment.fingerprint, frames: segment.frames, parts: segment.parts }));
  const both = StoryboardSchema.parse({ title: '片名', styleId: 'minimal-tech', scenes: [scene], intro: card, outro: card });
  const next = segmentPlan({ storyboard: both, cached: cached as never });
  const intro = next.segments.find(segment => segment.kind === 'intro')!;
  const outro = next.segments.find(segment => segment.kind === 'outro')!;
  assert.equal(intro.fingerprint, outro.fingerprint, '两张卡片内容一致');
  assert.equal(intro.reuse, true);
  assert.equal(outro.reuse, false, '新启用的片尾必须重新渲染');
});
