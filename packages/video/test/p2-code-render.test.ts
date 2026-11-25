/**
 * P2 code-scene renderer regressions: #145 / #165 step holding, #146 non-growing trace window,
 * #147 / #167 scrolling through oversized selections, #148 content-sized trace panel.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCodeScrollKeyframes } from '@m2v/schema';
import { fitTracePanel, stepIndexAt } from '../src/code-scene';

test('[#145 #165] a pause between windows holds the most recently started step', () => {
  const frames = [{ startFrame: 0, endFrame: 24 }, { startFrame: 30, endFrame: 54 }, { startFrame: 60, endFrame: 120 }];
  assert.equal(stepIndexAt(frames, 24), 0);
  assert.equal(stepIndexAt(frames, 29), 0);
  assert.equal(stepIndexAt(frames, 30), 1);
  assert.equal(stepIndexAt(frames, 57), 1);
  assert.equal(stepIndexAt(frames, 200), 2);
  assert.equal(stepIndexAt([{ startFrame: 18, endFrame: 42 }, { startFrame: 72, endFrame: 120 }], 42), 0, '#165 的例子');
});

test('[#147 #167] an oversized selection scrolls from its first to its last line within the beat', () => {
  const keyframes = resolveCodeScrollKeyframes({ beats: [{ startFrame: 0, endFrame: 100, lines: Array.from({ length: 40 }, (_, index) => index + 1) }], totalLines: 60, visibleLineCount: 16 });
  assert.equal(keyframes[0].startLine, 1, '开头可见');
  const last = keyframes.at(-1)!;
  assert.equal(last.startLine, 25, '最后能看到第 40 行');
  assert.ok(last.frame < 100, '滚动在本段内完成');
  for (let index = 1; index < keyframes.length; index += 1) assert.ok(keyframes[index].frame >= keyframes[index - 1].frame);
});

test('[#148] the trace panel fits its content and counts what does not fit', () => {
  const small = fitTracePanel({ state: [{ name: 'total', value: '3' }], widthPx: 600, maxHeightPx: 700, scale: 1 });
  assert.ok(small.heightPx > 39 + 24, `一行状态也要放得下标题和值：${small.heightPx}`);
  assert.equal(small.hidden, 0);
  const many = Array.from({ length: 12 }, (_, index) => ({ name: `v${index}`, value: 'x'.repeat(120), changed: index === 11 }));
  const fitted = fitTracePanel({ state: many, output: 'done', widthPx: 600, maxHeightPx: 300, scale: 1 });
  assert.ok(fitted.heightPx <= 300);
  assert.ok(fitted.hidden > 0);
  assert.ok(fitted.state.some(entry => entry.changed), '变化的条目优先保留');
});
