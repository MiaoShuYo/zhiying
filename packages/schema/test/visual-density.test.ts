import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SceneSchema,
  StoryboardSchema,
  VisualDensitySettingsSchema,
  applyVisualDensity,
  applyDensitySettings,
  defaultVisualDensitySettings,
  estimateVisualDensity,
  resolveVisualBeatTimeline,
  VisualPlanSchema,
  type Scene,
} from '../src/index';
import { visualQualitySourceSamples } from '../../video/test/fixtures/v19-visual-quality';

const longTableScene = (narration = [
  '第一阶段读取十二个月的服务可用率。',
  '第二阶段标记每月维护窗口与对应时段。',
  '第三阶段比较可用率变化并说明数据限制。',
  '最后保留原始数字供人工核对。',
].join('')): Scene => SceneSchema.parse({
  id: 'v190-density-table',
  type: 'table',
  title: visualQualitySourceSamples.longTable.title,
  narration,
  visual: { headers: visualQualitySourceSamples.longTable.headers, rows: visualQualitySourceSamples.longTable.rows },
});

const longTextScene = (): Scene => {
  const paragraphs = Array.from({ length: 8 }, () => visualQualitySourceSamples.longText.facts.join(''));
  return SceneSchema.parse({
    id: 'v190-density-text', type: 'text', title: visualQualitySourceSamples.longText.title,
    narration: paragraphs.join('\n'),
    visual: { text: paragraphs.join('\n\n') },
  });
};

test('density estimator flags long text and 12-row tables on both canvas sizes', () => {
  const longText = longTextScene();
  const table = longTableScene();
  for (const scene of [longText, table]) {
    for (const aspect of ['16:9', '9:16'] as const) {
      const estimate = estimateVisualDensity(scene, aspect);
      assert.ok(estimate.usedHeight > 0);
      assert.ok(estimate.availableHeight > 0);
      assert.ok(estimate.ratio > 0);
      assert.equal(estimate.overBudget, true, `${scene.id} ${aspect}`);
      assert.ok(estimate.warnings.length > 0);
    }
  }
});

test('auto split preserves source facts, complete narration order and table rows', () => {
  const scene = longTableScene();
  const result = applyVisualDensity(scene, '16:9', defaultVisualDensitySettings);
  assert.equal(result.narration, scene.narration);
  assert.deepEqual(result.visual, scene.visual);
  assert.equal(result.visualBeatsProvenance, 'rule');
  assert.ok((result.visualBeats?.length ?? 0) >= 2);
  assert.equal(result.visualBeats?.map(beat => beat.narrationText).join(''), scene.narration);
  assert.equal((result.visual.rows as unknown[][]).length, 12);
  assert.equal(result.visualPlan?.templateId, undefined, '保真表格不被强制替换成别的镜头模板');
});

test('long paragraph beats reproduce every source character without rewriting facts', () => {
  const scene = longTextScene();
  const result = applyVisualDensity(scene, '9:16', defaultVisualDensitySettings);
  const withoutLineBreaks = (text: string) => text.replace(/\r?\n/g, '');
  assert.equal(withoutLineBreaks(result.visualBeats!.map(beat => beat.narrationText).join('')), withoutLineBreaks(scene.narration));
  for (const fact of visualQualitySourceSamples.longText.facts) assert.ok(result.narration.includes(fact));
  assert.deepEqual(result.visual, scene.visual);
  assert.equal(result.visualBeats!.map(beat => beat.contentText ?? '').join(''), scene.visual.text, 'visual beat content reconstructs every source fact without rewriting');
});

test('nested five-by-four lists and a twelve-node flow retain every source target when split', () => {
  const bullets = SceneSchema.parse({
    id: 'v190-density-nested-list', type: 'bullets', title: visualQualitySourceSamples.nestedBullets.title,
    narration: visualQualitySourceSamples.nestedBullets.items.map(item => item.text).join(''),
    visual: { items: visualQualitySourceSamples.nestedBullets.items },
  });
  const flow = SceneSchema.parse({
    id: 'v190-density-flow', type: 'diagram', title: visualQualitySourceSamples.flow.title,
    narration: visualQualitySourceSamples.flow.nodes.map(node => node.label).join(''),
    visual: { nodes: visualQualitySourceSamples.flow.nodes },
  });

  for (const aspect of ['16:9', '9:16'] as const) {
    assert.equal(estimateVisualDensity(bullets, aspect).overBudget, true, `nested list ${aspect}`);
    assert.equal(estimateVisualDensity(flow, aspect).overBudget, true, `flow ${aspect}`);
  }

  const splitBullets = applyVisualDensity(bullets, '9:16', defaultVisualDensitySettings);
  assert.deepEqual(splitBullets.visual, bullets.visual, 'all twenty child details remain available');
  assert.equal(splitBullets.narration, bullets.narration);
  assert.deepEqual(
    [...new Set(splitBullets.visualBeats!.flatMap(beat => beat.targetIds).filter(targetId => targetId.startsWith('bullet-')))].sort(),
    Array.from({ length: 5 }, (_, index) => `bullet-${index + 1}`),
  );

  const splitFlow = applyVisualDensity(flow, '16:9', { autoSplit: true, strategy: 'concise' });
  assert.deepEqual(splitFlow.visual, flow.visual);
  assert.equal(splitFlow.narration, flow.narration);
  assert.deepEqual(
    splitFlow.visualBeats!.flatMap(beat => beat.targetIds).filter(targetId => targetId.startsWith('flow-step-')),
    visualQualitySourceSamples.flow.nodes.map(node => node.id),
  );
  assert.equal(splitFlow.visualBeats!.map(beat => beat.narrationText).join(''), flow.narration);
});

test('density beats retain TTS mapping after regeneration without duplicating narration or audio', () => {
  const narrationParts = [
    '第一阶段读取十二个月的服务可用率。',
    '第二阶段标记每月维护窗口与对应时段。',
    '第三阶段比较可用率变化并说明数据限制。',
    '最后保留原始数字供人工核对。',
  ];
  const original = SceneSchema.parse({
    ...longTableScene(narrationParts.join('')),
    audioSrc: 'projects/v190/assets/sample-tts.wav',
    audioDuration: 10,
    wordTimings: narrationParts.map((text, index) => ({ text, start: index * 2, end: index * 2 + 1 })),
  });
  const split = applyVisualDensity(original, '16:9', defaultVisualDensitySettings);
  const initialFrames = resolveVisualBeatTimeline(split, 30);
  const regenerated = SceneSchema.parse({
    ...split,
    wordTimings: split.wordTimings!.map(item => ({ ...item, start: item.start + .5, end: item.end + .5 })),
  });
  const regeneratedFrames = resolveVisualBeatTimeline(regenerated, 30);

  assert.equal(split.narration, original.narration);
  assert.equal(split.audioSrc, original.audioSrc);
  assert.deepEqual(split.visualBeats!.filter(beat => beat.narrationText).map(beat => beat.narrationText), narrationParts);
  assert.deepEqual(regenerated.visualBeats, split.visualBeats);
  assert.deepEqual(regeneratedFrames.slice(0, narrationParts.length).map(beat => beat.startFrame),
    initialFrames.slice(0, narrationParts.length).map(beat => beat.startFrame + 15));
});

test('concise, balanced and complete strategies group semantic targets without changing narration', () => {
  const scene = longTableScene();
  const perBeatCounts = (strategy: 'concise' | 'balanced' | 'complete') => {
    const result = applyVisualDensity(scene, '16:9', { autoSplit: true, strategy });
    assert.equal(result.narration, scene.narration);
    assert.equal(result.visualBeats!.filter(beat => beat.narrationText.length > 0).length, 4);
    return result.visualBeats!.map(beat => beat.targetIds.length);
  };
  assert.deepEqual(perBeatCounts('concise'), Array(13).fill(1));
  assert.deepEqual(perBeatCounts('balanced'), [2, 2, 2, 2, 2, 2, 1]);
  assert.deepEqual(perBeatCounts('complete'), [3, 3, 3, 3, 1]);
});

test('disabled auto split and manually locked scenes do not get rewritten', () => {
  const scene = longTableScene();
  assert.equal(applyVisualDensity(scene, '16:9', { autoSplit: false, strategy: 'balanced' }), scene);
  const text = longTextScene();
  const locked: Scene = {
    ...text,
    visualPlan: VisualPlanSchema.parse({ templateId: 'hero', manualOverride: true }),
    visualBeats: [{ id: 'user-beat', narrationText: '用户手工划分的旁白。', targetIds: ['user-target'] }],
    visualBeatsProvenance: 'user',
  };
  assert.equal(applyVisualDensity(locked, '16:9', { autoSplit: true, strategy: 'concise' }), locked);
});

test('rule-generated beats can be removed when auto split is disabled', () => {
  const scene = longTableScene();
  const generated = applyVisualDensity(scene, '16:9', defaultVisualDensitySettings);
  const restored = applyVisualDensity(generated, '16:9', { autoSplit: false, strategy: 'balanced' });
  assert.equal(restored.visualBeats, undefined);
  assert.equal(restored.visualBeatsProvenance, undefined);
  assert.equal(restored.visualPlan, undefined);
  assert.equal(restored.narration, scene.narration);
});

test('project density settings are schema-validated and produce deterministic scene snapshots', () => {
  assert.equal(VisualDensitySettingsSchema.safeParse(defaultVisualDensitySettings).success, true);
  assert.equal(VisualDensitySettingsSchema.safeParse({ autoSplit: true, strategy: 'summary' }).success, false);
  const board = StoryboardSchema.parse({
    title: 'V1.9.0 密度样例', styleId: 'minimal-tech', aspectRatio: '16:9',
    scenes: [longTableScene()],
  });
  const once = applyDensitySettings(board, defaultVisualDensitySettings);
  const twice = applyDensitySettings(board, defaultVisualDensitySettings);
  assert.deepEqual(once.visualDensity, defaultVisualDensitySettings);
  assert.ok(once.scenes[0]!.visualBeats!.length > 0);
  assert.deepEqual(once.scenes, twice.scenes);
});
