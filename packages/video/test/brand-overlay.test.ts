import assert from 'node:assert/strict';
import test from 'node:test';
import { BrandLogoSchema, SubtitleSchema, type BrandLogo } from '@m2v/schema';
import { BRAND_LOGO_Z_INDEX, brandLogoPlacement } from '../src/brand-overlay';
import {
  CAPTION_EDGE_RATIO,
  CAPTION_LINE_HEIGHT,
  CAPTION_PADDING_Y,
  CAPTION_RESERVED_LINES,
  LOGO_CAPTION_GAP,
  captionSafeArea,
  rendererScale,
} from '../src/safe-area';

const LANDSCAPE = { videoWidth: 1920, videoHeight: 1080 };
const PORTRAIT = { videoWidth: 1080, videoHeight: 1920 };
const POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;

const logo = (patch: Record<string, unknown> = {}): BrandLogo => BrandLogoSchema.parse({ src: 'brand-logo.png', ...patch });
const subtitles = (patch: Record<string, unknown> = {}) => SubtitleSchema.parse(patch);

test('rendererScale keeps 1080p and 9:16 authored sizes and clamps extreme frames', () => {
  assert.equal(rendererScale(1920, 1080), 1, '16:9 1080p is the authored landscape size');
  assert.equal(rendererScale(1080, 1920), 1, '9:16 1080x1920 is the authored portrait size');
  assert.equal(rendererScale(960, 540), 0.5, 'half-size landscape output halves the design px');
  assert.equal(rendererScale(540, 960), 0.5, 'half-size portrait output halves the design px');
  assert.equal(rendererScale(3840, 2160), 1.25, '4K is capped so overlay UI does not inflate');
  assert.equal(rendererScale(0, 0), 0);
  assert.equal(rendererScale(-10, -20), 0, 'invalid sizes never produce a negative scale');
  assert.equal(rendererScale(Number.NaN, 1080), 0);
});

test('captionSafeArea exposes the exact band a stacked Logo has to clear', () => {
  const scale = rendererScale(LANDSCAPE.videoWidth, LANDSCAPE.videoHeight);
  const fontSize = 30;
  const area = captionSafeArea({ videoHeight: LANDSCAPE.videoHeight, fontSize, scale });

  assert.equal(area.edge, LANDSCAPE.videoHeight * CAPTION_EDGE_RATIO);
  assert.equal(area.lines, CAPTION_RESERVED_LINES);
  assert.equal(area.lineHeight, fontSize * scale * CAPTION_LINE_HEIGHT);
  assert.equal(area.contentHeight, area.lineHeight * CAPTION_RESERVED_LINES);
  assert.equal(area.padding, CAPTION_PADDING_Y * scale);
  assert.equal(area.blockHeight, area.contentHeight + area.padding * 2);
  assert.equal(area.captionInset, area.edge + area.blockHeight);
  assert.equal(area.total, area.captionInset + LOGO_CAPTION_GAP * scale);
});

test('all four positions anchor the Logo to their own horizontal and vertical edge', () => {
  const scale = rendererScale(LANDSCAPE.videoWidth, LANDSCAPE.videoHeight);
  const combos = new Set<string>();

  for (const position of POSITIONS) {
    const placement = brandLogoPlacement({
      logo: logo({ position, width: 160, opacity: 0.8, margin: 40 }),
      subtitles: subtitles({ enabled: false }),
      ...LANDSCAPE,
    });
    assert.ok(placement, `${position} always yields geometry`);
    assert.equal(placement.edge, position.endsWith('left') ? 'left' : 'right');
    assert.equal(placement.verticalEdge, position.startsWith('top') ? 'top' : 'bottom');
    assert.equal(placement.edgeOffset, 40 * scale, `${position} pins the horizontal margin`);
    assert.equal(placement.verticalOffset, 40 * scale, `${position} keeps the plain margin when captions are off`);
    assert.equal(placement.width, 160 * scale);
    assert.equal(placement.opacity, 0.8);
    assert.equal(placement.zIndex, BRAND_LOGO_Z_INDEX);
    combos.add(`${placement.edge}/${placement.verticalEdge}`);
  }

  assert.equal(combos.size, 4, 'the four positions cover all left/right x top/bottom corners');
});

test('width and margin follow rendererScale while opacity is applied as configured', () => {
  const half = brandLogoPlacement({
    logo: logo({ position: 'top-right', width: 200, margin: 80, opacity: 0.35 }),
    subtitles: subtitles({ enabled: false }),
    videoWidth: 960,
    videoHeight: 540,
  });
  const full = brandLogoPlacement({
    logo: logo({ position: 'top-right', width: 200, margin: 80, opacity: 0.35 }),
    subtitles: subtitles({ enabled: false }),
    ...LANDSCAPE,
  });
  assert.ok(half && full);

  assert.equal(rendererScale(960, 540), 0.5);
  assert.equal(half.width, 200 * 0.5);
  assert.equal(half.edgeOffset, 80 * 0.5);
  assert.equal(half.verticalOffset, 80 * 0.5);
  assert.equal(half.opacity, 0.35, 'opacity is used directly and is not scaled');

  assert.equal(full.width, 200);
  assert.equal(full.edgeOffset, 80);
  assert.equal(full.verticalOffset, 80);
  assert.equal(full.opacity, 0.35);
  assert.ok(half.width < full.width && half.edgeOffset < full.edgeOffset, 'half-size renders scale the Logo down');
});

test('missing, disabled or empty Logo sources render nothing', () => {
  const cases: { name: string; value: BrandLogo | null | undefined }[] = [
    { name: 'no brand / no logo', value: null },
    { name: 'undefined logo', value: undefined },
    { name: 'enabled=false', value: logo({ enabled: false }) },
    { name: 'empty src', value: { ...logo(), src: '' } },
    { name: 'blank src', value: { ...logo(), src: '   ' } },
  ];

  for (const entry of cases) {
    assert.equal(
      brandLogoPlacement({ logo: entry.value, subtitles: subtitles(), ...LANDSCAPE }),
      null,
      `${entry.name} must not render`,
    );
  }
});

test('16:9 and 9:16 both work and portrait clears the taller caption inset', () => {
  const margin = 40;
  const fontSize = 30;
  const lifted: Record<string, number> = {};

  for (const frame of [LANDSCAPE, PORTRAIT]) {
    const scale = rendererScale(frame.videoWidth, frame.videoHeight);
    const area = captionSafeArea({ videoHeight: frame.videoHeight, fontSize, scale });
    const placement = brandLogoPlacement({
      logo: logo({ position: 'bottom-right', margin }),
      subtitles: subtitles({ position: 'bottom', fontSize }),
      ...frame,
    });
    assert.ok(placement, `${frame.videoWidth}x${frame.videoHeight} renders the Logo`);
    assert.equal(placement.edgeOffset, margin * scale);
    assert.equal(placement.verticalOffset, Math.max(margin * scale, area.total));
    assert.ok(placement.verticalOffset >= area.total, 'the Logo never enters the caption band');
    lifted[`${frame.videoWidth}x${frame.videoHeight}`] = placement.verticalOffset;
  }

  assert.ok(lifted['1080x1920'] > lifted['1920x1080'], 'the 9:16 edge ratio reserves a taller bottom band');
});

test('a Logo sharing the caption edge is lifted above the safe area', () => {
  const fontSize = 36;
  const area = captionSafeArea({
    videoHeight: LANDSCAPE.videoHeight,
    fontSize,
    scale: rendererScale(LANDSCAPE.videoWidth, LANDSCAPE.videoHeight),
  });

  for (const [logoPosition, subtitlePosition] of [
    ['bottom-right', 'bottom'],
    ['bottom-left', 'bottom'],
    ['top-left', 'top'],
    ['top-right', 'top'],
  ] as const) {
    const placement = brandLogoPlacement({
      logo: logo({ position: logoPosition, margin: 40 }),
      subtitles: subtitles({ position: subtitlePosition, fontSize }),
      ...LANDSCAPE,
    });
    assert.ok(placement);
    assert.equal(placement.verticalEdge, subtitlePosition);
    assert.equal(placement.verticalOffset, Math.max(40, area.total), `${logoPosition} clears the ${subtitlePosition} captions`);
    assert.ok(placement.verticalOffset > 40, 'the safe area lift is larger than the plain margin');
  }
});

test('center captions, disabled captions and the opposite edge never move the Logo', () => {
  const cases = [
    { name: 'center captions', settings: subtitles({ position: 'center' }) },
    { name: 'disabled captions', settings: subtitles({ enabled: false, position: 'bottom' }) },
    { name: 'opposite edge captions', settings: subtitles({ position: 'top' }) },
  ];

  for (const entry of cases) {
    const placement = brandLogoPlacement({
      logo: logo({ position: 'bottom-right', margin: 40 }),
      subtitles: entry.settings,
      ...LANDSCAPE,
    });
    assert.ok(placement, entry.name);
    assert.equal(placement.verticalOffset, 40, `${entry.name} keep the Logo on its plain margin`);
    assert.ok(placement.verticalOffset < captionSafeArea({ videoHeight: LANDSCAPE.videoHeight, fontSize: entry.settings.fontSize, scale: 1 }).total);
  }
});

test('subtitles omitted from the storyboard fall back to the schema defaults', () => {
  const withDefaults = brandLogoPlacement({ logo: logo({ position: 'bottom-left', margin: 40 }), subtitles: undefined, ...LANDSCAPE });
  const explicit = brandLogoPlacement({ logo: logo({ position: 'bottom-left', margin: 40 }), subtitles: subtitles(), ...LANDSCAPE });
  assert.ok(withDefaults);
  assert.deepEqual(withDefaults, explicit, 'an absent subtitle block parses to the schema default (bottom + enabled)');
  assert.ok(withDefaults.verticalOffset > 40, 'default bottom captions still lift a bottom Logo');
});

test('placement is a pure, repeatable function of the Logo, subtitles and frame size', () => {
  const input = {
    logo: logo({ position: 'bottom-right', width: 180, margin: 48, opacity: 0.9 }),
    subtitles: subtitles({ position: 'bottom', fontSize: 32 }),
    ...LANDSCAPE,
  };
  const frozen = structuredClone(input);
  const first = brandLogoPlacement(input);

  // A different frame/position in between must not share or leak any state.
  brandLogoPlacement({ logo: logo({ position: 'top-left' }), subtitles: subtitles({ position: 'top' }), ...PORTRAIT });
  const second = brandLogoPlacement(input);
  const third = brandLogoPlacement({ ...input, logo: { ...input.logo } });

  assert.deepEqual(second, first, 'repeated calls give identical geometry');
  assert.deepEqual(third, first, 'a structurally equal Logo gives identical geometry');
  assert.deepEqual(input, frozen, 'the inputs are not mutated');
  assert.equal(first?.verticalOffset, second?.verticalOffset);
  assert.equal(first?.verticalOffset, third?.verticalOffset);
});
