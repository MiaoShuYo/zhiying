/**
 * P1 last batch: #189 brand HTML colours, #142 trace evidence, #144 / #158 code narration guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { brandSceneHtml } from '@m2v/schema';
import { buildStoryboardSceneOrFallback, traceBackedBySource } from '../src/lib/pipeline';

const brand = { bg: '#101010', fg: '#fafafa', muted: '#999999', accent: '#ff0055', card: '#202020', secondary: '#303030' };

test('[#189] generated HTML palette colours follow the brand, other colours stay', () => {
  const html = '<div style="background:linear-gradient(135deg,#11162d,#090d1b);color:#fff;border:1px solid #7c3aed88"><span style="color:#06b6d4">x</span><i style="color:#123456">y</i></div>';
  const branded = brandSceneHtml(html, brand);
  assert.match(branded, /#202020/);
  assert.match(branded, /#101010/);
  assert.match(branded, /color:#fafafa/);
  assert.match(branded, /#ff005588/, '保留透明度后缀');
  assert.match(branded, /#123456/, '非版式颜色不变');
  assert.doesNotMatch(branded, /#7c3aed|#06b6d4|#11162d/);
});

const code = 'function add(a, b) {\n  return a + b;\n}\nconsole.log(add(1, 2));';
const chapter = { title: '加法', text: '调用 add(1, 2) 输出 3。', codeBlocks: [{ code, language: 'js' }] };

test('[#142] trace values need source evidence', () => {
  assert.equal(traceBackedBySource([{ state: [{ value: '1' }, { value: '2' }], output: '3' }], chapter as never), true);
  assert.equal(traceBackedBySource([{ state: [{ value: '42' }], output: '99' }], chapter as never), false);
  const built = buildStoryboardSceneOrFallback(chapter as never, {
    type: 'code', narration: '这段代码把两个数相加，然后打印结果，调用时传入一和二。',
    visual: { code, language: 'js', mode: 'trace', traceSteps: [{ lines: [4], state: [{ name: 'a', value: '42' }], output: '99' }] },
  });
  assert.equal(built.fallbackUsed, false);
  assert.equal((built.scene.visual as { mode?: string }).mode, 'focus');
  assert.match(built.modeFallback ?? '', /trace/);
});

test('[#144] a diff downgraded to focus still rejects narration that reads source code', () => {
  const built = buildStoryboardSceneOrFallback(chapter as never, {
    type: 'code', narration: '先看 return a + b; 这一行，它把两个参数相加并返回结果给调用方。',
    visual: { code, language: 'js', mode: 'diff', beforeCode: 'function add() {}' },
  });
  assert.equal(built.fallbackUsed, true);
  assert.match(built.validationError ?? '', /旁白/);
});
