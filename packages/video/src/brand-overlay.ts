import { SubtitleSchema, type BrandLogo, type Storyboard } from '@m2v/schema';
import { captionSafeArea, rendererScale } from './safe-area';

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
  subtitles: Storyboard['subtitles'];
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
