import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCodeBeatTimeline } from '../src/index';

/** #17 契约：code beats 与字幕/词级时间轴自动对齐（doc/V1.6.8_issues.md §2.2）。 */

const codeOf = (count: number) => Array.from({ length: count }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n');

const beatsOf = (lines: number[][]): { lines: number[]; label?: string; narrationText?: string }[] =>
  lines.map((lines, index) => ({ lines, label: `区域${index + 1}`, narrationText: `旁白${index + 1}` }));

const words = (entries: [string, number, number][]) => entries.map(([text, start, end]) => ({ text, start, end }));

function sceneOf(visual: Record<string, unknown>, patch: Record<string, unknown> = {}): { duration: number; visual: Record<string, unknown> } & Record<string, unknown> {
  return { duration: 4, visual: { code: codeOf(8), ...visual }, ...patch };
}

// ── #17-1 wordTimings 命中：start/end 按词组时间换算，顺序正确 ─────────────────────
test('#17-1 有 wordTimings 时 beat 跟随匹配词组切换，start/end 为帧换算且顺序正确', () => {
  const wordTimings = words([
    ['如果', 0, 0.2], ['缓存', 0.2, 0.4], ['命中', 0.4, 0.6], ['直接', 0.6, 1.0], ['返回', 1.0, 1.4],
    ['那么', 1.6, 1.8], ['请求', 2.4, 2.6], ['数据', 2.6, 2.8],
  ]);
  // narrationText 含标点：匹配应先去掉空白/标点，再按子串定位词组。
  const scene = sceneOf({
    beats: [
      { lines: [3, 1], label: '命中后返回', narrationText: '直接，返回。' },
      { lines: [6], label: '请求数据', narrationText: '请求数据' },
    ],
  }, { audioDuration: 4, wordTimings });

  const timeline = resolveCodeBeatTimeline(scene, 30);
  assert.equal(timeline.length, 2);
  const [first, second] = timeline;
  assert.equal(first.startFrame, Math.round(0.6 * 30), '首个匹配词组的 start');
  assert.equal(first.endFrame, Math.round(1.4 * 30), '末个匹配词组的 end');
  assert.equal(second.startFrame, Math.round(2.4 * 30));
  assert.equal(second.endFrame, Math.round(4 * 30), '最后一个 beat 覆盖到场景结束');
  assert.deepEqual(first.lines, [1, 3], 'lines 升序去重输出');
  assert.deepEqual(second.lines, [6]);
  assert.ok(second.startFrame >= first.endFrame, 'beat 顺序单调');
  assert.ok(second.startFrame > first.startFrame);
});

// ── #17-2 只有 subtitleCues 时可用 ────────────────────────────────────────────────
test('#17-2 无 wordTimings、只有 subtitleCues 时 beat 定位到匹配 cue 的时间', () => {
  const scene = sceneOf({
    beats: [
      { lines: [1], label: '命中', narrationText: '直接返回' },
      { lines: [2], label: '请求', narrationText: '请求数据' },
    ],
  }, {
    audioDuration: 4,
    subtitleCues: [
      { text: '命中缓存后直接返回结果', start: 1, end: 2.5 },
      { text: '再发起请求数据', start: 2.5, end: 4 },
    ],
  });
  const timeline = resolveCodeBeatTimeline(scene, 30);
  assert.equal(timeline.length, 2);
  assert.equal(timeline[0].startFrame, Math.round(1 * 30));
  assert.equal(timeline[0].endFrame, Math.round(2.5 * 30));
  assert.equal(timeline[1].startFrame, Math.round(2.5 * 30));
  assert.equal(timeline[1].endFrame, Math.round(4 * 30));
});

// ── #17-3 完全没有对齐数据时稳定均匀分配并覆盖整个时长 ────────────────────────────
test('#17-3 无 wordTimings/subtitleCues 时按 beat 顺序均匀分配，覆盖 [0,durationFrames] 且确定', () => {
  const scene = sceneOf({ beats: beatsOf([[1], [2], [3]]) }, { duration: 4, audioDuration: undefined });
  const first = resolveCodeBeatTimeline(scene, 30);
  const second = resolveCodeBeatTimeline(scene, 30);
  assert.deepEqual(second, first, '同一输入两次调用结果一致');
  const durationFrames = Math.round(4 * 30);
  assert.equal(first.length, 3);
  assert.equal(first[0].startFrame, 0, '覆盖从 0 开始');
  assert.equal(first[first.length - 1].endFrame, durationFrames, '覆盖到场景结束');
  const durations = first.map(beat => beat.endFrame - beat.startFrame);
  assert.ok(Math.max(...durations) - Math.min(...durations) <= 2, `均匀分配（${durations.join(',')}）`);
  for (let index = 1; index < first.length; index += 1) {
    assert.ok(first[index].startFrame >= first[index - 1].endFrame, '单调不重叠');
  }
  for (const frame of [0, 39, 40, 79, 80, durationFrames - 1]) {
    assert.equal(first.filter(beat => beat.startFrame <= frame && frame < beat.endFrame).length, 1, `frame ${frame} 恰好被一个 beat 覆盖`);
  }
  assert.deepEqual(first.map(beat => beat.lines), [[1], [2], [3]], '保持 beat 顺序');
});

// ── #17-4 最小展示时长与顺序 ──────────────────────────────────────────────────────
test('#17-4 每个 beat 最小展示时长 ≥ round(0.6*fps) 帧，顺序单调不重叠', () => {
  const landscape = sceneOf({ beats: beatsOf([[1], [2], [3], [4], [5]]) }, { duration: 4 });
  for (const fps of [30, 60]) {
    const timeline = resolveCodeBeatTimeline(landscape, fps);
    const minimum = Math.max(1, Math.round(fps * 0.6));
    assert.equal(minimum, fps === 30 ? 18 : 36);
    for (const beat of timeline) {
      assert.ok(beat.endFrame - beat.startFrame >= minimum, `${fps}fps 下 beat 展示 ${beat.startFrame}-${beat.endFrame} 不足 ${minimum} 帧`);
    }
    for (let index = 1; index < timeline.length; index += 1) {
      assert.ok(timeline[index].startFrame >= timeline[index - 1].endFrame, '顺序单调不重叠');
    }
  }
});

// ── #17-5 最后一个 beat 覆盖场景结束 ─────────────────────────────────────────────
test('#17-5 最后 beat 的 endFrame 等于 durationFrames（audioDuration 优先，其次 max(3,duration)）', () => {
  const cases: { name: string; scene: Record<string, unknown>; frames: number }[] = [
    { name: 'audioDuration', scene: sceneOf({ beats: beatsOf([[1], [2]]) }, { duration: 4, audioDuration: 5.5 }), frames: 165 },
    { name: 'duration only', scene: sceneOf({ beats: beatsOf([[1], [2]]) }, { duration: 7, audioDuration: undefined }), frames: 210 },
    { name: 'defaults', scene: sceneOf({ beats: beatsOf([[1], [2]]) }, { duration: undefined, audioDuration: undefined }), frames: 180 },
    { name: 'short duration floor', scene: sceneOf({ beats: beatsOf([[1], [2]]) }, { duration: 1, audioDuration: undefined }), frames: 90 },
    { name: 'fraction rounds', scene: sceneOf({ beats: beatsOf([[1], [2]]) }, { duration: 4, audioDuration: 4.03 }), frames: 121 },
  ];
  for (const entry of cases) {
    const timeline = resolveCodeBeatTimeline(entry.scene, 30);
    assert.equal(timeline[timeline.length - 1].endFrame, entry.frames, entry.name);
  }
});

// ── #17-6 输入变化重算，且不写回 visual.beats ────────────────────────────────────
test('#17-6 audioDuration/wordTimings 变化后重算时间轴，visual.beats 不被修改', () => {
  const visual = {
    beats: [
      { lines: [1], label: '命中', narrationText: '直接返回' },
      { lines: [2], label: '请求', narrationText: '请求数据' },
    ],
  };
  const wordTimings = words([['直接', 0.6, 0.8], ['返回', 0.8, 1.0], ['请求', 2.4, 2.6], ['数据', 2.6, 2.8]]);
  const scene = sceneOf(visual, { duration: 4, audioDuration: 4, wordTimings });
  const frozen = structuredClone(scene);
  const before = resolveCodeBeatTimeline(scene, 30);

  const longer = resolveCodeBeatTimeline({ ...scene, audioDuration: 6 }, 30);
  assert.equal(before[before.length - 1].endFrame, 120);
  assert.equal(longer[longer.length - 1].endFrame, 180, 'audioDuration 变化后自动重算');
  assert.notDeepEqual(before, longer);

  const shifted = resolveCodeBeatTimeline({ ...scene, wordTimings: wordTimings.map(word => ({ ...word, start: word.start + 1, end: word.end + 1 })) }, 30);
  assert.equal(shifted[0].startFrame, Math.round(1.6 * 30), 'wordTimings 变化后起始帧跟随');
  assert.notDeepEqual(before, shifted);

  assert.deepEqual(scene, frozen, '输入 scene 未被修改');
  const sceneBeats = scene.visual.beats as { startFrame?: number; endFrame?: number }[];
  assert.deepEqual(sceneBeats, frozen.visual.beats, 'visual.beats 未写入绝对时间');
  for (const beat of sceneBeats) {
    assert.equal('startFrame' in beat, false);
    assert.equal('endFrame' in beat, false);
  }
  // speechSpeed 不属于时间轴输入，不影响同一个 audioDuration 的结果（改语速只需重算时间轴）。
  const sameAudio = resolveCodeBeatTimeline({ ...scene, speechSpeed: 1.6 }, 30);
  assert.deepEqual(sameAudio, before);
});

// ── #17-7 边界：0/1 beat、无 narrationText、beat 数过多 ──────────────────────────
test('#17-7 边界：无 beats 返回 []，单 beat 覆盖全程，无 narrationText 走 fallback，beat 过多仍输出合法帧区间', () => {
  assert.deepEqual(resolveCodeBeatTimeline(sceneOf({}, { duration: 4 }), 30), []);
  assert.deepEqual(resolveCodeBeatTimeline({ duration: 4, visual: {} }, 30), []);
  assert.deepEqual(resolveCodeBeatTimeline({ duration: 4, visual: { code: codeOf(3) } }, 30), []);

  const single = resolveCodeBeatTimeline({ duration: 5, visual: { code: codeOf(3), beats: [{ lines: [2] }] } }, 30);
  assert.equal(single.length, 1);
  assert.equal(single[0].startFrame, 0);
  assert.equal(single[0].endFrame, 150);
  assert.deepEqual(single[0].lines, [2]);

  const mixed = sceneOf({ beats: [{ lines: [1], narrationText: '直接返回' }, { lines: [2] }] }, { duration: 4, wordTimings: words([['直接', 0.6, 0.8], ['返回', 0.8, 1.0]]) });
  const mixedTimeline = resolveCodeBeatTimeline(mixed, 30);
  assert.equal(mixedTimeline.length, 2);
  assert.equal(mixedTimeline[0].startFrame, Math.round(0.6 * 30));
  assert.equal(mixedTimeline[1].endFrame, 120);
  assert.ok(mixedTimeline[1].endFrame > mixedTimeline[1].startFrame);

  // beat 数多于可见时间：仍输出合法、单调的帧区间。
  const crowded = sceneOf({ code: codeOf(10), beats: Array.from({ length: 10 }, (_, index) => ({ lines: [index + 1] })) }, { duration: 3 });
  const crowdedTimeline = resolveCodeBeatTimeline(crowded, 30);
  assert.equal(crowdedTimeline.length, 10);
  assert.equal(crowdedTimeline[crowdedTimeline.length - 1].endFrame, 90);
  for (const beat of crowdedTimeline) {
    assert.ok(Number.isInteger(beat.startFrame) && Number.isInteger(beat.endFrame), '整数帧');
    assert.ok(beat.startFrame >= 0 && beat.endFrame <= 90, 'clamp 在 [0,durationFrames]');
    assert.ok(beat.endFrame > beat.startFrame, '非零展示时长');
  }
  for (let index = 1; index < crowdedTimeline.length; index += 1) {
    assert.ok(crowdedTimeline[index].startFrame >= crowdedTimeline[index - 1].endFrame, '单调');
  }
});

// ── #17-8 fps 帧换算 ─────────────────────────────────────────────────────────────
test('#17-8 fps 30/60 帧换算比例一致，默认 fps=30', () => {
  const scene = sceneOf({
    beats: [
      { lines: [1], narrationText: '直接返回' },
      { lines: [2], narrationText: '请求数据' },
    ],
  }, {
    audioDuration: 3,
    wordTimings: words([['直接', 1.0, 1.2], ['返回', 1.2, 1.4], ['请求', 2.2, 2.4], ['数据', 2.4, 2.6]]),
  });
  const at30 = resolveCodeBeatTimeline(scene, 30);
  const at60 = resolveCodeBeatTimeline(scene, 60);
  const defaulted = resolveCodeBeatTimeline(scene);
  assert.deepEqual(defaulted, at30, '默认 30fps');
  assert.equal(at30[0].startFrame, 30);
  assert.equal(at60[0].startFrame, 60);
  assert.equal(at30[at30.length - 1].endFrame, 90);
  assert.equal(at60[at60.length - 1].endFrame, 180);
  assert.ok(Math.abs(at30[0].startFrame / 30 - at60[0].startFrame / 60) <= 1 / 60, '秒级位置一致');
  assert.ok(Math.abs(at30[1].startFrame / 30 - at60[1].startFrame / 60) <= 1 / 60);
});
