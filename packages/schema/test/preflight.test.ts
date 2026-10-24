import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneSchema, StoryboardSchema, preflight } from '../src/index';

const scene = (patch: Record<string, unknown> = {}) => SceneSchema.parse({ id: 'a', type: 'title', narration: '第一句。第二句。', visual: {}, duration: 6, ...patch });
const board = (scenes: Record<string, unknown>[], patch: Record<string, unknown> = {}) => StoryboardSchema.parse({ title: '例子', styleId: 'minimal-tech', scenes, ...patch });
const codes = (result: ReturnType<typeof preflight>) => result.issues.map(issue => issue.code);

test('a complete scene passes with no blocking issue', () => {
  const result = preflight(board([scene({ audioSrc: 'audio/a.wav', audioDuration: 6 })]), []);
  assert.equal(result.blocking, 0);
  assert.deepEqual(codes(result), []);
  assert.equal(result.estimatedSeconds, 6);
});

test('media scenes must point at a registered project asset', () => {
  // The schema rejects these shapes, so stale boards are simulated after parsing.
  const valid = board([scene({ type: 'media', visual: { src: 'projects/p/assets/x.png' }, audioSrc: 'audio/a.wav', audioDuration: 6 })]);
  const withVisual = (visual: Record<string, unknown>) => ({ ...valid, scenes: [{ ...valid.scenes[0], visual }] });

  const noSource = preflight(withVisual({}), []);
  assert.equal(noSource.blocking, 1);
  assert.equal(noSource.issues[0].code, 'missing_image');
  assert.equal(noSource.issues[0].sceneIndex, 0);

  const outside = preflight(withVisual({ src: '/tmp/x.png' }), []);
  assert.equal(outside.issues[0].code, 'missing_image');

  const unregistered = preflight(valid, [{ path: 'projects/p/assets/y.png' }]);
  assert.equal(unregistered.issues[0].code, 'missing_image');
  assert.match(unregistered.issues[0].message, /没有登记/);

  const ok = preflight(valid, [{ path: 'projects/p/assets/x.png' }]);
  assert.deepEqual(codes(ok), []);
});

test('missing files are only reported when the server supplies a filesystem check', () => {
  const storyboard = board([scene({ type: 'media', visual: { src: 'projects/p/assets/x.png' }, audioSrc: 'audio/a.wav', audioDuration: 6 })]);
  const assets = [{ path: 'projects/p/assets/x.png' }];
  assert.deepEqual(codes(preflight(storyboard, assets)), []);
  const checked = preflight(storyboard, assets, { exists: path => path !== 'projects/p/assets/x.png' });
  assert.deepEqual(codes(checked), ['missing_file']);
  assert.equal(checked.blocking, 1);
  const bgmGone = preflight(board([scene({ audioSrc: 'audio/a.wav', audioDuration: 6 })], { bgmSrc: 'audio/bgm.mp3' }), [], { exists: () => false });
  assert.ok(codes(bgmGone).includes('missing_bgm'));
  const audioGone = preflight(board([scene({ audioSrc: 'audio/a.wav', audioDuration: 6 })]), [], { exists: () => false });
  assert.deepEqual(codes(audioGone), ['missing_file']);
});

test('narration without generated voice blocks the export', () => {
  const result = preflight(board([scene({ narration: '还没有语音。' })]), []);
  assert.equal(result.issues[0].code, 'missing_audio');
  assert.equal(result.issues[0].severity, 'error');
  assert.equal(result.issues[0].fix, 'generate_audio');
});

test('very long narration gets a rewrite warning and belongs to the narration checklist', async () => {
  const { preflightCategoryOf } = await import('../src/index');
  const result = preflight(board([scene({ narration: '长旁白。'.repeat(180), duration: 360, audioSrc: 'audio/a.wav', audioDuration: 360 })]), []);
  const issue = result.issues.find(item => item.code === 'narration_too_long');
  assert.ok(issue);
  assert.equal(issue.severity, 'warning');
  assert.equal(issue.fix, 'rewrite_narration');
  assert.equal(preflightCategoryOf(issue), 'narration');
  assert.match(issue.message, /拆分场景或精简旁白/);
});

test('manual cues that overflow or overrun the scene are warned with a scene pointer', () => {
  const long = preflight(board([scene({ audioSrc: 'audio/a.wav', audioDuration: 6, subtitleCues: [{ text: '字幕'.repeat(20), start: 0, end: 2 }] })]), []);
  assert.equal(long.issues[0].code, 'caption_overflow');
  assert.equal(long.issues[0].severity, 'warning');
  assert.equal(long.blocking, 0);

  const late = preflight(board([scene({ audioSrc: 'audio/a.wav', audioDuration: 4, subtitleCues: [{ text: '一', start: 0, end: 9 }] })]), []);
  assert.equal(late.issues[0].code, 'caption_overtime');
  assert.match(late.issues[0].message, /4\.00 秒/);
});

test('portrait output uses the narrower caption limit', () => {
  const text = '一'.repeat(30);
  const cues = [{ text, start: 0, end: 2 }];
  const wide = preflight(board([scene({ audioSrc: 'audio/a.wav', audioDuration: 6, subtitleCues: cues })]), []);
  const tall = preflight(board([scene({ audioSrc: 'audio/a.wav', audioDuration: 6, subtitleCues: cues })], { aspectRatio: '9:16' }), []);
  assert.deepEqual(codes(wide), []);
  assert.deepEqual(codes(tall), ['caption_overflow']);
});

test('narration with an unbreakable run warns about automatic captions', () => {
  const result = preflight(board([scene({ narration: '一'.repeat(50), audioSrc: 'audio/a.wav', audioDuration: 6 })]), []);
  assert.equal(result.issues[0].code, 'caption_overflow');
  assert.equal(result.issues[0].sceneIndex, 0);
});

test('short scenes, duration drift and disabled subtitles are informational or warning level', () => {
  const result = preflight(board([scene({ audioSrc: 'audio/a.wav', audioDuration: 2, duration: 2 })], { durationTarget: 60 }), []);
  const found = codes(result);
  assert.ok(found.includes('scene_too_short'));
  assert.ok(found.includes('duration_target_miss'));
  assert.equal(result.issues.find(issue => issue.code === 'duration_target_miss')?.severity, 'info');
  assert.equal(result.blocking, 0);
  const muted = preflight(board([scene({ audioSrc: 'audio/a.wav', audioDuration: 6 })], { subtitles: { enabled: false } }), []);
  assert.deepEqual(codes(muted), ['subtitles_off']);
});

test('estimated duration and resolution follow the preset and aspect ratio', () => {
  const storyboard = board([scene({ audioDuration: 5, duration: 6, sceneGap: 1 }), scene({ id: 'b', duration: 4 })], { aspectRatio: '9:16' });
  const full = preflight(storyboard, []);
  assert.equal(full.estimatedSeconds, 11);
  assert.equal(full.width, 1080);
  assert.equal(full.height, 1920);
  assert.equal(full.preset, 'full');
  const draft = preflight(storyboard, [], { preset: 'draft' });
  assert.equal(draft.width, 540);
  assert.equal(draft.height, 960);
  assert.equal(draft.preset, 'draft');
  const landscape = preflight(board([scene({ audioDuration: 6 })]), [], { preset: 'draft' });
  assert.equal(landscape.width, 960);
  assert.equal(landscape.height, 540);
});
