import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneSchema, StoryboardSchema, applyBatch, batchImpact, effectiveSubtitles } from '../src/index';

const scene = (patch: Record<string, unknown> = {}) => SceneSchema.parse({ id: 'a', type: 'title', narration: '第一句。第二句。', visual: {}, duration: 6, ...patch });
const board = StoryboardSchema.parse({
  title: '批量精修', styleId: 'minimal-tech', aspectRatio: '16:9',
  scenes: [
    scene({ id: 'a', title: '第一幕', audioSrc: 'audio/a.wav', audioDuration: 6 }),
    scene({ id: 'b', title: '第二幕', audioSrc: 'audio/b.wav', audioDuration: 6, speechSpeed: 1.25 }),
    scene({ id: 'c', title: '第三幕', audioSrc: 'audio/c.wav', audioDuration: 6 }),
  ],
});

test('只改选中的场景，未选中的原样保留', () => {
  const next = applyBatch(board, [0, 1], { speechSpeed: 1.4, sceneGap: 1.5 });
  assert.equal(next.scenes[0].speechSpeed, 1.4);
  assert.equal(next.scenes[1].speechSpeed, 1.4);
  assert.equal(next.scenes[2].speechSpeed, undefined, '没选中的场景不能被动到');
  assert.equal(next.scenes[0].sceneGap, 1.5);
  assert.equal(next.scenes[2].sceneGap, undefined);
  assert.equal(board.scenes[0].speechSpeed, undefined, '预览用的原分镜不能被改写');
});

test('已经一致的值不列进影响范围', () => {
  const impact = batchImpact(board, [1], { speechSpeed: 1.25 });
  assert.equal(impact.empty, true);
  assert.equal(impact.changes, 0);
  assert.deepEqual(impact.rows, []);
  assert.deepEqual(impact.staleAudio, [], '没有变化就不必重新配音');
});

test('语速与句间停顿变化时列出需要重新配音的场景', () => {
  const impact = batchImpact(board, [0, 1, 2], { speechSpeed: 1.1, sentencePause: 0.3 });
  assert.deepEqual(impact.scenes, [0, 1, 2]);
  assert.deepEqual(impact.staleAudio, [0, 1, 2]);
  const silent = batchImpact(board, [0], { speechSpeed: 1.1 });
  assert.deepEqual(silent.staleAudio, [0], '只改了一个场景就只提醒这一个');
  const noAudio = StoryboardSchema.parse({ ...board, scenes: [{ ...board.scenes[0], audioSrc: undefined }] });
  assert.deepEqual(batchImpact(noAudio, [0], { speechSpeed: 1.1 }).staleAudio, [], '还没有语音的场景无需重新配音');
});

test('未设置句间停顿的场景按 0.12 秒比较，不会把没有变化说成变化', () => {
  // The voice route synthesises with 0.12s pauses when a scene never set one.
  const impact = batchImpact(board, [0], { sentencePause: 0.12 });
  assert.equal(impact.empty, true, '默认就是 0.12 秒，选它不该显示为修改');
  const changed = batchImpact(board, [0], { sentencePause: 0.4 });
  assert.deepEqual(changed.rows.map(row => [row.field, row.current, row.next]), [['sentencePause', '0.12s', '0.4s']]);
});

test('字幕是项目级设置，单列在项目行里', () => {
  const impact = batchImpact(board, [0], { subtitles: { fontSize: 42 } });
  assert.deepEqual(impact.rows, [], '字幕不按场景重复列出');
  assert.equal(impact.projectRows.length, 1);
  assert.deepEqual(impact.projectRows[0].field, 'subtitles.fontSize');
  assert.equal(impact.projectRows[0].sceneIndex, -1);
  assert.deepEqual([impact.projectRows[0].label, impact.projectRows[0].current, impact.projectRows[0].next], ['字幕字号', '30 px', '42 px']);
  assert.equal(applyBatch(board, [0], { subtitles: { fontSize: 42 } }).subtitles?.fontSize, 42);
});

test('超出范围的数值按上下限收敛后再落库', () => {
  const impact = batchImpact(board, [0], { speechSpeed: 9, sceneGap: 99 });
  assert.deepEqual(impact.rows.map(row => row.next), ['3×', '10s']);
  const next = applyBatch(board, [0], { speechSpeed: 9, sceneGap: 99 });
  assert.equal(next.scenes[0].speechSpeed, 3);
  assert.equal(next.scenes[0].sceneGap, 10);
  assert.equal(applyBatch(board, [0], { speechSpeed: 0.1 }).scenes[0].speechSpeed, 0.5);
});

test('越界或重复的场景序号被忽略，也不会重复计算', () => {
  const impact = batchImpact(board, [0, 0, 5, -1], { speechSpeed: 1.2 });
  assert.deepEqual(impact.scenes, [0]);
  assert.equal(impact.rows.length, 1);
});

test('字幕的默认值来自项目设置，未设置时用渲染默认值', () => {
  assert.deepEqual(effectiveSubtitles(board), { enabled: true, preset: 'boxed', position: 'bottom', fontSize: 30, color: '#ffffff', background: '#000000', backgroundOpacity: 0.72 });
  const custom = StoryboardSchema.parse({ ...board, subtitles: { fontSize: 24, position: 'top' } });
  assert.equal(effectiveSubtitles(custom).fontSize, 24);
  assert.equal(effectiveSubtitles(custom).position, 'top');
  assert.equal(effectiveSubtitles(custom).preset, 'boxed', '没改的字段仍是默认值');
});
