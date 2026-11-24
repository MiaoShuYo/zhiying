/**
 * P1 pipeline regressions: #199 PPT fallback narration never reads internal labels aloud.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreservedSlideScene, fallbackChapter, slideFallbackText } from '../src/lib/pipeline';

test('[#199] slide fallbacks narrate notes or body without the internal labels', () => {
  const withNotes = { title: '第 3 页', text: '演讲者备注（优先旁白依据）：\n备注里的重点。\n\n页面内容（补充依据）：\n页面正文。', page: 3 };
  assert.equal(slideFallbackText(withNotes.text), '备注里的重点。');
  const scene = buildPreservedSlideScene(withNotes, { narration: '' }, 'projects/p/assets/slide-003.png').scene;
  assert.doesNotMatch(scene.narration, /演讲者备注|页面内容|优先旁白依据|补充依据/);
  const bodyOnly = { title: '第 4 页', text: '页面内容：\n只有正文的一页。', page: 4 };
  assert.doesNotMatch(fallbackChapter(bodyOnly).narration, /页面内容/);
  assert.equal(slideFallbackText('普通章节正文'), null, '非幻灯片章节不受影响');
});
