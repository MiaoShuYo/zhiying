import { z } from 'zod';

const frameDuration = z.number().int().min(1).max(300);
const base = {
  targetId: z.string().min(1).max(80),
  beatRef: z.string().min(1).max(80),
  durationPolicy: z.enum(['beat', 'fixed', 'until-next']),
  durationFrames: frameDuration.optional(),
  easingPreset: z.enum(['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'spring-lite']).default('ease-out'),
  reducedMotionFallback: z.enum(['static', 'fade', 'highlight']).default('static'),
};

const variants = [
  z.object({ ...base, action: z.literal('reveal'), parameters: z.object({ direction: z.enum(['up', 'down', 'left', 'right', 'center']).default('up'), staggerFrames: z.number().int().min(0).max(90).default(0) }).strict().default({}) }).strict(),
  z.object({ ...base, action: z.literal('stagger'), parameters: z.object({ delayFrames: z.number().int().min(0).max(90).default(6) }).strict().default({}) }).strict(),
  z.object({ ...base, action: z.literal('focus-dim'), parameters: z.object({ dimOpacity: z.number().min(0.15).max(0.8).default(0.35) }).strict().default({}) }).strict(),
  z.object({ ...base, action: z.literal('highlight'), parameters: z.object({ strength: z.number().min(0.1).max(1).default(0.7) }).strict().default({}) }).strict(),
  z.object({ ...base, action: z.literal('number-count'), parameters: z.object({ decimals: z.number().int().min(0).max(4).default(0) }).strict().default({}) }).strict(),
  z.object({ ...base, action: z.literal('bar-grow'), parameters: z.object({ startPercent: z.number().min(0).max(100).default(0) }).strict().default({}) }).strict(),
  z.object({ ...base, action: z.literal('line-draw'), parameters: z.object({ startPercent: z.number().min(0).max(100).default(0) }).strict().default({}) }).strict(),
  z.object({ ...base, action: z.literal('arrow-flow'), parameters: z.object({ speed: z.number().min(0.25).max(2).default(1) }).strict().default({}) }).strict(),
  z.object({ ...base, action: z.literal('group-expand'), parameters: z.object({ startScale: z.number().min(0.25).max(1).default(0.85) }).strict().default({}) }).strict(),
  z.object({ ...base, action: z.literal('morph-lite'), parameters: z.object({ intensity: z.number().min(0).max(1).default(0.4) }).strict().default({}) }).strict(),
  z.object({ ...base, action: z.literal('annotation'), parameters: z.object({ placement: z.enum(['top', 'right', 'bottom', 'left']).default('right') }).strict().default({}) }).strict(),
] as const;

/** Strict, action-specific parameters prevent model output from becoming arbitrary render code. */
export const MotionActionSchema = z.discriminatedUnion('action', variants).superRefine((action, ctx) => {
  if (action.durationPolicy === 'fixed' && action.durationFrames === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['durationFrames'], message: 'fixed 动作需要显式 durationFrames' });
  }
  if (action.durationPolicy !== 'fixed' && action.durationFrames !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['durationFrames'], message: '只有 fixed 动作可以填写 durationFrames' });
  }
});
export type MotionAction = z.infer<typeof MotionActionSchema>;

export const ReducedMotionSchema = z.object({ enabled: z.boolean().optional() }).strict();
export type ReducedMotionSettings = z.infer<typeof ReducedMotionSchema>;
