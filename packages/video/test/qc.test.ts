import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneSchema, StoryboardSchema } from '../../schema/src/index';
import { checkAudio, checkSubtitles, renderFailedIssue } from '../src/qc';

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
  assert.equal(result.silent, 0);
});

test('a scene without narration counts as deliberate silence instead of a missing file', () => {
  const result = checkAudio(board([
    scene({ id: 'quiet', narration: '   ' }),
    scene({ id: 'quiet2', narration: ' \n\t ' }),
    scene({ id: 'spoken', narration: '有台词但没音频。' }),
  ]), new Map());
  assert.equal(result.silent, 2, '没有台词的场景单独计数');
  assert.equal(result.measurable, 0);
  assert.deepEqual(result.issues.map(item => item.sceneId), ['spoken'], '只有写了台词却没音频的场景才是阻断');
  assert.equal(result.issues[0].code, 'audio_missing');
});

test('a broken background music reference is reported even when the scenes are clean', () => {
  const bgmBoard = board([scene({ id: 'a', audioSrc: 'audio/a.wav' })], { bgmSrc: 'audio/bgm.mp3' });
  const missing = checkAudio(bgmBoard, new Map([['a', probe()]]), 'missing');
  assert.equal(missing.bgm.state, 'missing');
  assert.equal(missing.issues.length, 1);
  const issue = missing.issues[0];
  assert.equal(issue.code, 'bgm_missing');
  assert.equal(issue.kind, 'audio');
  assert.equal(issue.severity, 'error');
  assert.equal(issue.fix, 'open_render');
  // No scene owns background music, so the UI must not jump to the first scene.
  assert.equal(issue.sceneId, '');
  assert.equal(issue.sceneIndex, -1);
});

test('background music states cover unreadable, silent, track-less and healthy files', () => {
  const bgmBoard = board([scene({ id: 'a', audioSrc: 'audio/a.wav' })], { bgmSrc: 'audio/bgm.mp3' });
  const probes = new Map([['a', probe()]]);
  assert.equal(checkAudio(bgmBoard, probes, 'unreadable').bgm.state, 'unreadable');
  assert.equal(checkAudio(bgmBoard, probes, probe({ peakVolume: -60, meanVolume: -62 })).bgm.state, 'silent');
  assert.equal(checkAudio(bgmBoard, probes, probe({ hasAudio: false })).bgm.state, 'no_audio');

  const healthy = checkAudio(bgmBoard, probes, probe({ peakVolume: -12, meanVolume: -20 }));
  assert.equal(healthy.bgm.state, 'ok');
  assert.deepEqual(healthy.issues, []);
});

test('background music is unknown without a probe and absent without a reference', () => {
  const probes = new Map([['a', probe()]]);
  assert.equal(checkAudio(board([scene({ id: 'a', audioSrc: 'audio/a.wav' })]), probes).bgm.state, 'none');
  assert.equal(checkAudio(board([scene({ id: 'a', audioSrc: 'audio/a.wav' })], { bgmSrc: 'audio/bgm.mp3' }), probes).bgm.state, 'unknown');
});

test('a scene below the shortest rendered duration is flagged, and its dwell is not judged', () => {
  const result = checkSubtitles(board([scene({ duration: 1, subtitleCues: [{ text: '一闪', start: 0, end: 0.2 }] })]));
  assert.deepEqual(codes(result.issues), ['scene_too_short']);
  assert.equal(result.issues[0].severity, 'warning');
  assert.equal(result.issues[0].fix, 'open_captions');
});

test('blank manual captions are reported because the renderer drops them', () => {
  const result = checkSubtitles(board([scene({ subtitleCues: [{ text: '   ', start: 0, end: 2 }] })]));
  assert.deepEqual(codes(result.issues), ['subtitle_empty']);
  assert.equal(result.issues[0].cueIndex, 0);
});

test('a failed render becomes a blocking render issue with its reason', () => {
  const issue = renderFailedIssue({ id: 'job-1', error: '  ffmpeg exited 1  ', createdAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(issue.kind, 'render');
  assert.equal(issue.code, 'render_failed');
  assert.equal(issue.severity, 'error');
  assert.equal(issue.fix, 'open_render');
  assert.match(issue.message, /ffmpeg exited 1/);
  assert.match(issue.message, /2026-01-01T00:00:00\.000Z/);
  assert.match(renderFailedIssue({ id: 'job-2', error: null, createdAt: new Date(0) }).message, /未提供原因/);
});
