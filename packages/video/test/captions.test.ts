import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptionCues, captionAt } from '../src/captions';

test('letter alignment displays complete English words and keeps punctuation', () => {
  const text = 'AI helps developers. 下一句。';
  const timings = [...'AIhelpsdevelopers下一句'].map((text, i) => ({ text, start: i * 0.1, end: i * 0.1 + 0.02 }));
  const cues = buildCaptionCues(text, timings, 4);
  assert.equal(cues[0].text, 'AI helps developers.');
  for (let time = 0; time < cues[1].start; time += 1 / 30) assert.equal(captionAt(cues, time), 'AI helps developers.');
  assert.equal(captionAt(cues, 3.9), '下一句。');
});

test('old single-frame Chinese timings do not blink during pauses', () => {
  const cues = buildCaptionCues('第一句。第二句。', [{ text: '第', start: 0.2, end: 0.22 }, { text: '一', start: 0.6, end: 0.62 }, { text: '句', start: 1, end: 1.02 }, { text: '第', start: 2, end: 2.02 }, { text: '二', start: 2.5, end: 2.52 }, { text: '句', start: 3, end: 3.02 }], 4);
  assert.equal(captionAt(cues, 0), '');
  assert.equal(captionAt(cues, 1.5), '第一句。');
  assert.equal(captionAt(cues, 2), '第二句。');
});

test('missing alignment falls back to short readable phrases', () => {
  const narration = '这是一段很长的旁白。它需要分成多个短句显示，避免一次铺满整幅画面。';
  const cues = buildCaptionCues(narration, [], 10, true);
  assert.ok(cues.length > 1);
  assert.equal(cues.map(cue => cue.text).join(''), narration);
  for (let time = 0; time < 10; time += 1 / 30) assert.ok(captionAt(cues, time));
});

test('line limits never divide English words', () => {
  const cues = buildCaptionCues('The developers write maintainable implementations with documentation and meaningful examples.', [], 10, true);
  assert.ok(cues.length > 1);
  assert.equal(cues.map(cue => cue.text).join(' '), 'The developers write maintainable implementations with documentation and meaningful examples.');
});
