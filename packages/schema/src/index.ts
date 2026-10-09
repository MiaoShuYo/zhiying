import { z } from 'zod';

export const SceneTypeSchema = z.enum(['title', 'bullets', 'diagram', 'comparison', 'chart', 'code']);
export const StyleIdSchema = z.enum(['minimal-tech', 'clean-light', 'academic', 'social-short']);
export const AspectRatioSchema = z.literal('16:9');

const BaseSceneSchema = z.object({
  id: z.string().min(1),
  type: SceneTypeSchema,
  title: z.string().max(50).optional(),
  narration: z.string().min(1),
  duration: z.number().positive().optional(),
  audioSrc: z.string().optional(),
  visual: z.record(z.unknown()).default({}),
  animation: z.string().optional(),
  styleOverride: z.record(z.unknown()).optional(),
});

export const SceneSchema = BaseSceneSchema.superRefine((scene, ctx) => {
  if (scene.type === 'bullets') {
    const items = scene.visual.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > 5 || !items.every((x) => typeof x === 'string')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['visual', 'items'], message: 'bullets 场景需要 1 到 5 条字符串 items' });
    }
  }
  if (scene.type === 'comparison' && (!Array.isArray(scene.visual.columns) || scene.visual.columns.length !== 2)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['visual', 'columns'], message: 'comparison 场景需要两列 columns' });
  }
  if (scene.type === 'chart' && (!Array.isArray(scene.visual.data) || scene.visual.data.length < 1)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['visual', 'data'], message: 'chart 场景需要非空 data' });
  }
});

export const StoryboardSchema = z.object({
  title: z.string().min(1),
  aspectRatio: AspectRatioSchema.default('16:9'),
  styleId: StyleIdSchema,
  durationTarget: z.number().positive().optional(),
  scenes: z.array(SceneSchema).min(1).max(40),
});
export const ProjectStatusSchema = z.enum(['created', 'extracting', 'analyzing', 'writing', 'storyboarding', 'awaiting_review', 'generating_audio', 'building_timeline', 'rendering', 'encoding', 'completed', 'failed']);
export const JobStatusSchema = z.enum(['queued', 'running', 'completed', 'failed']);

export const StyleSchema = z.object({
  id: StyleIdSchema,
  name: z.string(),
  visual: z.object({ mode: z.enum(['light', 'dark']), background: z.enum(['solid', 'gradient', 'grid', 'paper']), density: z.enum(['minimal', 'balanced', 'dense']) }),
  typography: z.object({ headingFont: z.string(), bodyFont: z.string(), titleScale: z.number(), bodyScale: z.number(), maxWordsPerScreen: z.number() }),
  layout: z.object({ padding: z.number(), alignment: z.enum(['center', 'left']), cardStyle: z.enum(['none', 'flat', 'soft']), borderRadius: z.number() }),
  motion: z.object({ pace: z.enum(['slow', 'medium', 'fast']), entrance: z.enum(['fade', 'slide', 'scale', 'kinetic']), transition: z.enum(['fade', 'slide', 'cut', 'zoom']) }),
  narration: z.object({ tone: z.enum(['teacher', 'professional', 'casual', 'energetic']), speed: z.number() }),
});

export type Scene = z.infer<typeof SceneSchema>;
export type SceneType = z.infer<typeof SceneTypeSchema>;
export type Storyboard = z.infer<typeof StoryboardSchema>;
export type StyleId = z.infer<typeof StyleIdSchema>;
