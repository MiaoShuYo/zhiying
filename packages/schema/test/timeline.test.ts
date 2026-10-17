import assert from 'node:assert/strict';
import test from 'node:test';
import { StoryboardSchema, preflight, timelineFrames, timelineFor } from '../src/index';

const scene = (id: string, duration: number) => ({ id, type: 'title' as const, title: id, narration: '旁白', duration });

const board = (extra: Record<string, unknown> = {}) => StoryboardSchema.parse({ title: '时间轴', styleId: 'minimal-tech', scenes: [scene('a', 4), scene('b', 6)], ...extra });

test('scenes are laid end to end and the total matches their sum', () => {
  const timeline = timelineFor(board());
  assert.equal(timeline.totalSeconds, 10);
  assert.deepEqual(timeline.scenes.map(s => [s.start, s.duration, s.end]), [[0, 4, 4], [4, 6, 10]]);
  assert.equal(timeline.intro, undefined);
  assert.equal(timeline.outro, undefined);
});

test('the intro shifts every scene and extends the total', () => {
  const timeline = timelineFor(board({ intro: { enabled: true, title: '开场', duration: 3 } }));
  assert.deepEqual([timeline.intro?.start, timeline.intro?.duration], [0, 3]);
  assert.equal(timeline.scenes[0].start, 3);
  assert.equal(timeline.scenes[1].start, 7);
  assert.equal(timeline.totalSeconds, 13);
});

test('the outro is appended after the last scene', () => {
  const timeline = timelineFor(board({ outro: { enabled: true, title: '片尾', duration: 2.5 } }));
  assert.equal(timeline.outro?.start, 10);
  assert.equal(timeline.outro?.end, 12.5);
  assert.equal(timeline.totalSeconds, 12.5);
  assert.equal(timeline.segments.at(-1)?.kind, 'outro');
});

test('disabled frames cost no time', () => {
  const timeline = timelineFor(board({ intro: { enabled: false, duration: 5 }, outro: { enabled: false, duration: 5 } }));
  assert.equal(timeline.totalSeconds, 10);
});

test('frames are rounded once per segment so sequences never overlap', () => {
  const { segments, totalFrames } = timelineFrames(board({ intro: { enabled: true, duration: 1.5 }, outro: { enabled: true, duration: 2.5 } }), 30);
  assert.deepEqual(segments.map(s => [s.startFrame, s.frames]), [[0, 45], [45, 120], [165, 180], [345, 75]]);
  assert.equal(totalFrames, 420);
});

test('legacy storyboards without frame settings still parse with no transition', () => {
  const parsed = StoryboardSchema.parse({ title: '旧项目', styleId: 'minimal-tech', scenes: [scene('a', 4)] });
  assert.equal(parsed.transition, 'none');
  assert.equal(timelineFor(parsed).totalSeconds, 4);
});

test('the delivery estimate includes the frames', () => {
  assert.equal(preflight(board(), []).estimatedSeconds, 10);
  assert.equal(preflight(board({ intro: { enabled: true, duration: 3 }, outro: { enabled: true, duration: 2 } }), []).estimatedSeconds, 15);
});
