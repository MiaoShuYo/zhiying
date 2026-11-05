import type { BrandPalette, BrandSnapshot, StyleId } from '@m2v/schema';

export const styles = {
  'minimal-tech': { id: 'minimal-tech', name: 'Minimal Tech', visual: { mode: 'dark', background: 'grid', density: 'minimal' }, typography: { headingFont: 'Arial', bodyFont: 'Arial', titleScale: 1.1, bodyScale: 1, maxWordsPerScreen: 36 }, layout: { padding: 100, alignment: 'left', cardStyle: 'soft', borderRadius: 20 }, motion: { pace: 'medium', entrance: 'fade', transition: 'fade' }, narration: { tone: 'professional', speed: 1 } },
  'clean-light': { id: 'clean-light', name: 'Clean Light', visual: { mode: 'light', background: 'solid', density: 'balanced' }, typography: { headingFont: 'Arial', bodyFont: 'Arial', titleScale: 1.05, bodyScale: 1, maxWordsPerScreen: 42 }, layout: { padding: 96, alignment: 'left', cardStyle: 'flat', borderRadius: 18 }, motion: { pace: 'medium', entrance: 'slide', transition: 'fade' }, narration: { tone: 'teacher', speed: 1 } },
  academic: { id: 'academic', name: 'Academic', visual: { mode: 'light', background: 'paper', density: 'dense' }, typography: { headingFont: 'Georgia', bodyFont: 'Georgia', titleScale: 1, bodyScale: 0.95, maxWordsPerScreen: 55 }, layout: { padding: 90, alignment: 'left', cardStyle: 'none', borderRadius: 4 }, motion: { pace: 'slow', entrance: 'fade', transition: 'cut' }, narration: { tone: 'professional', speed: 0.94 } },
  'social-short': { id: 'social-short', name: 'Social Short', visual: { mode: 'dark', background: 'gradient', density: 'minimal' }, typography: { headingFont: 'Arial', bodyFont: 'Arial', titleScale: 1.35, bodyScale: 1.2, maxWordsPerScreen: 22 }, layout: { padding: 110, alignment: 'center', cardStyle: 'soft', borderRadius: 26 }, motion: { pace: 'fast', entrance: 'kinetic', transition: 'zoom' }, narration: { tone: 'energetic', speed: 1.08 } },
  whiteboard: { id: 'whiteboard', name: 'Whiteboard', visual: { mode: 'light', background: 'paper', density: 'balanced' }, typography: { headingFont: 'Arial', bodyFont: 'Arial', titleScale: 1.05, bodyScale: 1.1, maxWordsPerScreen: 34 }, layout: { padding: 100, alignment: 'left', cardStyle: 'none', borderRadius: 8 }, motion: { pace: 'medium', entrance: 'slide', transition: 'fade' }, narration: { tone: 'teacher', speed: 0.96 } },
} satisfies Record<StyleId, object>;

/** The default color palette for each built-in base style. */
export const palettes: Record<StyleId, BrandPalette> = {
  'minimal-tech': { bg: '#080d19', fg: '#f3f7ff', muted: '#9aaac2', accent: '#50e3c2', card: '#111b2c', secondary: '#182741' },
  'clean-light': { bg: '#f4f7fb', fg: '#192438', muted: '#68758a', accent: '#4169e1', card: '#ffffff', secondary: '#e7eefc' },
  academic: { bg: '#f2ead8', fg: '#2d2923', muted: '#736a5b', accent: '#8a3d2e', card: '#faf6eb', secondary: '#e6dcc6' },
  'social-short': { bg: '#190d35', fg: '#ffffff', muted: '#e3d9ff', accent: '#ffcf4a', card: '#34205d', secondary: '#ef4d9b' },
  whiteboard: { bg: '#fffef9', fg: '#20252c', muted: '#606974', accent: '#2367c8', card: '#ffffff', secondary: '#e8f0fc' },
};

type StyleDefinition = (typeof styles)[StyleId];

export type ResolvedTheme = {
  visual: StyleDefinition['visual'];
  typography: {
    headingFont: string;
    bodyFont: string;
    titleScale: number;
    bodyScale: number;
    maxWordsPerScreen: number;
  };
  layout: StyleDefinition['layout'];
  motion: StyleDefinition['motion'];
  narration: StyleDefinition['narration'];
  colors: BrandPalette;
};

/** Combines one built-in style's design language with optional brand identity. */
export function resolveBrandTheme(styleId?: StyleId, brandSnapshot?: BrandSnapshot): ResolvedTheme {
  const selectedStyleId = styleId ?? brandSnapshot?.baseStyleId ?? 'minimal-tech';
  const style = styles[selectedStyleId];
  const colors = brandSnapshot?.colors ?? palettes[selectedStyleId];

  return {
    visual: { ...style.visual },
    typography: {
      ...style.typography,
      ...(brandSnapshot ? {
        headingFont: brandSnapshot.typography.headingFont,
        bodyFont: brandSnapshot.typography.bodyFont,
      } : {}),
    },
    layout: { ...style.layout },
    motion: { ...style.motion },
    narration: { ...style.narration },
    colors: { ...colors },
  };
}

export function resolveStyle(id: StyleId, override?: Record<string, unknown>) {
  const base = styles[id];
  return override ? { ...base, ...override } : base;
}
