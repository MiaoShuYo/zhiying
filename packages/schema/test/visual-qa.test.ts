import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autoFixVisualQuality,
  MotionActionSchema,
  SceneSchema,
  StoryboardSchema,
  VisualPlanSchema,
  VisualQaRenderEvidenceSchema,
  visualQualityAudit,
  type Scene,
  type Storyboard,
} from '../src/index';
import { visualQualitySourceSamples } from '../../video/test/fixtures/v19-visual-quality';

const longTable = () => SceneSchema.parse({
  id: 'qa-long-table', type: 'table', title: visualQualitySourceSamples.longTable.title,
  narration: '先核对每个月的可用率。再标记维护窗口。比较变化并说明数据限制。最后保留原始数字供核对。',
  duration: 10, audioDuration: 10, audioSrc: 'projects/v19/assets/voice.wav',
  wordTimings: [{ text: '先核对每个月的可用率。', start: 0, end: 2 }],
  subtitleCues: [{ text: '先核对每个月的可用率。', start: 0, end: 2 }],
  visual: { headers: visualQualitySourceSamples.longTable.headers, rows: visualQualitySourceSamples.longTable.rows },
});

const boardOf = (scenes: Scene[], patch: Record<string, unknown> = {}) => StoryboardSchema.parse({
  title: 'V1.9.0 Visual QA', aspectRatio: '16:9', styleId: 'minimal-tech', transition: 'none', scenes, ...patch,
});

test('post-render audit identifies readability, collision, contrast, black-frame, transition and subtitle timing issues with locations', () => {
  const scene = longTable();
  const evidence = VisualQaRenderEvidenceSchema.parse({
    layout: [
      { sceneId: scene.id, beatId: 'qa-beat', targetId: 'table-row-1', frame: 30, screenshotPath: 'docs/screenshots/v1.9.0/qa-frame-30.png', elementType: 'text', bounds: { x: .08, y: .12, width: .48, height: .12 }, fontSizePx: 16, contrastRatio: 2.8, overflow: true },
      { sceneId: scene.id, beatId: 'qa-beat', targetId: 'table-row-2', frame: 30, screenshotPath: 'docs/screenshots/v1.9.0/qa-frame-30.png', elementType: 'text', bounds: { x: .12, y: .14, width: .48, height: .12 }, fontSizePx: 16, contrastRatio: 3.1 },
      { sceneId: scene.id, beatId: 'qa-beat', targetId: 'subtitle', frame: 30, screenshotPath: 'docs/screenshots/v1.9.0/qa-frame-30.png', elementType: 'subtitle', bounds: { x: .94, y: .91, width: .08, height: .08 } },
      { sceneId: scene.id, beatId: 'qa-beat', targetId: 'brand-logo', frame: 30, screenshotPath: 'docs/screenshots/v1.9.0/qa-frame-30.png', elementType: 'logo', bounds: { x: .94, y: .91, width: .08, height: .08 } },
    ],
    frames: [{ sceneId: scene.id, beatId: 'qa-beat', frame: 45, screenshotPath: 'docs/screenshots/v1.9.0/qa-frame-45.png', meanLuminance: .002, blankPixelRatio: .995 }],
    subtitleTiming: [{ sceneId: scene.id, beatId: 'qa-beat', frame: 60, screenshotPath: 'docs/screenshots/v1.9.0/qa-frame-60.png', beatStartFrame: 30, beatEndFrame: 75, subtitleStartFrame: 45, subtitleEndFrame: 100 }],
    transitions: [{ fromSceneId: 'previous-scene', toSceneId: scene.id, frame: 90, screenshotPath: 'docs/screenshots/v1.9.0/qa-transition-90.png', unmatchedPixelRatio: .88, blackFrame: true, sharedElementDetected: false }],
  });
  const report = visualQualityAudit(boardOf([scene]), { fps: 30, renderEvidence: evidence, renderOverflowSceneIds: [scene.id] });
  const codes = new Set(report.findings.map(finding => finding.code));
  for (const code of ['density-over-budget', 'render-overflow', 'font-too-small', 'low-contrast', 'caption-safe-area', 'logo-safe-area', 'logo-collision', 'text-collision', 'black-frame', 'empty-frame', 'sudden-change', 'subtitle-beat-timeout'] as const) {
    assert.ok(codes.has(code), `expected rule ${code}`);
  }
  const sizeFinding = report.findings.find(finding => finding.code === 'font-too-small')!;
  assert.deepEqual(sizeFinding.location, {
    sceneId: scene.id, beatId: 'qa-beat', targetId: 'table-row-1', frame: 30,
    screenshotPath: 'docs/screenshots/v1.9.0/qa-frame-30.png',
  });
  const timeout = report.findings.find(finding => finding.code === 'subtitle-beat-timeout')!;
  assert.deepEqual(timeout.location, {
    sceneId: scene.id, beatId: 'qa-beat', frame: 60,
    screenshotPath: 'docs/screenshots/v1.9.0/qa-frame-60.png',
  });
  assert.equal(report.phase, 'post-render');
  assert.equal(report.evidenceFrames, 2, 'frame and transition evidence are counted');
});

test('subtitle and logo exactly on the 5% safe-area boundary are not flagged by floating-point noise', () => {
  const scene = SceneSchema.parse({ id: 'qa-safe-boundary', type: 'title', title: '边界', narration: '边界测试', visual: {} });
  const report = visualQualityAudit(boardOf([scene]), {
    fps: 30,
    renderEvidence: VisualQaRenderEvidenceSchema.parse({
      layout: [
        { sceneId: scene.id, targetId: 'subtitle', frame: 0, elementType: 'subtitle', bounds: { x: .05, y: .9177083333333333, width: .9, height: .03229166666666667 } },
        { sceneId: scene.id, targetId: 'brand-logo', frame: 0, elementType: 'logo', bounds: { x: .05, y: .05, width: .9, height: .9 } },
      ],
    }),
  });
  assert.equal(report.findings.some(finding => finding.code === 'caption-safe-area' || finding.code === 'logo-safe-area'), false);
});

test('density auto-fix re-audits, preserves source narration/visual/audio/timings, and is capped at two rounds', () => {
  const scene = longTable();
  const board = boardOf([scene]);
  const result = autoFixVisualQuality(board, { maxRounds: 99, fps: 30 });
  assert.ok(result.report.autoFixRounds >= 1 && result.report.autoFixRounds <= 2);
  assert.equal(result.storyboard.scenes[0]!.narration, scene.narration);
  assert.deepEqual(result.storyboard.scenes[0]!.visual, scene.visual);
  assert.equal(result.storyboard.scenes[0]!.audioSrc, scene.audioSrc);
  assert.equal(result.storyboard.scenes[0]!.audioDuration, scene.audioDuration);
  assert.deepEqual(result.storyboard.scenes[0]!.wordTimings, scene.wordTimings);
  assert.deepEqual(result.storyboard.scenes[0]!.subtitleCues, scene.subtitleCues);
  assert.equal(visualQualityAudit(result.storyboard).findings.some(finding => finding.code === 'density-over-budget'), false);
  assert.ok((result.storyboard.scenes[0]!.visualBeats?.length ?? 0) > 1);
});

test('auto-fix leaves manually locked content unchanged and reports it as non-fixable', () => {
  const lockedScene = SceneSchema.parse({
    id: 'qa-user-locked', type: 'chart', title: '十二个月的高密度数据',
    narration: '逐月查看十二组数据。', visual: { data: Array.from({ length: 12 }, (_, index) => ({ label: `${index + 1} 月`, value: index + 1 })) },
    visualPlan: VisualPlanSchema.parse({ templateId: 'chart', manualOverride: true, provenance: 'user', keyFocus: '用户锁定的焦点' }),
  });
  const board = boardOf([lockedScene]);
  const result = autoFixVisualQuality(board, { maxRounds: 2 });
  const finding = result.report.findings.find(item => item.code === 'density-over-budget');
  assert.ok(finding);
  assert.equal(finding.fixable, false);
  assert.equal(result.report.autoFixRounds, 0);
  assert.deepEqual(result.storyboard.scenes[0], lockedScene);
});

test('auto-fix refuses to shrink a 9.92px rendered label and keeps its located overflow unresolved', () => {
  const scene = SceneSchema.parse({
    id: 'qa-unreadable-overflow', type: 'chart', title: '请求量', narration: '十二个月的请求量需要完整阅读。', duration: 6,
    visual: { data: Array.from({ length: 12 }, (_, index) => ({ label: `${index + 1}月`, value: index + 1 })) },
  });
  const board = boardOf([scene], { aspectRatio: '9:16' });
  const evidence = VisualQaRenderEvidenceSchema.parse({ layout: [{
    sceneId: scene.id, beatId: 'qa-beat', targetId: 'chart-label-1', frame: 30,
    screenshotPath: 'docs/screenshots/v1.9.0/qa-9.92px-overflow.png', elementType: 'text',
    bounds: { x: -.01, y: .3, width: .82, height: .04 }, fontSizePx: 9.92, overflow: true,
  }] });
  const result = autoFixVisualQuality(board, { maxRounds: 2, fps: 30, renderEvidence: evidence });
  const finding = result.report.findings.find(item => item.sceneId === scene.id && item.code === 'render-overflow');
  assert.ok(finding);
  assert.equal(result.storyboard.scenes[0]!.visualFitScale ?? 1, scene.visualFitScale ?? 1, 'the unreadable layout is not scaled down further');
  assert.equal(evidence.layout[0]!.fontSizePx, 9.92, 'the original browser-measured font size is retained as evidence');
  assert.ok(result.report.autoFixRounds <= 2, 'the normal repair round limit still applies');
  assert.equal(finding.fixable, false, 'unresolved overflow is not presented as repaired');
  assert.match(finding.message, /拆分场景或手工调整布局/);
  assert.deepEqual(finding.location, {
    sceneId: scene.id, beatId: 'qa-beat', targetId: 'chart-label-1', frame: 30,
    screenshotPath: 'docs/screenshots/v1.9.0/qa-9.92px-overflow.png',
  });
});

test('two failed visual repair rounds end in a located static fallback without changing facts or locked scenes', () => {
  const beat = { id: 'metric-beat', narrationText: '请求量为十。', targetIds: ['chart-bar-1'] };
  const repairable = SceneSchema.parse({
    id: 'qa-static-fallback', type: 'chart', title: '请求量', narration: '请求量为十。', duration: 4,
    audioSrc: 'audio/voice.wav', audioDuration: 4,
    wordTimings: [{ text: '请求量为十。', start: 0, end: 3 }],
    subtitleCues: [{ text: '请求量为十。', start: 0, end: 3 }],
    visual: { data: [{ id: 'metric', label: '请求量', value: 10 }] }, visualBeats: [beat],
    visualPlan: VisualPlanSchema.parse({
      templateId: 'chart', beats: [beat],
      motionPresets: [{ targetId: 'chart-bar-1', beatRef: beat.id, durationPolicy: 'fixed', durationFrames: 30, action: 'bar-grow' }],
    }),
  });
  const locked = SceneSchema.parse({
    ...repairable,
    id: 'qa-static-fallback-locked',
    visualPlan: VisualPlanSchema.parse({ ...repairable.visualPlan!, manualOverride: true, provenance: 'user' }),
  });
  const result = autoFixVisualQuality(boardOf([repairable, locked]), {
    maxRounds: 99,
    renderOverflowSceneIds: [repairable.id, locked.id],
  });

  assert.equal(result.report.autoFixRounds, 2, 'input rounds are clamped and both bounded repairs are attempted');
  const fallbackScene = result.storyboard.scenes.find(scene => scene.id === repairable.id)!;
  assert.equal(fallbackScene.visualStaticFallback, true);
  assert.ok(fallbackScene.visualStaticFallbackReason?.length);
  assert.deepEqual(
    result.report.staticFallbacks,
    [{ sceneId: repairable.id, reason: fallbackScene.visualStaticFallbackReason }],
    'report identifies the exact scene and user-facing fallback reason',
  );
  assert.equal(result.report.staticFallbacks.length, 1, 'the locked scene is excluded from automatic fallback');
  assert.ok(result.report.findings.some(item => item.sceneId === repairable.id && item.code === 'render-overflow'), 'unresolved render evidence remains visible for review');
  assert.deepEqual(result.storyboard.scenes.find(scene => scene.id === locked.id), locked, 'manual override remains byte-for-byte unchanged');
  assert.equal(fallbackScene.narration, repairable.narration);
  assert.deepEqual(fallbackScene.visual, repairable.visual);
  assert.equal(fallbackScene.audioSrc, repairable.audioSrc);
  assert.equal(fallbackScene.audioDuration, repairable.audioDuration);
  assert.deepEqual(fallbackScene.wordTimings, repairable.wordTimings);
  assert.deepEqual(fallbackScene.subtitleCues, repairable.subtitleCues);
});

test('unmapped motion target is located at its semantic beat frame', () => {
  const scene = SceneSchema.parse({
    id: 'qa-bad-motion', type: 'title', title: '操作状态', narration: '读取并返回结果。', duration: 4,
    visual: {}, visualBeats: [{ id: 'read', narrationText: '读取', targetIds: ['source'] }],
    visualPlan: VisualPlanSchema.parse({ templateId: 'hero', beats: [{ id: 'read', narrationText: '读取', targetIds: ['source'] }] }),
  });
  const invalidAction = MotionActionSchema.parse({ targetId: 'missing-target', beatRef: 'read', durationPolicy: 'beat', action: 'reveal' });
  const unsafeScene = { ...scene, visualPlan: { ...scene.visualPlan!, motionPresets: [invalidAction] } } as Scene;
  const unsafeBoard = { ...boardOf([scene]), scenes: [unsafeScene] } as Storyboard;
  const report = visualQualityAudit(unsafeBoard, { fps: 30 });
  const finding = report.findings.find(item => item.code === 'unmapped-motion-target');
  assert.ok(finding);
  assert.deepEqual(finding.location, { sceneId: scene.id, beatId: 'read', targetId: 'missing-target', frame: 0 });
});
