import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedNarration, fallbackChapter, modelChapterExcerpt } from '../src/lib/pipeline';

test('model narration is truncated at a readable boundary and makes truncation visible', () => {
  const narration = boundedNarration(`${'句子内容。'.repeat(60)}更多内容`);
  assert.ok([...narration].length <= 261);
  assert.ok(narration.endsWith('…'));
  assert.ok(narration.endsWith('。…'), 'prefer a complete sentence when one is available');
});

test('model requests keep long source chapters within a readable context excerpt', () => {
  const source = { title: 'Long chapter', text: '正文内容。'.repeat(1000), page: 3 };
  const excerpt = modelChapterExcerpt(source);
  assert.ok([...excerpt.text].length <= 401);
  assert.ok(excerpt.text.endsWith('…'));
  assert.equal(excerpt.page, 3);
  assert.equal(source.text.length, 5000, 'the original chapter stays intact');
});

test('fallback storyboard keeps long source chapters from becoming hour-long narration', () => {
  const source = '长章节内容。'.repeat(1000);
  const scene = fallbackChapter({ title: 'Long chapter', text: source });
  assert.ok([...scene.narration].length <= 261);
  assert.ok((scene.duration ?? 0) <= 53);
  assert.ok(scene.narration.endsWith('…'), 'truncation is visible to the editor');
  assert.ok(Array.isArray(scene.visual.items) && scene.visual.items.length === 5, 'the fallback still uses source sentences for visual bullets');
});

test('fallback storyboard keeps ordinary chapters intact', () => {
  const scene = fallbackChapter({ title: 'Short chapter', text: '第一句。第二句。' });
  assert.equal(scene.narration, '第一句。第二句。');
  assert.equal(scene.duration, 12);
});
