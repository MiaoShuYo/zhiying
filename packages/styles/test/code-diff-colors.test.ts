import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrandPalette } from '@m2v/schema';
import { contrastRatio, palettes, resolveCodeDiffColors } from '../src/index';

/**
 * #26 契约：主题化 unified diff 调色板（doc/V1.7.0_issues.md §2.8）。
 * add←accent、remove←secondary、context←fg，每个 fg 与代码窗口背景 card 对比度 ≥3:1。
 */

const STYLE_IDS = ['minimal-tech', 'clean-light', 'academic', 'social-short', 'whiteboard'] as const;

const HEX6 = /^#[0-9a-f]{6}$/i;
const HEX8 = /^#[0-9a-f]{8}$/i;

/** 品牌快照调色板：暗色低对比、亮色低对比、全部角色同色三种对抗输入。 */
const BRAND_PALETTES: { name: string; palette: BrandPalette }[] = [
  {
    name: '暗色低对比品牌',
    palette: { bg: '#000000', fg: '#202020', muted: '#101010', accent: '#303030', card: '#000000', secondary: '#404040' },
  },
  {
    name: '亮色低对比品牌',
    palette: { bg: '#ffffff', fg: '#eeeeee', muted: '#dddddd', accent: '#f0f0f0', card: '#fefefe', secondary: '#ededed' },
  },
  {
    name: '全角色同色品牌',
    palette: { bg: '#0a0a0a', fg: '#777777', muted: '#777777', accent: '#777777', card: '#0a0a0a', secondary: '#777777' },
  },
];

function assertColorSet(set: { fg: string; bg: string }, card: string, label: string): void {
  assert.match(set.fg, HEX6, `${label}: fg 必须是合法 #rrggbb（实际 ${set.fg}）`);
  assert.match(set.bg, HEX8, `${label}: bg 必须是 8 位 hex（实际 ${set.bg}）`);
  assert.equal(set.bg.toLowerCase(), `${set.fg.toLowerCase()}22`, `${label}: bg = fg + 22`);
  const ratio = contrastRatio(set.fg, card);
  assert.ok(Number.isFinite(ratio) && ratio >= 3, `${label}: fg 与 card 对比度 ${ratio} 必须 ≥3:1`);
}

test('#26-11 resolveCodeDiffColors：5 套 style + brand 调色板 fg 合法且对比度≥3:1、三者可区分、bg 8 位 hex、确定性', () => {
  const cases: { name: string; card: string; colors: BrandPalette }[] = [
    ...STYLE_IDS.map(styleId => ({ name: styleId, card: palettes[styleId].card, colors: palettes[styleId] })),
    ...BRAND_PALETTES.map(entry => ({ name: entry.name, card: entry.palette.card, colors: entry.palette })),
  ];
  for (const entry of cases) {
    const colors = resolveCodeDiffColors(entry.colors);
    assert.deepEqual(Object.keys(colors).sort(), ['add', 'context', 'remove'], `${entry.name}: 返回 add/remove/context`);
    assertColorSet(colors.add, entry.card, `${entry.name}: add`);
    assertColorSet(colors.remove, entry.card, `${entry.name}: remove`);
    assertColorSet(colors.context, entry.card, `${entry.name}: context`);

    const fgValues = [colors.add.fg.toLowerCase(), colors.remove.fg.toLowerCase(), colors.context.fg.toLowerCase()];
    assert.equal(new Set(fgValues).size, 3, `${entry.name}: add/remove/context fg 必须互不相同（${fgValues.join(',')}）`);

    assert.deepEqual(resolveCodeDiffColors(entry.colors), resolveCodeDiffColors({ ...entry.colors }), `${entry.name}: 相同输入 deepEqual（确定性）`);
    assert.doesNotMatch(JSON.stringify(colors), /NaN|undefined|null/, `${entry.name}: 无 NaN/undefined`);
  }
});

test('#26-11 基础来源：5 套 style 中已满足对比度的 add/context 直接使用 accent/fg，remove 被确定性提亮', () => {
  for (const styleId of STYLE_IDS) {
    const palette = palettes[styleId];
    const colors = resolveCodeDiffColors(palette);
    const addRatio = contrastRatio(palette.accent, palette.card);
    if (addRatio >= 3) {
      assert.equal(colors.add.fg.toLowerCase(), palette.accent.toLowerCase(), `${styleId}: add 直接使用 accent`);
    }
    const contextRatio = contrastRatio(palette.fg, palette.card);
    if (contextRatio >= 3) {
      assert.equal(colors.context.fg.toLowerCase(), palette.fg.toLowerCase(), `${styleId}: context 直接使用 fg`);
    }
    assert.ok(contrastRatio(colors.remove.fg, palette.card) >= 3, `${styleId}: remove 调整后仍 ≥3:1`);
  }
});

test('#26-11 对抗调色板：非法/缺失颜色与同色角色不产生 NaN/undefined，仍满足对比度与可区分性', () => {
  const invalid = [
    {} as BrandPalette,
    { bg: '', card: 'not-a-color', fg: 'red', accent: '#zzz', secondary: undefined, muted: null } as unknown as BrandPalette,
    { ...palettes['minimal-tech'], card: '#ffffff', accent: '#ffffff', secondary: '#ffffff', fg: '#ffffff' },
  ];
  for (const palette of invalid) {
    const colors = resolveCodeDiffColors(palette);
    assert.doesNotMatch(JSON.stringify(colors), /NaN/, '无 NaN');
    const card = (palette as { card?: unknown }).card;
    const referenceCard = typeof card === 'string' && HEX6.test(card) ? card : '#000000';
    for (const [name, set] of Object.entries(colors)) {
      assert.match(set.fg, HEX6, `${name} fg 兜底后仍为合法 #rrggbb`);
      assert.match(set.bg, HEX8);
      if (name !== 'context' || referenceCard) {
        assert.ok(contrastRatio(set.fg, referenceCard) >= 3, `${name} 与 card 对比度 ≥3:1`);
      }
    }
    assert.equal(new Set(Object.values(colors).map(set => set.fg.toLowerCase())).size, 3, '同色角色被确定性分离');
  }
});
