import { z } from 'zod';

/** Optional visual skins layered over the existing base Style and Brand Kit. */
export const StylePackIdSchema = z.enum(['editorial-tech', 'clean-data', 'paper-collage-lite']);
export type StylePackId = z.infer<typeof StylePackIdSchema>;
