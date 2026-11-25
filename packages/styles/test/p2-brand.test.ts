/**
 * P2 brand regressions: #149 uppercase brand hex in code token contrast.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio, resolveCodeTokenColors } from '../src/code-token-colors';

test('[#149] an uppercase white card is parsed as white, so token colours stay readable on it', () => {
  const upper = { bg: '#FFFFFF', fg: '#111111', muted: '#666666', accent: '#FFEE88', card: '#FFFFFF', secondary: '#FFF8D0' };
  const lower = Object.fromEntries(Object.entries(upper).map(([key, value]) => [key, value.toLowerCase()])) as typeof upper;
  const colors = resolveCodeTokenColors(upper) as unknown as Record<string, string>;
  assert.deepEqual(colors, resolveCodeTokenColors(lower) as unknown as Record<string, string>, '大小写不影响结果');
  for (const value of Object.values(colors)) assert.ok(contrastRatio(value, '#ffffff') >= 3, `${value} 在白色卡片上对比度不足`);
});
