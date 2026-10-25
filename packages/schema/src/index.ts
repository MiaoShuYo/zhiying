import { z } from 'zod';
import { AspectRatioSchema, FrameCardSchema, SubtitleSchema, TransitionSchema } from './delivery';

export const SceneTypeSchema = z.enum(['title', 'text', 'bullets', 'diagram', 'comparison', 'chart', 'code', 'timeline', 'math', 'table', 'media', 'html']);
export const StyleIdSchema = z.enum(['minimal-tech', 'clean-light', 'academic', 'social-short', 'whiteboard']);

export const PronunciationRuleSchema = z.object({
  text: z.string().regex(/^[\u3400-\u9fff]{1,80}$/, '纠音词组需为 1 到 80 个汉字'),
  pinyin: z.array(z.string().regex(/^[a-züv]+[1-5]$/, '请填写带声调数字的拼音，如 hang2')).min(1).max(80),
  occurrence: z.number().int().positive().optional(),
}).refine(rule => rule.text.length === rule.pinyin.length, '每个汉字需要一个拼音');
export type PronunciationRule = z.infer<typeof PronunciationRuleSchema>;

export const SubtitleCueSchema = z.object({
  text: z.string().min(1).max(200),
  start: z.number().nonnegative(),
  end: z.number().positive(),
}).refine(cue => cue.end > cue.start, '字幕结束时间需晚于开始时间');
export type SubtitleCue = z.infer<typeof SubtitleCueSchema>;

const BaseSceneSchema = z.object({
  id: z.string().min(1),
  type: SceneTypeSchema,
  title: z.string().max(50).optional(),
  narration: z.string().min(1),
  pronunciationOverrides: z.array(PronunciationRuleSchema).max(200).optional(),
  pronunciationWarnings: z.array(z.string()).optional(),
  duration: z.number().positive().optional(),
  layout: z.enum(['auto', 'stack', 'columns', 'compact']).optional(),
  sceneStyle: StyleIdSchema.optional(),
  speechSpeed: z.number().min(0.5).max(3).optional(),
  sentencePause: z.number().min(0).max(3).optional(),
  sceneGap: z.number().min(0).max(10).optional(),
  audioDuration: z.number().nonnegative().optional(),
  audioKey: z.string().optional(),
  image: z.object({ fit: z.enum(['contain', 'cover']).default('contain'), zoom: z.number().min(1).max(3).default(1), x: z.number().min(0).max(100).default(50), y: z.number().min(0).max(100).default(50) }).optional(),
  audioSrc: z.string().optional(),
  wordTimings: z.array(z.object({ text: z.string(), start: z.number().nonnegative(), end: z.number().positive() })).optional(),
  subtitleCues: z.array(SubtitleCueSchema).max(60).optional(),
  sourcePage: z.number().int().min(1).optional(),
  visual: z.record(z.unknown()).default({}),
  animation: z.string().optional(),
  styleOverride: z.record(z.unknown()).optional(),
});

export const SceneSchema = BaseSceneSchema.superRefine((scene, ctx) => {
  if (scene.type === 'html' && (typeof scene.visual.html !== 'string' || !scene.visual.html.trim() || scene.visual.html.length > 20000)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['visual', 'html'], message: 'html 场景需要不超过 20000 个字符的 HTML 片段' });
  }
  if (scene.type === 'bullets') {
    const items = scene.visual.items;
    const validItem = (item: unknown): boolean => {
      if (typeof item === 'string') return true;
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const point = item as { text?: unknown; children?: unknown };
      return typeof point.text === 'string' && (point.children === undefined || (
        Array.isArray(point.children) && point.children.length <= 4 && point.children.every(child => typeof child === 'string')
      ));
    };
    if (!Array.isArray(items) || items.length < 1 || items.length > 5 || !items.every(validItem)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['visual', 'items'], message: 'bullets 场景需要 1 到 5 条要点；每条可为字符串或包含 text 与 children 的两层要点' });
    }
  }
  if (scene.type === 'comparison' && (!Array.isArray(scene.visual.columns) || scene.visual.columns.length !== 2)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['visual', 'columns'], message: 'comparison 场景需要两列 columns' });
  }
  if (scene.type === 'chart' && (!Array.isArray(scene.visual.data) || scene.visual.data.length < 1) && (!Array.isArray(scene.visual.nodes) || scene.visual.nodes.length < 2)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['visual'], message: '图表/图示场景需要 data 或至少两个 nodes' });
  }
  if (scene.type === 'timeline' && (!Array.isArray(scene.visual.items) || scene.visual.items.length < 2)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['visual', 'items'], message: 'timeline 场景至少需要两个时间节点' });
  }
  if (scene.type === 'table') {
    const headers = scene.visual.headers;
    const rows = scene.visual.rows;
    if (!Array.isArray(headers) || headers.length < 1 || !Array.isArray(rows) || rows.length < 1 || !rows.every(row => Array.isArray(row) && row.length === headers.length && row.every(cell => typeof cell === 'string'))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['visual'], message: 'table 场景需要 headers 和列数一致的非空 rows' });
    }
  }
  if (scene.type === 'math' && typeof scene.visual.formula !== 'string') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['visual', 'formula'], message: 'math 场景需要公式文本' });
  }
  if (scene.type === 'text' && (typeof scene.visual.text !== 'string' || !scene.visual.text.trim())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['visual', 'text'], message: 'text 场景需要非空文本' });
  }
  if (scene.type === 'media' && (typeof scene.visual.src !== 'string' || !/^(projects\/[A-Za-z0-9_-]+\/assets\/[^/]+)$/.test(scene.visual.src))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['visual', 'src'], message: 'media 场景需要本地素材路径' });
  }
});

/** Restrict generated scene markup to inert presentation HTML and inline styles. */
export function sanitizeSceneHtml(input: string): string {
  let html = input.slice(0, 20000)
    .replace(/<(script|style|iframe|object|embed|form|video|audio|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|iframe|object|embed|form|video|audio|svg|math)\b[^>]*\/?>/gi, '');
  const tags = new Set(['div', 'span', 'p', 'h1', 'h2', 'h3', 'strong', 'b', 'em', 'i', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'br', 'hr']);
  html = html.replace(/<\/?([a-z][a-z0-9-]*)\b([^>]*)>/gi, (whole, rawName: string, rawAttrs: string) => {
    const name = rawName.toLowerCase();
    if (!tags.has(name)) return '';
    if (whole.startsWith('</')) return `</${name}>`;
    const attrs: string[] = [];
    const className = /\bclass\s*=\s*(["'])(.*?)\1/i.exec(rawAttrs)?.[2];
    if (className && /^[\w\s-]{1,120}$/.test(className)) attrs.push(`class="${className}"`);
    const style = /\bstyle\s*=\s*(["'])(.*?)\1/i.exec(rawAttrs)?.[2];
    if (style) {
      const allowed = new Set(['color', 'background', 'background-color', 'font-size', 'font-weight', 'text-align', 'line-height', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin', 'border', 'border-radius', 'display', 'flex', 'flex-direction', 'gap', 'align-items', 'justify-content', 'width', 'max-width', 'height', 'grid-template-columns', 'box-shadow']);
      const declarations = style.split(';').flatMap(rule => {
        const colon = rule.indexOf(':');
        if (colon < 1) return [];
        const property = rule.slice(0, colon).trim().toLowerCase();
        const value = rule.slice(colon + 1).trim();
        return allowed.has(property) && value.length <= 100 && /^[\w\s#(),.%/-]+$/.test(value) ? [`${property}:${value}`] : [];
      });
      if (declarations.length) attrs.push(`style="${declarations.join(';')}"`);
    }
    return `<${name}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
  });
  return html;
}

/** Basic delivery frame: a title card before the first scene or after the last one. */
export type FrameCard = z.infer<typeof FrameCardSchema>;

export type Transition = z.infer<typeof TransitionSchema>;

export const StoryboardSchema = z.object({
  title: z.string().min(1),
  pronunciationRules: z.array(PronunciationRuleSchema.refine(rule => rule.occurrence === undefined, '项目规则不能指定出现位置')).max(200).optional(),
  aspectRatio: AspectRatioSchema.default('16:9'),
  styleId: StyleIdSchema,
  durationTarget: z.number().positive().optional(),
  subtitles: SubtitleSchema.optional(),
  bgmSrc: z.string().optional(),
  bgmVolume: z.number().min(0).max(1).default(0.12),
  bgmFadeIn: z.number().min(0).max(10).default(1),
  bgmFadeOut: z.number().min(0).max(10).default(1),
  intro: FrameCardSchema.optional(),
  outro: FrameCardSchema.optional(),
  transition: TransitionSchema,
  scenes: z.array(SceneSchema).min(1),
}).superRefine((storyboard, ctx) => {
  if (storyboard.bgmSrc && !/^(?:projects\/[A-Za-z0-9_-]+\/assets\/[^/]+|audio\/[^/]+)$/.test(storyboard.bgmSrc)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bgmSrc'], message: 'BGM 必须引用本地项目素材' });
  }
});
export const ProjectStatusSchema = z.enum(['awaiting_source_review', 'created', 'extracting', 'analyzing', 'writing', 'storyboarding', 'awaiting_review', 'generating_audio', 'building_timeline', 'rendering', 'encoding', 'completed', 'failed']);
export const JobStatusSchema = z.enum(['queued', 'running', 'cancelling', 'cancelled', 'completed', 'failed']);

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

export * from "./batch";
export * from "./captions";
export * from "./delivery";
export * from "./editor";
export * from "./estimate";
export * from "./export-flow";
export * from "./presets";
export * from "./preflight";
export * from "./production-template";
export * from "./qc";
export * from "./render-plan";
export * from "./render-validation";
export * from "./timeline";
