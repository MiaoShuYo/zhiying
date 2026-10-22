import test from 'node:test';
import assert from 'node:assert/strict';
import { ExportPresetSchema, SceneSchema, StoryboardSchema, changedPresetCount, presetBoardPatch, presetChanges } from '../src/index';

const preset = (patch: Record<string, unknown> = {}) => ExportPresetSchema.parse({
  id: 'preset-1', name: ' 竖屏交付 ', aspectRatio: '9:16', subtitles: {},
  createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z', ...patch,
});

test('a preset fills in the render preset, subtitle and transition defaults', () => {
  const value = preset();
  assert.equal(value.name, '竖屏交付', '预设名要去掉首尾空格');
  assert.equal(value.renderPreset, 'full');
  assert.equal(value.transition, 'none');
  assert.equal(value.aspectRatio, '9:16');
  assert.equal(value.subtitles.enabled, true);
  assert.equal(value.subtitles.preset, 'boxed');
  assert.equal(value.intro, undefined);
});

test('invalid aspect ratios, empty names and unknown transitions are rejected', () => {
  assert.throws(() => preset({ aspectRatio: '1:1' }));
  assert.throws(() => preset({ name: '   ' }), '空白名称不能保存');
  assert.throws(() => preset({ name: 'x'.repeat(41) }), '名称最长 40 字');
  assert.throws(() => preset({ transition: 'slide' }));
  assert.throws(() => preset({ renderPreset: 'high' }));
  assert.throws(() => preset({ subtitles: { fontSize: 12 } }), '字幕字号有下限');
});

test('presetBoardPatch only carries delivery settings', () => {
  const patch = presetBoardPatch(preset({ intro: { enabled: true, title: '片头' }, transition: 'fade' }));
  assert.deepEqual(Object.keys(patch).sort(), ['aspectRatio', 'intro', 'outro', 'subtitles', 'transition']);
  assert.equal(patch.aspectRatio, '9:16');
  assert.equal(patch.transition, 'fade');
  assert.equal(patch.intro?.title, '片头');
  assert.equal(patch.outro, undefined);
});

test('applying a preset keeps the storyboard content untouched', () => {
  const board = StoryboardSchema.parse({
    title: '历史纪录片', styleId: 'minimal-tech',
    scenes: [
      SceneSchema.parse({ id: 'a', type: 'title', narration: '第一句。', duration: 6, audioSrc: 'audio/a.wav' }),
      SceneSchema.parse({ id: 'b', type: 'bullets', narration: '第二句。', visual: { items: ['要点一', '要点二'] }, duration: 8 }),
    ],
  });
  const merged = StoryboardSchema.parse({ ...board, ...presetBoardPatch(preset()) });
  assert.deepEqual(merged.scenes, board.scenes, '分镜、旁白与素材必须原样保留');
  assert.equal(merged.title, '历史纪录片');
  assert.equal(merged.styleId, 'minimal-tech');
  assert.equal(merged.aspectRatio, '9:16');
  assert.ok(!JSON.stringify(presetBoardPatch(preset())).includes('scenes'), '预设内容里不能混入分镜');
});

test('presets are only default when explicitly marked', () => {
  assert.equal(preset().isDefault, false);
  assert.equal(preset({ isDefault: true }).isDefault, true);
});

test('presetChanges lists every delivery field with readable before/after values', () => {
  const board = StoryboardSchema.parse({
    title: '例子', styleId: 'minimal-tech', subtitles: { preset: 'minimal', fontSize: 24 },
    scenes: [{ id: 'a', type: 'title', narration: '一句话。', visual: {} }],
  });
  const target = preset({ intro: { enabled: true, title: '开场', duration: 2 }, transition: 'fade', renderPreset: 'draft' });
  const changes = presetChanges(board, target, 'full');
  assert.deepEqual(changes.map(change => change.key), ['aspectRatio', 'subtitles', 'intro', 'outro', 'transition', 'renderPreset']);
  const byKey = (key: string) => changes.find(change => change.key === key)!;
  assert.equal(byKey('aspectRatio').current, '横屏 16:9');
  assert.equal(byKey('aspectRatio').next, '竖屏 9:16');
  assert.equal(byKey('aspectRatio').changed, true);
  assert.notEqual(byKey('subtitles').current, byKey('subtitles').next);
  assert.match(byKey('intro').next, /开场/);
  assert.equal(byKey('outro').changed, false);
  assert.equal(byKey('transition').changed, true);
  assert.equal(byKey('renderPreset').next, '草稿');
  assert.equal(changedPresetCount(changes), 5);
});

test('applying a preset that matches the board reports no changes', () => {
  const board = StoryboardSchema.parse({
    title: '例子', styleId: 'minimal-tech', aspectRatio: '9:16', transition: 'fade', subtitles: {},
    scenes: [{ id: 'a', type: 'title', narration: '一句话。', visual: {} }],
  });
  const target = preset({ aspectRatio: '9:16', transition: 'fade' });
  const changes = presetChanges(board, target);
  assert.equal(changedPresetCount(changes), 0);
  assert.equal(changes.every(change => change.current === change.next), true);
});
