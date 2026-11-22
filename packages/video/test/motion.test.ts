import test from 'node:test';
import assert from 'node:assert/strict';
import { MotionActionSchema, SceneSchema, VisualPlanSchema } from '@m2v/schema';
import { animatedNumberValue, motionStyleForTarget } from '../src/motion';

const beats = [
  { id: 'beat-1', narrationText: '第一季度', targetIds: ['chart-1', 'chart-value-1'] },
  { id: 'beat-2', narrationText: '第二季度', targetIds: ['chart-2', 'chart-value-2'] },
];

function chartScene(action?: unknown) {
  return SceneSchema.parse({
    id: 'v190-motion-chart', type: 'chart', title: '季度活跃用户', narration: '第一季度为 120 万，第二季度为 150 万。',
    duration: 4, audioDuration: 4,
    visual: { data: [{ label: '第一季度', value: 120 }, { label: '第二季度', value: 150 }] },
    visualBeats: beats,
    visualPlan: VisualPlanSchema.parse({ templateId: 'chart', beats, motionPresets: action ? [action] : [] }),
  });
}

test('motion style is a deterministic frame-only mapping for whitelisted actions', () => {
  const actions = ['reveal', 'stagger', 'focus-dim', 'highlight', 'number-count', 'bar-grow', 'line-draw', 'arrow-flow', 'group-expand', 'morph-lite', 'annotation'];
  for (const action of actions) {
    const preset = MotionActionSchema.parse({ targetId: 'chart-1', beatRef: 'beat-1', durationPolicy: 'beat', action });
    const scene = chartScene(preset);
    const first = motionStyleForTarget({ targetId: 'chart-1', scene, frame: 12, fps: 30 });
    const second = motionStyleForTarget({ targetId: 'chart-1', scene, frame: 12, fps: 30 });
    assert.deepEqual(first, second, action);
    assert.ok(typeof first === 'object', action);
  }
});

test('reveal progresses smoothly and reduced motion returns a stable static style', () => {
  const scene = chartScene({ targetId: 'chart-1', beatRef: 'beat-1', durationPolicy: 'fixed', durationFrames: 30, action: 'reveal', parameters: { direction: 'up' } });
  const start = motionStyleForTarget({ targetId: 'chart-1', scene, frame: 0, fps: 30 });
  const middle = motionStyleForTarget({ targetId: 'chart-1', scene, frame: 15, fps: 30 });
  const end = motionStyleForTarget({ targetId: 'chart-1', scene, frame: 30, fps: 30 });
  assert.equal(start.opacity, 0);
  assert.ok(Number(middle.opacity) > 0 && Number(middle.opacity) < 1);
  assert.equal(end.opacity, 1);
  assert.deepEqual(motionStyleForTarget({ targetId: 'chart-1', scene, frame: 15, fps: 30, reducedMotion: true }), {});
});

test('target focus follows the narrated beat and dims inactive objects', () => {
  const scene = chartScene();
  assert.deepEqual(motionStyleForTarget({ targetId: 'chart-2', scene, frame: 0, fps: 30 }), { opacity: .12 });
  assert.deepEqual(motionStyleForTarget({ targetId: 'chart-2', scene, frame: 60, fps: 30 }), { opacity: 1 });
  assert.deepEqual(motionStyleForTarget({ targetId: 'chart-1', scene, frame: 90, fps: 30 }), { opacity: .52 });
});

test('focus-dim eases from its dim start through the beat midpoint to full focus', () => {
  const scene = chartScene({
    targetId: 'chart-2', beatRef: 'beat-2', durationPolicy: 'beat', action: 'focus-dim',
    easingPreset: 'ease-in-out', reducedMotionFallback: 'static', parameters: {},
  });
  const start = motionStyleForTarget({ targetId: 'chart-2', scene, frame: 60, fps: 30 });
  const middle = motionStyleForTarget({ targetId: 'chart-2', scene, frame: 90, fps: 30 });
  const end = motionStyleForTarget({ targetId: 'chart-2', scene, frame: 119, fps: 30 });
  const reduced = motionStyleForTarget({ targetId: 'chart-2', scene, frame: 90, fps: 30, reducedMotion: true });
  assert.equal(start.opacity, .12);
  assert.equal(middle.opacity, .56);
  assert.ok(Number(end.opacity) > .99 && Number(end.opacity) <= 1);
  assert.deepEqual(reduced, {});
});

test('number-count displays the final value with reduced motion and animates the numeric range', () => {
  const scene = chartScene({ targetId: 'chart-value-1', beatRef: 'beat-1', durationPolicy: 'beat', action: 'number-count', parameters: { decimals: 1 } });
  assert.equal(animatedNumberValue({ targetId: 'chart-value-1', value: 120, scene, frame: 0, fps: 30 }), '0.0');
  assert.equal(animatedNumberValue({ targetId: 'chart-value-1', value: 120, scene, frame: 30, fps: 30 }), '90.0');
  assert.equal(animatedNumberValue({ targetId: 'chart-value-1', value: 120, scene, frame: 60, fps: 30 }), '120.0');
  assert.equal(animatedNumberValue({ targetId: 'chart-value-1', value: 120, scene, frame: 0, fps: 30, reducedMotion: true }), '120');
});
