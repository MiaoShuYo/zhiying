import { z } from 'zod';

/** Frame-level delivery settings shared by the storyboard, the preflight and the export presets. */
export const AspectRatioSchema = z.enum(['16:9', '9:16']).default('16:9');
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

export const SubtitleSchema = z.object({
  enabled: z.boolean().default(true), preset: z.enum(['minimal', 'boxed', 'highlight']).default('boxed'),
  position: z.enum(['top', 'center', 'bottom']).default('bottom'),
  fontSize: z.number().min(18).max(72).default(30), color: z.string().regex(/^#[0-9a-f]{6}$/i).default('#ffffff'),
  background: z.string().regex(/^#[0-9a-f]{6}$/i).default('#000000'), backgroundOpacity: z.number().min(0).max(1).default(0.72),
});
export type SubtitleSettings = z.infer<typeof SubtitleSchema>;

export const FrameCardSchema = z.object({
  enabled: z.boolean().default(false),
  title: z.string().max(50).optional(),
  subtitle: z.string().max(120).optional(),
  duration: z.number().min(1).max(15).default(3),
});
export type FrameCard = z.infer<typeof FrameCardSchema>;

export const TransitionSchema = z.enum(['none', 'fade']).default('none');
export type Transition = z.infer<typeof TransitionSchema>;
