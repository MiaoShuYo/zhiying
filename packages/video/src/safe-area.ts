/**
 * Compatibility surface for the renderer.
 *
 * The geometry used to live here; it now lives in `@m2v/schema` (`brand-layout.ts`) so the
 * preflight can reuse the exact same numbers without `@m2v/schema` depending on `@m2v/video`.
 * These re-exports keep the renderer imports and `packages/video/test/brand-overlay.test.ts`
 * working unchanged.
 */
export {
  CAPTION_EDGE_RATIO,
  CAPTION_LINE_HEIGHT,
  CAPTION_PADDING_Y,
  CAPTION_RESERVED_LINES,
  LOGO_CAPTION_GAP,
  captionSafeArea,
  rendererScale,
} from '@m2v/schema';
export type { CaptionSafeArea } from '@m2v/schema';
