import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StoryboardSchema,
  applyDensitySettings,
  defaultVisualDensitySettings,
  selectRuleVisualPlans,
} from '@m2v/schema';
import {
  buildModelStoryboardScene,
  buildStoryboardSceneOrFallback,
  splitIntoChapters,
} from '../src/lib/pipeline';

const markdown = `# 标题镜头\n接口延迟降低到 20 ms。\n\n# 左右对比\n同步流程等待结果，异步流程立即返回。\n\n# 数据图表\n第一季度请求量为 12，第二季度为 18。\n\n# 处理流程\n请求经过校验后返回结果。\n\n# 时间线\n时间线上，2025 年启动，2026 年完成。`;

const generated = [
  { type: 'title', narration: '接口延迟降低到 20 ms。', visual: { text: '延迟：20 ms' } },
  { type: 'comparison', narration: '同步流程等待结果，异步流程立即返回。', visual: { columns: [{ title: '同步', items: ['等待结果'] }, { title: '异步', items: ['立即返回'] }] } },
  { type: 'chart', narration: '第一季度请求量为 12，第二季度为 18。', visual: { data: [{ label: '第一季度', value: 12 }, { label: '第二季度', value: 18 }] } },
  { type: 'diagram', narration: '请求经过校验后返回结果。', visual: { nodes: [{ id: 'request', label: '请求' }, { id: 'validate', label: '校验' }, { id: 'response', label: '返回' }] } },
  { type: 'timeline', narration: '时间线上，2025 年启动，2026 年完成。', visual: { items: [{ date: '2025', label: '启动' }, { date: '2026', label: '完成' }] } },
];

test('fixed Markdown generates five editable rule VisualPlans without rewriting source facts', () => {
  const chapters = splitIntoChapters('V1.9.0 固定样例', markdown);
  assert.equal(chapters.length, generated.length, JSON.stringify(chapters));
  const scenes = chapters.map((chapter, index) => {
    const result = buildModelStoryboardScene(chapter!, generated[index]);
    assert.equal(result.success, true, chapter!.title);
    assert.equal(result.data.narration, generated[index]!.narration);
    return result.data;
  });
  const sourceBoard = StoryboardSchema.parse({ title: '固定 Markdown', styleId: 'minimal-tech', transition: 'none', scenes });
  const selected = selectRuleVisualPlans(sourceBoard);
  const stable = selectRuleVisualPlans(sourceBoard);
  assert.deepEqual(selected.scenes.map(scene => scene.visualPlan?.templateId), ['hero', 'comparison', 'chart', 'diagram', 'timeline']);
  assert.deepEqual(selected.scenes.map(scene => scene.visualPlan?.selectionReason), ['title-or-text', 'two-column-comparison', 'numeric-data', 'ordered-flow', 'chronological-events']);
  assert.deepEqual(selected.scenes, stable.scenes, 'template and beat selection are deterministic');
  for (const [index, scene] of selected.scenes.entries()) {
    assert.equal(scene.visualPlan?.provenance, 'rule');
    assert.equal(scene.narration, generated[index]!.narration);
    assert.deepEqual(scene.visual, scenes[index]!.visual, `${scene.title} retains editable source values`);
  }
  const withDensity = applyDensitySettings(selected, defaultVisualDensitySettings);
  assert.deepEqual(withDensity.scenes.map(scene => scene.narration), scenes.map(scene => scene.narration));
  assert.deepEqual(withDensity.scenes.map(scene => scene.visual), scenes.map(scene => scene.visual));
});

test('invalid or unavailable model output degrades to a local readable scene and safe rule plan', () => {
  const chapter = splitIntoChapters('离线样例', '# 离线样例\n保留本地事实和值 42。')[0]!;
  const fallback = buildStoryboardSceneOrFallback(chapter, undefined);
  assert.equal(fallback.fallbackUsed, true);
  assert.ok(fallback.scene.narration.includes('42'));
  assert.equal(fallback.scene.type, 'bullets', 'unsupported model output uses the local structured static fallback');
  const board = selectRuleVisualPlans(StoryboardSchema.parse({ title: '离线样例', styleId: 'minimal-tech', transition: 'none', scenes: [fallback.scene] }));
  assert.equal(board.scenes[0]!.visualPlan, undefined, 'unmapped fallback content stays readable without an invented template');
});
