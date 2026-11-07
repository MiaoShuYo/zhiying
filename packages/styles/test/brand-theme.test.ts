import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrandSnapshot, StyleId } from '@m2v/schema';
import { palettes, resolveBrandTheme, styles } from '../src/index';

const legacy = {
  'minimal-tech': {
    colors: { bg: '#080d19', fg: '#f3f7ff', muted: '#9aaac2', accent: '#50e3c2', card: '#111b2c', secondary: '#182741' },
    visual: { mode: 'dark', background: 'grid', density: 'minimal' },
    typography: { headingFont: 'Arial', bodyFont: 'Arial', titleScale: 1.1, bodyScale: 1, maxWordsPerScreen: 36 },
    layout: { padding: 100, alignment: 'left', cardStyle: 'soft', borderRadius: 20 },
    motion: { pace: 'medium', entrance: 'fade', transition: 'fade' },
    narration: { tone: 'professional', speed: 1 },
  },
  'clean-light': {
    colors: { bg: '#f4f7fb', fg: '#192438', muted: '#68758a', accent: '#4169e1', card: '#ffffff', secondary: '#e7eefc' },
    visual: { mode: 'light', background: 'solid', density: 'balanced' },
    typography: { headingFont: 'Arial', bodyFont: 'Arial', titleScale: 1.05, bodyScale: 1, maxWordsPerScreen: 42 },
    layout: { padding: 96, alignment: 'left', cardStyle: 'flat', borderRadius: 18 },
    motion: { pace: 'medium', entrance: 'slide', transition: 'fade' },
    narration: { tone: 'teacher', speed: 1 },
  },
  academic: {
    colors: { bg: '#f2ead8', fg: '#2d2923', muted: '#736a5b', accent: '#8a3d2e', card: '#faf6eb', secondary: '#e6dcc6' },
    visual: { mode: 'light', background: 'paper', density: 'dense' },
    typography: { headingFont: 'Georgia', bodyFont: 'Georgia', titleScale: 1, bodyScale: 0.95, maxWordsPerScreen: 55 },
    layout: { padding: 90, alignment: 'left', cardStyle: 'none', borderRadius: 4 },
    motion: { pace: 'slow', entrance: 'fade', transition: 'cut' },
    narration: { tone: 'professional', speed: 0.94 },
  },
  'social-short': {
    colors: { bg: '#190d35', fg: '#ffffff', muted: '#e3d9ff', accent: '#ffcf4a', card: '#34205d', secondary: '#ef4d9b' },
    visual: { mode: 'dark', background: 'gradient', density: 'minimal' },
    typography: { headingFont: 'Arial', bodyFont: 'Arial', titleScale: 1.35, bodyScale: 1.2, maxWordsPerScreen: 22 },
    layout: { padding: 110, alignment: 'center', cardStyle: 'soft', borderRadius: 26 },
    motion: { pace: 'fast', entrance: 'kinetic', transition: 'zoom' },
    narration: { tone: 'energetic', speed: 1.08 },
  },
  whiteboard: {
    colors: { bg: '#fffef9', fg: '#20252c', muted: '#606974', accent: '#2367c8', card: '#ffffff', secondary: '#e8f0fc' },
    visual: { mode: 'light', background: 'paper', density: 'balanced' },
    typography: { headingFont: 'Arial', bodyFont: 'Arial', titleScale: 1.05, bodyScale: 1.1, maxWordsPerScreen: 34 },
    layout: { padding: 100, alignment: 'left', cardStyle: 'none', borderRadius: 8 },
    motion: { pace: 'medium', entrance: 'slide', transition: 'fade' },
    narration: { tone: 'teacher', speed: 0.96 },
  },
} satisfies Record<StyleId, object>;

const brand: BrandSnapshot = {
  name: '样例品牌',
  baseStyleId: 'academic',
  colors: { bg: '#101820', fg: '#f4f4f4', muted: '#b1bbc5', accent: '#fa8058', card: '#202b35', secondary: '#354654' },
  typography: { headingFont: 'Brand Display', bodyFont: 'Brand Sans' },
};

test('resolves each built-in style to the legacy visual, typography, layout, motion, narration and colors', () => {
  for (const styleId of Object.keys(legacy) as StyleId[]) {
    const expected = legacy[styleId];
    const result = resolveBrandTheme(styleId);
    assert.deepEqual(result.colors, expected.colors, `${styleId} retains its legacy colors`);
    assert.deepEqual(result.visual, expected.visual, `${styleId} retains its visual language`);
    assert.deepEqual(result.typography, expected.typography, `${styleId} retains its typography`);
    assert.deepEqual(result.layout, expected.layout, `${styleId} retains its layout`);
    assert.deepEqual(result.motion, expected.motion, `${styleId} retains its motion`);
    assert.deepEqual(result.narration, expected.narration, `${styleId} retains its narration settings`);
  }
});

test('brand colors override only colors while retaining the selected style design language', () => {
  const baseline = resolveBrandTheme('clean-light');
  const colorsOnlyBrand: BrandSnapshot = {
    ...brand,
    typography: { headingFont: baseline.typography.headingFont, bodyFont: baseline.typography.bodyFont },
  };
  const result = resolveBrandTheme('clean-light', colorsOnlyBrand);
  assert.deepEqual(result.colors, colorsOnlyBrand.colors);
  assert.deepEqual(result.visual, baseline.visual);
  assert.deepEqual(result.typography, baseline.typography);
  assert.deepEqual(result.layout, baseline.layout);
  assert.deepEqual(result.motion, baseline.motion);
  assert.deepEqual(result.narration, baseline.narration);
});

test('brand fonts override the font families but keep scale and density values from the style', () => {
  const result = resolveBrandTheme('social-short', brand);
  assert.equal(result.typography.headingFont, 'Brand Display');
  assert.equal(result.typography.bodyFont, 'Brand Sans');
  assert.equal(result.typography.titleScale, 1.35);
  assert.equal(result.typography.bodyScale, 1.2);
  assert.equal(result.typography.maxWordsPerScreen, 22);
  assert.equal(result.visual.density, 'minimal');
});

test('the same brand combines with different layouts and motion without changing its colors', () => {
  const academic = resolveBrandTheme('academic', brand);
  const cleanLight = resolveBrandTheme('clean-light', brand);
  assert.deepEqual(academic.colors, brand.colors);
  assert.deepEqual(cleanLight.colors, brand.colors);
  assert.notDeepEqual(academic.layout, cleanLight.layout);
  assert.notDeepEqual(academic.motion, cleanLight.motion);
});

test('explicit style wins; otherwise brand base style or minimal-tech is used', () => {
  assert.deepEqual(resolveBrandTheme(undefined, brand), resolveBrandTheme('academic', brand));
  assert.deepEqual(resolveBrandTheme('whiteboard', brand).layout, resolveBrandTheme('whiteboard').layout);
  assert.deepEqual(resolveBrandTheme(), resolveBrandTheme('minimal-tech'));
});

const SANS_STACK = ['Arial', 'Microsoft YaHei', 'sans-serif'];
const SERIF_STACK = ['Georgia', 'Times', 'serif'];

test('fontFamilies provide the design-language fallback chain for every base style', () => {
  const expected: Record<StyleId, string[]> = {
    'minimal-tech': SANS_STACK,
    'clean-light': SANS_STACK,
    academic: SERIF_STACK,
    'social-short': SANS_STACK,
    whiteboard: SANS_STACK,
  };

  for (const styleId of Object.keys(expected) as StyleId[]) {
    const theme = resolveBrandTheme(styleId);
    assert.equal(theme.fontFamilies.heading, expected[styleId].join(', '), `${styleId} heading fallback`);
    assert.equal(theme.fontFamilies.body, expected[styleId].join(', '), `${styleId} body fallback`);
    assert.equal(theme.typography.headingFont, styles[styleId].typography.headingFont, `${styleId} keeps the raw headingFont`);
    assert.equal(theme.typography.bodyFont, styles[styleId].typography.bodyFont, `${styleId} keeps the raw bodyFont`);
  }
});

test('brand fonts come first in the font stack and inherit the serif fallback of an academic base', () => {
  const academic = resolveBrandTheme('academic', brand);
  assert.equal(academic.fontFamilies.heading, 'Brand Display, Georgia, Times, serif');
  assert.equal(academic.fontFamilies.body, 'Brand Sans, Georgia, Times, serif');
  assert.equal(academic.typography.headingFont, 'Brand Display', 'typography keeps the bare configured name');
  assert.equal(academic.typography.bodyFont, 'Brand Sans', 'typography keeps the bare configured name');
  assert.equal(academic.typography.headingFont.includes(','), false, 'typography must not contain the fallback stack');
});

test('brand fonts on a sans base use the sans fallback chain', () => {
  const clean = resolveBrandTheme('clean-light', brand);
  assert.equal(clean.fontFamilies.heading, 'Brand Display, Arial, Microsoft YaHei, sans-serif');
  assert.equal(clean.fontFamilies.body, 'Brand Sans, Arial, Microsoft YaHei, sans-serif');
  assert.equal(clean.typography.headingFont, 'Brand Display');
  assert.equal(clean.typography.bodyFont, 'Brand Sans');

  const minimal = resolveBrandTheme('minimal-tech');
  assert.equal(minimal.fontFamilies.heading, 'Arial, Microsoft YaHei, sans-serif');
  assert.equal(minimal.fontFamilies.body, 'Arial, Microsoft YaHei, sans-serif');
});

test('the serif fallback follows the base style, not the brand font name', () => {
  const academicBrand = resolveBrandTheme('academic', { ...brand, typography: { headingFont: 'Inter', bodyFont: 'Inter' } });
  assert.equal(academicBrand.typography.headingFont, 'Inter');
  assert.ok(academicBrand.fontFamilies.heading.startsWith('Inter, '), 'the brand font stays first');
  assert.ok(academicBrand.fontFamilies.heading.includes('serif'), 'an academic base keeps a serif fallback');
  assert.equal(academicBrand.fontFamilies.heading.includes('sans-serif'), false, 'academic must not silently become sans-serif');

  const minimalBrand = resolveBrandTheme('minimal-tech', { ...brand, typography: { headingFont: 'Georgia', bodyFont: 'Georgia' } });
  assert.equal(minimalBrand.typography.headingFont, 'Georgia');
  assert.ok(minimalBrand.fontFamilies.heading.startsWith('Georgia, '), 'the brand serif name is still used first');
  assert.ok(minimalBrand.fontFamilies.heading.endsWith('sans-serif'), 'a minimal-tech base keeps a sans fallback');
});

test('a brand font equal to a fallback entry is not repeated in the stack', () => {
  assert.equal(resolveBrandTheme('academic', brand).fontFamilies.heading, 'Brand Display, Georgia, Times, serif');
  assert.equal(
    resolveBrandTheme('academic', { ...brand, typography: { headingFont: 'Georgia', bodyFont: 'Times' } }).fontFamilies.heading,
    'Georgia, Times, serif',
    'Georgia is not duplicated',
  );
  assert.equal(
    resolveBrandTheme('academic', { ...brand, typography: { headingFont: 'Georgia', bodyFont: 'Times' } }).fontFamilies.body,
    'Times, Georgia, serif',
    'the configured name keeps its position',
  );
  assert.equal(
    resolveBrandTheme('minimal-tech', { ...brand, typography: { headingFont: 'Arial', bodyFont: 'Microsoft YaHei' } }).fontFamilies.heading,
    'Arial, Microsoft YaHei, sans-serif',
    'Arial is not duplicated',
  );
  assert.equal(
    resolveBrandTheme('minimal-tech', { ...brand, typography: { headingFont: 'Arial', bodyFont: 'Microsoft YaHei' } }).fontFamilies.body,
    'Microsoft YaHei, Arial, sans-serif',
    'the configured body font keeps its position',
  );
});

test('brand typography overrides heading and body independently while keeping the stack shape', () => {
  const theme = resolveBrandTheme('clean-light', { ...brand, typography: { headingFont: 'Heading Only', bodyFont: brand.typography.bodyFont } });
  assert.equal(theme.typography.headingFont, 'Heading Only');
  assert.equal(theme.typography.bodyFont, brand.typography.bodyFont);
  assert.equal(theme.fontFamilies.heading, 'Heading Only, Arial, Microsoft YaHei, sans-serif');
  assert.equal(theme.fontFamilies.body, 'Brand Sans, Arial, Microsoft YaHei, sans-serif');
});

test('resolution does not mutate inputs or share mutable nested objects with defaults', () => {
  const before = structuredClone(brand);
  const result = resolveBrandTheme('minimal-tech', brand);
  assert.deepEqual(brand, before);

  result.colors.accent = '#000000';
  result.typography.bodyScale = 99;
  result.layout.padding = 1;
  result.visual.density = 'dense';
  assert.deepEqual(brand, before);
  assert.equal(palettes['minimal-tech'].accent, legacy['minimal-tech'].colors.accent);
  assert.equal(styles['minimal-tech'].typography.bodyScale, legacy['minimal-tech'].typography.bodyScale);
  assert.equal(resolveBrandTheme('minimal-tech', brand).colors.accent, brand.colors.accent);
});
