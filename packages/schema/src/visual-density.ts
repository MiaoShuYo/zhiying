import { z } from 'zod';
import type { Scene, Storyboard } from './index';
import { VisualPlanSchema, type VisualTemplateId, type VisualBeat, type VisualPlan } from './visual-plan';

export const VisualDensitySettingsSchema = z.object({
  autoSplit: z.boolean(),
  strategy: z.enum(['concise', 'balanced', 'complete']),
});
export type VisualDensitySettings = z.infer<typeof VisualDensitySettingsSchema>;
export const defaultVisualDensitySettings: VisualDensitySettings = { autoSplit: true, strategy: 'balanced' };

export type VisualDensityEstimate = {
  usedHeight: number;
  availableHeight: number;
  ratio: number;
  overBudget: boolean;
  warnings: string[];
  targetIds: string[];
};

type TextBlock = { targetId: string; text: string; fontSize: number; lineHeight: number; extraHeight?: number };
const safeText = (value: unknown) => typeof value === 'string' ? value : '';
const recordLabel = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const item = value as Record<string, unknown>;
  return [item.label, item.text, item.title, item.content, item.description, item.value].find(part => typeof part === 'string') as string | undefined ?? '';
};
const textWidth = (text: string): number => [...text].reduce((sum, char) => {
  if (/\s/u.test(char)) return sum + 0.32;
  if (/[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\u{1f000}-\u{1faff}]/u.test(char)) return sum + 1;
  return sum + 0.56;
}, 0);

function blocksFor(scene: Scene, portrait: boolean): TextBlock[] {
  const body = portrait ? 27 : 30;
  const title = portrait ? 47 : 58;
  const blocks: TextBlock[] = [];
  if (scene.title) blocks.push({ targetId: 'scene-title', text: scene.title, fontSize: title, lineHeight: 1.12, extraHeight: 20 });
  switch (scene.type) {
    case 'title':
    case 'text': blocks.push({ targetId: 'hero-copy', text: scene.type === 'text' ? safeText(scene.visual.text) || scene.narration : scene.narration, fontSize: body, lineHeight: 1.55 }); break;
    case 'bullets':
      for (const [index, item] of (Array.isArray(scene.visual.items) ? scene.visual.items : []).entries()) {
        const value = typeof item === 'string' ? item : recordLabel(item);
        const children = item && typeof item === 'object' && !Array.isArray(item) && Array.isArray((item as Record<string, unknown>).children) ? (item as { children: unknown[] }).children : [];
        blocks.push({ targetId: `bullet-${index + 1}`, text: [value, ...children.map(safeText)].join('\n'), fontSize: body, lineHeight: 1.48, extraHeight: 14 });
      }
      break;
    case 'comparison':
      for (const [index, column] of (Array.isArray(scene.visual.columns) ? scene.visual.columns : []).entries()) {
        const value = column && typeof column === 'object' ? column as Record<string, unknown> : {};
        blocks.push({ targetId: `compare-${index + 1}`, text: [safeText(value.title), ...(Array.isArray(value.items) ? value.items.map(safeText) : [])].join('\n'), fontSize: body, lineHeight: 1.45, extraHeight: 72 });
      }
      break;
    case 'diagram':
      for (const [index, node] of (Array.isArray(scene.visual.nodes) ? scene.visual.nodes : []).entries()) blocks.push({ targetId: typeof (node as { id?: unknown })?.id === 'string' ? String((node as { id: string }).id) : `node-${index + 1}`, text: recordLabel(node), fontSize: body, lineHeight: 1.4, extraHeight: 60 });
      break;
    case 'timeline':
      for (const [index, item] of (Array.isArray(scene.visual.items) ? scene.visual.items : []).entries()) {
        const value = item && typeof item === 'object' ? item as Record<string, unknown> : {};
        blocks.push({ targetId: `timeline-${index + 1}`, text: `${safeText(value.date)}\n${safeText(value.label)}`, fontSize: body, lineHeight: 1.45, extraHeight: 60 });
      }
      break;
    case 'chart':
      for (const [index, item] of (Array.isArray(scene.visual.data) ? scene.visual.data : []).entries()) blocks.push({ targetId: `chart-${index + 1}`, text: recordLabel(item), fontSize: body * .72, lineHeight: 1.3, extraHeight: 74 });
      break;
    case 'table': {
      const rows = Array.isArray(scene.visual.rows) ? scene.visual.rows : [];
      for (const [index, row] of rows.entries()) blocks.push({ targetId: `table-row-${index + 1}`, text: Array.isArray(row) ? row.map(safeText).join(' ') : '', fontSize: body * .72, lineHeight: 1.3, extraHeight: 24 });
      break;
    }
    case 'math': blocks.push({ targetId: 'formula', text: safeText(scene.visual.formula), fontSize: body * 1.5, lineHeight: 1.3, extraHeight: 80 }); break;
    case 'media': blocks.push({ targetId: 'media', text: scene.narration, fontSize: body, lineHeight: 1.4 }); break;
    case 'code': blocks.push({ targetId: 'code', text: safeText(scene.visual.code) || scene.narration, fontSize: body * .72, lineHeight: 1.55 }); break;
    case 'html': blocks.push({ targetId: 'html', text: scene.narration, fontSize: body, lineHeight: 1.4 }); break;
  }
  return blocks.filter(block => block.text.trim());
}

/** Estimated text geometry on the actual logical canvas, reserving title, subtitle and Logo bands. */
export function estimateVisualDensity(scene: Scene, aspectRatio: Storyboard['aspectRatio']): VisualDensityEstimate {
  const portrait = aspectRatio === '9:16';
  const width = portrait ? 1080 : 1920;
  const height = portrait ? 1920 : 1080;
  const availableWidth = width * .86;
  const availableHeight = height * .63;
  const blocks = blocksFor(scene, portrait);
  const usedHeight = blocks.reduce((sum, block) => {
    const linePx = Math.max(1, textWidth(block.text) * block.fontSize);
    const explicitLines = block.text.split(/\r?\n/).length;
    const wrappedLines = Math.max(explicitLines, Math.ceil(linePx / availableWidth));
    return sum + wrappedLines * block.fontSize * block.lineHeight + (block.extraHeight ?? 0);
  }, scene.title ? 28 : 0);
  const ratio = usedHeight / Math.max(1, availableHeight);
  const overBudget = ratio > .82 || blocks.length > (portrait ? 6 : 8);
  const warnings: string[] = [];
  if (overBudget) warnings.push('场景超出可读性预算，建议按知识点分步显示或拆镜。');
  if (scene.title && textWidth(scene.title) * (portrait ? 47 : 58) > availableWidth * 1.8) warnings.push('标题可能需要分行或缩短后再检查最小字号。');
  return { usedHeight, availableHeight, ratio, overBudget, warnings, targetIds: blocks.map(block => block.targetId) };
}

function sentenceParts(narration: string): string[] {
  const raw = narration.split(/(?<=[。！？!?；;\n])/u).filter(part => part.length > 0);
  const merged: string[] = [];
  let leadingWhitespace = '';
  for (const part of raw) {
    if (!part.trim()) {
      if (merged.length) merged[merged.length - 1] += part;
      else leadingWhitespace += part;
    } else {
      merged.push(leadingWhitespace + part);
      leadingWhitespace = '';
    }
  }
  if (leadingWhitespace && merged.length) merged[merged.length - 1] += leadingWhitespace;
  const result: string[] = [];
  for (const part of merged) {
    if ([...part].length <= 640) result.push(part);
    else {
      let rest = part;
      while ([...rest].length > 640) {
        const characters = [...rest];
        let splitAt = 560;
        for (let index = 559; index >= 320; index -= 1) {
          if (/\s/u.test(characters[index]!)) { splitAt = index + 1; break; }
        }
        let chunk = characters.slice(0, splitAt).join('');
        rest = characters.slice(splitAt).join('');
        if (!chunk.trim() && rest.trim()) {
          const firstVisible = [...rest].findIndex(character => !/\s/u.test(character));
          if (firstVisible >= 0 && firstVisible < 640) {
            const restCharacters = [...rest];
            chunk += restCharacters.slice(0, firstVisible + 1).join('');
            rest = restCharacters.slice(firstVisible + 1).join('');
          }
        }
        if (chunk.trim()) result.push(chunk);
        else if (result.length) result[result.length - 1] += chunk;
        else leadingWhitespace += chunk;
        if (leadingWhitespace && rest.trim()) { rest = leadingWhitespace + rest; leadingWhitespace = ''; }
      }
      if (rest) {
        if (rest.trim()) result.push(rest);
        else if (result.length) result[result.length - 1] += rest;
        else leadingWhitespace += rest;
      }
    }
  }
  if (leadingWhitespace && result.length) result[result.length - 1] += leadingWhitespace;
  return result.filter(part => part.trim().length > 0);
}

function targetGroups(targetIds: string[], strategy: VisualDensitySettings['strategy']): string[][] {
  const groupSize = strategy === 'concise' ? 1 : strategy === 'complete' ? 3 : 2;
  const groups: string[][] = [];
  for (let index = 0; index < targetIds.length; index += groupSize) groups.push(targetIds.slice(index, index + groupSize));
  return groups.length ? groups : [[]];
}

function defaultTemplate(scene: Scene): VisualTemplateId | null {
  switch (scene.type) {
    case 'title': case 'text': return 'hero';
    case 'comparison': return 'comparison';
    case 'diagram': return 'diagram';
    case 'timeline': return 'timeline';
    case 'chart': return Array.isArray(scene.visual.data) && scene.visual.data.some(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).value === 'number') ? 'chart' : null;
    default: return null;
  }
}

export type VisualTemplateDecision = {
  templateId: VisualTemplateId;
  narrativeIntent: VisualPlan['narrativeIntent'];
  selectionReason: NonNullable<VisualPlan['selectionReason']>;
};

/** Deterministic semantic rules select a compatible template without model output. */
export function decideVisualTemplate(scene: Scene): VisualTemplateDecision | null {
  const templateId = defaultTemplate(scene);
  if (!templateId) return null;
  const byTemplate: Record<VisualTemplateId, Omit<VisualTemplateDecision, 'templateId'>> = {
    hero: { narrativeIntent: scene.title ? 'hook' : 'explanation', selectionReason: 'title-or-text' },
    comparison: { narrativeIntent: 'comparison', selectionReason: 'two-column-comparison' },
    diagram: { narrativeIntent: 'flow', selectionReason: 'ordered-flow' },
    timeline: { narrativeIntent: 'timeline', selectionReason: 'chronological-events' },
    chart: { narrativeIntent: 'data-story', selectionReason: 'numeric-data' },
  };
  return { templateId, ...byTemplate[templateId] };
}

/** Applies rule-selected visual plans to newly generated boards; user locks take precedence. */
export function selectRuleVisualPlans(board: Storyboard): Storyboard {
  return {
    ...board,
    scenes: board.scenes.map(scene => {
      if (scene.visualPlan?.manualOverride || scene.visualPlan?.provenance === 'user') return scene;
      const decision = decideVisualTemplate(scene);
      if (!decision) return scene;
      const visualPlan = VisualPlanSchema.parse({
        ...scene.visualPlan,
        ...decision,
        manualOverride: false,
        provenance: 'rule',
      });
      return { ...scene, visualPlan };
    }),
  };
}

/** Assign semantic beats without changing or summarizing the source narration or visual values. */
export function applyVisualDensity(scene: Scene, aspectRatio: Storyboard['aspectRatio'], settings: VisualDensitySettings): Scene {
  const density = estimateVisualDensity(scene, aspectRatio);
  if (scene.type === 'media' || scene.type === 'code' || scene.type === 'html' || typeof scene.visual.html === 'string') return scene;
  if (scene.visualPlan?.manualOverride) return scene;
  if (!settings.autoSplit || !density.overBudget || !scene.narration.trim()) {
    if (scene.visualBeatsProvenance !== 'rule') return scene;
    const cleared: Scene = { ...scene, visualBeats: undefined, visualBeatsProvenance: undefined };
    if (scene.visualPlan?.provenance === 'rule' && !scene.visualPlan.manualOverride) cleared.visualPlan = VisualPlanSchema.parse({ ...scene.visualPlan, beats: [] });
    return cleared;
  }
  const templateId = scene.visualPlan?.templateId ?? defaultTemplate(scene);
  const sentences = sentenceParts(scene.narration);
  const displaySegments = templateId === 'hero' ? sentenceParts(scene.type === 'text' ? safeText(scene.visual.text) || scene.narration : scene.narration) : [];
  const groups = targetGroups(density.targetIds, settings.strategy);
  const beatCount = Math.max(sentences.length, groups.length, displaySegments.length);
  const beats: VisualBeat[] = Array.from({ length: beatCount }, (_, index) => ({
    id: `density-${index + 1}`,
    narrationText: sentences[index] ?? '',
    ...(displaySegments[index] ? { contentText: displaySegments[index] } : {}),
    targetIds: templateId === 'hero' ? [`hero-copy-${index + 1}`] : groups[Math.min(groups.length - 1, Math.floor(index * groups.length / Math.max(1, beatCount)))] ?? [],
    ...(groups.length > sentences.length ? { label: `重点 ${index + 1}` } : {}),
  }));
  const existing = scene.visualPlan;
  const next: Scene = {
    ...scene,
    visualBeats: beats,
    visualBeatsProvenance: 'rule',
  };
  if (templateId) next.visualPlan = VisualPlanSchema.parse({
      ...existing,
      templateId,
      narrativeIntent: existing?.narrativeIntent ?? (templateId === 'hero' ? 'explanation' : templateId === 'comparison' ? 'comparison' : templateId === 'diagram' ? 'flow' : templateId === 'timeline' ? 'timeline' : 'data-story'),
      keyFocus: existing?.keyFocus,
      beats,
      motionPresets: existing?.motionPresets ?? [],
      elementMap: existing?.elementMap ?? {},
      manualOverride: false,
      provenance: 'rule',
    });
  return next;
}

export function applyDensitySettings(board: Storyboard, settings: VisualDensitySettings): Storyboard {
  return { ...board, visualDensity: settings, scenes: board.scenes.map(scene => applyVisualDensity(scene, board.aspectRatio, settings)) };
}
