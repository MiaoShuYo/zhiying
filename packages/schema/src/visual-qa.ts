import { z } from 'zod';
import type { Scene, Storyboard } from './index';
import { applyVisualDensity, estimateVisualDensity, type VisualDensitySettings } from './visual-density';
import { resolveVisualBeatTimeline } from './visual-timeline';

const UnitBoxSchema = z.object({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() }).strict();

/** Browser-measured element data from a rendered frame. Bounds use normalized 0..1 coordinates. */
export const VisualQaLayoutSampleSchema = z.object({
  sceneId: z.string().min(1),
  beatId: z.string().optional(),
  targetId: z.string().optional(),
  frame: z.number().int().nonnegative(),
  screenshotPath: z.string().min(1).optional(),
  elementType: z.enum(['text', 'subtitle', 'logo', 'visual']),
  bounds: UnitBoxSchema,
  fontSizePx: z.number().positive().optional(),
  /** Text content is captured only for staged hero copy targets to aid beat-level QA. */
  textContent: z.string().max(1200).optional(),
  contrastRatio: z.number().nonnegative().optional(),
  overflow: z.boolean().optional(),
}).strict();

export const VisualQaFrameSampleSchema = z.object({
  sceneId: z.string().min(1),
  beatId: z.string().optional(),
  frame: z.number().int().nonnegative(),
  screenshotPath: z.string().min(1).optional(),
  meanLuminance: z.number().min(0).max(1).optional(),
  blankPixelRatio: z.number().min(0).max(1).optional(),
  backgroundMatched: z.boolean().optional(),
  blackFrame: z.boolean().optional(),
}).strict();

export const VisualQaSubtitleTimingSampleSchema = z.object({
  sceneId: z.string().min(1),
  beatId: z.string().min(1),
  frame: z.number().int().nonnegative(),
  screenshotPath: z.string().min(1).optional(),
  beatStartFrame: z.number().int().nonnegative(),
  beatEndFrame: z.number().int().positive(),
  subtitleStartFrame: z.number().int().nonnegative(),
  subtitleEndFrame: z.number().int().positive(),
}).strict();

export const VisualQaTransitionSampleSchema = z.object({
  fromSceneId: z.string().min(1),
  toSceneId: z.string().min(1),
  frame: z.number().int().nonnegative(),
  screenshotPath: z.string().min(1).optional(),
  unmatchedPixelRatio: z.number().min(0).max(1),
  blackFrame: z.boolean().optional(),
  sharedElementDetected: z.boolean().optional(),
}).strict();

export const VisualQaRenderEvidenceSchema = z.object({
  layout: z.array(VisualQaLayoutSampleSchema).default([]),
  frames: z.array(VisualQaFrameSampleSchema).default([]),
  subtitleTiming: z.array(VisualQaSubtitleTimingSampleSchema).default([]),
  transitions: z.array(VisualQaTransitionSampleSchema).default([]),
}).strict();
export type VisualQaRenderEvidence = z.infer<typeof VisualQaRenderEvidenceSchema>;

export const VisualQaFindingSchema = z.object({
  sceneId: z.string(),
  code: z.enum([
    'density-over-budget', 'render-overflow', 'font-too-small', 'caption-safe-area', 'logo-safe-area',
    'logo-collision', 'text-collision', 'low-contrast', 'empty-frame', 'black-frame', 'sudden-change',
    'subtitle-beat-timeout', 'unmapped-motion-target', 'table-staging-incomplete',
  ]),
  severity: z.enum(['warning', 'error']),
  message: z.string(),
  /** Stable editor and timeline location, even when a preview image is not available yet. */
  location: z.object({ sceneId: z.string(), beatId: z.string().optional(), targetId: z.string().optional(), frame: z.number().int().nonnegative(), screenshotPath: z.string().min(1).optional() }).strict(),
  targetIds: z.array(z.string()).default([]),
  fixable: z.boolean(),
}).strict();
export type VisualQaFinding = z.infer<typeof VisualQaFindingSchema>;

export const VisualQaReportSchema = z.object({
  version: z.literal(1),
  phase: z.enum(['preflight', 'post-render']),
  checkedScenes: z.number().int().nonnegative(),
  evidenceFrames: z.number().int().nonnegative(),
  findings: z.array(VisualQaFindingSchema),
  autoFixRounds: z.number().int().min(0).max(2).default(0),
  /** Scenes whose motion was disabled after bounded repairs could not clear a render risk. */
  staticFallbacks: z.array(z.object({ sceneId: z.string().min(1), reason: z.string().min(1) }).strict()).default([]),
});
export type VisualQaReport = z.infer<typeof VisualQaReportSchema>;

type QaInput = { fps?: number; phase?: 'preflight' | 'post-render'; renderEvidence?: VisualQaRenderEvidence; renderOverflowSceneIds?: string[] };

function canRepairScene(scene: Scene | undefined): scene is Scene {
  return Boolean(scene && !scene.visualPlan?.manualOverride && scene.visualPlan?.provenance !== 'user'
    && scene.visualBeatsProvenance !== 'user'
    && scene.type !== 'media' && scene.type !== 'code' && scene.type !== 'html' && typeof scene.visual.html !== 'string');
}

function canRepairOverflowScene(scene: Scene | undefined): scene is Scene {
  // Tables already enforce a readable font-size floor in the renderer. Scaling
  // the whole table to fix overflow would make every cell unreadable.
  return canRepairScene(scene) && scene.type !== 'table';
}

const boxesOverlap = (a: z.infer<typeof UnitBoxSchema>, b: z.infer<typeof UnitBoxSchema>) => {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const area = width * height;
  return area / Math.max(.0001, Math.min(a.width * a.height, b.width * b.height));
};

function screenshotFor(evidence: VisualQaRenderEvidence, sceneId: string, beatId?: string, frame?: number) {
  return evidence.layout.find(sample => sample.sceneId === sceneId && (!beatId || sample.beatId === beatId) && (frame === undefined || sample.frame === frame))?.screenshotPath
    ?? evidence.frames.find(sample => sample.sceneId === sceneId && (!beatId || sample.beatId === beatId) && (frame === undefined || sample.frame === frame))?.screenshotPath;
}

export function visualQualityAudit(board: Storyboard, input: QaInput = {}): VisualQaReport {
  const fps = input.fps ?? 30;
  const evidence = VisualQaRenderEvidenceSchema.parse(input.renderEvidence ?? {});
  const overflowIds = new Set(input.renderOverflowSceneIds ?? []);
  const findings: VisualQaFinding[] = [];
  const add = (finding: VisualQaFinding) => findings.push(VisualQaFindingSchema.parse(finding));

  for (const scene of board.scenes) {
    const density = estimateVisualDensity(scene, board.aspectRatio);
    const stagedByRule = scene.visualBeatsProvenance === 'rule' && (scene.visualBeats?.length ?? 0) > 1;
    const beat = resolveVisualBeatTimeline(scene, fps)[0];
    if (density.overBudget && !stagedByRule) add({
      sceneId: scene.id, code: 'density-over-budget', severity: 'warning',
      message: density.warnings[0] ?? '场景内容超过可读性预算。', targetIds: density.targetIds,
      location: { sceneId: scene.id, ...(beat ? { beatId: beat.id } : {}), frame: beat?.startFrame ?? 0, screenshotPath: screenshotFor(evidence, scene.id, beat?.id, beat?.startFrame) },
      fixable: canRepairScene(scene),
    });
    const tableRows = scene.type === 'table' && Array.isArray(scene.visual.rows) ? scene.visual.rows : [];
    const rowTargetIds = tableRows.map((_, index) => `table-row-${index + 1}`);
    const tableBeatTargets = new Set(resolveVisualBeatTimeline(scene, fps).flatMap(item => item.targetIds));
    const uncoveredTableRows = rowTargetIds.filter(targetId => !tableBeatTargets.has(targetId));
    const sceneBeats = resolveVisualBeatTimeline(scene, fps);
    if (tableRows.length > 1 && sceneBeats.length > 1 && uncoveredTableRows.length > 0) add({
      sceneId: scene.id, code: 'table-staging-incomplete', severity: 'warning',
      message: '表格分步目标没有覆盖全部数据行，已保留完整表格以避免隐藏事实。',
      targetIds: uncoveredTableRows,
      location: { sceneId: scene.id, beatId: sceneBeats[0]!.id, frame: sceneBeats[0]!.startFrame, screenshotPath: screenshotFor(evidence, scene.id, sceneBeats[0]!.id, sceneBeats[0]!.startFrame) },
      fixable: false,
    });
    if (overflowIds.has(scene.id)) add({
      sceneId: scene.id, code: 'render-overflow', severity: 'error',
      message: '浏览器排版测量发现内容超出安全画面。', targetIds: density.targetIds,
      location: { sceneId: scene.id, ...(beat ? { beatId: beat.id } : {}), frame: beat?.startFrame ?? 0, screenshotPath: screenshotFor(evidence, scene.id, beat?.id, beat?.startFrame) },
      fixable: canRepairOverflowScene(scene),
    });
    const knownTargets = new Set([...density.targetIds, 'scene-title', 'hero-copy', 'hero-stat', 'hero-stat-number', 'key-focus']);
    for (const targetId of Object.values(scene.visualPlan?.elementMap ?? {})) knownTargets.add(targetId);
    for (const visualBeat of [...(scene.visualBeats ?? []), ...(scene.visualPlan?.beats ?? [])]) for (const targetId of visualBeat.targetIds) knownTargets.add(targetId);
    const unknownTargets = scene.visualStaticFallback ? [] : (scene.visualPlan?.motionPresets ?? []).filter(action => !knownTargets.has(action.targetId));
    if (unknownTargets.length) add({
      sceneId: scene.id, code: 'unmapped-motion-target', severity: 'error',
      message: '动画动作引用了场景中不存在的目标。', targetIds: unknownTargets.map(action => action.targetId),
      location: { sceneId: scene.id, beatId: unknownTargets[0]!.beatRef, targetId: unknownTargets[0]!.targetId, frame: resolveVisualBeatTimeline(scene, fps).find(item => item.id === unknownTargets[0]!.beatRef)?.startFrame ?? 0 },
      fixable: false,
    });
  }

  for (const sample of evidence.layout) {
    const location = { sceneId: sample.sceneId, ...(sample.beatId ? { beatId: sample.beatId } : {}), ...(sample.targetId ? { targetId: sample.targetId } : {}), frame: sample.frame, ...(sample.screenshotPath ? { screenshotPath: sample.screenshotPath } : {}) };
    const scene = board.scenes.find(item => item.id === sample.sceneId);
    if (sample.overflow || sample.bounds.x < 0 || sample.bounds.y < 0 || sample.bounds.x + sample.bounds.width > 1 || sample.bounds.y + sample.bounds.height > 1) add({
      sceneId: sample.sceneId, code: 'render-overflow', severity: 'error', message: '元素超出画面边界。', location, targetIds: sample.targetId ? [sample.targetId] : [], fixable: canRepairOverflowScene(scene),
    });
    const minimumFont = board.aspectRatio === '9:16' ? 20 : 18;
    if (sample.elementType === 'text' && sample.fontSizePx !== undefined && sample.fontSizePx < minimumFont) add({
      sceneId: sample.sceneId, code: 'font-too-small', severity: 'warning', message: `字号 ${sample.fontSizePx}px 低于 ${minimumFont}px 可读阈值。`, location, targetIds: sample.targetId ? [sample.targetId] : [], fixable: false,
    });
    if (sample.elementType === 'text' && sample.contrastRatio !== undefined && sample.contrastRatio < 4.5) add({
      sceneId: sample.sceneId, code: 'low-contrast', severity: 'warning', message: `文字对比度 ${sample.contrastRatio.toFixed(2)}:1 低于 4.5:1。`, location, targetIds: sample.targetId ? [sample.targetId] : [], fixable: false,
    });
    // DOMRect values are normalized floating point measurements. Allow a tiny
    // tolerance at the exact 5% boundary so a mathematically safe subtitle
    // (for example bottom=0.05) is not reported outside the safe area due to
    // binary rounding.
    const safeAreaEpsilon = 1e-6;
    if (sample.elementType === 'subtitle' && (sample.bounds.x < .05 - safeAreaEpsilon || sample.bounds.y < .05 - safeAreaEpsilon || sample.bounds.x + sample.bounds.width > .95 + safeAreaEpsilon || sample.bounds.y + sample.bounds.height > .95 + safeAreaEpsilon)) add({
      sceneId: sample.sceneId, code: 'caption-safe-area', severity: 'error', message: '字幕超出 5% 安全边距。', location, targetIds: sample.targetId ? [sample.targetId] : [], fixable: false,
    });
    if (sample.elementType === 'logo' && (sample.bounds.x < .05 - safeAreaEpsilon || sample.bounds.y < .05 - safeAreaEpsilon || sample.bounds.x + sample.bounds.width > .95 + safeAreaEpsilon || sample.bounds.y + sample.bounds.height > .95 + safeAreaEpsilon)) add({
      sceneId: sample.sceneId, code: 'logo-safe-area', severity: 'warning', message: 'Logo 超出 5% 安全边距。', location, targetIds: sample.targetId ? [sample.targetId] : [], fixable: false,
    });
  }
  for (const sample of evidence.layout) {
    if (sample.elementType === 'logo' || sample.elementType === 'subtitle') {
      const collisions = evidence.layout.filter(other => other.sceneId === sample.sceneId && other.frame === sample.frame && other !== sample && ((sample.elementType === 'logo' && other.elementType === 'subtitle') || (sample.elementType === 'subtitle' && other.elementType === 'logo')) && boxesOverlap(sample.bounds, other.bounds) > .08);
      for (const other of collisions) add({
        sceneId: sample.sceneId, code: 'logo-collision', severity: 'error', message: 'Logo 与字幕占用同一安全区域。',
        location: { sceneId: sample.sceneId, ...(sample.beatId ? { beatId: sample.beatId } : {}), ...(sample.targetId ? { targetId: sample.targetId } : {}), frame: sample.frame, ...(sample.screenshotPath ? { screenshotPath: sample.screenshotPath } : {}) },
        targetIds: [sample.targetId, other.targetId].filter((value): value is string => Boolean(value)), fixable: false,
      });
    }
  }
  const textSamples = evidence.layout.filter(sample => sample.elementType === 'text');
  for (let left = 0; left < textSamples.length; left += 1) for (let right = left + 1; right < textSamples.length; right += 1) {
    const a = textSamples[left]!, b = textSamples[right]!;
    if (a.sceneId !== b.sceneId || a.frame !== b.frame || boxesOverlap(a.bounds, b.bounds) <= .15) continue;
    add({ sceneId: a.sceneId, code: 'text-collision', severity: 'error', message: '两个文本区域发生碰撞。',
      location: { sceneId: a.sceneId, ...(a.beatId ? { beatId: a.beatId } : {}), ...(a.targetId ? { targetId: a.targetId } : {}), frame: a.frame, ...(a.screenshotPath ? { screenshotPath: a.screenshotPath } : {}) },
      targetIds: [a.targetId, b.targetId].filter((value): value is string => Boolean(value)), fixable: false });
  }
  for (const sample of evidence.frames) {
    const location = { sceneId: sample.sceneId, ...(sample.beatId ? { beatId: sample.beatId } : {}), frame: sample.frame, ...(sample.screenshotPath ? { screenshotPath: sample.screenshotPath } : {}) };
    if (sample.blackFrame || (sample.meanLuminance !== undefined && sample.meanLuminance < .008 && !sample.backgroundMatched)) add({ sceneId: sample.sceneId, code: 'black-frame', severity: 'error', message: '采样帧接近全黑。', location, targetIds: [], fixable: false });
    if (sample.blankPixelRatio !== undefined && sample.blankPixelRatio > .99) add({ sceneId: sample.sceneId, code: 'empty-frame', severity: 'error', message: '采样帧超过 99% 为空白像素。', location, targetIds: [], fixable: false });
  }
  for (const sample of evidence.transitions) {
    const location = { sceneId: sample.toSceneId, frame: sample.frame, ...(sample.screenshotPath ? { screenshotPath: sample.screenshotPath } : {}) };
    if (sample.blackFrame) add({ sceneId: sample.toSceneId, code: 'black-frame', severity: 'error', message: '转场帧接近全黑。', location, targetIds: [], fixable: false });
    if (sample.unmatchedPixelRatio > .72 && !sample.sharedElementDetected) add({ sceneId: sample.toSceneId, code: 'sudden-change', severity: 'warning', message: `转场像素突变比例 ${Math.round(sample.unmatchedPixelRatio * 100)}%，建议使用匹配或共享元素过渡。`, location, targetIds: [], fixable: false });
  }
  for (const sample of evidence.subtitleTiming) {
    const scene = board.scenes.find(item => item.id === sample.sceneId);
    const fpsTolerance = Math.max(2, Math.round(fps * .08));
    if (sample.subtitleStartFrame > sample.beatStartFrame + fpsTolerance || sample.subtitleEndFrame > sample.beatEndFrame + fpsTolerance) add({
      sceneId: sample.sceneId, code: 'subtitle-beat-timeout', severity: 'warning', message: '字幕起止时间超出对应旁白 beat。',
      location: { sceneId: sample.sceneId, beatId: sample.beatId, frame: sample.frame, ...(sample.screenshotPath ? { screenshotPath: sample.screenshotPath } : {}) },
      targetIds: [], fixable: false,
    });
    void scene;
  }
  const deduped = [...new Map(findings.map(finding => [`${finding.sceneId}:${finding.code}:${finding.location.frame}:${finding.location.targetId ?? ''}:${finding.location.beatId ?? ''}`, finding])).values()];
  return VisualQaReportSchema.parse({
    version: 1,
    phase: input.phase ?? (input.renderEvidence ? 'post-render' : 'preflight'),
    checkedScenes: board.scenes.length,
    evidenceFrames: evidence.frames.length + evidence.transitions.length,
    findings: deduped,
    autoFixRounds: 0,
    staticFallbacks: board.scenes.filter(scene => scene.visualStaticFallback).map(scene => ({
      sceneId: scene.id,
      reason: scene.visualStaticFallbackReason ?? '该场景已启用静态动作回退。',
    })),
  });
}

function protectedSceneData(scenes: Scene[]) {
  return scenes.map(scene => JSON.stringify({ narration: scene.narration, visual: scene.visual, audioSrc: scene.audioSrc, audioDuration: scene.audioDuration, wordTimings: scene.wordTimings, subtitleCues: scene.subtitleCues }));
}

/** Runs at most two deterministic density/fit repairs, then disables motion on unresolved risky scenes. */
export function autoFixVisualQuality(board: Storyboard, input: QaInput & { maxRounds?: number } = {}): { storyboard: Storyboard; report: VisualQaReport } {
  const maxRounds = Math.min(2, Math.max(0, Math.floor(input.maxRounds ?? 2)));
  const protectedBefore = protectedSceneData(board.scenes);
  const lockedBefore = board.scenes.map(scene => scene.visualPlan?.manualOverride ? scene : undefined);
  let storyboard = board;
  let autoFixRounds = 0;
  const staticFallbacks = new Map<string, string>();
  const fontGuardedOverflowIds = new Set<string>();
  let currentInput: QaInput = input;
  for (let round = 0; round < maxRounds; round += 1) {
    const report = visualQualityAudit(storyboard, currentInput);
    const densityIds = new Set(report.findings.filter(finding => finding.fixable && finding.code === 'density-over-budget').map(finding => finding.sceneId));
    const overflowIds = new Set(report.findings.filter(finding => finding.fixable && finding.code === 'render-overflow').map(finding => finding.sceneId));
    if (!densityIds.size && !overflowIds.size) break;
    const settings: VisualDensitySettings = { autoSplit: true, strategy: round === 0 ? 'concise' : 'balanced' };
    const nextScenes = storyboard.scenes.map(scene => {
      if (!canRepairScene(scene)) return scene;
      let next = densityIds.has(scene.id) ? applyVisualDensity(scene, storyboard.aspectRatio, settings) : scene;
      if (overflowIds.has(scene.id)) {
        const current = next.visualFitScale ?? 1;
        const scale = Math.max(.78, Math.round((current - .1) * 100) / 100);
        if (scale < current) {
          const minimumFont = storyboard.aspectRatio === '9:16' ? 20 : 18;
          const fontSamples = currentInput.renderEvidence?.layout.filter(sample => sample.sceneId === scene.id && sample.elementType === 'text' && sample.fontSizePx !== undefined) ?? [];
          const wouldMakeTextUnreadable = fontSamples.some(sample => sample.fontSizePx! * scale / current < minimumFont);
          if (wouldMakeTextUnreadable) fontGuardedOverflowIds.add(scene.id);
          else next = { ...next, visualFitScale: scale };
        }
      }
      return next;
    });
    if (nextScenes.every((scene, index) => scene === storyboard.scenes[index])) break;
    if (currentInput.renderEvidence && overflowIds.size) {
      const previousScales = new Map(storyboard.scenes.map(scene => [scene.id, scene.visualFitScale ?? 1]));
      const nextScales = new Map(nextScenes.map(scene => [scene.id, scene.visualFitScale ?? 1]));
      const layout = currentInput.renderEvidence.layout.map(sample => {
        const previousScale = previousScales.get(sample.sceneId) ?? 1;
        const nextScale = nextScales.get(sample.sceneId) ?? previousScale;
        const ratio = nextScale / previousScale;
        if (!overflowIds.has(sample.sceneId) || ratio >= 1 || sample.elementType === 'logo') return sample;
        const centerX = sample.bounds.x + sample.bounds.width / 2;
        const centerY = sample.bounds.y + sample.bounds.height / 2;
        const width = sample.bounds.width * ratio;
        const height = sample.bounds.height * ratio;
        const x = .5 + (centerX - .5) * ratio - width / 2;
        const y = .5 + (centerY - .5) * ratio - height / 2;
        return {
          ...sample,
          bounds: { x, y, width, height },
          overflow: x < 0 || y < 0 || x + width > 1 || y + height > 1,
        };
      });
      currentInput = {
        ...currentInput,
        renderEvidence: { ...currentInput.renderEvidence, layout },
        renderOverflowSceneIds: currentInput.renderOverflowSceneIds?.filter(sceneId => !overflowIds.has(sceneId)),
      };
    }
    storyboard = { ...storyboard, scenes: nextScenes };
    autoFixRounds += 1;
  }
  // Static fallback is a terminal safety mode, not a third layout-repair pass.
  // Preserve facts and user-owned scenes, and report the reason so an editor can
  // review the fallback instead of treating it as a successful visual repair.
  if (maxRounds > 0) {
    const finalAudit = visualQualityAudit(storyboard, currentInput);
    const fallbackCodes = new Set(['render-overflow', 'unmapped-motion-target', 'empty-frame', 'black-frame']);
    const fallbackSceneIds = new Set(finalAudit.findings
      .filter(finding => fallbackCodes.has(finding.code))
      .map(finding => finding.sceneId));
    const fallbackReason = `自动修复结束后仍有渲染风险（${autoFixRounds} 轮），已关闭该场景的动态效果；请检查静态画面并重新进行导出后验收。`;
    if (fallbackSceneIds.size > 0) {
      storyboard = {
        ...storyboard,
        scenes: storyboard.scenes.map(scene => {
          const hasMotion = Boolean(scene.visualPlan?.motionPresets.length);
          if (!fallbackSceneIds.has(scene.id) || !hasMotion || !canRepairScene(scene)) return scene;
          staticFallbacks.set(scene.id, fallbackReason);
          return { ...scene, visualStaticFallback: true, visualStaticFallbackReason: fallbackReason };
        }),
      };
    }
  }
  if (JSON.stringify(protectedBefore) !== JSON.stringify(protectedSceneData(storyboard.scenes))) throw new Error('视觉 QA 修复不得改写旁白、画面事实或音频时间信息');
  for (const [index, locked] of lockedBefore.entries()) if (locked && storyboard.scenes[index] !== locked) throw new Error('视觉 QA 修复不得改写用户锁定的场景');
  const finalAudit = visualQualityAudit(storyboard, currentInput);
  const report = VisualQaReportSchema.parse({
    ...finalAudit,
    findings: finalAudit.findings.map(finding => fontGuardedOverflowIds.has(finding.sceneId) && finding.code === 'render-overflow'
      ? { ...finding, fixable: false, message: `${finding.message} 为保护文字可读性，自动修复未继续缩小字号；请拆分场景或手工调整布局。` }
      : finding),
    autoFixRounds,
    staticFallbacks: [...staticFallbacks].map(([sceneId, reason]) => ({ sceneId, reason })),
  });
  return { storyboard, report };
}
