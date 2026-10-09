import type { StyleId } from '@m2v/schema';

export const styles = {
  'minimal-tech': { id: 'minimal-tech', name: 'Minimal Tech', visual: { mode: 'dark', background: 'grid', density: 'minimal' }, typography: { headingFont: 'Arial', bodyFont: 'Arial', titleScale: 1.1, bodyScale: 1, maxWordsPerScreen: 36 }, layout: { padding: 100, alignment: 'left', cardStyle: 'soft', borderRadius: 20 }, motion: { pace: 'medium', entrance: 'fade', transition: 'fade' }, narration: { tone: 'professional', speed: 1 } },
  'clean-light': { id: 'clean-light', name: 'Clean Light', visual: { mode: 'light', background: 'solid', density: 'balanced' }, typography: { headingFont: 'Arial', bodyFont: 'Arial', titleScale: 1.05, bodyScale: 1, maxWordsPerScreen: 42 }, layout: { padding: 96, alignment: 'left', cardStyle: 'flat', borderRadius: 18 }, motion: { pace: 'medium', entrance: 'slide', transition: 'fade' }, narration: { tone: 'teacher', speed: 1 } },
  academic: { id: 'academic', name: 'Academic', visual: { mode: 'light', background: 'paper', density: 'dense' }, typography: { headingFont: 'Georgia', bodyFont: 'Georgia', titleScale: 1, bodyScale: 0.95, maxWordsPerScreen: 55 }, layout: { padding: 90, alignment: 'left', cardStyle: 'none', borderRadius: 4 }, motion: { pace: 'slow', entrance: 'fade', transition: 'cut' }, narration: { tone: 'professional', speed: 0.94 } },
  'social-short': { id: 'social-short', name: 'Social Short', visual: { mode: 'dark', background: 'gradient', density: 'minimal' }, typography: { headingFont: 'Arial', bodyFont: 'Arial', titleScale: 1.35, bodyScale: 1.2, maxWordsPerScreen: 22 }, layout: { padding: 110, alignment: 'center', cardStyle: 'soft', borderRadius: 26 }, motion: { pace: 'fast', entrance: 'kinetic', transition: 'zoom' }, narration: { tone: 'energetic', speed: 1.08 } },
} satisfies Record<StyleId, object>;

export function resolveStyle(id: StyleId, override?: Record<string, unknown>) {
  const base = styles[id];
  return override ? { ...base, ...override } : base;
}
