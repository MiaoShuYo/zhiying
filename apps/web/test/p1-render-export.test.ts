/**
 * P1 render/export regressions: #203 HTML scenes follow their data, #206 HTML math is typeset,
 * #251 a failed verdict is not "passed", #252 empty 416 body.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportFlow, SceneSchema, sanitizeSceneHtml } from '@m2v/schema';
import { MATH_FORMULA_CLASS, structuredSceneHtml, syncSceneHtml } from '../src/lib/scene-html-builder';
import { videoHeaders, videoStreamResponse } from '../src/lib/video-range';

const htmlScene = (patch: Record<string, unknown>) => {
  const scene = SceneSchema.parse({ id: 's1', type: 'text', title: '旧标题', narration: '旁白', visual: { text: '旧正文' }, duration: 6, ...patch });
  return { ...scene, visual: { ...scene.visual, html: sanitizeSceneHtml(structuredSceneHtml(scene, 6)) } };
};

test('[#203] changing type, title or data rebuilds an HTML scene and keeps its design', () => {
  const before = htmlScene({});
  const retitled = syncSceneHtml(before, { ...before, title: '新标题' });
  assert.match(String(retitled.visual.html), /新标题/);
  assert.doesNotMatch(String(retitled.visual.html), /旧标题/);
  assert.match(String(retitled.visual.html), /知识拆解　✦　07/, '保留原来的版式编号');
  const comparison = syncSceneHtml(before, { ...before, type: 'comparison', visual: { html: before.visual.html, columns: [{ title: '甲', items: ['一', '二'] }, { title: '乙', items: ['三', '四'] }] } });
  assert.match(String(comparison.visual.html), /双向对照/);
  // An edit that sets the markup itself is kept verbatim; no source change keeps it too.
  const manual = { ...before, visual: { ...before.visual, html: '<div>手写</div>' } };
  assert.equal(syncSceneHtml(before, manual).visual.html, '<div>手写</div>');
  assert.equal(syncSceneHtml(before, { ...before }).visual.html, before.visual.html);
});

test('[#206] HTML math scenes mark the formula for KaTeX typesetting', () => {
  const scene = SceneSchema.parse({ id: 'm', type: 'math', title: '分数', narration: '分数', visual: { formula: '\\frac{a}{b}' }, duration: 6 });
  const html = sanitizeSceneHtml(structuredSceneHtml(scene, 0));
  assert.match(html, new RegExp(`<p class="${MATH_FORMULA_CLASS}"[^>]*>\\\\frac\\{a\\}\\{b\\}</p>`), '清洗后保留标记与可回退的文本');
});

test('[#251] a stored verdict with blocking failures fails the validate step', () => {
  const job = { id: 'j', status: 'completed', updatedAt: new Date().toISOString(), hasValidation: true, videoState: 'current' as const };
  const failed = exportFlow({ blocking: 0, checkedRevision: 1, revision: 1, job: { ...job, validationFailure: '文件无法读取：坏了' }, delivery: null });
  const step = failed.steps.find(item => item.key === 'validate')!;
  assert.equal(step.state, 'failed');
  assert.match(step.message, /文件无法读取/);
  assert.equal(failed.resumeFrom, 'validate');
  const passed = exportFlow({ blocking: 0, checkedRevision: 1, revision: 1, job: { ...job, validationFailure: null }, delivery: null });
  assert.equal(passed.steps.find(item => item.key === 'validate')!.state, 'passed');
});

test('[#252] an unsatisfiable range answers 416 with an empty-body length', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm2v-range-'));
  try {
    const file = join(dir, 'a.mp4');
    await writeFile(file, Buffer.alloc(100));
    const response = videoStreamResponse(file, 100, 'bytes=500-', videoHeaders(100, 'inline'));
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-length'), '0');
    assert.equal(response.headers.get('content-range'), 'bytes */100');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
