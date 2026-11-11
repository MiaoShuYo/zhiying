import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrandPalette, CodeTokenType } from '@m2v/schema';
import { contrastRatio, palettes, resolveCodeTokenColors } from '../src/index';

/**
 * #23-9 契约：主题化 token 颜色（doc/V1.6.9_issues.md §2.3）。
 * 5 套内置 style + brand 调色板都必须达到与代码窗口背景 `card` 的 ≥3:1 对比度，且颜色合法。
 */

const TOKEN_TYPES: CodeTokenType[] = ['plain', 'keyword', 'string', 'comment', 'number', 'function', 'variable', 'punctuation'];
const HEX = /^#[0-9a-f]{6}$/i;

/** 契约基础映射：token 类型 → palette 字段。 */
const BASE_MAPPING: Record<CodeTokenType, keyof BrandPalette> = {
  plain: 'fg',
  variable: 'fg',
  function: 'fg',
  punctuation: 'muted',
  comment: 'muted',
  keyword: 'accent',
  number: 'accent',
  string: 'secondary',
};

const brandPalettes: { name: string; palette: BrandPalette }[] = [
  {
    name: '深色品牌',
    palette: { bg: '#101820', fg: '#f4f4f4', muted: '#b1bbc5', accent: '#fa8058', card: '#202b35', secondary: '#354654' },
  },
  {
    name: '极浅品牌（全部低对比）',
    palette: { bg: '#ffffff', fg: '#eeeeee', muted: '#dddddd', accent: '#ffff00', card: '#ffffff', secondary: '#f0f0f0' },
  },
  {
    name: '退化灰（所有颜色相同）',
    palette: { bg: '#808080', fg: '#808080', muted: '#808080', accent: '#808080', card: '#808080', secondary: '#808080' },
  },
];

test('#23-9 contrastRatio：黑白 21、同色 1、对称且有限', () => {
  assert.ok(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 0.05, '黑白对比度应为 21');
  assert.ok(Math.abs(contrastRatio('#ffffff', '#000000') - 21) < 0.05, '黑白对比度与顺序无关');
  assert.equal(contrastRatio('#123456', '#123456'), 1, '同色对比度为 1');
  for (const [foreground, background] of [['#50e3c2', '#111b2c'], ['#192438', '#ffffff'], ['#f3f7ff', '#080d19']]) {
    const forward = contrastRatio(foreground, background);
    const backward = contrastRatio(background, foreground);
    assert.ok(Number.isFinite(forward) && forward >= 1, 'contrastRatio 为 ≥1 的有限数');
    assert.ok(Math.abs(forward - backward) < 1e-9, '对比度对称');
  }
});

test('#23-9 5 套内置 style：全部 token 颜色合法、与 card 对比度 ≥3:1、基础映射在足够对比时保持不变', () => {
  const styleIds = Object.keys(palettes) as (keyof typeof palettes)[];
  assert.equal(styleIds.length, 5, '5 套内置 style');
  for (const styleId of styleIds) {
    const palette = palettes[styleId];
    const colors = resolveCodeTokenColors(palette);
    assert.deepEqual(Object.keys(colors).sort(), [...TOKEN_TYPES].sort(), `${styleId}: 必须覆盖全部 8 个 token 类型`);
    for (const type of TOKEN_TYPES) {
      const color = colors[type];
      assert.equal(typeof color, 'string', `${styleId}/${type}: 颜色必须是字符串`);
      assert.match(color, HEX, `${styleId}/${type}: 颜色必须是合法 #rrggbb：${String(color)}`);
      assert.doesNotMatch(color, /NaN|undefined/i, `${styleId}/${type}: 不得出现 NaN/undefined`);
      const ratio = contrastRatio(color, palette.card);
      assert.ok(Number.isFinite(ratio), `${styleId}/${type}: 对比度必须有限`);
      assert.ok(ratio >= 3 - 1e-9, `${styleId}/${type}: 与 card 对比度 ${ratio.toFixed(2)} 必须 ≥ 3:1`);
      // 基础映射颜色本身已满足 3:1 时，结果必须保持该 palette 颜色（不得无谓改色）
      const base = palette[BASE_MAPPING[type]];
      if (contrastRatio(base, palette.card) >= 3) {
        assert.equal(color.toLowerCase(), base.toLowerCase(), `${styleId}/${type}: 基础映射 ${base} 已满足对比度，应原样使用`);
      }
    }
    // keyword / string / comment 三色可区分
    const distinct = new Set([colors.keyword.toLowerCase(), colors.string.toLowerCase(), colors.comment.toLowerCase()]);
    assert.equal(distinct.size, 3, `${styleId}: keyword/string/comment 颜色必须互不相同：${[...distinct].join(',')}`);
  }
  // 5 套 style 的颜色结果互不相同
  const outputs = new Set(styleIds.map(styleId => JSON.stringify(resolveCodeTokenColors(palettes[styleId]))));
  assert.equal(outputs.size, 5, '5 套 style 的 token 颜色映射互不相同');
});

test('#23-9 brand 调色板走同一函数：合法、对比度 ≥3:1、确定性、无 NaN/undefined', () => {
  for (const { name, palette } of brandPalettes) {
    const colors = resolveCodeTokenColors(palette);
    assert.deepEqual(Object.keys(colors).sort(), [...TOKEN_TYPES].sort(), `${name}: 覆盖全部 token 类型`);
    for (const type of TOKEN_TYPES) {
      const color = colors[type];
      assert.match(color, HEX, `${name}/${type}: 合法 #rrggbb，实际 ${String(color)}`);
      assert.doesNotMatch(color, /NaN|undefined/i, `${name}/${type}: 不得出现 NaN/undefined`);
      const ratio = contrastRatio(color, palette.card);
      assert.ok(ratio >= 3 - 1e-9, `${name}/${type}: 与 card 对比度 ${ratio.toFixed(2)} 必须 ≥ 3:1`);
    }
    // brand 调色板只要求安全与对比度（颜色本身相同/接近时不做任意换色，可区分性由 5 套内置 style 保证）
    assert.deepEqual(resolveCodeTokenColors({ ...palette }), colors, `${name}: 同输入结果确定性一致`);
    assert.deepEqual(resolveCodeTokenColors(palette), colors, `${name}: 纯函数可重复调用`);
  }
});
