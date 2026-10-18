import { z } from 'zod';
import { AspectRatioSchema, FrameCardSchema, SubtitleSchema } from './delivery';
import type { Storyboard } from './index';

/** A reusable bundle of delivery settings. Storyboard content is deliberately excluded. */
export const ExportPresetSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(40),
  aspectRatio: AspectRatioSchema,
  renderPreset: z.enum(['full', 'draft']).default('full'),
  subtitles: SubtitleSchema,
  intro: FrameCardSchema.optional(),
  outro: FrameCardSchema.optional(),
  transition: z.enum(['none', 'fade']).default('none'),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExportPreset = z.infer<typeof ExportPresetSchema>;

export type ExportPresetPatch = Pick<Storyboard, 'aspectRatio' | 'subtitles' | 'intro' | 'outro' | 'transition'>;

/** The single apply entry point: scenes, narration, assets and style stay untouched. */
export function presetBoardPatch(preset: ExportPreset): ExportPresetPatch {
  return {
    aspectRatio: preset.aspectRatio,
    subtitles: preset.subtitles,
    intro: preset.intro,
    outro: preset.outro,
    transition: preset.transition,
  };
}
