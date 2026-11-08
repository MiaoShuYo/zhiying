/**
 * Compatibility surface for the renderer.
 *
 * `brandLogoPlacement` now lives in `@m2v/schema` (`brand-layout.ts`) so the preflight and the
 * renderer share one pure function. Re-exported here so existing renderer imports and
 * `packages/video/test/brand-overlay.test.ts` stay unchanged.
 */
export { BRAND_LOGO_Z_INDEX, brandLogoPlacement } from '@m2v/schema';
export type { BrandLogoPlacement } from '@m2v/schema';
