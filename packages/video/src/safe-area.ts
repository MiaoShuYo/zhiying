/**
 * Geometry shared by the renderer's caption layer and the brand Logo overlay.
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

/**
 * Scales design-canvas px to the current composition. Landscape frames are authored at 1920px
 * wide, portrait frames at 1080px wide; the result is capped so 4K renders do not inflate the UI.
 */
export function rendererScale(width: number, height: number): number {
  const authored = height > width ? width / 1080 : width / 1920;
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
 * clear of the edge inset, the full 2-line caption block and a small gap above it.
 */
export function captionSafeArea(input: { videoHeight: number; fontSize: number; scale: number }): CaptionSafeArea {
  const scale = Number.isFinite(input.scale) && input.scale > 0 ? input.scale : 0;
  const videoHeight = Number.isFinite(input.videoHeight) ? Math.max(0, input.videoHeight) : 0;
  const fontSize = Number.isFinite(input.fontSize) ? Math.max(0, input.fontSize) : 0;

  const edge = videoHeight * CAPTION_EDGE_RATIO;
  const lineHeight = fontSize * scale * CAPTION_LINE_HEIGHT;
  const contentHeight = lineHeight * CAPTION_RESERVED_LINES;
  const padding = CAPTION_PADDING_Y * scale;
  const blockHeight = contentHeight + padding * 2;
  const captionInset = edge + blockHeight;

  return {
    edge,
    lines: CAPTION_RESERVED_LINES,
    lineHeight,
    contentHeight,
    padding,
    blockHeight,
    captionInset,
    total: captionInset + LOGO_CAPTION_GAP * scale,
  };
}
