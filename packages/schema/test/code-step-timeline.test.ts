import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codeLines,
  resolveCodeBeatTimeline,
  resolveCodeBuildStepTimeline,
  resolveCodeDiffBeatTimeline,
  resolveCodeTraceStepTimeline,
} from '../src/index';

/**
 * #25 / #26 / #27 契约：build/trace/diff 步骤时间轴（doc/V1.7.0_issues.md §2.5）。
 * 与既有 resolveCodeBeatTimeline 使用完全一致的旁白锚定规则。
 */

const codeOf = (count: number) => Array.from({ length: count }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n');

type SceneLike = Record<string, unknown>;
const sceneOf = (visual: Record<string, unknown>, patch: Record<string, unknown> = {}): SceneLike => ({
  id: 'code-timeline',
  type: 'code',
  title: '时间轴',
  narration: '这一页讲解代码逻辑。',
  duration: 6,
  visual,
  ...patch,
});

const buildScene = (steps: unknown[], patch: Record<string, unknown> = {}): SceneLike =>
  sceneOf({ code: codeOf(6), mode: 'build', buildSteps: steps }, patch);

const traceScene = (steps: unknown[], patch: Record<string, unknown> = {}): SceneLike =>
  sceneOf({ code: codeOf(8), mode: 'trace', traceSteps: steps }, patch);

/** 20 行、两处替换（第 2 行与第 12 行）→ 2 个 hunk 的 diff 源码。 */
const TWO_HUNK_BEFORE = Array.from({ length: 20 }, (_, index) => (index === 1 ? 'old 2' : index === 11 ? 'old 12' : `line ${index + 1}`)).join('\n');
const TWO_HUNK_AFTER = Array.from({ length: 20 }, (_, index) => (index === 1 ? 'new 2' : index === 11 ? 'new 12' : `line ${index + 1}`)).join('\n');
const TWO_HUNK_DIFF = { code: TWO_HUNK_AFTER, mode: 'diff', beforeCode: TWO_HUNK_BEFORE, afterCode: TWO_HUNK_AFTER };
const twoHunkScene = (patch: Record<string, unknown> = {}): SceneLike => sceneOf({ ...TWO_HUNK_DIFF }, patch);

/** 断言步骤窗口合法：单调不重叠、非空、最后一步覆盖到场景结束。 */
function assertMonotonic(frames: { startFrame: number; endFrame: number }[], durationFrames: number, label: string): void {
  assert.ok(frames.length > 0, `${label}: 有步骤`);
  for (const frame of frames) {
    assert.ok(Number.isInteger(frame.startFrame) && Number.isInteger(frame.endFrame), `${label}: 帧为整数`);
    assert.ok(frame.startFrame >= 0, `${label}: startFrame ≥ 0`);
    assert.ok(frame.startFrame < frame.endFrame, `${label}: startFrame < endFrame（${frame.startFrame}/${frame.endFrame}）`);
  }
  for (let index = 1; index < frames.length; index += 1) {
    assert.ok(frames[index].startFrame >= frames[index - 1].endFrame, `${label}: 单调不重叠 #${index}`);
  }
  assert.equal(frames[frames.length - 1].endFrame, durationFrames, `${label}: 最后一步结束 = durationFrames`);
}

// ═════════════════════════════ #25-3 build 时间轴 ═════════════════════════════

test('#25-3 resolveCodeBuildStepTimeline：wordTimings/subtitleCues 对齐、失败均分、最小 0.6s、单调、fps 缺省 30', () => {
  const steps = [
    { revealLines: [1, 2], label: '声明', narrationText: '先声明变量' },
    { revealLines: [3, 4], label: '判断', narrationText: '再写判断' },
    { revealLines: [5, 6], label: '收尾', narrationText: '最后收尾' },
  ];

  // wordTimings 命中：三个旁白各自锚定
  const words = [
    { text: '先声明', start: 0, end: 0.4 }, { text: '变量', start: 0.4, end: 0.8 },
    { text: '再写', start: 1, end: 1.4 }, { text: '判断', start: 1.4, end: 1.8 },
    { text: '最后', start: 2, end: 2.4 }, { text: '收尾', start: 2.4, end: 2.9 },
  ];
  const aligned = buildScene(steps, { audioDuration: 4, wordTimings: words });
  assert.deepEqual(
    resolveCodeBuildStepTimeline(aligned, 30).map(frame => [frame.startFrame, frame.endFrame]),
    [[0, 24], [30, 54], [60, 120]],
    'wordTimings 命中窗口',
  );
  assert.deepEqual(resolveCodeBuildStepTimeline(aligned, 30).map(frame => frame.index), [0, 1, 2], 'index 顺序');
  assert.deepEqual(resolveCodeBuildStepTimeline(aligned, 30).map(frame => frame.revealLines), [[1, 2], [3, 4], [5, 6]]);
  assert.deepEqual(resolveCodeBuildStepTimeline(aligned, 30).map(frame => frame.focusLines), [[1, 2], [3, 4], [5, 6]], 'focusLines 缺省 = revealLines');
  assert.deepEqual(resolveCodeBuildStepTimeline(aligned, 30).map(frame => frame.label), ['声明', '判断', '收尾']);

  // subtitleCues 命中（无 wordTimings）
  const cues = [
    { text: '先声明变量。', start: 0.2, end: 1 },
    { text: '再写判断。', start: 1, end: 2 },
    { text: '最后收尾。', start: 2, end: 3 },
  ];
  const cueAligned = buildScene(steps, { audioDuration: 4, subtitleCues: cues });
  assert.deepEqual(
    resolveCodeBuildStepTimeline(cueAligned, 30).map(frame => [frame.startFrame, frame.endFrame]),
    [[6, 30], [30, 60], [60, 120]],
    'subtitleCues 命中窗口',
  );

  // 对齐失败 → 按步骤顺序均分（6s @30fps = 180 帧，3 步各 60 帧）
  const even = resolveCodeBuildStepTimeline(buildScene(steps), 30);
  assert.deepEqual(even.map(frame => [frame.startFrame, frame.endFrame]), [[0, 60], [60, 120], [120, 180]], '均分');
  assertMonotonic(even, 180, '均分');

  // 最小 0.6s：可行时每步 ≥18 帧（即使旁白只对齐到极小窗口）
  const tinyWords = [{ text: '先声明变量', start: 0.1, end: 0.2 }];
  const tiny = buildScene([
    { revealLines: [1, 2], narrationText: '先声明变量' },
    { revealLines: [3, 4] },
    { revealLines: [5, 6] },
  ], { audioDuration: 6, wordTimings: tinyWords });
  const tinyTimeline = resolveCodeBuildStepTimeline(tiny, 30);
  assert.ok(tinyTimeline[0].endFrame - tinyTimeline[0].startFrame >= 18, `最小 0.6s：实际 ${tinyTimeline[0].endFrame - tinyTimeline[0].startFrame} 帧`);
  assertMonotonic(tinyTimeline, 180, '最小展示时长');

  // 可用时长不足 → 均分优先于最小 0.6s（30 帧 2 步）
  const short = buildScene([
    { revealLines: [1, 2, 3] },
    { revealLines: [4, 5, 6] },
  ], { audioDuration: 1 });
  const shortTimeline = resolveCodeBuildStepTimeline(short, 30);
  assertMonotonic(shortTimeline, 30, '短时长');
  assert.equal(shortTimeline.length, 2);
  assert.ok(shortTimeline.every(frame => frame.endFrame - frame.startFrame <= 30));

  // fps 缺省 30；非法 fps 回退 30
  assert.deepEqual(resolveCodeBuildStepTimeline(aligned), resolveCodeBuildStepTimeline(aligned, 30), 'fps 缺省 30');
  assert.deepEqual(resolveCodeBuildStepTimeline(aligned, Number.NaN), resolveCodeBuildStepTimeline(aligned, 30), 'NaN fps 回退 30');
  assert.deepEqual(resolveCodeBuildStepTimeline(aligned, 0), resolveCodeBuildStepTimeline(aligned, 30), '0 fps 回退 30');

  // 数据非法/模式不匹配 → []
  assert.deepEqual(resolveCodeBuildStepTimeline(sceneOf({ code: codeOf(6), buildSteps: steps })), [], '无 mode=build → []');
  assert.deepEqual(resolveCodeBuildStepTimeline(sceneOf({ code: codeOf(6), mode: 'build' })), [], '无 buildSteps → []');
  assert.deepEqual(resolveCodeBuildStepTimeline(sceneOf({ code: codeOf(6), mode: 'build', buildSteps: [{ revealLines: [99] }] })), [], '非法行号 → []');
  assert.deepEqual(resolveCodeBuildStepTimeline(sceneOf({ code: codeOf(6), mode: 'build', buildSteps: [{ revealLines: [1, 2] }] })), [], '覆盖不完整 → []');
  assert.deepEqual(resolveCodeBuildStepTimeline({}), [], '空 scene → []');
  assert.deepEqual(resolveCodeBuildStepTimeline({ visual: null } as unknown as Record<string, unknown>), [], 'visual=null → []');

  // 既有 resolveCodeBeatTimeline 行为不回归（单 beat 为最后一步 → endFrame = durationFrames）
  const beatsScene = sceneOf({ code: codeOf(6), beats: [{ lines: [1], narrationText: '先声明变量' }] }, { audioDuration: 4, wordTimings: [words[0], words[1]] });
  assert.deepEqual(resolveCodeBeatTimeline(beatsScene, 30).map(frame => [frame.startFrame, frame.endFrame]), [[0, 120]], '既有 beat 时间轴不回归');
  const multiBeats = sceneOf({ code: codeOf(6), beats: [{ lines: [1], narrationText: '先声明变量' }, { lines: [3], narrationText: '再写判断' }] }, { audioDuration: 4, wordTimings: words });
  assert.deepEqual(resolveCodeBeatTimeline(multiBeats, 30).map(frame => [frame.startFrame, frame.endFrame]), [[0, 24], [30, 120]], '既有多 beat 时间轴对齐不回归');
  assert.ok(codeLines(codeOf(3)).length === 3);
});

// ═════════════════════════════ #26-6 diff 时间轴 ═════════════════════════════

test('#26-6 resolveCodeDiffBeatTimeline：diffBeats 旁白对齐/均分/最小 0.6s/单调/最后到结束；非法数据 []', () => {
  // 两处变更 → 2 个 hunk；diffBeats 各指一个 hunk
  const scene = sceneOf({ ...TWO_HUNK_DIFF, diffBeats: [
    { hunkIds: ['h1'], label: '第一处', narrationText: '先看第一处修改' },
    { hunkIds: ['h2'], label: '第二处', narrationText: '再看第二处修改' },
  ] }, { audioDuration: 3, wordTimings: [
    { text: '先看', start: 0.5, end: 0.8 }, { text: '第一处修改', start: 0.8, end: 1 },
    { text: '再看', start: 2, end: 2.2 }, { text: '第二处修改', start: 2.2, end: 2.5 },
  ] });
  const timeline = resolveCodeDiffBeatTimeline(scene, 30);
  assert.equal(timeline.length, 2, '两个 beat');
  assert.deepEqual(timeline.map(frame => [frame.startFrame, frame.endFrame]), [[15, 33], [60, 90]], '旁白对齐窗口 + 最小 0.6s（18 帧）且最后一步到场景结束');
  assert.deepEqual(timeline.map(frame => frame.hunkIds), [['h1'], ['h2']], 'hunkIds 与 beat 一致');
  assert.deepEqual(timeline.map(frame => frame.label), ['第一处', '第二处']);
  assertMonotonic(timeline, 90, 'diff 对齐');

  // 缺省 diffBeats → 每 hunk 默认一条 beat，按顺序均分（6s = 180 帧）
  const defaultBeats = resolveCodeDiffBeatTimeline(twoHunkScene(), 30);
  assert.equal(defaultBeats.length, 2, '每个 hunk 默认一条 beat');
  assert.deepEqual(defaultBeats.map(frame => frame.hunkIds), [['h1'], ['h2']]);
  assert.deepEqual(defaultBeats.map(frame => [frame.startFrame, frame.endFrame]), [[0, 90], [90, 180]], '默认 beat 均分');
  assertMonotonic(defaultBeats, 180, 'diff 均分');

  // 最小 0.6s + fps 缺省
  const tinyWords = [{ text: '先看第一处修改', start: 0.1, end: 0.2 }];
  const tinyScene = sceneOf({ ...TWO_HUNK_DIFF, diffBeats: [{ hunkIds: ['h1'], narrationText: '先看第一处修改' }, { hunkIds: ['h2'] }] }, { audioDuration: 6, wordTimings: tinyWords });
  const tinyTimeline = resolveCodeDiffBeatTimeline(tinyScene);
  assert.ok(tinyTimeline[0].endFrame - tinyTimeline[0].startFrame >= 18, '最小 0.6s');
  assert.equal(resolveCodeDiffBeatTimeline(tinyScene)[1].endFrame, 180, 'fps 缺省 30 + 最后到结束');

  // 非法数据 → []
  assert.deepEqual(resolveCodeDiffBeatTimeline(sceneOf({ code: codeOf(4), beforeCode: 'a', afterCode: codeOf(4) })), [], '无 mode → []');
  assert.deepEqual(resolveCodeDiffBeatTimeline(sceneOf({ code: codeOf(4), mode: 'diff' })), [], '缺 before/after → []');
  assert.deepEqual(resolveCodeDiffBeatTimeline(sceneOf({ code: codeOf(4), mode: 'diff', beforeCode: codeOf(4), afterCode: codeOf(4) })), [], '无实际变更 → []');
  assert.deepEqual(resolveCodeDiffBeatTimeline({}), [], '空 scene → []');
});

// ═════════════════════════════ #27-6 trace 时间轴 ═════════════════════════════

test('#27-6 resolveCodeTraceStepTimeline：旁白对齐/均分/最小 0.6s/单调/最后到结束；state/output/callDepth 透传；非法 []', () => {
  const steps = [
    { lines: [2], label: '初始化', narrationText: '初始化变量', state: [{ name: 'sum', value: '0' }] },
    { lines: [4], label: '累加', narrationText: '累加当前值', state: [{ name: 'sum', value: '3', changed: true }], output: '3', callDepth: 1 },
    { lines: [6], label: '返回', narrationText: '输出结果', state: [{ name: 'result', value: '3', changed: true }], output: '3', callDepth: 0 },
  ];
  // 均分：6s @30fps → 180 帧，3 步
  const even = resolveCodeTraceStepTimeline(traceScene(steps), 30);
  assert.deepEqual(even.map(frame => [frame.startFrame, frame.endFrame]), [[0, 60], [60, 120], [120, 180]], '均分');
  assert.deepEqual(even.map(frame => frame.lines), [[2], [4], [6]]);
  assert.deepEqual(even.map(frame => frame.label), ['初始化', '累加', '返回']);
  assert.deepEqual(even[0].state, [{ name: 'sum', value: '0' }], 'state 透传');
  assert.deepEqual(even[1].state, [{ name: 'sum', value: '3', changed: true }]);
  assert.equal(even[1].output, '3');
  assert.equal(even[1].callDepth, 1);
  assert.equal(even[2].callDepth, 0);
  assertMonotonic(even, 180, 'trace 均分');

  // wordTimings 对齐
  const aligned = traceScene(steps, { audioDuration: 4, wordTimings: [
    { text: '初始化变量', start: 0.2, end: 1 },
    { text: '累加当前值', start: 1, end: 2 },
    { text: '输出结果', start: 2, end: 3 },
  ] });
  assert.deepEqual(
    resolveCodeTraceStepTimeline(aligned, 30).map(frame => [frame.startFrame, frame.endFrame]),
    [[6, 30], [30, 60], [60, 120]],
    'wordTimings 命中窗口',
  );

  // subtitleCues 对齐（无 wordTimings）
  const cueAligned = traceScene(steps, { audioDuration: 4, subtitleCues: [
    { text: '初始化变量。', start: 0.2, end: 1 },
    { text: '累加当前值。', start: 1, end: 2 },
    { text: '输出结果。', start: 2, end: 3 },
  ] });
  assert.deepEqual(
    resolveCodeTraceStepTimeline(cueAligned, 30).map(frame => [frame.startFrame, frame.endFrame]),
    [[6, 30], [30, 60], [60, 120]],
    'subtitleCues 命中窗口',
  );

  // 最小 0.6s
  const tiny = traceScene([
    { lines: [2], narrationText: '初始化变量' },
    { lines: [4] },
  ], { audioDuration: 6, wordTimings: [{ text: '初始化变量', start: 0.1, end: 0.2 }] });
  const tinyTimeline = resolveCodeTraceStepTimeline(tiny, 30);
  assert.ok(tinyTimeline[0].endFrame - tinyTimeline[0].startFrame >= 18, '最小 0.6s');
  assertMonotonic(tinyTimeline, 180, 'trace 最小展示时长');

  // fps 缺省 30
  assert.deepEqual(resolveCodeTraceStepTimeline(traceScene(steps)), resolveCodeTraceStepTimeline(traceScene(steps), 30), 'fps 缺省 30');

  // 非法 → []
  assert.deepEqual(resolveCodeTraceStepTimeline(sceneOf({ code: codeOf(8), traceSteps: steps })), [], '无 mode → []');
  assert.deepEqual(resolveCodeTraceStepTimeline(sceneOf({ code: codeOf(8), mode: 'trace' })), [], '无 traceSteps → []');
  assert.deepEqual(resolveCodeTraceStepTimeline(sceneOf({ code: codeOf(8), mode: 'trace', traceSteps: [{ lines: [99] }] })), [], '行号越界 → []');
  assert.deepEqual(resolveCodeTraceStepTimeline({}), [], '空 scene → []');
  assert.deepEqual(resolveCodeTraceStepTimeline({ visual: undefined } as unknown as Record<string, unknown>), [], 'visual 缺失 → []');
});
