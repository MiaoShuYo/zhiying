import type { Scene, Storyboard } from '@m2v/schema';
import { resolveBrandTheme, type ResolvedTheme } from '@m2v/styles';

/** Resolve render styling from the scene's selected base style and saved snapshot. */
export function resolveSceneTheme(
  storyboard: Pick<Storyboard, 'styleId' | 'brand'>,
  scene: Pick<Scene, 'sceneStyle'>,
): ResolvedTheme {
  return resolveBrandTheme(scene.sceneStyle ?? storyboard.styleId, storyboard.brand);
}
