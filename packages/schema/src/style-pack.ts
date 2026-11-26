import { z } from 'zod';

/** Optional visual skins layered over the existing base Style and Brand Kit. */
export const StylePackIdSchema = z.enum(['editorial-tech', 'clean-data', 'paper-collage-lite']);
export type StylePackId = z.infer<typeof StylePackIdSchema>;

/**
 * Immutable attribution snapshot captured with a project when its style pack is
 * selected. It intentionally describes only bundled/procedural pack resources;
 * system fonts remain governed by the OS/vendor license and are not distributed.
 */
export const StylePackProvenanceSchema = z.object({
  stylePackId: StylePackIdSchema,
  version: z.string().min(1).max(32),
  source: z.literal('m2v-procedural'),
  license: z.literal('MIT'),
  licenseUrl: z.string().url(),
  assets: z.array(z.object({
    name: z.string().min(1).max(100),
    source: z.literal('procedural-css'),
    license: z.literal('MIT'),
    offline: z.literal(true),
  })).max(20),
  fonts: z.array(z.object({
    family: z.string().min(1).max(100),
    source: z.literal('system-font'),
    bundled: z.literal(false),
    license: z.literal('system-vendor-terms'),
  })).max(20),
});
export type StylePackProvenance = z.infer<typeof StylePackProvenanceSchema>;
