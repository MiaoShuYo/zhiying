import assert from 'node:assert/strict';
import test from 'node:test';
import { StoryboardSchema } from '@m2v/schema';
import { resolveBrandTheme } from '@m2v/styles';
import { resolveSceneTheme } from '../src/theme';

const colors = { bg: '#101820', fg: '#f4f4f4', muted: '#b1bbc5', accent: '#fa8058', card: '#202b35', secondary: '#354654' };
const snapshot = {
  name: '项目品牌快照',
  baseStyleId: 'academic' as const,
  colors,
  typography: { headingFont: 'Brand Display', bodyFont: 'Brand Sans' },
};

test('legacy Storyboards resolve to their unchanged built-in renderer theme', () => {
  const storyboard = StoryboardSchema.parse({
    title: '旧项目', styleId: 'minimal-tech',
    scenes: [{ id: 's1', type: 'title', narration: '保留旧样式。' }],
  });
  assert.deepEqual(resolveSceneTheme(storyboard, storyboard.scenes[0]), resolveBrandTheme('minimal-tech'));
});

test('scene and storyboard styles render from the saved snapshot without consulting its source ID', () => {
  const storyboard = StoryboardSchema.parse({
    title: '品牌项目', styleId: 'social-short', brandKitId: 'deleted-kit', brand: snapshot,
    scenes: [{ id: 's1', type: 'title', sceneStyle: 'whiteboard', narration: '使用保存的品牌。' }],
  });
  const theme = resolveSceneTheme(storyboard, storyboard.scenes[0]);
  const base = resolveBrandTheme('whiteboard');
  assert.deepEqual(theme.colors, colors);
  assert.equal(theme.typography.headingFont, 'Brand Display');
  assert.equal(theme.typography.bodyFont, 'Brand Sans');
  assert.deepEqual(theme.layout, base.layout);
  assert.deepEqual(theme.motion, base.motion);
});
