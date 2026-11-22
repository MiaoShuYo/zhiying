import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneSchema, resolveVisualBeatTimeline } from '../src/index';

const base = (patch: Record<string, unknown> = {}) => SceneSchema.parse({
  id: 'v190-beats', type: 'title', title: '处理步骤', narration: '读取数据，然后返回结果。',
  duration: 4, audioDuration: 4,
  visualBeats: [
    { id: 'read', narrationText: '读取数据', targetIds: ['source'] },
    { id: 'return', narrationText: '返回结果', targetIds: ['output'] },
  ],
  ...patch,
});

test('visual beats align to word timings and convert seconds to frames', () => {
  const scene = base({ wordTimings: [
    { text: '先', start: 0, end: .2 },
    { text: '读取', start: .2, end: .5 },
    { text: '数据', start: .5, end: .8 },
    { text: '然后', start: .8, end: 1 },
    { text: '返回', start: 1, end: 1.4 },
    { text: '结果', start: 1.4, end: 1.7 },
  ] });
  const frames = resolveVisualBeatTimeline(scene, 30);
  assert.deepEqual(frames.map(({ id, startFrame, endFrame }) => ({ id, startFrame, endFrame })), [
    { id: 'read', startFrame: 6, endFrame: 24 },
    { id: 'return', startFrame: 30, endFrame: 120 },
  ]);
  assert.deepEqual(frames.map(frame => frame.targetIds), [['source'], ['output']]);
});

test('subtitle cues are used when word timings do not resolve the beat', () => {
  const scene = base({ subtitleCues: [
    { text: '读取数据', start: .75, end: 1.4 },
    { text: '返回结果', start: 2, end: 2.6 },
  ] });
  const frames = resolveVisualBeatTimeline(scene, 30);
  assert.deepEqual(frames.map(frame => [frame.startFrame, frame.endFrame]), [[23, 42], [60, 120]]);
});

test('missing or invalid timing falls back to ordered frame distribution, including visual-only beats', () => {
  const scene = base({ visualBeats: [
    { id: 'a', narrationText: '读取数据', targetIds: ['a'] },
    { id: 'b', narrationText: '', targetIds: ['b'], label: '额外图表步骤' },
    { id: 'c', narrationText: '返回结果', targetIds: ['c'] },
  ], wordTimings: [{ text: '无关词', start: 0, end: 1 }] });
  const frames = resolveVisualBeatTimeline(scene, 30);
  assert.deepEqual(frames.map(frame => [frame.startFrame, frame.endFrame]), [[0, 40], [40, 80], [80, 120]]);
  assert.equal(frames[1]!.narrationText, '');
  assert.equal(frames[1]!.label, '额外图表步骤');
  assert.ok(frames.every(frame => frame.startFrame >= 0 && frame.endFrame <= 120 && frame.endFrame > frame.startFrame));
});

test('regenerated TTS timing shifts frames without changing semantic beat data', () => {
  const original = base({ wordTimings: [
    { text: '读取', start: .2, end: .5 }, { text: '数据', start: .5, end: .8 },
    { text: '返回', start: 1, end: 1.4 }, { text: '结果', start: 1.4, end: 1.7 },
  ] });
  const newTimings = original.wordTimings!.map(item => ({ ...item, start: item.start + .5, end: item.end + .5 }));
  const regenerated = SceneSchema.parse({ ...original, wordTimings: newTimings });
  assert.deepEqual(regenerated.visualBeats, original.visualBeats);
  assert.equal(resolveVisualBeatTimeline(regenerated, 30)[0]!.startFrame, resolveVisualBeatTimeline(original, 30)[0]!.startFrame + 15);
  assert.deepEqual(original.wordTimings?.[0], { text: '读取', start: .2, end: .5 }, 'resolver is pure and does not mutate its input');
});

test('invalid fps safely defaults to 30 and windows remain monotonic within clip duration', () => {
  const frames = resolveVisualBeatTimeline(base(), Number.NaN);
  assert.equal(frames[0]!.endFrame, 60);
  assert.equal(frames[1]!.endFrame, 120);
  for (let index = 1; index < frames.length; index += 1) assert.ok(frames[index]!.startFrame >= frames[index - 1]!.endFrame);
});
