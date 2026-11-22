import { z } from 'zod';

export const SfxCueIdSchema = z.enum(['soft-transition', 'emphasis-tick', 'data-pop', 'flow-pulse', 'success-chime', 'paper-tap']);
export type SfxCueId = z.infer<typeof SfxCueIdSchema>;

export const SfxLicenseMetadataSchema = z.object({
  kind: z.enum(['procedural', 'CC0', 'custom']).default('procedural'),
  name: z.string().trim().min(1).max(120).default('M2V procedural audio'),
  attribution: z.string().max(240).default('Generated locally from synthesized tones; no third-party recording.'),
  sourceUrl: z.string().url().optional(),
  requiresAttribution: z.boolean().default(false),
}).strict();
export type SfxLicenseMetadata = z.infer<typeof SfxLicenseMetadataSchema>;

const LocalSfxPathSchema = z.string().max(240).regex(/^(?:audio\/sfx\/[A-Za-z0-9_-]+\.wav|projects\/[A-Za-z0-9_-]+\/assets\/[A-Za-z0-9_.-]+)$/i, '音效只能引用本地 WAV 素材');

export const SfxCueSchema = z.object({
  id: z.string().min(1).max(80),
  cueId: SfxCueIdSchema,
  /** Optional semantic animation target; when no beatRef is set, its beat is resolved at render time. */
  targetId: z.string().min(1).max(80).optional(),
  beatRef: z.string().min(1).max(80).optional(),
  offsetSeconds: z.number().min(0).max(3600).default(0),
  durationSeconds: z.number().min(0.05).max(8).optional(),
  gain: z.number().min(0).max(1).default(0.65),
  assetSrc: LocalSfxPathSchema.optional(),
  license: SfxLicenseMetadataSchema.default({}),
}).strict().refine(cue => !cue.assetSrc?.startsWith('projects/') || cue.license.kind !== 'procedural', {
  path: ['license'],
  message: '用户导入的本地音效必须声明 CC0 或自有许可来源',
});
export type SfxCue = z.infer<typeof SfxCueSchema>;

export const SoundEffectsSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  volume: z.number().min(0).max(1).default(0.2),
  voiceDuck: z.number().min(0).max(0.9).default(0.15),
  bgmDuck: z.number().min(0).max(0.9).default(0.35),
  fadeIn: z.number().min(0).max(2).default(0.03),
  fadeOut: z.number().min(0).max(3).default(0.18),
});
export type SoundEffectsSettings = z.infer<typeof SoundEffectsSettingsSchema>;
