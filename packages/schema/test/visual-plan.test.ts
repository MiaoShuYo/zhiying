import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SceneSchema,
  MotionActionSchema,
  VisualPlanSchema,
  VisualTemplateIdSchema,
  visualTemplateSupportsScene,
} from '../src/index';

const plan = (templateId: string) => ({
  templateId,
  narrativeIntent: 'explanation',
  keyFocus: '阶段顺序',
  beats: [{ id: 'beat-1', narrationText: '读取数据', targetIds: ['stage-1'] }],
  elementMap: { sourceStep: 'stage-1' },
});

test('V1.9.0 accepts only the five standard visual template IDs', () => {
  const ids = ['hero', 'comparison', 'diagram', 'timeline', 'chart'];
  for (const id of ids) assert.equal(VisualTemplateIdSchema.safeParse(id).success, true, id);
  for (const id of ['spatial', 'custom-css', '', null]) assert.equal(VisualTemplateIdSchema.safeParse(id).success, false, String(id));
});

test('VisualPlan defaults versioned semantic metadata and rejects malformed beats', () => {
  const parsed = VisualPlanSchema.parse({ templateId: 'diagram' });
  assert.equal(parsed.version, 1);
  assert.equal(parsed.registryVersion, '1');
  assert.equal(parsed.provenance, 'rule');
  assert.deepEqual(parsed.beats, []);
  assert.equal(VisualPlanSchema.safeParse({ ...plan('diagram'), version: 2 }).success, false);
  assert.equal(VisualPlanSchema.safeParse({ ...plan('diagram'), beats: [{ id: '', narrationText: '' }] }).success, false);
  assert.equal(VisualPlanSchema.safeParse({ ...plan('diagram'), templateId: 'run-script' }).success, false);
});

test('template compatibility maps standard Scene kinds and preserves legacy scenes', () => {
  const sceneTypes = { hero: 'title', comparison: 'comparison', diagram: 'diagram', timeline: 'timeline', chart: 'chart' } as const;
  const visuals = {
    hero: {},
    comparison: { columns: [{ title: 'A', items: ['a'] }, { title: 'B', items: ['b'] }] },
    diagram: { nodes: ['A', 'B'] },
    timeline: { items: [{ date: '1', label: 'A' }, { date: '2', label: 'B' }] },
    chart: { data: [{ label: 'A', value: 1 }] },
  };
  for (const [templateId, sceneType] of Object.entries(sceneTypes)) {
    assert.equal(visualTemplateSupportsScene(templateId as keyof typeof sceneTypes, sceneType), true);
    const parsed = SceneSchema.safeParse({ id: `scene-${templateId}`, type: sceneType, narration: '测试旁白', visual: visuals[templateId as keyof typeof visuals], visualPlan: plan(templateId) });
    assert.equal(parsed.success, true, `${templateId} should support ${sceneType}`);
  }
  assert.equal(SceneSchema.safeParse({ id: 'legacy', type: 'title', narration: '旧项目', visual: {} }).success, true);
  assert.equal(SceneSchema.safeParse({ id: 'mismatch', type: 'chart', narration: '不匹配', visual: {}, visualPlan: plan('hero') }).success, false);
});

test('VisualPlan cannot carry executable instructions into parsed storyboard data', () => {
  const parsed = VisualPlanSchema.parse({ ...plan('hero'), css: 'position:fixed', script: 'alert(1)', assetUrl: 'https://example.invalid/a.png' });
  assert.equal('css' in parsed, false);
  assert.equal('script' in parsed, false);
  assert.equal('assetUrl' in parsed, false);
});

test('V1.9.0 motion actions whitelist eleven primitive types and strict parameters', () => {
  const actions = ['reveal', 'stagger', 'focus-dim', 'highlight', 'number-count', 'bar-grow', 'line-draw', 'arrow-flow', 'group-expand', 'morph-lite', 'annotation'];
  for (const action of actions) {
    const parsed = MotionActionSchema.safeParse({ targetId: 'target-1', beatRef: 'beat-1', durationPolicy: 'beat', action });
    assert.equal(parsed.success, true, action);
  }
  assert.equal(MotionActionSchema.safeParse({ targetId: '', beatRef: 'beat-1', durationPolicy: 'beat', action: 'reveal' }).success, false);
  assert.equal(MotionActionSchema.safeParse({ targetId: 'target-1', beatRef: 'missing', durationPolicy: 'fixed', action: 'highlight' }).success, false);
  assert.equal(MotionActionSchema.safeParse({ targetId: 'target-1', beatRef: 'beat-1', durationPolicy: 'fixed', durationFrames: 30, action: 'highlight' }).success, true);
  assert.equal(MotionActionSchema.safeParse({ targetId: 'target-1', beatRef: 'beat-1', durationPolicy: 'beat', durationFrames: 30, action: 'highlight' }).success, false);
  assert.equal(MotionActionSchema.safeParse({ targetId: 'target-1', beatRef: 'beat-1', durationPolicy: 'beat', action: 'reveal', parameters: { css: 'position:fixed' } }).success, false);
});
