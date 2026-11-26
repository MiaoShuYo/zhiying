import test from 'node:test';
import assert from 'node:assert/strict';
import { StylePackIdSchema } from '@m2v/schema';
import { contrastRatio, resolveBrandTheme, visualStylePacks } from '../src/index';

const ids = ['editorial-tech', 'clean-data', 'paper-collage-lite'] as const;

test('all three visual packs are schema-valid, offline, and materially distinct', () => {
  const resolved = ids.map(id => {
    assert.equal(StylePackIdSchema.safeParse(id).success, true);
    const pack = visualStylePacks[id];
    assert.equal(pack.id, id);
    assert.ok(pack.colors.bg.startsWith('#'));
    assert.ok(pack.typography.maxWordsPerScreen > 0);
    assert.ok(pack.layout.padding > 0);
    assert.deepEqual(pack.provenance, {
      version: id === 'editorial-tech' ? '1.0.0' : '1.0.1',
      source: 'm2v-procedural',
      license: 'MIT',
      assets: 'procedural-only',
      fonts: 'system-fonts-not-bundled',
    });
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

test('style pack provenance snapshots carry the version used by render fingerprints', async () => {
  const { visualStylePackProvenance } = await import('../src/index');
  assert.equal(visualStylePackProvenance('editorial-tech').version, '1.0.0');
  assert.equal(visualStylePackProvenance('clean-data').version, '1.0.1');
  assert.equal(visualStylePackProvenance('paper-collage-lite').version, '1.0.1');
});

test('visual packs keep readable contrast and explicit Latin/CJK system-font fallback stacks', () => {
  for (const id of ids) {
    const pack = visualStylePacks[id];
    const theme = resolveBrandTheme('minimal-tech', undefined, id);
    assert.ok(contrastRatio(pack.colors.fg, pack.colors.bg) >= 7, `${id} primary text contrast`);
    assert.ok(contrastRatio(pack.colors.muted, pack.colors.bg) >= 4.5, `${id} secondary text contrast`);
    assert.match(theme.fontFamilies.heading, /Arial|Georgia/);
    assert.match(theme.fontFamilies.body, /Arial/);
    assert.match(theme.fontFamilies.heading, /Microsoft YaHei/);
    assert.match(theme.fontFamilies.body, /Microsoft YaHei/);
    assert.match(theme.fontFamilies.heading, /sans-serif|serif/);
    assert.match(theme.fontFamilies.body, /sans-serif/);
    assert.equal(pack.provenance.fonts, 'system-fonts-not-bundled');
    assert.equal(pack.provenance.assets, 'procedural-only');
  }
});

test('style pack definitions remain local, procedural and deterministic for offline rendering', () => {
  for (const id of ids) {
    const serialized = JSON.stringify(visualStylePacks[id]);
    assert.doesNotMatch(serialized, /https?:\/\//i, `${id} has no remote asset or font URL`);
    assert.doesNotMatch(serialized, /@import|@font-face|<svg|<img/i, `${id} does not embed remote-capable markup`);
    assert.deepEqual(resolveBrandTheme('minimal-tech', undefined, id), resolveBrandTheme('minimal-tech', undefined, id));
  }
});

