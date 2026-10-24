import type { Storyboard } from './index';
import { timelineFrames } from './timeline';

/** Bump when the rendered pixels or the segment cache layout change. */
export const RENDER_VERSION = 1;
export const RENDER_FPS = 30;

export const RENDER_STAGES = ['bundling', 'rendering', 'concatenating', 'encoding', 'validating'] as const;
export type RenderStage = (typeof RENDER_STAGES)[number];

export const RENDER_STAGE_LABELS: Record<string, string> = {
  queued: '等待 Worker',
  bundling: '准备渲染资源',
  rendering: '渲染画面',
  concatenating: '拼接片段',
  encoding: '视频编码',
  validating: '校验成片',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
};

export type RenderFailureCode =
  | 'worker_lost'
  | 'interrupted'
  | 'cancelled'
  | 'asset_missing'
  | 'render_failed'
  | 'concat_failed'
  | 'encode_failed'
  | 'validate_failed'
  | 'unknown';

export type SegmentKind = 'intro' | 'scene' | 'outro';

/** Independently addressable render inputs; comparing them explains why a segment must run again. */
export type SegmentParts = { global: string; content: string; audio: string };

export type SegmentReason = 'new' | 'content' | 'audio' | 'global';

export type PlannedSegment = {
  key: string;
  kind: SegmentKind;
  index: number;
  sceneId?: string;
  startFrame: number;
  /** Frame count of this segment; `frameRange` end is `startFrame + frames - 1`. */
  frames: number;
  endFrame: number;
  parts: SegmentParts;
  fingerprint: string;
  reuse: boolean;
  reason: SegmentReason | null;
};

export type RenderPlan = {
  version: number;
  preset: 'full' | 'draft';
  fps: number;
  totalFrames: number;
  totalSeconds: number;
  segments: PlannedSegment[];
  reusedCount: number;
  renderedCount: number;
  reusedFrames: number;
  renderedFrames: number;
  reusedSeconds: number;
  renderedSeconds: number;
};

/** Sidecar written next to a cached segment file; the cache index is built from these. */
export type CachedSegment = {
  key: string;
  kind?: SegmentKind;
  fingerprint: string;
  frames: number;
  bytes?: number;
  parts?: SegmentParts;
  version?: number;
  preset?: string;
  createdAt?: string;
};

export type AudioSignature = { bytes: number; mtimeMs: number };

export type SegmentPlanInput = {
  storyboard: Storyboard;
  preset?: string;
  fps?: number;
  cached?: CachedSegment[];
  audioSignatures?: Record<string, AudioSignature>;
};

/** Key order independent serialisation so the same content always hashes to the same value. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return 'null';
}

/** 64 bit FNV-1a pair rendered as hex; deterministic and available in the browser and in Node. */
export function fingerprintOf(input: string): string {
  let left = 0x811c9dc5 ^ input.length;
  let right = 0x01000193 ^ input.length;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    left = Math.imul(left ^ code, 16777619);
    right = Math.imul(right ^ code, 2246822519);
  }
  left = Math.imul(left ^ (left >>> 15), 2246822507) ^ Math.imul(right ^ (right >>> 13), 3266489909);
  right = Math.imul(right ^ (right >>> 16), 2246822507) ^ Math.imul(left ^ (left >>> 13), 3266489909);
  return `${(right >>> 0).toString(16).padStart(8, '0')}${(left >>> 0).toString(16).padStart(8, '0')}`;
}

/** Inclusive range Remotion expects for `frameRange`. */
export const segmentFrameRange = (segment: Pick<PlannedSegment, 'startFrame' | 'frames'>): [number, number] => [segment.startFrame, segment.startFrame + segment.frames - 1];

export const segmentSeconds = (segment: Pick<PlannedSegment, 'frames'>, fps = RENDER_FPS) => segment.frames / fps;

const reasonOf = (cached: CachedSegment | undefined, next: SegmentParts): SegmentReason => {
  if (!cached) return 'new';
  if (!cached.parts || cached.parts.content !== next.content) return 'content';
  if (cached.parts.audio !== next.audio) return 'audio';
  return 'global';
};

/**
 * Splits the timeline into independently renderable segments and decides which
 * cached ones can be reused. Frame boundaries come from `timelineFrames` so the
 * plan can never disagree with the preview, the subtitles or the delivery check.
 */
export function segmentPlan(input: SegmentPlanInput): RenderPlan {
  const fps = input.fps ?? RENDER_FPS;
  const preset = input.preset === 'draft' ? 'draft' : 'full';
  const { storyboard } = input;
  const globalHash = fingerprintOf(stableStringify({
    version: RENDER_VERSION,
    preset,
    fps,
    styleId: storyboard.styleId,
    aspectRatio: storyboard.aspectRatio,
    subtitles: storyboard.subtitles ?? null,
    transition: storyboard.transition ?? 'none',
    bgm: {
      src: storyboard.bgmSrc ?? null,
      volume: storyboard.bgmVolume ?? 0.12,
      fadeIn: storyboard.bgmFadeIn ?? 1,
      fadeOut: storyboard.bgmFadeOut ?? 1,
    },
  }));
  const cachedByFingerprint = new Map<string, CachedSegment>();
  const cachedByKey = new Map<string, CachedSegment>();
  for (const item of input.cached ?? []) {
    cachedByFingerprint.set(item.fingerprint, item);
    cachedByKey.set(item.key, item);
  }
  const { segments, totalFrames } = timelineFrames(storyboard, fps);
  const planned: PlannedSegment[] = segments.map(segment => {
    const scene = segment.kind === 'scene' ? storyboard.scenes[segment.index] : undefined;
    const key = segment.kind === 'scene' ? `scene:${scene!.id}` : segment.kind;
    const content = segment.kind === 'scene'
      ? stableStringify(scene)
      : stableStringify({ card: segment.kind === 'intro' ? storyboard.intro ?? null : storyboard.outro ?? null, title: storyboard.title });
    const signature = scene?.audioSrc ? input.audioSignatures?.[scene.audioSrc] ?? null : null;
    const audio = segment.kind === 'scene'
      ? stableStringify({ src: scene?.audioSrc ?? null, duration: scene?.audioDuration ?? null, key: scene?.audioKey ?? null, signature })
      : stableStringify(null);
    const parts: SegmentParts = {
      global: globalHash,
      content: fingerprintOf(content),
      audio: fingerprintOf(audio),
    };
    const fingerprint = fingerprintOf(`${parts.global}:${parts.content}:${parts.audio}`);
    const reuse = cachedByFingerprint.has(fingerprint);
    return {
      key,
      kind: segment.kind,
      index: segment.index,
      sceneId: scene?.id,
      startFrame: segment.startFrame,
      frames: segment.frames,
      endFrame: segment.startFrame + segment.frames - 1,
      parts,
      fingerprint,
      reuse,
      reason: reuse ? null : reasonOf(cachedByKey.get(key), parts),
    };
  });
  const reusedFrames = planned.filter(segment => segment.reuse).reduce((total, segment) => total + segment.frames, 0);
  const renderedFrames = planned.filter(segment => !segment.reuse).reduce((total, segment) => total + segment.frames, 0);
  const reusedCount = planned.filter(segment => segment.reuse).length;
  return {
    version: RENDER_VERSION,
    preset,
    fps,
    totalFrames,
    totalSeconds: Math.round((totalFrames / fps) * 100) / 100,
    segments: planned,
    reusedCount,
    renderedCount: planned.length - reusedCount,
    reusedFrames,
    renderedFrames,
    reusedSeconds: Math.round((reusedFrames / fps) * 100) / 100,
    renderedSeconds: Math.round((renderedFrames / fps) * 100) / 100,
  };
}

/** Plan for a project that has no cache yet; every segment is rendered. */
export const fullRenderPlan = (storyboard: Storyboard, preset: string = 'full', fps = RENDER_FPS) => segmentPlan({ storyboard, preset, fps, cached: [] });

export type PlanReasonSummary = { code: SegmentReason; label: string; count: number; segments: PlannedSegment[] };

const reasonLabels: Record<SegmentReason, string> = {
  content: '内容有改动',
  audio: '语音有改动',
  global: '字幕/样式/BGM/画质有改动',
  new: '新增片段',
};

const reasonOrder: SegmentReason[] = ['content', 'audio', 'global', 'new'];

/** Why segments must be rendered again, grouped for the export panel. */
export function planReasons(plan: RenderPlan): PlanReasonSummary[] {
  return reasonOrder
    .map(code => {
      const segments = plan.segments.filter(segment => segment.reason === code);
      return { code, label: reasonLabels[code], count: segments.length, segments };
    })
    .filter(summary => summary.count > 0);
}

/** Segment label shown in the plan and in the render log. */
export function segmentLabel(segment: PlannedSegment, storyboard?: Storyboard): string {
  if (segment.kind === 'intro') return '片头';
  if (segment.kind === 'outro') return '片尾';
  const scene = storyboard?.scenes[segment.index];
  const title = scene?.title?.trim();
  return `场景 ${segment.index + 1}${title ? ` · ${title}` : ''}`;
}

/** Consecutive frame coverage check: the plan must tile the timeline without gaps. */
export function planCoversTimeline(plan: RenderPlan): boolean {
  let cursor = 0;
  for (const segment of plan.segments) {
    if (segment.startFrame !== cursor) return false;
    if (segment.frames <= 0) return false;
    cursor += segment.frames;
  }
  return cursor === plan.totalFrames;
}
