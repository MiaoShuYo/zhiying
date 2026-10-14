import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneSchema, StoryboardSchema } from '../src/index';

test('preserves scoped pronunciation rules without changing narration', () => {
  const scene = { id: 'voice', type: 'title', narration: '几行代码', pronunciationOverrides: [{ text: '行', pinyin: ['hang2'], occurrence: 1 }] };
  const value = StoryboardSchema.parse({ title: '纠音', styleId: 'academic', pronunciationRules: [{ text: '几行代码', pinyin: ['ji3', 'hang2', 'dai4', 'ma3'] }], scenes: [scene] });
  assert.equal(value.scenes[0].narration, '几行代码');
  assert.equal(value.scenes[0].pronunciationOverrides?.[0].occurrence, 1);
  assert.equal(value.pronunciationRules?.[0].pinyin[1], 'hang2');
  assert.equal(SceneSchema.safeParse({ ...scene, pronunciationOverrides: [{ text: '代码', pinyin: ['dai4'] }] }).success, false);
});

test('accepts valid scenes and rejects missing narration', () => {
  const scene = { id: 'one', type: 'bullets', title: '核心观点', narration: '讲清楚这一组观点。', visual: { items: ['A', 'B'] } };
  assert.equal(SceneSchema.safeParse(scene).success, true);
  assert.equal(SceneSchema.safeParse({ ...scene, narration: undefined }).success, false);
});
test('rejects invalid visual data', () => {
  const common = { id: 'bad', narration: '说明', visual: {} };
  for (const type of ['bullets', 'comparison', 'chart']) assert.equal(SceneSchema.safeParse({ ...common, type }).success, false);
});
test('parses storyboard and defaults to 16:9', () => {
  const parsed = StoryboardSchema.parse({ title: '演示', styleId: 'academic', scenes: [{ id: 'one', type: 'title', narration: '开场', visual: {} }] });
  assert.equal(parsed.aspectRatio, '16:9');
});
test('supports portrait video, local BGM settings, and aligned word captions', () => {
  const parsed = StoryboardSchema.parse({ title: '竖屏演示', styleId: 'whiteboard', aspectRatio: '9:16', bgmSrc: 'projects/p/assets/music.wav', bgmVolume: 0.2, bgmFadeIn: 2, scenes: [{ id: 's1', type: 'media', title: '图片', narration: '逐字字幕', audioSrc: 'audio/s1.wav', wordTimings: [{ text: '逐', start: 0, end: 0.2 }, { text: '字', start: 0.2, end: 0.4 }], visual: { src: 'projects/p/assets/image.png', attribution: 'Creator', license: 'CC BY 4.0' } }] });
  assert.equal(parsed.aspectRatio, '9:16');
  assert.equal(parsed.bgmFadeOut, 1);
  assert.equal(parsed.scenes[0].wordTimings?.length, 2);
});
test('validates timeline and math scenes', () => {
  assert.equal(SceneSchema.safeParse({ id: 'timeline', type: 'timeline', narration: '时间线', visual: { items: [{ date: '2020', label: '开始' }, { date: '2024', label: '现在' }] } }).success, true);
  assert.equal(SceneSchema.safeParse({ id: 'math', type: 'math', narration: '公式', visual: { formula: 'E=mc^2' } }).success, true);
  assert.equal(SceneSchema.safeParse({ id: 'timeline-bad', type: 'timeline', narration: '时间线', visual: { items: [{ date: '2020', label: '开始' }] } }).success, false);
});

import { randomUUID } from 'node:crypto';
test('accepts a complete long-document storyboard beyond 100 scenes', () => {
  const scenes = Array.from({ length: 332 }, (_, index) => ({ id: randomUUID(), type: 'title', narration: `章节 ${index + 1}` }));
  const parsed = StoryboardSchema.parse({ title: '长文', styleId: 'academic', scenes });
  assert.equal(parsed.scenes.length, 332);
  assert.equal(parsed.scenes[331].narration, '章节 332');
});
