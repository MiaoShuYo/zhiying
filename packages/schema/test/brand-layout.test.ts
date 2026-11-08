import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BrandLogoSchema,
  CAPTION_EDGE_RATIO,
  CAPTION_LINE_HEIGHT,
  CAPTION_PADDING_Y,
  CAPTION_RESERVED_LINES,
  LOGO_CAPTION_GAP,
  SubtitleSchema,
  brandLogoPlacement,
  captionSafeArea,
  designCanvas,
  rendererScale,
} from '../src/index';

const LANDSCAPE = designCanvas(false);
const PORTRAIT = designCanvas(true);
const POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
const logo = (patch: Record<string, unknown> = {}) => BrandLogoSchema.parse({ src: 'brand-logo.png', ...patch });
const subtitles = (patch: Record<string, unknown> = {}) => SubtitleSchema.parse(patch);

test('designCanvas exposes the authored 16:9 and 9:16 frames with a scale of exactly 1', () => {
  assert.deepEqual({ width: LANDSCAPE.width, height: LANDSCAPE.height }, { width: 1920, height: 1080 });
  assert.deepEqual({ width: PORTRAIT.width, height: PORTRAIT.height }, { width: 1080, height: 1920 });
  assert.equal(rendererScale(LANDSCAPE.width, LANDSCAPE.height), 1, '16:9 design canvas is authored at scale 1');
  assert.equal(rendererScale(PORTRAIT.width, PORTRAIT.height), 1, '9:16 design canvas is authored at scale 1');
});

test('rendererScale keeps 1080p and 9:16 authored sizes and clamps extreme frames', () => {
  assert.equal(rendererScale(960, 540), 0.5, 'half-size landscape output halves the design px');
  assert.equal(rendererScale(540, 960), 0.5, 'half-size portrait output halves the design px');
  assert.equal(rendererScale(3840, 2160), 1.25, '4K is capped so overlay UI does not inflate');
  assert.equal(rendererScale(0, 0), 0);
  assert.equal(rendererScale(-10, -20), 0, 'invalid sizes never produce a negative scale');
  assert.equal(rendererScale(Number.NaN, 1080), 0);
});

test('captionSafeArea reserves two lines by default and accepts the lines a scene actually needs', () => {
  const scale = rendererScale(LANDSCAPE.width, LANDSCAPE.height);
  const fontSize = 30;
  const area = captionSafeArea({ videoHeight: LANDSCAPE.height, fontSize, scale });

  assert.equal(area.lines, CAPTION_RESERVED_LINES);
  assert.equal(area.edge, LANDSCAPE.height * CAPTION_EDGE_RATIO);
  assert.equal(area.lineHeight, fontSize * scale * CAPTION_LINE_HEIGHT);
  assert.equal(area.contentHeight, area.lineHeight * CAPTION_RESERVED_LINES);
  assert.equal(area.padding, CAPTION_PADDING_Y * scale);
  assert.equal(area.blockHeight, area.contentHeight + area.padding * 2);
  assert.equal(area.captionInset, area.edge + area.blockHeight);
  assert.equal(area.total, area.captionInset + LOGO_CAPTION_GAP * scale);

  const threeLines = captionSafeArea({ videoHeight: LANDSCAPE.height, fontSize, scale, lines: 3 });
  assert.equal(threeLines.lines, 3);
  assert.equal(threeLines.contentHeight, area.lineHeight * 3, 'extra caption lines grow the reserved band');
  assert.equal(threeLines.total, area.total + area.lineHeight, 'one extra line pushes the cleared inset down by one line height');

  for (const invalid of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(captionSafeArea({ videoHeight: LANDSCAPE.height, fontSize, scale, lines: invalid }).lines, CAPTION_RESERVED_LINES, `${invalid} falls back to the renderer reservation`);
  }
});

test('brandLogoPlacement keeps renderer geometry for all four corners on the design canvas', () => {
  const combos = new Set<string>();
  for (const position of POSITIONS) {
    const placement = brandLogoPlacement({
      logo: logo({ position, width: 160, opacity: 0.8, margin: 40 }),
      subtitles: subtitles({ enabled: false }),
      videoWidth: LANDSCAPE.width,
      videoHeight: LANDSCAPE.height,
    });
    assert.ok(placement, `${position} always yields geometry`);
    assert.equal(placement.edge, position.endsWith('left') ? 'left' : 'right');
    assert.equal(placement.verticalEdge, position.startsWith('top') ? 'top' : 'bottom');
    assert.equal(placement.edgeOffset, 40, 'design-canvas margins are used unscaled (scale = 1)');
    assert.equal(placement.verticalOffset, 40, 'captions are off, so the Logo keeps the plain margin');
    assert.equal(placement.width, 160);
    assert.equal(placement.opacity, 0.8);
    assert.equal(placement.zIndex, 20, 'the Logo stays above scene content and captions');
    combos.add(`${placement.edge}/${placement.verticalEdge}`);
  }
  assert.equal(combos.size, 4, 'the four positions cover all left/right x top/bottom corners');
});

test('a Logo sharing the caption edge is lifted to the exact caption safe inset on both canvases', () => {
  for (const [frame, position] of [[LANDSCAPE, 'bottom-right'], [PORTRAIT, 'bottom-left']] as const) {
    const fontSize = 30;
    const area = captionSafeArea({ videoHeight: frame.height, fontSize, scale: rendererScale(frame.width, frame.height) });
    const placement = brandLogoPlacement({
      logo: logo({ position, margin: 40 }),
      subtitles: subtitles({ position: 'bottom', fontSize }),
      videoWidth: frame.width,
      videoHeight: frame.height,
    });
    assert.ok(placement);
    assert.equal(placement.verticalOffset, Math.max(40, area.total), `${position} clears the 2-line caption band`);
    assert.ok(placement.verticalOffset > 40, 'the safe-area lift is larger than the plain margin');
  }
});

test('center captions, disabled captions, the opposite edge and disabled/empty Logos never move the Logo', () => {
  const cases = [
    { name: 'center captions', settings: subtitles({ position: 'center' }) },
    { name: 'disabled captions', settings: subtitles({ enabled: false, position: 'bottom' }) },
    { name: 'opposite edge captions', settings: subtitles({ position: 'top' }) },
  ];
  for (const entry of cases) {
    const placement = brandLogoPlacement({
      logo: logo({ position: 'bottom-right', margin: 40 }),
      subtitles: entry.settings,
      videoWidth: LANDSCAPE.width,
      videoHeight: LANDSCAPE.height,
    });
    assert.ok(placement, entry.name);
    assert.equal(placement.verticalOffset, 40, `${entry.name} keep the Logo on its plain margin`);
  }

  const none: (ReturnType<typeof logo> | null | undefined)[] = [
    null,
    undefined,
    logo({ enabled: false }),
    { ...logo(), src: '' },
    { ...logo(), src: '   ' },
  ];
  for (const value of none) {
    assert.equal(brandLogoPlacement({ logo: value, subtitles: subtitles(), videoWidth: LANDSCAPE.width, videoHeight: LANDSCAPE.height }), null);
  }
});

test('brandLogoPlacement is pure and does not mutate its inputs', () => {
  const input = {
    logo: logo({ position: 'bottom-right', width: 180, margin: 48, opacity: 0.9 }),
    subtitles: subtitles({ position: 'bottom', fontSize: 32 }),
    videoWidth: LANDSCAPE.width,
    videoHeight: LANDSCAPE.height,
  };
  const frozen = structuredClone(input);
  const first = brandLogoPlacement(input);
  brandLogoPlacement({ logo: logo({ position: 'top-left' }), subtitles: subtitles({ position: 'top' }), videoWidth: PORTRAIT.width, videoHeight: PORTRAIT.height });
  assert.deepEqual(brandLogoPlacement(input), first, 'repeated calls give identical geometry');
  assert.deepEqual(input, frozen, 'the inputs are not mutated');
});
