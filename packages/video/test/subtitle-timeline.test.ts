import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneSchema, StoryboardSchema } from '../../schema/src/index';
import { exportSubtitles, subtitleCues, validateSubtitleTimeline } from '../src/subtitles';

const scene = (patch: Record<string, unknown> = {}) => SceneSchema.parse({ id: 'a', type: 'title', narration: '第一句。第二句。', visual: {}, duration: 6, ...patch });
const board = (scenes: Record<string, unknown>[], patch: Record<string, unknown> = {}) => StoryboardSchema.parse({ title: '例子', styleId: 'minimal-tech', scenes, ...patch });

test('a clean cue list validates and reports the exported timeline length', () => {
  const result = validateSubtitleTimeline(board([scene({ subtitleCues: [{ text: '第一句', start: 0, end: 2 }, { text: '第二句', start: 2, end: 4 }] })]));
  assert.equal(result.ok, true);
  assert.equal(result.cues, 2);
  assert.equal(result.total > 0, true);
  assert.deepEqual(result.issues, []);
});

test('overlapping cues are rejected before packaging', () => {
  const result = validateSubtitleTimeline(board([scene({ subtitleCues: [{ text: '第一句', start: 0, end: 3 }, { text: '第二句', start: 2, end: 4 }] })]));
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(issue => issue.code), ['overlap']);
});

test('cues past an explicit render duration are reported', () => {
  const result = validateSubtitleTimeline(board([scene({ subtitleCues: [{ text: '很靠后', start: 0, end: 5 }] })]), 2);
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(issue => issue.code), ['past_end']);
  assert.match(result.issues[0].message, /超出成片时长/);
});

test('cue offsets follow the timeline, not each scene start', () => {
  const cues = subtitleCues(board([
    scene({ id: 'a', duration: 6, subtitleCues: [{ text: '第一句', start: 0, end: 2 }] }),
    scene({ id: 'b', duration: 6, subtitleCues: [{ text: '第二句', start: 0, end: 2 }] }),
  ]));
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 0);
  assert.equal(cues[1].start >= 6, true, '第二条字幕要落在第二个场景内');
});

test('subtitle exporters share the same cue list', () => {
  const storyboard = board([scene({ subtitleCues: [{ text: '第一句', start: 0, end: 2 }] })]);
  const srt = exportSubtitles(storyboard, 'srt');
  assert.match(srt, /^1\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n第一句/);
  assert.match(exportSubtitles(storyboard, 'vtt'), /^WEBVTT\n\n1\n\d{2}:\d{2}:\d{2}\.\d{3}/);
  const ass = exportSubtitles(storyboard, 'ass');
  assert.match(ass, /\[Script Info\]/);
  assert.match(ass, /Dialogue: 0,/);
  assert.match(ass, /第一句/);
});
