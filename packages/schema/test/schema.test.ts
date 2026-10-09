import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneSchema, StoryboardSchema } from '../src/index';

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
