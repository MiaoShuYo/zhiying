import test from 'node:test';
import assert from 'node:assert/strict';
import { StylePackIdSchema } from '@m2v/schema';
import { resolveBrandTheme, visualStylePacks } from '../src/index';

const ids = ['editorial-tech', 'clean-data', 'paper-collage-lite'] as const;

test('all three visual packs are schema-valid, offline, and materially distinct', () => {
  const resolved = ids.map(id => {
    assert.equal(StylePackIdSchema.safeParse(id).success, true);
    const pack = visualStylePacks[id];
    assert.equal(pack.id, id);
    assert.ok(pack.colors.bg.startsWith('#'));
    assert.ok(pack.typography.maxWordsPerScreen > 0);
    assert.ok(pack.layout.padding > 0);
    return resolveBrandTheme('minimal-tech', undefined, id);
  });
  assert.equal(new Set(resolved.map(theme => theme.colors.bg)).size, 3);
  assert.deepEqual(resolved.map(theme => theme.visual.background), ['grid', 'solid', 'paper']);
  assert.ok(resolved.every(theme => theme.stylePackId));
});

test('Brand Kit colors and fonts override a selected pack while base-style fallback remains stable', () => {
  const brand = {
    name: 'Offline test brand', baseStyleId: 'academic' as const,
    colors: { bg: '#101010', fg: '#fafafa', muted: '#aaaaaa', accent: '#55ddaa', card: '#222222', secondary: '#335577' },
    typography: { headingFont: 'Brand Display', bodyFont: 'Brand Text' },
  };
  const theme = resolveBrandTheme('academic', brand, 'editorial-tech');
  assert.deepEqual(theme.colors, brand.colors);
  assert.equal(theme.typography.headingFont, 'Brand Display');
  assert.equal(theme.typography.bodyFont, 'Brand Text');
  assert.match(theme.fontFamilies.heading, /Georgia, Times, serif$/);
  assert.match(theme.fontFamilies.body, /Georgia, Times, serif$/);
  assert.equal(theme.visual.background, 'grid', 'pack visual language remains opt-in around brand identity');
});

