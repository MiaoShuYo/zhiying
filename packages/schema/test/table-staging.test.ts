import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneSchema, resolveTableRowsForFrame } from '../src/index';

const sourceRows = [
  ['一月', '99.90%'],
  ['二月', '99.91%'],
  ['三月', '99.92%'],
  ['四月', '99.93%'],
];

function stagedTable(incomplete = false) {
  return SceneSchema.parse({
    id: 'table-staging-test', type: 'table', title: '季度服务可用率',
    narration: '先查看前两个月。随后查看后两个月。', duration: 4, audioDuration: 4,
    wordTimings: [
      { text: '先查看前两个月。', start: 0, end: 1 },
      { text: '随后查看后两个月。', start: 3, end: 4 },
    ],
    visual: { headers: ['月份', '可用率'], rows: sourceRows.map(row => [...row]) },
    visualBeats: [
      { id: 'first-pair', narrationText: '先查看前两个月。', targetIds: ['table-row-1', 'table-row-2'] },
      { id: 'second-pair', narrationText: '随后查看后两个月。', targetIds: incomplete ? ['table-row-3'] : ['table-row-3', 'table-row-4'] },
    ],
  });
}

test('a complete table plan selects only the row group mapped to each beat', () => {
  const scene = stagedTable();
  const first = resolveTableRowsForFrame(scene, 0, 30);
  const second = resolveTableRowsForFrame(scene, 90, 30);
  assert.deepEqual(first, { rowIndices: [0, 1], staged: true, beatId: 'first-pair', uncoveredTargetIds: [] });
  assert.deepEqual(second, { rowIndices: [2, 3], staged: true, beatId: 'second-pair', uncoveredTargetIds: [] });
});

test('an incomplete table plan falls back to every source row and reports missing targets', () => {
  const scene = stagedTable(true);
  const result = resolveTableRowsForFrame(scene, 90, 30);
  assert.deepEqual(result, { rowIndices: [0, 1, 2, 3], staged: false, uncoveredTargetIds: ['table-row-4'] });
  assert.deepEqual(scene.visual.rows, sourceRows, 'staging does not remove or rewrite any source table fact');
});

test('a beat end resolves to the nearest slice and the next beat start advances the rows', () => {
  const scene = stagedTable();
  const firstBeatEnd = resolveTableRowsForFrame(scene, 30, 30);
  const secondBeatStart = resolveTableRowsForFrame(scene, 90, 30);
  assert.deepEqual(firstBeatEnd.rowIndices, [0, 1]);
  assert.equal(firstBeatEnd.beatId, 'first-pair');
  assert.deepEqual(secondBeatStart.rowIndices, [2, 3]);
  assert.equal(secondBeatStart.beatId, 'second-pair');
});
