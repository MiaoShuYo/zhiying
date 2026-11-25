/**
 * P2 code-scene regressions (schema side): #143 build focus, #151 code points, #164 beat minimum,
 * #167 oversized beat spans.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCodeBeatTimeline, resolveCodeBuildSteps, resolveCodeViewport, tokenizeCode } from '../src/index';

test('[#167] a beat taller than the viewport starts at its first selected line', () => {
  const viewport = resolveCodeViewport({ totalLines: 60, visibleLineCount: 16, activeLines: [1, 60] });
  assert.equal(viewport.startLine, 1);
  assert.equal(viewport.endLine, 16);
});

test('[#164] a late first anchor keeps the minimum for every following beat', () => {
  const code = Array.from({ length: 6 }, (_, index) => `line${index + 1}`).join('\n');
  const scene = {
    duration: 4, audioDuration: 4,
    wordTimings: [{ text: '最后', start: 3.97, end: 4 }],
    visual: { code, beats: [{ lines: [1], narrationText: '最后' }, { lines: [2] }, { lines: [3] }] },
  };
  const frames = resolveCodeBeatTimeline(scene, 30);
  assert.equal(frames.length, 3);
  for (const frame of frames) assert.ok(frame.endFrame - frame.startFrame >= 18, `每段至少 0.6 秒：${JSON.stringify(frames)}`);
  for (let index = 1; index < frames.length; index += 1) assert.ok(frames[index].startFrame >= frames[index - 1].endFrame, '窗口不重叠');
  assert.equal(frames.at(-1)!.endFrame, 120);
});

test('[#143] a build step cannot focus a line that is not revealed yet', () => {
  const code = Array.from({ length: 50 }, (_, index) => `x${index + 1}`).join('\n');
  const all = Array.from({ length: 50 }, (_, index) => index + 1);
  const bad = resolveCodeBuildSteps({ code, mode: 'build', buildSteps: [{ revealLines: [1], focusLines: [50] }, { revealLines: all.slice(1) }] } as never);
  assert.equal(bad, null);
  const good = resolveCodeBuildSteps({ code, mode: 'build', buildSteps: [{ revealLines: [1], focusLines: [1] }, { revealLines: all.slice(1), focusLines: [50] }] } as never);
  assert.ok(good);
});

test('[#151] supplementary characters stay one token', () => {
  const texts: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { if (key === 'text' && typeof item === 'string') texts.push(item); else visit(item); }
  };
  visit(tokenizeCode('const 𝑥 = 1;', 'javascript'));
  assert.ok(texts.length > 0);
  assert.ok(texts.every(text => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)), `不能出现落单的代理项：${JSON.stringify(texts)}`);
  assert.ok(texts.some(text => text.includes('𝑥')));
});
