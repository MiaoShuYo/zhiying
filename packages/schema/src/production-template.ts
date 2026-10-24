import { z } from 'zod';
import { AspectRatioSchema, FrameCardSchema, SubtitleSchema, TransitionSchema } from './delivery';
import type { Storyboard } from './index';

/** A reusable production setup: voice, subtitles, frame and export quality in one bundle. */
export const ProductionTemplateSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(40),
  voiceId: z.string().max(120).optional(),
  speechSpeed: z.number().min(0.5).max(3).default(1),
  sentencePause: z.number().min(0).max(3).default(0.12),
  sceneGap: z.number().min(0).max(10).default(0),
  aspectRatio: AspectRatioSchema,
  subtitles: SubtitleSchema,
  transition: TransitionSchema,
  intro: FrameCardSchema.optional(),
  outro: FrameCardSchema.optional(),
  bgmVolume: z.number().min(0).max(1).default(0.12),
  bgmFadeIn: z.number().min(0).max(10).default(1),
  bgmFadeOut: z.number().min(0).max(10).default(1),
  renderPreset: z.enum(['full', 'draft']).default('full'),
  isDefault: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProductionTemplate = z.infer<typeof ProductionTemplateSchema>;

export type TemplateSceneSettings = Pick<ProductionTemplate, 'speechSpeed' | 'sentencePause' | 'sceneGap'>;
export type TemplateBoardPatch = Pick<Storyboard, 'aspectRatio' | 'subtitles' | 'transition' | 'intro' | 'outro' | 'bgmVolume' | 'bgmFadeIn' | 'bgmFadeOut'>;

export type TemplateChangeKey = 'voiceId' | 'speechSpeed' | 'sentencePause' | 'sceneGap' | 'aspectRatio' | 'subtitles' | 'intro' | 'outro' | 'transition' | 'bgmVolume' | 'renderPreset';

/** One row of the "what would applying this change" table. Scene-scoped rows are applied to every scene. */
export type TemplateChange = { key: TemplateChangeKey; label: string; current: string; next: string; changed: boolean; scope: 'project' | 'scene' };
export type TemplateImpact = { rows: TemplateChange[]; sceneCount: number; changedCount: number };

const speedOrDefault = (value?: number) => value ?? 1;
const pauseOrDefault = (value?: number) => value ?? 0.12;
const gapOrDefault = (value?: number) => value ?? 0;

const sceneSettings = (scene: Storyboard['scenes'][number]): TemplateSceneSettings => ({
  speechSpeed: speedOrDefault(scene.speechSpeed),
  sentencePause: pauseOrDefault(scene.sentencePause),
  sceneGap: gapOrDefault(scene.sceneGap),
});

/** Most common value across scenes, so a template saved from an uneven project still matches what it actually renders most of the time. */
function mode(values: number[], fallback: number) {
  if (!values.length) return fallback;
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = fallback, bestCount = 0;
  for (const [value, count] of counts) if (count > bestCount) { best = value; bestCount = count; }
  return best;
}

export function templateFromProject(input: { board: Storyboard; voiceId?: string | null; renderPreset?: 'full' | 'draft' }): Omit<ProductionTemplate, 'id' | 'createdAt' | 'updatedAt'> {
  const { board } = input;
  const settings = board.scenes.map(sceneSettings);
  return {
    name: board.title.slice(0, 40),
    voiceId: input.voiceId ?? undefined,
    speechSpeed: mode(settings.map(setting => setting.speechSpeed), 1),
    sentencePause: mode(settings.map(setting => setting.sentencePause), 0.12),
    sceneGap: mode(settings.map(setting => setting.sceneGap), 0),
    aspectRatio: board.aspectRatio ?? '16:9',
    subtitles: SubtitleSchema.parse(board.subtitles ?? {}),
    transition: board.transition,
    intro: board.intro,
    outro: board.outro,
    bgmVolume: board.bgmVolume ?? 0.12,
    bgmFadeIn: board.bgmFadeIn ?? 1,
    bgmFadeOut: board.bgmFadeOut ?? 1,
    renderPreset: input.renderPreset ?? 'full',
    isDefault: false,
  };
}

/** Project-level settings only: never touches scenes, narration, pronunciation rules or assets. */
export function templateBoardPatch(template: ProductionTemplate): TemplateBoardPatch {
  return {
    aspectRatio: template.aspectRatio,
    subtitles: template.subtitles,
    transition: template.transition,
    intro: template.intro,
    outro: template.outro,
    bgmVolume: template.bgmVolume,
    bgmFadeIn: template.bgmFadeIn,
    bgmFadeOut: template.bgmFadeOut,
  };
}

export function templateScenePatch(template: ProductionTemplate): TemplateSceneSettings {
  return { speechSpeed: template.speechSpeed, sentencePause: template.sentencePause, sceneGap: template.sceneGap };
}

const ratioText: Record<string, string> = { '16:9': '横屏 16:9', '9:16': '竖屏 9:16' };
const presetText: Record<string, string> = { minimal: '极简', boxed: '描边', highlight: '高亮' };
const positionText: Record<string, string> = { top: '顶部', center: '居中', bottom: '底部' };
const subtitleText = (value: ReturnType<typeof SubtitleSchema.parse>) => value.enabled
  ? `${presetText[value.preset] ?? value.preset} · ${positionText[value.position] ?? value.position} · 字号 ${value.fontSize}`
  : '关闭';
const frameText = (frame: ReturnType<typeof FrameCardSchema.parse>) => frame.enabled ? `${frame.title?.trim() || '未命名'} · ${frame.duration} 秒` : '关闭';
const seconds = (value: number) => `${Number(value.toFixed(2))} 秒`;

/** Preview table before writing anything: which project rows change, and how many scenes get new timing. */
export function templateChanges(board: Storyboard, voiceId: string | null | undefined, template: ProductionTemplate, currentRenderPreset: 'full' | 'draft' = 'full'): TemplateImpact {
  const nextSettings = templateScenePatch(template);
  const settings = board.scenes.map(sceneSettings);
  const sceneCount = settings.filter(setting => setting.speechSpeed !== nextSettings.speechSpeed || setting.sentencePause !== nextSettings.sentencePause || setting.sceneGap !== nextSettings.sceneGap).length;
  const currentSubtitles = SubtitleSchema.parse(board.subtitles ?? {});
  const currentIntro = FrameCardSchema.parse(board.intro ?? {});
  const currentOutro = FrameCardSchema.parse(board.outro ?? {});
  const nextIntro = FrameCardSchema.parse(template.intro ?? {});
  const nextOutro = FrameCardSchema.parse(template.outro ?? {});
  const rows: TemplateChange[] = [
    { key: 'voiceId', label: '声音', scope: 'project', current: voiceId || '未指定', next: template.voiceId || '未指定', changed: (voiceId || '') !== (template.voiceId || '') },
    { key: 'speechSpeed', label: '语速', scope: 'scene', current: `${mode(settings.map(setting => setting.speechSpeed), 1)}×`, next: `${template.speechSpeed}×`, changed: settings.some(setting => setting.speechSpeed !== nextSettings.speechSpeed) },
    { key: 'sentencePause', label: '句间停顿', scope: 'scene', current: seconds(mode(settings.map(setting => setting.sentencePause), 0.12)), next: seconds(template.sentencePause), changed: settings.some(setting => setting.sentencePause !== nextSettings.sentencePause) },
    { key: 'sceneGap', label: '场景间隔', scope: 'scene', current: seconds(mode(settings.map(setting => setting.sceneGap), 0)), next: seconds(template.sceneGap), changed: settings.some(setting => setting.sceneGap !== nextSettings.sceneGap) },
    { key: 'aspectRatio', label: '画面比例', scope: 'project', current: ratioText[board.aspectRatio] ?? board.aspectRatio, next: ratioText[template.aspectRatio] ?? template.aspectRatio, changed: board.aspectRatio !== template.aspectRatio },
    { key: 'subtitles', label: '字幕样式', scope: 'project', current: subtitleText(currentSubtitles), next: subtitleText(template.subtitles), changed: JSON.stringify(currentSubtitles) !== JSON.stringify(template.subtitles) },
    { key: 'intro', label: '片头', scope: 'project', current: frameText(currentIntro), next: frameText(nextIntro), changed: JSON.stringify(currentIntro) !== JSON.stringify(nextIntro) },
    { key: 'outro', label: '片尾', scope: 'project', current: frameText(currentOutro), next: frameText(nextOutro), changed: JSON.stringify(currentOutro) !== JSON.stringify(nextOutro) },
    { key: 'transition', label: '转场', scope: 'project', current: board.transition === 'fade' ? '淡入淡出' : '无', next: template.transition === 'fade' ? '淡入淡出' : '无', changed: board.transition !== template.transition },
    { key: 'bgmVolume', label: '背景音乐音量', scope: 'project', current: `${Math.round((board.bgmVolume ?? 0.12) * 100)}%`, next: `${Math.round(template.bgmVolume * 100)}%`, changed: (board.bgmVolume ?? 0.12) !== template.bgmVolume },
    { key: 'renderPreset', label: '导出画质', scope: 'project', current: currentRenderPreset === 'draft' ? '草稿' : '正式', next: template.renderPreset === 'draft' ? '草稿' : '正式', changed: currentRenderPreset !== template.renderPreset },
  ];
  return { rows, sceneCount, changedCount: rows.filter(row => row.changed).length };
}

/** One-line summary for the template list, without needing any board. */
export function templateSummary(template: ProductionTemplate) {
  return `声音 ${template.voiceId || '未指定'} · ${template.speechSpeed}× · 字幕 ${subtitleText(template.subtitles)} · ${ratioText[template.aspectRatio] ?? template.aspectRatio} · ${template.renderPreset === 'draft' ? '草稿' : '正式'}`;
}
