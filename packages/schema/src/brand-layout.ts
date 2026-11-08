import { SubtitleSchema, type SubtitleSettings } from './delivery';
import type { BrandLogo } from './brand-kit';

/**
 * Geometry shared by the renderer's caption layer, the brand Logo overlay and the preflight.
 *
 * It lives in `@m2v/schema` (not `@m2v/video`) so the delivery check can reason about the exact
 * same numbers the renderer uses without the schema package depending on React/Remotion. The
 * video package re-exports every symbol from here, so renderer call sites are unchanged.
 *
 * Design-canvas values (fonts, paddings, margins) are authored for a 1080p frame and then
 * multiplied by `rendererScale`, so landscape, portrait and downscaled renders keep the same
 * relative layout. Captions are measured conservatively: the renderer wraps captions at runtime,
 * so the safe area always reserves the maximum expected number of lines.
 */

/** Inset of the caption block from the frame edge, as a fraction of the frame height. */
export const CAPTION_EDGE_RATIO = 0.05;

/** CSS line-height used by the caption layer. */
export const CAPTION_LINE_HEIGHT = 1.4;

/** Vertical padding of the caption block, in design-canvas pixels. */
export const CAPTION_PADDING_Y = 10;

/** Breathing room between a stacked brand Logo and the caption block, in design-canvas pixels. */
export const LOGO_CAPTION_GAP = 12;

/** Conservative number of caption lines the safe area reserves. */
export const CAPTION_RESERVED_LINES = 2;

/** Width of the authored 9:16 design canvas; the portrait renderer scales from this value. */
export const DESIGN_CANVAS_PORTRAIT_WIDTH = 1080;

/** Width of the authored 16:9 design canvas; the landscape renderer scales from this value. */
export const DESIGN_CANVAS_LANDSCAPE_WIDTH = 1920;

const DESIGN_CANVAS_PORTRAIT = { width: DESIGN_CANVAS_PORTRAIT_WIDTH, height: 1920 } as const;
const DESIGN_CANVAS_LANDSCAPE = { width: DESIGN_CANVAS_LANDSCAPE_WIDTH, height: 1080 } as const;

/**
 * The authored frame the renderer measures from: 1080×1920 for 9:16 and 1920×1080 for 16:9.
 *
 * Callers that only have a design-canvas value (like the preflight, which runs before an output
 * resolution is chosen) use this instead of the current render resolution. `rendererScale` of
 * either canvas is exactly 1, so the geometry is identical for full and draft exports.
 */
export function designCanvas(portrait: boolean): { readonly width: number; readonly height: number } {
  return portrait ? DESIGN_CANVAS_PORTRAIT : DESIGN_CANVAS_LANDSCAPE;
}

/**
 * Scales design-canvas px to the current composition. Landscape frames are authored at 1920px
 * wide, portrait frames at 1080px wide; the result is capped so 4K renders do not inflate the UI.
 */
export function rendererScale(width: number, height: number): number {
  const authored = height > width ? width / DESIGN_CANVAS_PORTRAIT_WIDTH : width / DESIGN_CANVAS_LANDSCAPE_WIDTH;
  if (!Number.isFinite(authored)) return 0;
  return Math.min(Math.max(authored, 0), 1.25);
}

export type CaptionSafeArea = {
  /** Frame inset holding the caption block (renderer px). */
  edge: number;
  /** Reserved caption lines. */
  lines: number;
  /** Rendered line height (renderer px). */
  lineHeight: number;
  /** Rendered caption text height for `lines` lines (renderer px). */
  contentHeight: number;
  /** Rendered vertical padding on one side (renderer px). */
  padding: number;
  /** Rendered caption block height, padding included (renderer px). */
  blockHeight: number;
  /** Distance from the anchored frame edge to the far edge of the caption block (renderer px). */
  captionInset: number;
  /** `captionInset` plus the Logo/caption gap; the offset a stacked Logo must keep (renderer px). */
  total: number;
};

/**
 * Reserves the vertical band a top/bottom caption can occupy for the given subtitle settings.
 *
 * `total` is the safe inset for an overlay (the brand Logo) that stacks with the caption: it stays
 * clear of the edge inset, the full caption block and a small gap above it.
 *
 * `lines` defaults to the renderer's 2-line reservation. The preflight passes the caption line
 * count a scene actually needs so it can tell a safe layout from one that outgrows the reservation.
 */
export function captionSafeArea(input: { videoHeight: number; fontSize: number; scale: number; lines?: number }): CaptionSafeArea {
  const scale = Number.isFinite(input.scale) && input.scale > 0 ? input.scale : 0;
  const videoHeight = Number.isFinite(input.videoHeight) ? Math.max(0, input.videoHeight) : 0;
  const fontSize = Number.isFinite(input.fontSize) ? Math.max(0, input.fontSize) : 0;
  const lines = Number.isFinite(input.lines) && (input.lines as number) > 0 ? Math.max(1, Math.floor(input.lines as number)) : CAPTION_RESERVED_LINES;

  const edge = videoHeight * CAPTION_EDGE_RATIO;
  const lineHeight = fontSize * scale * CAPTION_LINE_HEIGHT;
  const contentHeight = lineHeight * lines;
  const padding = CAPTION_PADDING_Y * scale;
  const blockHeight = contentHeight + padding * 2;
  const captionInset = edge + blockHeight;

  return {
    edge,
    lines,
    lineHeight,
    contentHeight,
    padding,
    blockHeight,
    captionInset,
    total: captionInset + LOGO_CAPTION_GAP * scale,
  };
}

/** Fixed stacking order: scene content and credits (1) → captions (5) → brand Logo (20). */
export const BRAND_LOGO_Z_INDEX = 20;

export type BrandLogoPlacement = {
  /** Horizontal corner the Logo is anchored to. */
  edge: 'left' | 'right';
  /** Rendered inset from the pinned horizontal edge. */
  edgeOffset: number;
  /** Vertical corner the Logo is anchored to. */
  verticalEdge: 'top' | 'bottom';
  /** Rendered inset from the pinned vertical edge. */
  verticalOffset: number;
  /** Rendered Logo width. */
  width: number;
  /** Brand-configured opacity, applied directly to the image. */
  opacity: number;
  zIndex: number;
};

/**
 * Pure geometry for the video-level brand Logo.
 *
 * A Logo shares its vertical edge with the captions, so it is lifted above the caption safe area
 * (2 reserved lines + gap) instead of overlapping the text. Center captions do not move the Logo,
 * and a missing/disabled Logo skips rendering entirely. Margins, width and the caption safe area
 * are all expressed in design-canvas px and scaled with the current composition.
 */
export function brandLogoPlacement(input: {
  logo: BrandLogo | null | undefined;
  subtitles: SubtitleSettings | undefined;
  videoWidth: number;
  videoHeight: number;
}): BrandLogoPlacement | null {
  const { logo, subtitles, videoWidth, videoHeight } = input;
  if (!logo?.enabled || !logo.src?.trim()) return null;

  const scale = rendererScale(videoWidth, videoHeight);
  const edge: BrandLogoPlacement['edge'] = logo.position.endsWith('left') ? 'left' : 'right';
  const verticalEdge: BrandLogoPlacement['verticalEdge'] = logo.position.startsWith('top') ? 'top' : 'bottom';
  const edgeOffset = logo.margin * scale;
  let verticalOffset = logo.margin * scale;

  const settings = SubtitleSchema.parse(subtitles ?? {});
  if (settings.enabled && settings.position === verticalEdge) {
    verticalOffset = Math.max(verticalOffset, captionSafeArea({ videoHeight, fontSize: settings.fontSize, scale }).total);
  }

  return {
    edge,
    edgeOffset,
    verticalEdge,
    verticalOffset,
    width: logo.width * scale,
    opacity: logo.opacity,
    zIndex: BRAND_LOGO_Z_INDEX,
  };
}
