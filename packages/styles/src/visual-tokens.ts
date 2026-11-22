/** Common layout tokens shared by the V1.9 standard templates and style packs. */
export const visualDesignTokens = {
  spacing: { xs: 8, sm: 16, md: 24, lg: 32, xl: 48, xxl: 64 },
  typeScale: { caption: 16, body: 24, lead: 32, heading: 48, display: 72 },
  depth: { flat: 'none', panel: '0 12px 32px rgba(4, 12, 28, .14)', raised: '0 20px 48px rgba(4, 12, 28, .22)' },
  compositionalAnchor: { center: 0.5, titleBand: 0.17, captionBand: 0.18 },
  subtitleSafeArea: { top: 0.08, bottom: 0.19, horizontal: 0.07 },
  emphasisColorBudget: 0.24,
} as const;

export type VisualDesignTokens = typeof visualDesignTokens;
