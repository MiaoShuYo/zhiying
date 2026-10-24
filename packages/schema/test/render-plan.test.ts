import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RENDER_FPS,
  RENDER_VERSION,
  SceneSchema,
  StoryboardSchema,
  fingerprintOf,
  fullRenderPlan,
  planCoversTimeline,
  planReasons,
  segmentFrameRange,
  segmentLabel,
  segmentPlan,
  segmentSeconds,
  stableStringify,
  type CachedSegment,
  type RenderPlan,
  type Storyboard,
} from '../src/index';

const scene = (patch: Record<string, unknown> = {}) => SceneSchema.parse({
  id: 'scene-1', type: 'title', title: '开场', narration: '第一句。第二句。', duration: 6, visual: {}, ...patch,
});

const board = (patch: Record<string, unknown> = {}): Storyboard => StoryboardSchema.parse({
  title: '增量渲染示例', styleId: 'minimal-tech', scenes: [], ...patch,
});

const threeScenes = () => board({
  scenes: [
    scene({ id: 'a', title: '一', narration: '第一段。' }),
    scene({ id: 'b', title: '二', narration: '第二段。' }),
    scene({ id: 'c', title: '三', narration: '第三段。' }),
  ],
});

/** Cache entries as the worker would report them after a completed render. */
const cacheOf = (plan: RenderPlan): CachedSegment[] => plan.segments.map(segment => ({
  key: segment.key, kind: segment.kind, fingerprint: segment.fingerprint, frames: segment.frames, parts: segment.parts,
}));

const withoutCache = (plan: RenderPlan): RenderPlan => ({ ...plan, reusedCount: 0, reusedFrames: 0, reusedSeconds: 0 });

test('stableStringify ignores key order and drops undefined values', () => {
  assert.equal(
    stableStringify({ b: 1, a: [2, { d: 4, c: 3 }] }),
    stableStringify({ a: [2, { c: 3, d: 4 }], b: 1 }),
    '同一份数据换一个键顺序必须得到同一段文本',
  );
  assert.equal(stableStringify({ a: undefined, b: null }), '{"b":null}');
  assert.equal(stableStringify(Number.NaN), 'null', 'NaN 不能进入指纹，否则指纹会抖动');
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
});

test('fingerprintOf is deterministic, fixed width and content sensitive', () => {
  const first = fingerprintOf('场景一');
  assert.equal(first, fingerprintOf('场景一'), '同一输入必须得到同一指纹');
  assert.match(first, /^[0-9a-f]{16}$/);
  assert.notEqual(first, fingerprintOf('场景二'));
  assert.notEqual(fingerprintOf(''), fingerprintOf(' '));
});

test('the plan tiles the whole timeline without gaps', () => {
  const plan = fullRenderPlan(threeScenes());
  assert.equal(plan.version, RENDER_VERSION);
  assert.equal(plan.fps, RENDER_FPS);
  assert.equal(plan.segments.length, 3);
  assert.equal(planCoversTimeline(plan), true);
  assert.equal(plan.segments[0].startFrame, 0);
  let cursor = 0;
  for (const segment of plan.segments) {
    assert.equal(segment.startFrame, cursor);
    assert.equal(segment.endFrame, segment.startFrame + segment.frames - 1, 'endFrame 必须指向最后一帧');
    const [start, end] = segmentFrameRange(segment);
    assert.equal(start, segment.startFrame);
    assert.equal(end, segment.endFrame, 'frameRange 结束帧是包含的');
    assert.ok(segment.frames > 0);
    cursor += segment.frames;
  }
  assert.equal(cursor, plan.totalFrames);
  assert.equal(plan.segments.at(-1)!.endFrame, plan.totalFrames - 1);
  assert.equal(planCoversTimeline({ ...plan, segments: plan.segments.slice(1) }), false, '少一个片段就不是完整覆盖');
});

test('an empty cache renders every segment and reports why', () => {
  const plan = fullRenderPlan(threeScenes());
  assert.equal(plan.renderedCount, 3);
  assert.equal(plan.reusedCount, 0);
  assert.equal(plan.reusedSeconds, 0);
  assert.equal(plan.renderedSeconds, plan.totalSeconds);
  assert.deepEqual(plan.segments.map(segment => segment.reason), ['new', 'new', 'new']);
  assert.deepEqual(planReasons(plan).map(summary => [summary.code, summary.count]), [['new', 3]]);
  assert.equal(planReasons(plan)[0].label, '新增片段');
});

test('an unchanged storyboard reuses every cached segment', () => {
  const first = fullRenderPlan(threeScenes());
  const second = segmentPlan({ storyboard: threeScenes(), cached: cacheOf(first) });
  assert.equal(second.reusedCount, 3);
  assert.equal(second.renderedCount, 0);
  assert.equal(second.reusedFrames, second.totalFrames);
  assert.equal(second.reusedSeconds, second.totalSeconds);
  assert.equal(second.renderedSeconds, 0);
  assert.deepEqual(planReasons(second), [], '没有改动就不该给出重渲染原因');
  assert.deepEqual(second.segments.map(segment => segment.fingerprint), first.segments.map(segment => segment.fingerprint));
});

test('editing one scene only re-renders that segment', () => {
  const first = fullRenderPlan(threeScenes());
  const edited = threeScenes();
  edited.scenes[1] = scene({ id: 'b', title: '二', narration: '第二段改过了。' });
  const plan = segmentPlan({ storyboard: edited, cached: cacheOf(first) });
  assert.equal(plan.renderedCount, 1);
  assert.equal(plan.reusedCount, 2);
  assert.equal(plan.segments[0].reuse, true);
  assert.equal(plan.segments[1].reuse, false);
  assert.equal(plan.segments[1].reason, 'content');
  assert.equal(plan.segments[2].reuse, true);
  assert.equal(plan.renderedSeconds, Math.round(segmentSeconds(plan.segments[1]) * 100) / 100);
  const reasons = planReasons(plan);
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].code, 'content');
  assert.equal(reasons[0].label, '内容有改动');
  assert.deepEqual(reasons[0].segments.map(segment => segment.key), ['scene:b']);
});

test('a regenerated voice file re-renders the segment as an audio change', () => {
  const voiced = () => board({
    scenes: [
      scene({ id: 'a', narration: '第一段。', audioSrc: 'projects/p1/assets/a.mp3' }),
      scene({ id: 'b', narration: '第二段。', audioSrc: 'projects/p1/assets/b.mp3' }),
    ],
  });
  const signatures = { 'projects/p1/assets/a.mp3': { bytes: 100, mtimeMs: 1000 }, 'projects/p1/assets/b.mp3': { bytes: 200, mtimeMs: 1000 } };
  const first = segmentPlan({ storyboard: voiced(), audioSignatures: signatures });
  const plan = segmentPlan({
    storyboard: voiced(),
    cached: cacheOf(first),
    audioSignatures: { ...signatures, 'projects/p1/assets/b.mp3': { bytes: 240, mtimeMs: 5000 } },
  });
  assert.equal(plan.renderedCount, 1);
  assert.equal(plan.segments[0].reuse, true, '没有重新配音的片段必须复用');
  assert.equal(plan.segments[1].reason, 'audio');
  assert.equal(plan.segments[1].parts.content, first.segments[1].parts.content, '画面内容没变，只有音频变了');
  assert.equal(planReasons(plan)[0].label, '语音有改动');
});

test('global delivery settings re-render every segment as a global change', () => {
  const first = fullRenderPlan(threeScenes());
  const restyled = threeScenes();
  restyled.styleId = 'academic';
  const plan = segmentPlan({ storyboard: restyled, cached: cacheOf(first) });
  assert.equal(plan.renderedCount, 3);
  assert.deepEqual(plan.segments.map(segment => segment.reason), ['global', 'global', 'global']);
  assert.equal(planReasons(plan)[0].label, '字幕/样式/BGM/画质有改动');
});

test('reordering scenes keeps every rendered segment', () => {
  const first = fullRenderPlan(threeScenes());
  const reordered = threeScenes();
  reordered.scenes = [reordered.scenes[2], reordered.scenes[0], reordered.scenes[1]];
  const plan = segmentPlan({ storyboard: reordered, cached: cacheOf(first) });
  assert.equal(plan.renderedCount, 0, '只调整顺序不应该重渲染');
  assert.deepEqual(plan.segments.map(segment => segment.key), ['scene:c', 'scene:a', 'scene:b']);
  assert.equal(plan.segments[0].startFrame, 0, '新的顺序要重新铺时间轴');
  assert.equal(planCoversTimeline(plan), true);
});

test('draft and full renders keep separate caches', () => {
  const full = fullRenderPlan(threeScenes(), 'full');
  const draft = segmentPlan({ storyboard: threeScenes(), preset: 'draft', cached: cacheOf(full) });
  assert.equal(draft.preset, 'draft');
  assert.equal(draft.renderedCount, 3, '草稿画质的缓存不能拿来交付');
  assert.deepEqual(draft.segments.map(segment => segment.reason), ['global', 'global', 'global']);
  assert.notEqual(draft.segments[0].fingerprint, full.segments[0].fingerprint);
});

test('intro and outro are independently addressable segments', () => {
  const deliverable = () => board({
    intro: { enabled: true, title: '片头', duration: 3 },
    outro: { enabled: true, title: '片尾', duration: 2 },
    scenes: [scene({ id: 'a', title: '一', narration: '第一段。' }), scene({ id: 'b', title: '二', narration: '第二段。' })],
  });
  const plan = fullRenderPlan(deliverable());
  assert.deepEqual(plan.segments.map(segment => segment.key), ['intro', 'scene:a', 'scene:b', 'outro']);
  assert.deepEqual(plan.segments.map(segment => segment.kind), ['intro', 'scene', 'scene', 'outro']);
  const storyboard = deliverable();
  assert.equal(segmentLabel(plan.segments[0], storyboard), '片头');
  assert.equal(segmentLabel(plan.segments[1], storyboard), '场景 1 · 一');
  assert.equal(segmentLabel(plan.segments[3], storyboard), '片尾');
  assert.equal(segmentLabel({ ...plan.segments[1], kind: 'scene', index: 1 }, storyboard), '场景 2 · 二');
});

test('segmentSeconds converts frames with the plan frame rate', () => {
  const plan = fullRenderPlan(threeScenes());
  assert.equal(segmentSeconds(plan.segments[0]), plan.segments[0].frames / RENDER_FPS);
  assert.equal(segmentSeconds({ frames: 90 }), 3);
  assert.equal(segmentSeconds({ frames: 90 }, 60), 1.5);
});

test('planReasons groups only the segments that must run again', () => {
  const first = fullRenderPlan(threeScenes());
  const edited = threeScenes();
  edited.scenes[0] = scene({ id: 'a', title: '一', narration: '第一段改过了。' });
  edited.scenes[2] = scene({ id: 'c', title: '三', narration: '第三段改过了。' });
  edited.scenes.push(scene({ id: 'd', title: '四', narration: '新增的一段。' }));
  const plan = segmentPlan({ storyboard: edited, cached: cacheOf(first) });
  const reasons = planReasons(plan);
  assert.deepEqual(reasons.map(summary => summary.code), ['content', 'new'], '原因按内容/语音/全局/新增排序');
  assert.deepEqual(reasons.map(summary => summary.count), [2, 1]);
  assert.equal(reasons.every(summary => summary.segments.every(segment => segment.reuse === false)), true);
  assert.equal(withoutCache(plan).reusedCount, 0);
});
