import test from 'node:test';
import assert from 'node:assert/strict';
import { BrandKitSchema, BrandSnapshotSchema, StoryboardSchema } from '../src/index';

const colors = {
  bg: '#ffffff',
  fg: '#101010',
  muted: '#777777',
  accent: '#123abc',
  card: '#eeeeee',
  secondary: '#abcdef',
};

const snapshot = {
  name: '示例品牌',
  baseStyleId: 'minimal-tech',
  colors,
  typography: { headingFont: 'Inter', bodyFont: 'Noto Sans' },
};

test('accepts a valid brand snapshot and rejects invalid colors', () => {
  assert.equal(BrandSnapshotSchema.safeParse(snapshot).success, true);
  assert.equal(BrandSnapshotSchema.safeParse({ ...snapshot, colors: { ...colors, accent: '#12ab' } }).success, false);
});

test('validates logo position and dimensions', () => {
  const logo = { src: 'brand-kits/example/logo.png' };
  const parsed = BrandSnapshotSchema.parse({ ...snapshot, logo });
  assert.deepEqual(parsed.logo, {
    enabled: true,
    src: logo.src,
    position: 'top-right',
    width: 160,
    opacity: 1,
    margin: 40,
  });

  for (const position of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
    assert.equal(BrandSnapshotSchema.safeParse({ ...snapshot, logo: { ...logo, position } }).success, true);
  }

  for (const patch of [
    { position: 'center' },
    { width: 39 },
    { width: 501 },
    { opacity: -0.01 },
    { opacity: 1.01 },
    { margin: -1 },
    { margin: 201 },
  ]) {
    assert.equal(BrandSnapshotSchema.safeParse({ ...snapshot, logo: { ...logo, ...patch } }).success, false);
  }
});

test('validates names, fonts, and base styles', () => {
  assert.equal(BrandSnapshotSchema.safeParse({ ...snapshot, name: ' ' }).success, false);
  assert.equal(BrandSnapshotSchema.safeParse({ ...snapshot, name: '名'.repeat(41) }).success, false);
  assert.equal(BrandSnapshotSchema.safeParse({ ...snapshot, baseStyleId: 'unknown-style' }).success, false);
  assert.equal(BrandSnapshotSchema.safeParse({ ...snapshot, typography: { headingFont: ' ', bodyFont: 'Noto Sans' } }).success, false);
  assert.equal(BrandSnapshotSchema.safeParse({ ...snapshot, typography: { headingFont: 'a'.repeat(101), bodyFont: 'Noto Sans' } }).success, false);
});

test('extracts a snapshot from a brand kit and supports kits without a logo', () => {
  const kit = BrandKitSchema.parse({
    ...snapshot,
    id: 'brand-1',
    isDefault: true,
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
  });

  const extracted = BrandSnapshotSchema.parse(kit);
  assert.deepEqual(extracted, snapshot);
  assert.equal('id' in extracted, false);
  assert.equal('isDefault' in extracted, false);
  assert.equal('createdAt' in extracted, false);
  assert.equal(BrandSnapshotSchema.safeParse({ ...snapshot, logo: undefined }).success, true);
});

test('storyboards preserve optional brand provenance and snapshots without changing legacy boards', () => {
  const legacy = StoryboardSchema.parse({
    title: '旧项目',
    styleId: 'minimal-tech',
    scenes: [{ id: 's1', type: 'title', narration: '旧项目保持原样。' }],
  });
  assert.equal(legacy.brand, undefined);
  assert.equal(legacy.brandKitId, undefined);

  const storyboard = StoryboardSchema.parse({
    ...legacy,
    brandKitId: 'deleted-brand-kit',
    brand: snapshot,
  });
  assert.equal(storyboard.brandKitId, 'deleted-brand-kit');
  assert.deepEqual(storyboard.brand, snapshot);
  assert.equal(StoryboardSchema.safeParse({ ...legacy, brandKitId: 'b'.repeat(65) }).success, false);
});
