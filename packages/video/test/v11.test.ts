import test from 'node:test';
import assert from 'node:assert/strict';
import { StoryboardSchema, sceneSeconds, storyboardWarnings } from '../../schema/src/index';
import { exportSubtitles } from '../src/subtitles';
const board = () => StoryboardSchema.parse({ title: '例子', styleId: 'minimal-tech', scenes: [{ id: 'a', type: 'title', title: '一', narration: '第一句。', duration: 3, audioDuration: 2, sceneGap: 1 }, { id: 'b', type: 'title', narration: '第二句。', duration: 3 }] });
test('subtitle formats share frame-rounded scene boundaries, including trailing gaps', () => {
  const value = board();
  assert.equal(sceneSeconds(value.scenes[0]), 4);
  assert.match(exportSubtitles(value, 'srt'), /00:00:04,000 --> 00:00:07,000/);
  assert.match(exportSubtitles(value, 'vtt'), /^WEBVTT/);
  assert.match(exportSubtitles(value, 'vtt'), /00:00:04\.000/);
  assert.match(exportSubtitles(value, 'ass'), /Dialogue: 0,0:00:04.00,0:00:07.00/);
});
test('ASS exports portrait resolution, position and safe literal text', () => {
  const value = StoryboardSchema.parse({ ...board(), aspectRatio: '9:16', subtitles: { position: 'top', color: '#ff0000', fontSize: 42 }, scenes: [{ ...board().scenes[0], narration: '{\\an9}内容' }] });
  const output = exportSubtitles(value, 'ass');
  assert.match(output, /PlayResX: 1080/); assert.match(output, /PlayResY: 1920/); assert.match(output, /Microsoft YaHei,42,&H000000FF/);
  assert.ok(!output.includes('{\\an9}'));
});
test('ASS writes custom caption colours, background opacity and the 16:9 canvas', () => {
  const value = StoryboardSchema.parse({ ...board(), subtitles: { preset: 'boxed', fontSize: 34, color: '#ffcc00', background: '#112233', backgroundOpacity: .65 } });
  const output = exportSubtitles(value, 'ass');
  assert.match(output, /PlayResX: 1920/); assert.match(output, /PlayResY: 1080/);
  assert.ok(output.includes('Style: Default,Microsoft YaHei,34,&H0000CCFF,&H0000CCFF,&H59332211,&H59332211,-1,0,0,0,100,100,0,0,3,2,0,2,96,96,54,1'), output.split('\n').find(line => line.startsWith('Style:')));
});
test('minimal captions keep only a text outline instead of a box', () => {
  const value = StoryboardSchema.parse({ ...board(), subtitles: { preset: 'minimal', fontSize: 34, color: '#ffcc00', background: '#112233', backgroundOpacity: .65 } });
  assert.ok(exportSubtitles(value, 'ass').includes('Style: Default,Microsoft YaHei,34,&H0000CCFF,&H0000CCFF,&H59332211,&H59332211,-1,0,0,0,100,100,0,0,1,2,0,2,96,96,54,1'));
});
test('caption settings survive a schema round trip instead of falling back to defaults', () => {
  const saved = StoryboardSchema.parse({ ...board(), subtitles: { preset: 'boxed', color: '#ffcc00', background: '#112233', backgroundOpacity: .65 } });
  const reloaded = StoryboardSchema.parse(JSON.parse(JSON.stringify(saved))).subtitles!;
  assert.equal(reloaded.color, '#ffcc00'); assert.equal(reloaded.background, '#112233'); assert.equal(reloaded.backgroundOpacity, .65);
  assert.equal(reloaded.preset, 'boxed');
});
test('legacy settings remain readable and unsafe control values fail validation', () => {
  assert.equal(board().subtitles, undefined);
  assert.equal(StoryboardSchema.safeParse({ ...board(), subtitles: { fontSize: 200 } }).success, false);
  assert.equal(StoryboardSchema.safeParse({ ...board(), scenes: [{ ...board().scenes[0], speechSpeed: 0 }] }).success, false);
  const dense = board(); dense.scenes[0].narration = '长正文'.repeat(300);
  assert.equal(storyboardWarnings(dense)[0].sceneId, 'a');
});
