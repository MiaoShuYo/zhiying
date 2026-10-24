import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProductionTemplateSchema, SceneSchema, StoryboardSchema,
  templateBoardPatch, templateChanges, templateFromProject, templateScenePatch, templateSummary,
} from '../src/index';

const scene = (patch: Record<string, unknown> = {}) => SceneSchema.parse({ id: 'a', type: 'title', narration: '第一句。', visual: {}, duration: 6, ...patch });
const board = StoryboardSchema.parse({
  title: '口播常用方案', styleId: 'minimal-tech', aspectRatio: '16:9',
  subtitles: { preset: 'boxed', position: 'bottom', fontSize: 30 },
  scenes: [
    scene({ id: 'a', title: '第一幕', speechSpeed: 1.2, sentencePause: 0.2, sceneGap: 0.5 }),
    scene({ id: 'b', title: '第二幕', speechSpeed: 1.2, sentencePause: 0.2, sceneGap: 0.5 }),
    scene({ id: 'c', title: '第三幕', speechSpeed: 1.05, sentencePause: 0.2, sceneGap: 0.5 }),
  ],
});
const fromProject = (patch: Record<string, unknown> = {}) => ProductionTemplateSchema.parse({
  ...templateFromProject({ board, voiceId: 'voice-1' }), id: 'tpl-1', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', ...patch,
});
// Every scene sharing the same timing is the ordinary case; the mixed board above is what
// "取多数" and "影响范围" have to survive.
const uniform = StoryboardSchema.parse({
  ...board,
  scenes: [scene({ id: 'a', speechSpeed: 1.2, sentencePause: 0.2, sceneGap: 0.5 }), scene({ id: 'b', speechSpeed: 1.2, sentencePause: 0.2, sceneGap: 0.5 })],
});
const uniformTemplate = (patch: Record<string, unknown> = {}) => ProductionTemplateSchema.parse({
  ...templateFromProject({ board: uniform, voiceId: 'voice-1' }), id: 'tpl-2', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', ...patch,
});

test('从项目保存方案时取各场景里最常见的设置', () => {
  const saved = templateFromProject({ board, voiceId: 'voice-1' });
  assert.equal(saved.speechSpeed, 1.2, '两个场景用 1.2，取多数而不是第一个或最后一个');
  assert.equal(saved.sentencePause, 0.2);
  assert.equal(saved.sceneGap, 0.5);
  assert.equal(saved.voiceId, 'voice-1');
  assert.equal(saved.name, '口播常用方案');
  assert.equal(saved.aspectRatio, '16:9');
  assert.equal(saved.subtitles.fontSize, 30);
  assert.equal(saved.renderPreset, 'full');
  assert.equal(saved.isDefault, false);
});

test('没有声音或没有场景时给出可用的默认值', () => {
  const empty = StoryboardSchema.parse({ title: '空', styleId: 'minimal-tech', scenes: [scene({ id: 'a' })] });
  const saved = templateFromProject({ board: empty, voiceId: null });
  assert.equal(saved.voiceId, undefined, '没选声音就不写声音');
  assert.equal(saved.speechSpeed, 1);
  assert.equal(saved.sentencePause, 0.12, '与配音接口的默认停顿一致');
  assert.equal(saved.sceneGap, 0);
  const long = StoryboardSchema.parse({ ...empty, title: '标'.repeat(60) });
  assert.equal(templateFromProject({ board: long }).name.length, 40, '名称过长要截断');
});

test('方案→分镜的补丁只碰项目级设置，场景级设置单独给出', () => {
  const template = fromProject({ aspectRatio: '9:16', bgmVolume: 0.4, transition: 'fade', renderPreset: 'draft' });
  const patch = templateBoardPatch(template);
  assert.deepEqual(Object.keys(patch).sort(), ['aspectRatio', 'bgmFadeIn', 'bgmFadeOut', 'bgmVolume', 'intro', 'outro', 'subtitles', 'transition']);
  assert.equal(patch.aspectRatio, '9:16');
  assert.equal(patch.bgmVolume, 0.4);
  assert.equal(patch.transition, 'fade');
  assert.deepEqual(templateScenePatch(template), { speechSpeed: 1.2, sentencePause: 0.2, sceneGap: 0.5 });
});

test('保存下来的方案原样应用时没有一项变化', () => {
  const template = uniformTemplate();
  const impact = templateChanges(uniform, 'voice-1', template, 'full');
  assert.equal(impact.rows.length, 11, '每一项设置都要出现在预览表里');
  assert.equal(impact.changedCount, 0);
  assert.equal(impact.sceneCount, 0);
  assert.ok(impact.rows.every(row => row.current === row.next), '预览表要能读出前后的值');
});

test('预览表列出每一项变化，并区分项目级与场景级', () => {
  const template = uniformTemplate({ aspectRatio: '9:16', bgmVolume: 0.5, renderPreset: 'draft', subtitles: { preset: 'highlight', position: 'top', fontSize: 36 } });
  const impact = templateChanges(uniform, 'voice-1', template, 'full');
  assert.deepEqual(impact.rows.filter(row => row.changed).map(row => row.key), ['aspectRatio', 'subtitles', 'bgmVolume', 'renderPreset']);
  assert.equal(impact.changedCount, 4);
  assert.equal(impact.sceneCount, 0, '场景时长设置没变，就不用重新配音');
  const byKey = new Map(impact.rows.map(row => [row.key, row]));
  assert.equal(byKey.get('aspectRatio')!.scope, 'project');
  assert.equal(byKey.get('speechSpeed')!.scope, 'scene');
  assert.deepEqual([byKey.get('aspectRatio')!.current, byKey.get('aspectRatio')!.next], ['横屏 16:9', '竖屏 9:16']);
  assert.deepEqual([byKey.get('bgmVolume')!.current, byKey.get('bgmVolume')!.next], ['12%', '50%']);
  assert.equal(byKey.get('subtitles')!.next, '高亮 · 顶部 · 字号 36');
});

test('语速不同要数出受影响的场景数，声音变化单独提示', () => {
  const template = fromProject({ speechSpeed: 1.4 });
  const impact = templateChanges(board, 'voice-1', template, 'full');
  assert.equal(impact.sceneCount, 3, '三个场景语速都会被改写');
  const voice = templateChanges(board, null, template, 'full');
  const row = voice.rows.find(item => item.key === 'voiceId')!;
  assert.equal(row.changed, true);
  assert.equal(row.current, '未指定');
  assert.equal(voice.sceneCount, 3);
  // The saved speed is the most common one, so only the odd scene out gets rewritten.
  const saved = templateChanges(board, 'voice-1', fromProject(), 'full');
  assert.equal(saved.sceneCount, 1, '与多数不同的那一个场景才会被改');
  assert.equal(saved.rows.find(item => item.key === 'speechSpeed')!.changed, true);
});

test('导出画质按当前选择比较，而不是固定当正式画质', () => {
  const draft = fromProject({ renderPreset: 'draft' });
  assert.equal(templateChanges(board, 'voice-1', draft, 'full').rows.find(row => row.key === 'renderPreset')!.changed, true);
  assert.equal(templateChanges(board, 'voice-1', draft, 'draft').rows.find(row => row.key === 'renderPreset')!.changed, false);
});

test('列表里的一行摘要说清声音、语速、字幕与画幅', () => {
  const template = fromProject();
  assert.equal(templateSummary(template), '声音 voice-1 · 1.2× · 字幕 描边 · 底部 · 字号 30 · 横屏 16:9 · 正式');
  const silent = fromProject({ voiceId: undefined, renderPreset: 'draft' });
  assert.match(templateSummary(silent), /^声音 未指定 /);
  assert.match(templateSummary(silent), /草稿$/);
});
