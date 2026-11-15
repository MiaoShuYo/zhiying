import type { BrandPalette } from '@m2v/schema';
import { contrastRatio, distinctColor, ensureContrast, normalizePaletteHex } from './code-token-colors';

/**
 * Theme-aware unified-diff colors (#26).
 *
 * Diff rows must never hardcode GitHub's palette: the add/remove/context foregrounds start from the
 * active brand palette (`accent` / `secondary` / `fg`) and are then deterministically corrected
 * until each one reaches the WCAG 3:1 contrast minimum against the code window background
 * (`colors.card`) — the same algorithm the syntax token colors use. The row backgrounds are the
 * same foreground at 22/255 alpha (8-digit hex), which the scene HTML sanitizer allows.
 */

export type CodeDiffColorSet = { fg: string; bg: string };

/** WCAG minimum contrast for code text; kept in sync with `code-token-colors.ts`. */
const MIN_CONTRAST = 3;
const FALLBACK_COLOR = '#000000';
const MIN_BACKGROUND_ALPHA = '22';

/**
 * Resolve the three diff colors for one palette.
 *
 * Every `fg` is a valid `#rrggbb` with ≥ 3:1 contrast against `colors.card`, add/remove/context are
 * mutually distinct (deterministically nudged apart if two palette roles collapse to the same
 * color) and every `bg` is `${fg}22`. Deterministic: the same palette always yields the same result.
 */
export function resolveCodeDiffColors(colors: BrandPalette): {
  add: CodeDiffColorSet;
  remove: CodeDiffColorSet;
  context: CodeDiffColorSet;
} {
  const palette = colors ?? ({} as BrandPalette);
  const background = normalizePaletteHex(palette.card, FALLBACK_COLOR);
  const foreground = normalizePaletteHex(palette.fg, FALLBACK_COLOR);
  const roles: { base: unknown; fallback: string }[] = [
    { base: palette.accent, fallback: foreground },
    { base: palette.secondary, fallback: foreground },
    { base: palette.fg, fallback: foreground },
  ];
  const used = new Set<string>();
  const resolved: string[] = [];
  for (const role of roles) {
    let color = ensureContrast(normalizePaletteHex(role.base, foreground), background, role.fallback);
    if (used.has(color)) color = distinctColor(color, background, used);
    used.add(color);
    resolved.push(color);
  }
  const toSet = (fg: string): CodeDiffColorSet => ({
    fg,
    // 8-digit hex (fg + alpha) keeps the row tint theme-driven and sanitizer-safe.
    bg: `${fg}${MIN_BACKGROUND_ALPHA}`,
  });
  return { add: toSet(resolved[0]), remove: toSet(resolved[1]), context: toSet(resolved[2]) };
}

/** Exposed for callers/tests that need the same contrast rule as the token palette. */
export function codeDiffContrastRatio(foreground: string, background: string): number {
  return contrastRatio(foreground, background);
}

/** The documented minimum contrast; useful for renderer/theme assertions. */
export const CODE_DIFF_MIN_CONTRAST = MIN_CONTRAST;
