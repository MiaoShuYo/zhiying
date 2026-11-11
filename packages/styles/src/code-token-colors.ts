import type { BrandPalette, CodeTokenType } from '@m2v/schema';

/**
 * Theme-aware syntax token colors.
 *
 * Code highlighting must stay readable on every built-in style *and* on arbitrary brand palettes,
 * so token colors are never hardcoded per theme: they start from the palette role mapping below and
 * are then deterministically corrected until they reach a 3:1 contrast ratio against the code
 * window background (`colors.card`). Mixing steps are discrete and bounded, so the same palette
 * always produces the same colors.
 */

/** WCAG minimum contrast for large/medium UI text; the code window uses it for every token. */
const MIN_CONTRAST = 3;
const MAX_MIX_STEPS = 10;

type Rgb = { r: number; g: number; b: number };

const TOKEN_PALETTE_ROLE: Record<CodeTokenType, keyof BrandPalette> = {
  plain: 'fg',
  variable: 'fg',
  function: 'fg',
  punctuation: 'muted',
  comment: 'muted',
  keyword: 'accent',
  number: 'accent',
  string: 'secondary',
};

const FALLBACK_FOREGROUND = '#000000';
const FALLBACK_BACKGROUND = '#000000';

function parseHex(value: unknown): Rgb | null {
  if (typeof value !== 'string') return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value.trim());
  if (!match) return null;
  const hex = match[1];
  if (hex.length === 3) {
    return { r: Number.parseInt(`${hex[0]}${hex[0]}`, 16), g: Number.parseInt(`${hex[1]}${hex[1]}`, 16), b: Number.parseInt(`${hex[2]}${hex[2]}`, 16) };
  }
  return { r: Number.parseInt(hex.slice(0, 2), 16), g: Number.parseInt(hex.slice(2, 4), 16), b: Number.parseInt(hex.slice(4, 6), 16) };
}

function channelHex(channel: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(channel)));
  return clamped.toString(16).padStart(2, '0');
}

function toHex(rgb: Rgb): string {
  return `#${channelHex(rgb.r)}${channelHex(rgb.g)}${channelHex(rgb.b)}`;
}

/** Relative luminance as defined by WCAG 2.x. */
function luminance(rgb: Rgb): number {
  const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
}

function mix(rgb: Rgb, target: number, ratio: number): Rgb {
  return {
    r: rgb.r + (target - rgb.r) * ratio,
    g: rgb.g + (target - rgb.g) * ratio,
    b: rgb.b + (target - rgb.b) * ratio,
  };
}

/**
 * WCAG contrast ratio between two `#rgb`/`#rrggbb` colors.
 *
 * Invalid input returns 1 (a finite, non-NaN value) instead of throwing: callers only ever use this
 * to decide whether a color is readable, so an unreadable/unknown color must never break rendering.
 */
export function contrastRatio(foreground: string, background: string): number {
  const fg = parseHex(foreground);
  const bg = parseHex(background);
  if (!fg || !bg) return 1;
  const fgLuminance = luminance(fg);
  const bgLuminance = luminance(bg);
  const lighter = Math.max(fgLuminance, bgLuminance);
  const darker = Math.min(fgLuminance, bgLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Normalize any palette entry to a safe `#rrggbb` value. */
function safeHex(value: unknown, fallback: string): string {
  const parsed = parseHex(value);
  return parsed ? toHex(parsed) : fallback;
}

/**
 * Raise one token color to the minimum contrast against the code window background.
 *
 * Mixing goes toward white on dark backgrounds and toward black on light backgrounds, one tenth at
 * a time (at most 10 steps). If that still fails, `fallback` (the palette foreground) is used, and
 * finally pure black/white — whichever contrasts more — so the result is always a valid `#rrggbb`.
 */
function ensureContrast(color: string, background: string, fallback: string): string {
  const backgroundRgb = parseHex(background);
  if (!backgroundRgb) return safeHex(color, FALLBACK_FOREGROUND);
  if (contrastRatio(color, background) >= MIN_CONTRAST) return safeHex(color, FALLBACK_FOREGROUND);
  const rgb = parseHex(color);
  if (rgb) {
    const target = luminance(backgroundRgb) < 0.5 ? 255 : 0;
    for (let step = 1; step <= MAX_MIX_STEPS; step += 1) {
      const candidate = toHex(mix(rgb, target, step / MAX_MIX_STEPS));
      if (contrastRatio(candidate, background) >= MIN_CONTRAST) return candidate;
    }
  }
  if (contrastRatio(fallback, background) >= MIN_CONTRAST) return fallback;
  return contrastRatio('#ffffff', background) >= contrastRatio('#000000', background) ? '#ffffff' : '#000000';
}

/**
 * Pick a deterministic color that differs from every already-used color while still meeting the
 * contrast minimum. Used only when two palette roles resolve to the same visible color (for example
 * a brand palette whose accent/secondary/muted entries are identical): the first color is kept and
 * the next one is nudged along the same black/white mixing axis, never below 3:1.
 */
function distinctColor(color: string, background: string, taken: Set<string>): string {
  const backgroundRgb = parseHex(background);
  const rgb = parseHex(color);
  const target = backgroundRgb && luminance(backgroundRgb) < 0.5 ? 255 : 0;
  const candidates: string[] = [];
  if (rgb) {
    for (let step = 1; step <= MAX_MIX_STEPS; step += 1) {
      candidates.push(toHex(mix(rgb, target, step / MAX_MIX_STEPS)));
    }
  }
  const pureWhite = '#ffffff';
  const pureBlack = '#000000';
  candidates.push(contrastRatio(pureWhite, background) >= contrastRatio(pureBlack, background) ? pureWhite : pureBlack);
  candidates.push(pureWhite, pureBlack);
  for (const candidate of candidates) {
    if (!taken.has(candidate) && contrastRatio(candidate, background) >= MIN_CONTRAST) return candidate;
  }
  // Last resort: deterministic symmetric channel shifts around the original color.
  const base = rgb ?? { r: 0, g: 0, b: 0 };
  for (const delta of [16, 32, 48, 64, 96, 128]) {
    for (const direction of [1, -1]) {
      const candidate = toHex({ r: base.r + delta * direction, g: base.g + delta * direction, b: base.b + delta * direction });
      if (!taken.has(candidate) && contrastRatio(candidate, background) >= MIN_CONTRAST) return candidate;
    }
  }
  return color;
}

/**
 * Resolve the eight token colors for one palette.
 *
 * Base mapping: plain/variable/function → fg; punctuation/comment → muted; keyword/number → accent;
 * string → secondary. Every entry is then corrected against `colors.card`, so all five built-in
 * styles and any brand snapshot share the same guarantee (contrast ≥ 3:1, valid `#rrggbb`).
 *
 * A palette may legitimately repeat a role color (an all-gray brand kit, for instance). Keyword,
 * string and comment are the three highlighted classes, so when their resolved colors collide they
 * are deterministically separated while keeping the contrast guarantee; a color that already
 * satisfies the ratio is never changed.
 */
export function resolveCodeTokenColors(colors: BrandPalette): Record<CodeTokenType, string> {
  const palette = colors ?? ({} as BrandPalette);
  const background = safeHex(palette.card, FALLBACK_BACKGROUND);
  const foreground = safeHex(palette.fg, FALLBACK_FOREGROUND);
  const resolved = {} as Record<CodeTokenType, string>;
  const baseSatisfiesContrast = {} as Record<CodeTokenType, boolean>;
  for (const type of Object.keys(TOKEN_PALETTE_ROLE) as CodeTokenType[]) {
    const base = safeHex(palette[TOKEN_PALETTE_ROLE[type]], foreground);
    baseSatisfiesContrast[type] = contrastRatio(base, background) >= MIN_CONTRAST;
    resolved[type] = ensureContrast(base, background, foreground);
  }
  const highlightedTypes: CodeTokenType[] = ['keyword', 'string', 'comment'];
  const used = new Set<string>();
  for (const type of highlightedTypes) {
    const color = resolved[type];
    if (!used.has(color)) {
      used.add(color);
      continue;
    }
    if (baseSatisfiesContrast[type]) {
      used.add(color);
      continue;
    }
    const replacement = distinctColor(color, background, used);
    resolved[type] = replacement;
    used.add(replacement);
  }
  return resolved;
}
