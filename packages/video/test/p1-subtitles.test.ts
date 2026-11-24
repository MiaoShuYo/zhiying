/**
 * P1 subtitle/timeline regressions: #297 #269 frame-aligned offsets, #283 nested overlap,
 * #295 explicitly empty manual timeline, #267 empty narration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneSchema, StoryboardSchema, hasManualCues, resolveCaptionCues, segmentPlan, subtitleCues as layerCues, timelineFrames } from '../../schema/src/index';
import { checkSubtitles } from '../src/qc';
import { subtitleCues, validateSubtitleTimeline } from '../src/subtitles';

const scene = (patch: Record<string, unknown> = {}) => SceneSchema.parse({ id: 'a', type: 'title', narration: '第一句。第二句。', visual: {}, duration: 6, ...patch });
const board = (scenes: Record<string, unknown>[], patch: Record<string, unknown> = {}) => StoryboardSchema.parse({ title: '例子', styleId: 'minimal-tech', scenes, ...patch });

test('[#297] cue offsets follow the frame-aligned timeline, intro included', () => {
  const scenes = Array.from({ length: 100 }, (_, index) => scene({ id: `s${index}`, duration: 3.01, subtitleCues: [{ text: `第${index}句`, start: 0, end: 1 }] }));
  const storyboard = board(scenes, { intro: { enabled: true, title: '片头', duration: 2.01 } });
  const frames = timelineFrames(storyboard, 30).segments.filter(segment => segment.kind === 'scene');
  const cues = subtitleCues(storyboard);
  assert.equal(cues.length, 100);
  assert.equal(cues[99].start, frames[99].startFrame / 30, '第 100 个场景的字幕要和画面同时开始');
});

test('[#269] cues end at the rendered scene boundary and the delivery check accepts them', () => {
  const scenes = Array.from({ length: 10 }, (_, index) => scene({ id: `s${index}`, duration: 6.01, audioDuration: 6.01 }));
  const storyboard = board(scenes);
  const total = timelineFrames(storyboard, 30).totalFrames / 30;
  const cues = subtitleCues(storyboard);
  assert.ok(cues.every(cue => cue.end <= total + 1e-9), '最后一条字幕不能超出成片');
  assert.equal(validateSubtitleTimeline(storyboard, total).ok, true);
});

test('[#283] nested overlaps are reported against the cue that ends last', () => {
  const nested = scene({ subtitleCues: [{ text: '长句', start: 0, end: 6 }, { text: '短一', start: 1, end: 2 }, { text: '短二', start: 3, end: 4 }] });
  const qc = checkSubtitles(board([nested]));
  const overlaps = qc.issues.filter(issue => issue.code === 'subtitle_overlap');
  assert.equal(overlaps.length, 2, '第二、三条都与第一条重叠');
  assert.match(overlaps[1].message, /第 1 条与第 3 条/);
  const timeline = validateSubtitleTimeline(board([nested]));
  assert.equal(timeline.issues.filter(issue => issue.code === 'overlap').length, 2);
});

test('[#295] deleting every manual cue keeps the scene caption-free', () => {
  const emptied = scene({ subtitleCues: [] });
  assert.equal(hasManualCues(emptied), true);
  assert.deepEqual(resolveCaptionCues(emptied), []);
  assert.equal(layerCues(board([emptied])).length, 0, '已删光的字幕不能自动恢复');
  const automatic = scene();
  assert.equal(hasManualCues(automatic), false);
  assert.ok(resolveCaptionCues(automatic).length > 0, 'undefined 表示自动生成');
});

test('[#267] an empty narration saves through the shared schema', () => {
  assert.equal(SceneSchema.safeParse({ id: 'a', type: 'title', narration: '', visual: {} }).success, true);
  assert.equal(board([{ id: 'a', type: 'title', narration: '', visual: {} }]).scenes[0].narration, '');
});

test('[#277] raw-list QC findings point at the row the caption timeline shows', () => {
  const unordered = scene({ subtitleCues: [{ text: '第二句', start: 2, end: 3 }, { text: '越界', start: 40, end: 42 }, { text: '第一句', start: 0, end: 1 }] });
  const outside = checkSubtitles(board([unordered])).issues.find(issue => issue.code === 'subtitle_out_of_scene' && issue.cueText === '越界');
  const shown = resolveCaptionCues(unordered);
  assert.ok(outside);
  assert.equal(shown[outside!.cueIndex!].text, '越界', '定位到的行就是出问题的那条字幕');
});

test('[#218] with BGM a segment fingerprint depends on its position and the total length', () => {
  const a = scene({ id: 'a', duration: 4 });
  const b = scene({ id: 'b', duration: 5 });
  const withBgm = { bgmSrc: 'audio/bgm.mp3' };
  const first = segmentPlan({ storyboard: board([a, b], withBgm), cached: [] });
  const reordered = segmentPlan({ storyboard: board([b, a], withBgm), cached: [] });
  const fingerprintOf = (plan: typeof first, id: string) => plan.segments.find(segment => segment.sceneId === id)!.fingerprint;
  assert.notEqual(fingerprintOf(first, 'a'), fingerprintOf(reordered, 'a'), '换了位置的片段要重新混入音乐');
  const plain = segmentPlan({ storyboard: board([a, b]), cached: [] });
  const plainReordered = segmentPlan({ storyboard: board([b, a]), cached: [] });
  assert.equal(fingerprintOf(plain, 'a'), fingerprintOf(plainReordered, 'a'), '没有 BGM 时换位置仍可复用');
});
