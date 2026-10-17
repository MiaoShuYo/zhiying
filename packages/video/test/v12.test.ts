import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneSchema, StoryboardSchema, timelineFrames } from '../../schema/src/index';
import { captionDuration, hasManualCues, resolveCaptionCues } from '../src/captions';
import { exportSubtitles } from '../src/subtitles';

const scene = (patch: Record<string, unknown> = {}) => SceneSchema.parse({ id: 'a', type: 'title', narration: '第一句。第二句。', visual: {}, duration: 6, ...patch });
const board = (scenes: Record<string, unknown>[]) => StoryboardSchema.parse({ title: '例子', styleId: 'minimal-tech', scenes });

test('scene schema accepts hand-timed cues and rejects inverted or oversized lists', () => {
  assert.equal(scene({ subtitleCues: [{ text: '第一句', start: 0, end: 1.2 }, { text: '第二句', start: 1.2, end: 3 }] }).subtitleCues?.length, 2);
  assert.equal(SceneSchema.safeParse({ id: 'a', type: 'title', narration: 'x', subtitleCues: [{ text: 'a', start: 2, end: 2 }] }).success, false);
  assert.equal(SceneSchema.safeParse({ id: 'a', type: 'title', narration: 'x', subtitleCues: [{ text: '', start: 0, end: 1 }] }).success, false);
  assert.equal(SceneSchema.safeParse({ id: 'a', type: 'title', narration: 'x', subtitleCues: Array.from({ length: 61 }, (_, i) => ({ text: 't', start: i, end: i + .5 })) }).success, false);
});

test('manual cues win over word alignments and stay scene-relative', () => {
  const value = scene({
    audioDuration: 4,
    wordTimings: [{ text: '第一句', start: 0, end: .8 }, { text: '第二句', start: .9, end: 1.6 }],
    subtitleCues: [{ text: '手动一', start: 0, end: 1.5 }, { text: '手动二', start: 1.5, end: 3.5 }],
  });
  assert.deepEqual(resolveCaptionCues(value, captionDuration(value), false), [{ text: '手动一', start: 0, end: 1.5 }, { text: '手动二', start: 1.5, end: 3.5 }]);
  assert.equal(hasManualCues(value), true);
  // Without hand-timed cues the resolver falls back to the alignment-based builder.
  assert.equal(hasManualCues(scene()), false);
  assert.ok(resolveCaptionCues(scene({ audioDuration: 4 }), 4, false).length > 0);
});

test('captionDuration prefers the real audio length so timing never drifts', () => {
  assert.equal(captionDuration({ audioDuration: 3.2, duration: 6 }), 3.2);
  assert.equal(captionDuration({ duration: 8 }), 8);
  assert.equal(captionDuration({ duration: 2 }), 3);
  assert.equal(captionDuration({}), 6);
});

test('manual cues are clamped into the scene instead of overflowing it', () => {
  const value = scene({ duration: 3, subtitleCues: [{ text: '长', start: 2, end: 9 }, { text: '晚', start: 30, end: 40 }] });
  const cues = resolveCaptionCues(value, captionDuration(value), false);
  assert.equal(cues.length, 2);
  for (const cue of cues) assert.ok(cue.start >= 0 && cue.end <= 3 && cue.end > cue.start, JSON.stringify(cues));
});

test('SRT export re-bases manual cues onto the storyboard timeline', () => {
  const value = board([
    { id: 'a', type: 'title', narration: '第一段', duration: 4, audioDuration: 4, subtitleCues: [{ text: '一甲', start: 0, end: 1 }, { text: '一乙', start: 1, end: 3.5 }] },
    { id: 'b', type: 'title', narration: '第二段', duration: 4, audioDuration: 4, subtitleCues: [{ text: '二甲', start: .5, end: 2 }] },
  ]);
  const srt = exportSubtitles(value, 'srt');
  assert.match(srt, /00:00:00,000 --> 00:00:01,000\n一甲/); assert.match(srt, /00:00:01,000 --> 00:00:03,500\n一乙/);
  assert.match(srt, /00:00:04,500 --> 00:00:06,000\n二甲/);
  const ass = exportSubtitles(value, 'ass');
  assert.match(ass, /Dialogue: 0,0:00:04.50,0:00:06.00,Default,,0,0,0,,二甲/);
});

test('auto and manual cues share one code path in every export format', () => {
  const auto = board([{ id: 'a', type: 'title', narration: '自动字幕。', duration: 4, audioDuration: 4 }]);
  const manual = board([{ id: 'a', type: 'title', narration: '自动字幕。', duration: 4, audioDuration: 4, subtitleCues: [{ text: '手写字幕', start: 0, end: 4 }] }]);
  assert.ok(exportSubtitles(auto, 'srt').includes('自动字幕'));
  assert.ok(exportSubtitles(manual, 'srt').includes('手写字幕'));
  assert.ok(exportSubtitles(manual, 'vtt').includes('手写字幕'));
  assert.ok(exportSubtitles(manual, 'ass').includes('手写字幕'));
});

test('manual cues survive a storyboard round trip unchanged', () => {
  const value = board([{ id: 'a', type: 'title', narration: '第一句。', subtitleCues: [{ text: '一', start: 0.25, end: 1.75 }] }]);
  const again = StoryboardSchema.parse(JSON.parse(JSON.stringify(value)));
  assert.deepEqual(again.scenes[0].subtitleCues, value.scenes[0].subtitleCues);
});

test('an intro pushes exported subtitles past the frame card', () => {
  const plain = board([{ id: 'a', type: 'title', narration: '第一句。', duration: 4, subtitleCues: [{ text: '一', start: 0, end: 2 }] }]);
  const withIntro = StoryboardSchema.parse({ ...plain, intro: { enabled: true, title: '开场', duration: 3 } });
  assert.match(exportSubtitles(plain, 'srt'), /00:00:00,000 --> 00:00:02,000/);
  assert.match(exportSubtitles(withIntro, 'srt'), /00:00:03,000 --> 00:00:05,000/);
  assert.doesNotMatch(exportSubtitles(withIntro, 'srt'), /00:00:00,000 -->/);
});

test('the composition length follows the timeline, not just the scenes', () => {
  const plain = board([{ id: 'a', type: 'title', narration: '第一句。', duration: 4 }]);
  const framed = StoryboardSchema.parse({ ...plain, intro: { enabled: true, duration: 3 }, outro: { enabled: true, duration: 2 } });
  assert.equal(timelineFrames(plain, 30).totalFrames, 120);
  assert.equal(timelineFrames(framed, 30).totalFrames, 270);
  assert.equal(timelineFrames(StoryboardSchema.parse({ ...plain, intro: { enabled: false, duration: 3 } }), 30).totalFrames, 120);
});
