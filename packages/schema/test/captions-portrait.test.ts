import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptionCues } from '../src/captions';

test('portrait captions keep a complete 27-character Chinese sentence together at the default font size', () => {
  const narration = '第 1 项：检查缓存一致性过程中的主步骤与对应边界条件。';
  assert.equal([...narration].length, 28);
  const cues = buildCaptionCues(narration, [], 4, true, 30);
  assert.equal(cues.length, 1);
  assert.equal(cues[0]?.text, narration);
  assert.equal(cues[0]?.start, 0);
  assert.equal(cues[0]?.end, 4);
});

test('portrait caption grouping scales down with a larger configured font without dropping punctuation or text', () => {
  const narration = '第 1 项：检查缓存一致性过程中的主步骤与对应边界条件。'.repeat(2);
  const cues = buildCaptionCues(narration, [], 4, true, 72);
  assert.ok(cues.length > 1, 'large font needs shorter cue groups');
  assert.equal(cues.map(cue => cue.text).join(''), narration);
  assert.equal(cues[0]?.start, 0);
  assert.equal(cues.at(-1)?.end, 4);
});

test('portrait caption splitting preserves sentence and clause punctuation and every source character', () => {
  const narration = '先检查缓存一致性过程中的主步骤，再确认对应边界条件，最后记录可观察结果。'.repeat(3);
  const cues = buildCaptionCues(narration, [], 12, true, 30);
  assert.ok(cues.length > 1);
  assert.equal(cues.map(cue => cue.text).join(''), narration);
  assert.ok(cues.some(cue => /[，。]$/.test(cue.text)), 'groups should prefer valid clause or sentence boundaries');
  assert.ok(cues.every(cue => cue.end > cue.start));
});
