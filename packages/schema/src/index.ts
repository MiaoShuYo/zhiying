import { z } from 'zod';

export const SceneTypeSchema = z.enum(['title', 'bullets', 'diagram', 'comparison', 'chart', 'code', 'timeline', 'math', 'media']);
export const StyleIdSchema = z.enum(['minimal-tech', 'clean-light', 'academic', 'social-short', 'whiteboard']);
export const AspectRatioSchema = z.enum(['16:9', '9:16']).default('16:9');

export const PronunciationRuleSchema = z.object({
  text: z.string().regex(/^[\u3400-\u9fff]{1,80}$/, '纠音词组需为 1 到 80 个汉字'),
  pinyin: z.array(z.string().regex(/^[a-züv]+[1-5]$/, '请填写带声调数字的拼音，如 hang2')).min(1).max(80),
  occurrence: z.number().int().positive().optional(),
}).refine(rule => rule.text.length === rule.pinyin.length, '每个汉字需要一个拼音');
export type PronunciationRule = z.infer<typeof PronunciationRuleSchema>;

const BaseSceneSchema = z.object({
  id: z.string().min(1),
  type: SceneTypeSchema,
  title: z.string().max(50).optional(),
  narration: z.string().min(1),
  pronunciationOverrides: z.array(PronunciationRuleSchema).max(200).optional(),
  pronunciationWarnings: z.array(z.string()).optional(),
  duration: z.number().positive().optional(),
  audioSrc: z.string().optional(),
  wordTimings: z.array(z.object({ text: z.string(), start: z.number().nonnegative(), end: z.number().positive() })).optional(),
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
  if (scene.type === 'timeline' && (!Array.isArray(scene.visual.items) || scene.visual.items.length < 2)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['visual', 'items'], message: 'timeline 场景至少需要两个时间节点' });
  }
  if (scene.type === 'math' && typeof scene.visual.formula !== 'string') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['visual', 'formula'], message: 'math 场景需要公式文本' });
  }
  if (scene.type === 'media' && (typeof scene.visual.src !== 'string' || !/^(projects\/[A-Za-z0-9_-]+\/assets\/[^/]+)$/.test(scene.visual.src))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['visual', 'src'], message: 'media 场景需要本地素材路径' });
  }
});

export const StoryboardSchema = z.object({
  title: z.string().min(1),
  pronunciationRules: z.array(PronunciationRuleSchema.refine(rule => rule.occurrence === undefined, '项目规则不能指定出现位置')).max(200).optional(),
  aspectRatio: AspectRatioSchema.default('16:9'),
  styleId: StyleIdSchema,
  durationTarget: z.number().positive().optional(),
  bgmSrc: z.string().optional(),
  bgmVolume: z.number().min(0).max(1).default(0.12),
  bgmFadeIn: z.number().min(0).max(10).default(1),
  bgmFadeOut: z.number().min(0).max(10).default(1),
  scenes: z.array(SceneSchema).min(1),
}).superRefine((storyboard, ctx) => {
  if (storyboard.bgmSrc && !/^(?:projects\/[A-Za-z0-9_-]+\/assets\/[^/]+|audio\/[^/]+)$/.test(storyboard.bgmSrc)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bgmSrc'], message: 'BGM 必须引用本地项目素材' });
  }
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
