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
  isDefault: z.boolean().default(false),
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

export type PresetChangeKey = 'aspectRatio' | 'subtitles' | 'intro' | 'outro' | 'transition' | 'renderPreset';
export type PresetChange = { key: PresetChangeKey; label: string; current: string; next: string; changed: boolean };

const ratioText: Record<string, string> = { '16:9': '横屏 16:9', '9:16': '竖屏 9:16' };
const subtitlePresetText: Record<string, string> = { minimal: '极简', boxed: '描边', highlight: '高亮' };
const subtitlePositionText: Record<string, string> = { top: '顶部', center: '居中', bottom: '底部' };
const frameText = (frame: ReturnType<typeof FrameCardSchema.parse>) => frame.enabled
  ? `${frame.title?.trim() || '未命名'}${frame.subtitle?.trim() ? ` · ${frame.subtitle.trim()}` : ''} · ${frame.duration} 秒`
  : '关闭';
const subtitleText = (value: ReturnType<typeof SubtitleSchema.parse>) => value.enabled
  ? `${subtitlePresetText[value.preset] ?? value.preset} · ${subtitlePositionText[value.position] ?? value.position} · 字号 ${value.fontSize}`
  : '关闭';

/** What applying a preset would change, for the confirm step before anything is written. */
export function presetChanges(board: ExportPresetPatch, preset: ExportPreset, currentRenderPreset: 'full' | 'draft' = 'full'): PresetChange[] {
  const currentSubtitles = SubtitleSchema.parse(board.subtitles ?? {});
  const currentIntro = FrameCardSchema.parse(board.intro ?? {});
  const currentOutro = FrameCardSchema.parse(board.outro ?? {});
  return [
    {
      key: 'aspectRatio',
      label: '画面比例',
      current: ratioText[board.aspectRatio] ?? board.aspectRatio,
      next: ratioText[preset.aspectRatio] ?? preset.aspectRatio,
      changed: board.aspectRatio !== preset.aspectRatio,
    },
    {
      key: 'subtitles',
      label: '字幕样式',
      current: subtitleText(currentSubtitles),
      next: subtitleText(preset.subtitles),
      changed: JSON.stringify(currentSubtitles) !== JSON.stringify(preset.subtitles),
    },
    {
      key: 'intro',
      label: '片头',
      current: frameText(currentIntro),
      next: frameText(preset.intro ?? FrameCardSchema.parse({})),
      changed: JSON.stringify(currentIntro) !== JSON.stringify(preset.intro ?? FrameCardSchema.parse({})),
    },
    {
      key: 'outro',
      label: '片尾',
      current: frameText(currentOutro),
      next: frameText(preset.outro ?? FrameCardSchema.parse({})),
      changed: JSON.stringify(currentOutro) !== JSON.stringify(preset.outro ?? FrameCardSchema.parse({})),
    },
    {
      key: 'transition',
      label: '转场',
      current: board.transition === 'fade' ? '淡入淡出' : '无',
      next: preset.transition === 'fade' ? '淡入淡出' : '无',
      changed: board.transition !== preset.transition,
    },
    {
      key: 'renderPreset',
      label: '渲染质量',
      current: currentRenderPreset === 'draft' ? '草稿' : '正式',
      next: preset.renderPreset === 'draft' ? '草稿' : '正式',
      changed: currentRenderPreset !== preset.renderPreset,
    },
  ];
}

export const changedPresetCount = (changes: PresetChange[]) => changes.filter(change => change.changed).length;
