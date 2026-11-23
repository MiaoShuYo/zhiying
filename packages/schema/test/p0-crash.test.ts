/**
 * P0 crash regressions: #326 timeline nodes, #214 table headers, #162 legacy code scenes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneSchema, StoryboardSchema, isLegacyCodeVisual } from '../src/index';

const scene = (type: string, visual: Record<string, unknown>) => ({ id: `${type}-1`, type, narration: '旁白', visual });

test('[#326] timeline nodes must be objects with date and label text', () => {
  assert.equal(SceneSchema.safeParse(scene('timeline', { items: [{ date: '2020', label: '开始' }, { date: 2024, label: '现在' }] })).success, true);
  for (const items of [[null, null], [{ date: '2020', label: '开始' }, null], ['2020', '2024'], [{ date: '2020' }, { date: '2024' }], [{ date: {}, label: 'a' }, { date: '1', label: 'b' }], [[], []]]) {
    assert.equal(SceneSchema.safeParse(scene('timeline', { items })).success, false, JSON.stringify(items));
  }
});

test('[#214] table headers must all be strings and rows must match their width', () => {
  assert.equal(SceneSchema.safeParse(scene('table', { headers: ['A', 'B'], rows: [['1', '2']] })).success, true);
  assert.equal(SceneSchema.safeParse(scene('table', { headers: [{ text: 'A' }, 'B'], rows: [['1', '2']] })).success, false);
  assert.equal(SceneSchema.safeParse(scene('table', { headers: ['A', null], rows: [['1', '2']] })).success, false);
  assert.equal(SceneSchema.safeParse(scene('table', { headers: ['A', 'B'], rows: [['1']] })).success, false);
  assert.equal(SceneSchema.safeParse(scene('table', { headers: [], rows: [] })).success, false);
});

test('[#162] legacy code scenes with explanation/steps only keep parsing', () => {
  const legacy = scene('code', { explanation: '用缓存避免重复计算', steps: ['读取缓存', '未命中时计算'] });
  assert.equal(SceneSchema.safeParse(legacy).success, true);
  assert.equal(SceneSchema.safeParse(scene('code', { steps: ['只有步骤'] })).success, true);
  const board = StoryboardSchema.safeParse({ title: '旧项目', styleId: 'minimal-tech', aspectRatio: '16:9', scenes: [legacy] });
  assert.equal(board.success, true, board.success ? '' : JSON.stringify(board.error.issues));
  // Structured code is still validated, and an empty code visual is still rejected.
  assert.equal(SceneSchema.safeParse(scene('code', {})).success, false);
  assert.equal(SceneSchema.safeParse(scene('code', { code: '', explanation: 'x' })).success, false);
  assert.equal(SceneSchema.safeParse(scene('code', { explanation: 'x', mode: 'diff' })).success, false);
  assert.equal(SceneSchema.safeParse(scene('code', { code: 'const a = 1;' })).success, true);
  assert.equal(isLegacyCodeVisual({ explanation: '   ' }), false);
  assert.equal(isLegacyCodeVisual({ steps: ['a', 2] }), false);
});
