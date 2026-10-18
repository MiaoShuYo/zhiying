import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneSchema, StoryboardSchema } from '../../schema/src/index';
import { checkAudio, checkSubtitles } from '../src/qc';

const scene = (patch: Record<string, unknown> = {}) => SceneSchema.parse({ id: 'a', type: 'title', narration: '第一句。第二句。', visual: {}, duration: 6, ...patch });
const board = (scenes: Record<string, unknown>[], patch: Record<string, unknown> = {}) => StoryboardSchema.parse({ title: '例子', styleId: 'minimal-tech', scenes, ...patch });
const codes = (issues: { code: string }[]) => issues.map(item => item.code);
const probe = (patch: Record<string, unknown> = {}) => ({ duration: 6, meanVolume: -18, peakVolume: -3, hasAudio: true, ...patch });

test('a clean subtitle track reports no issue and counts cues', () => {
  const result = checkSubtitles(board([scene({ subtitleCues: [{ text: '第一句', start: 0, end: 2 }, { text: '第二句', start: 2, end: 4 }] })]));
  assert.equal(result.enabled, true);
  assert.equal(result.cueCount, 2);
  assert.deepEqual(result.issues, []);
});

test('disabled subtitles still count cues but skip the issue checks', () => {
  const result = checkSubtitles(board([
    scene({ subtitleCues: [{ text: '第一句', start: 0, end: 0.2 }], narration: '第一句。' }),
    scene({ id: 'b', subtitleCues: [{ text: '第二句', start: 0, end: 2 }], narration: '第二句。' }),
  ], { subtitles: { enabled: false } }));
  assert.deepEqual(result, { enabled: false, cueCount: 2, issues: [] });
});

test('overlong captions are reported with the scene and cue position', () => {
  const result = checkSubtitles(board([scene({ subtitleCues: [{ text: '甲'.repeat(45), start: 0, end: 4 }] })]));
  const issue = result.issues.find(item => item.code === 'subtitle_too_long');
  assert.ok(issue);
  assert.equal(issue.sceneId, 'a');
  assert.equal(issue.sceneIndex, 0);
  assert.equal(issue.cueIndex, 0);
  assert.equal(issue.fix, 'open_captions');
});

test('short dwell and overlapping cues are reported', () => {
  const short = checkSubtitles(board([scene({ subtitleCues: [{ text: '一闪而过', start: 0, end: 0.4 }] })]));
  assert.ok(codes(short.issues).includes('subtitle_too_short'));

  const overlap = checkSubtitles(board([scene({ subtitleCues: [{ text: '第一句', start: 0, end: 2 }, { text: '第二句', start: 1, end: 3 }] })]));
  assert.ok(codes(overlap.issues).includes('subtitle_overlap'));
});

test('cues running past the scene window are caught before clamping hides them', () => {
  const result = checkSubtitles(board([scene({ duration: 6, audioDuration: 6, subtitleCues: [{ text: '超出场景', start: 0, end: 9 }] })]));
  assert.ok(codes(result.issues).includes('subtitle_out_of_scene'));
});

test('portrait boards use the stricter caption width budget', () => {
  const cues = [{ text: '甲'.repeat(30), start: 0, end: 4 }];
  const landscape = checkSubtitles(board([scene({ subtitleCues: cues })], { aspectRatio: '16:9' }));
  const portrait = checkSubtitles(board([scene({ subtitleCues: cues })], { aspectRatio: '9:16' }));
  assert.equal(codes(landscape.issues).includes('subtitle_too_long'), false);
  assert.equal(codes(portrait.issues).includes('subtitle_too_long'), true);
});

test('audio QC flags missing, silent, short and mismatched narration', () => {
  const scenes = [
    scene({ id: 'missing', narration: '没有音频。' }),
    scene({ id: 'silent', narration: '静音。', audioSrc: 'audio/silent.wav' }),
    scene({ id: 'short', narration: '太短。', audioSrc: 'audio/short.wav' }),
    scene({ id: 'drift', narration: '时长差异。', audioSrc: 'audio/drift.wav' }),
    scene({ id: 'fine', narration: '正常。', audioSrc: 'audio/fine.wav' }),
  ];
  const probes = new Map([
    ['silent', probe({ duration: 6, meanVolume: -60, peakVolume: -50 })],
    ['short', probe({ duration: 0.4 })],
    ['drift', probe({ duration: 12 })],
    ['fine', probe({ duration: 6.2 })],
  ]);
  const result = checkAudio(board(scenes), probes);
  const byCode = (code: string) => result.issues.filter(item => item.code === code).map(item => item.sceneId);

  assert.deepEqual(byCode('audio_missing'), ['missing']);
  assert.deepEqual(byCode('audio_silent'), ['silent']);
  assert.deepEqual(byCode('audio_too_short'), ['short']);
  assert.deepEqual(byCode('audio_duration_mismatch'), ['short', 'drift']);
  assert.equal(result.issues.find(item => item.sceneId === 'drift')?.severity, 'error');
  assert.equal(result.measurable, 4);
  assert.equal(result.issues.some(item => item.sceneId === 'fine'), false);
  assert.equal(result.issues.every(item => item.kind === 'audio'), true);
});

test('audio QC leaves unmeasurable scenes alone and reports deleted files', () => {
  const result = checkAudio(board([scene({ id: 'gone', narration: '删除了。', audioSrc: 'audio/gone.wav' }), scene({ id: 'unknown', narration: '未测量。', audioSrc: 'audio/x.wav' })]), new Map([['gone', 'missing']]));
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].sceneId, 'gone');
  assert.equal(result.issues[0].fix, 'regenerate_audio');
  assert.equal(result.measurable, 0);
});
