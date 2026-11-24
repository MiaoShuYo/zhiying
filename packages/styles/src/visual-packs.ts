import type { BrandPalette } from '@m2v/schema';
import type { StylePackId } from '@m2v/schema';

export type VisualStylePack = {
  id: StylePackId;
  name: string;
  /** Provenance for reproducibility and license review; no third-party media is bundled. */
  provenance: {
    version: string;
    source: 'm2v-procedural';
    license: 'MIT';
    assets: 'procedural-only';
    fonts: 'system-fonts-not-bundled';
  };
  colors: BrandPalette;
  visual: { mode: 'dark' | 'light'; background: 'grid' | 'solid' | 'paper'; density: 'minimal' | 'balanced' };
  typography: { headingFont: string; bodyFont: string; titleScale: number; bodyScale: number; maxWordsPerScreen: number };
  layout: { padding: number; alignment: 'left' | 'center'; cardStyle: 'soft' | 'flat' | 'none'; borderRadius: number };
  motion: { entrance: 'fade' | 'slide' | 'scale' | 'kinetic' };
};

/** Procedural, offline skins; brand colors and typography still take precedence. */
export const visualStylePacks: Record<StylePackId, VisualStylePack> = {
  'editorial-tech': {
    id: 'editorial-tech', name: 'Editorial Tech',
    provenance: { version: '1.0.0', source: 'm2v-procedural', license: 'MIT', assets: 'procedural-only', fonts: 'system-fonts-not-bundled' },
    colors: { bg: '#0d1522', fg: '#f0f5fb', muted: '#a5b3c4', accent: '#57d8d0', card: '#172638', secondary: '#29425a' },
    visual: { mode: 'dark', background: 'grid', density: 'minimal' },
    typography: { headingFont: 'Arial', bodyFont: 'Arial', titleScale: 1.08, bodyScale: 1, maxWordsPerScreen: 34 },
    layout: { padding: 96, alignment: 'left', cardStyle: 'soft', borderRadius: 16 },
    motion: { entrance: 'fade' },
  },
  'clean-data': {
    id: 'clean-data', name: 'Clean Data',
    provenance: { version: '1.0.0', source: 'm2v-procedural', license: 'MIT', assets: 'procedural-only', fonts: 'system-fonts-not-bundled' },
    colors: { bg: '#f2f7fb', fg: '#182c40', muted: '#61758a', accent: '#2279c8', card: '#ffffff', secondary: '#61b9a6' },
    visual: { mode: 'light', background: 'solid', density: 'balanced' },
    typography: { headingFont: 'Arial', bodyFont: 'Arial', titleScale: 1.04, bodyScale: 1, maxWordsPerScreen: 38 },
    layout: { padding: 94, alignment: 'left', cardStyle: 'flat', borderRadius: 14 },
    motion: { entrance: 'fade' },
  },
  'paper-collage-lite': {
    id: 'paper-collage-lite', name: 'Paper Collage Lite',
    provenance: { version: '1.0.0', source: 'm2v-procedural', license: 'MIT', assets: 'procedural-only', fonts: 'system-fonts-not-bundled' },
    colors: { bg: '#f4eddd', fg: '#292922', muted: '#756d5c', accent: '#b34d36', card: '#fffaf0', secondary: '#e6c995' },
    visual: { mode: 'light', background: 'paper', density: 'balanced' },
    typography: { headingFont: 'Georgia', bodyFont: 'Arial', titleScale: 1.02, bodyScale: 1, maxWordsPerScreen: 34 },
    layout: { padding: 102, alignment: 'left', cardStyle: 'soft', borderRadius: 8 },
    motion: { entrance: 'fade' },
  },
};

export const stylePackOptions = Object.values(visualStylePacks).map(({ id, name }) => ({ id, name }));
