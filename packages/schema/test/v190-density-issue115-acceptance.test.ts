import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SceneSchema,
  StoryboardSchema,
  applyDensitySettings,
  applyVisualDensity,
  defaultVisualDensitySettings,
  estimateVisualDensity,
  getVisualBeatTimingDiagnostic,
  resolveVisualBeatTimeline,
} from '../src/index';

const nestedListItems = Array.from({ length: 5 }, (_, group) => ({
  id: `group-${group + 1}`,
  text: `第 ${group + 1} 组处理策略`,
  children: Array.from({ length: 4 }, (_, child) => `策略事实 ${group + 1}-${child + 1}：最多等待 ${group + child + 1} 秒。`),
}));
const nestedList = SceneSchema.parse({
  id: 'issue115-nested-list',
  type: 'bullets',
  title: '缓存一致性的五类处理',
  narration: nestedListItems.map(item => `${item.text}。`).join(''),
  duration: 3,
  visual: { items: nestedListItems },
});

const flowNodes = Array.from({ length: 12 }, (_, index) => ({
  id: `step-${index + 1}`,
  label: `步骤 ${index + 1}：处理队列中的第 ${index + 1} 阶段数据`,
}));
const twelveStepFlow = SceneSchema.parse({
  id: 'issue115-twelve-step-flow',
  type: 'diagram',
  title: '请求处理全流程',
  narration: flowNodes.map(node => `${node.label}。`).join(''),
  duration: 4,
  visual: { nodes: flowNodes },
});

const tableRows = Array.from({ length: 12 }, (_, index) => [
  `月份 ${index + 1}`,
  `${99.1 + index / 10}%`,
  `维护窗口 ${index + 1}`,
]);
const narratedParts = [
  '第一阶段读取十二个月的服务可用率。',
  '第二阶段记录每月维护窗口和对应时段。',
  '第三阶段比较可用率变化，并说明数据限制。',
  '最后保留全部原始数字供人工核对。',
];
const timedTable = SceneSchema.parse({
  id: 'issue115-twelve-row-table',
  type: 'table',
  title: '服务可用率与维护窗口',
  narration: narratedParts.join(''),
  duration: 16,
  audioDuration: 16,
  audioSrc: 'projects/issue115/assets/narration.wav',
  wordTimings: narratedParts.map((text, index) => ({ text, start: index * 4, end: (index + 1) * 4 })),
  subtitleCues: narratedParts.map((text, index) => ({ text, start: index * 4, end: (index + 1) * 4 })),
  visual: { headers: ['月份', '可用率', '维护窗口'], rows: tableRows },
});

const preserveScenes = [
  SceneSchema.parse({ id: 'html-preserve', type: 'html', title: 'HTML 原页', narration: '保留原始 HTML。', visual: { html: '<main><h1>原始版式</h1></main>' } }),
  SceneSchema.parse({ id: 'code-preserve', type: 'code', title: 'Code 原文', narration: '保留原始代码。', visual: { code: 'const important = 42;', language: 'typescript' } }),
  SceneSchema.parse({ id: 'ppt-preserve', type: 'media', title: 'PPT 原页', narration: '保留原始幻灯片。', visual: { src: 'projects/issue115/assets/slide-1.png', sourceType: 'pptx', fullBleed: true } }),
];

test('fixed nested-list and 12-node flow fixtures split at both aspect ratios without dropping source facts', () => {
  for (const aspectRatio of ['16:9', '9:16'] as const) {
    for (const source of [nestedList, twelveStepFlow]) {
      const estimate = estimateVisualDensity(source, aspectRatio);
      assert.equal(estimate.overBudget, true, `${source.id} crosses the density boundary at ${aspectRatio}`);
      const split = applyVisualDensity(source, aspectRatio, defaultVisualDensitySettings);
      assert.ok((split.visualBeats?.length ?? 0) > 1, `${source.id} gets multiple visual beats at ${aspectRatio}`);
      assert.deepEqual(split.visual, source.visual, `${source.id} retains all structured facts and values`);
      assert.equal(split.narration, source.narration, `${source.id} narration is byte-for-byte unchanged`);
      assert.equal(split.visualBeats?.map(beat => beat.narrationText).join(''), source.narration, `${source.id} beat narration is complete, ordered and not duplicated`);
      if (source.id === nestedList.id) {
        assert.equal((split.visual.items as Array<{ children: string[] }>).flatMap(item => item.children).length, 20);
        assert.deepEqual(split.visualBeats?.flatMap(beat => beat.targetIds).filter(id => id.startsWith('bullet-')), ['bullet-1', 'bullet-2', 'bullet-3', 'bullet-4', 'bullet-5']);
      } else {
        const preservedSteps = [...new Set(split.visualBeats?.flatMap(beat => beat.targetIds).filter(id => id.startsWith('step-')) ?? [])];
        assert.deepEqual(preservedSteps, flowNodes.map(node => node.id), 'all flow nodes remain reachable from beats in source order');
      }
      if (source.id === nestedList.id || source.id === twelveStepFlow.id) {
        const timing = getVisualBeatTimingDiagnostic(split);
        assert.equal(timing?.source, 'uniform-fallback', `${source.id} without measured TTS/cue data uses uniform fallback`);
        assert.equal(timing?.minimumDwellSeconds, 1.25);
        assert.equal(timing?.fallbackDurationExtended, true, `${source.id} extends its scene when the default duration cannot provide the minimum dwell`);
        assert.ok(timing!.effectiveDurationSeconds >= split.visualBeats!.length * timing!.minimumDwellSeconds);
        assert.ok((split.duration ?? 0) >= timing!.effectiveDurationSeconds, 'the scene duration follows the fallback beat timeline');
      }
    }
  }
});

test('density strategies, preview snapshot, disable/restore and manual locks preserve content', () => {
  const board = StoryboardSchema.parse({
    title: 'Issue 115 固定密度样例',
    styleId: 'minimal-tech',
    aspectRatio: '9:16',
    transition: 'none',
    scenes: [timedTable, nestedList, ...preserveScenes],
  });
  const originalJson = JSON.stringify(board);
  const counts = (['concise', 'balanced', 'complete'] as const).map(strategy => {
    const preview = applyDensitySettings(board, { autoSplit: true, strategy });
    assert.equal(preview.scenes[0]!.narration, timedTable.narration);
    assert.deepEqual(preview.scenes[0]!.visual, timedTable.visual);
    assert.deepEqual(preview.scenes.slice(2), preserveScenes, `${strategy} keeps HTML/Code/PPT Preserve scenes byte-equivalent`);
    assert.equal(JSON.stringify(board), originalJson, 'preview never mutates the saved board before Apply');
    return preview.scenes[0]!.visualBeats!.map(beat => beat.targetIds.length);
  });
  assert.notDeepEqual(counts[0], counts[1], 'concise and balanced group the 12 table rows differently');
  assert.notDeepEqual(counts[1], counts[2], 'balanced and complete group the 12 table rows differently');

  const applied = applyDensitySettings(board, { autoSplit: true, strategy: 'balanced' });
  const disabled = applyDensitySettings(applied, { autoSplit: false, strategy: 'balanced' });
  assert.equal(disabled.scenes[0]!.visualBeats, undefined, 'turning auto-split off clears rule-generated beats');
  assert.equal(disabled.scenes[0]!.visualPlan, undefined, 'turning auto-split off clears the rule-created plan');
  assert.deepEqual(disabled.scenes.slice(2), preserveScenes, 'disable/restore does not rewrite preserved sources');
  const undoSnapshot = StoryboardSchema.parse(JSON.parse(originalJson));
  assert.deepEqual(undoSnapshot, board, 'the original immutable board snapshot can be restored for undo');

  const locked = SceneSchema.parse({
    ...twelveStepFlow,
    visualPlan: { templateId: 'diagram', manualOverride: true, provenance: 'user' },
    visualBeats: [{ id: 'handmade', narrationText: '用户逐项手工安排。', targetIds: ['manual-target'] }],
    visualBeatsProvenance: 'user',
  });
  assert.deepEqual(applyVisualDensity(locked, '9:16', { autoSplit: true, strategy: 'concise' }), locked, 'manual scene locks win over automatic density changes');
});

test('user-provenance beats are preserved even without a VisualPlan or manualOverride flag', () => {
  const userBeats = [
    { id: 'manual-a', narrationText: '用户先讲主目标。', targetIds: ['manual-target-a'] },
    { id: 'manual-b', narrationText: '用户再讲边界条件。', targetIds: ['manual-target-b'] },
  ];
  const scene = SceneSchema.parse({
    ...nestedList,
    visualPlan: undefined,
    visualBeats: userBeats,
    visualBeatsProvenance: 'user',
  });
  const result = applyVisualDensity(scene, '9:16', { autoSplit: true, strategy: 'concise' });
  assert.strictEqual(result, scene, 'user-provenance alone protects editor beats from automatic density rewriting');
  assert.deepEqual(result.visualBeats, userBeats);
});

test('TTS speed regeneration moves word and subtitle aligned beats without repeating narration or media', () => {
  const split = applyVisualDensity(timedTable, '16:9', defaultVisualDensitySettings);
  const initial = resolveVisualBeatTimeline(split, 30);
  const initialTiming = getVisualBeatTimingDiagnostic(split);
  assert.equal(initialTiming?.source, 'wordTimings', 'these fixtures use synthetic word timings, not product-generated TTS');
  assert.equal(initialTiming?.fallbackDurationExtended, false, 'valid timing keeps the authored clip duration');
  assert.ok(initial.length > 1);

  const faster = SceneSchema.parse({
    ...split,
    audioDuration: 8,
    wordTimings: split.wordTimings!.map(item => ({ ...item, start: item.start / 2, end: item.end / 2 })),
    subtitleCues: split.subtitleCues!.map(cue => ({ ...cue, start: cue.start / 2, end: cue.end / 2 })),
  });
  const fasterFrames = resolveVisualBeatTimeline(faster, 30);
  assert.equal(getVisualBeatTimingDiagnostic(faster)?.source, 'wordTimings');
  assert.equal(getVisualBeatTimingDiagnostic(faster)?.fallbackDurationExtended, false);
  assert.deepEqual(faster.visualBeats, split.visualBeats, 'TTS regeneration does not rewrite semantic beats');
  assert.deepEqual(fasterFrames.map(beat => beat.startFrame), initial.map(beat => Math.round(beat.startFrame / 2)), 'synthetic word timings at half duration move every grouped beat proportionally');
  assert.equal(faster.narration, timedTable.narration);
  assert.equal(faster.visualBeats!.filter(beat => beat.narrationText).map(beat => beat.narrationText).join(''), timedTable.narration);
  assert.equal(faster.audioSrc, timedTable.audioSrc, 'one original media reference remains attached; split does not duplicate audio');

  const cueOnly = SceneSchema.parse({ ...faster, wordTimings: undefined });
  assert.equal(getVisualBeatTimingDiagnostic(cueOnly)?.source, 'subtitleCues');
  assert.deepEqual(resolveVisualBeatTimeline(cueOnly, 30).map(beat => beat.startFrame), fasterFrames.map(beat => beat.startFrame), 'subtitle cues preserve the regenerated beat map when word timing is unavailable');
});
