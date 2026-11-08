import type { CodeBeatFrame } from './code-timeline';

export type CodeViewport = { startLine: number; endLine: number };
export type CodeScrollKeyframe = { frame: number; startLine: number };

/** Guards against a single visible line (or a viewport smaller than one line). */
const LANDSCAPE_MIN_LINES = 12;
const LANDSCAPE_MAX_LINES = 16;
const PORTRAIT_MIN_LINES = 7;
const PORTRAIT_MAX_LINES = 11;
const LANDSCAPE_DEFAULT_LINES = 14;
const PORTRAIT_DEFAULT_LINES = 9;
const DEFAULT_LINE_HEIGHT_RATIO = 1.5;
const DEFAULT_TRANSITION_FRAMES = 12;
const MIN_TRANSITION_FRAMES = 8;
const MAX_TRANSITION_FRAMES = 15;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.max(1, Math.floor(value as number)) : fallback;
}

/**
 * How many code lines fit a fixed readable font size.
 *
 * Landscape frames show 12–16 lines and portrait frames 7–11 lines; the result is always an
 * integer and falls back to the portrait/landscape default when the measured size is invalid.
 */
export function resolveCodeVisibleLineCount(input: {
  heightPx: number;
  fontSizePx: number;
  lineHeightRatio?: number;
  portrait?: boolean;
}): number {
  const portrait = input.portrait === true;
  const ratio = Number.isFinite(input.lineHeightRatio) && (input.lineHeightRatio as number) > 0
    ? (input.lineHeightRatio as number)
    : DEFAULT_LINE_HEIGHT_RATIO;
  const heightPx = Number.isFinite(input.heightPx) ? Math.max(0, input.heightPx) : 0;
  const fontSizePx = Number.isFinite(input.fontSizePx) ? Math.max(0, input.fontSizePx) : 0;
  const fallback = portrait ? PORTRAIT_DEFAULT_LINES : LANDSCAPE_DEFAULT_LINES;
  if (!heightPx || !fontSizePx) return fallback;
  const raw = Math.floor(heightPx / (fontSizePx * ratio));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return clamp(raw, portrait ? PORTRAIT_MIN_LINES : LANDSCAPE_MIN_LINES, portrait ? PORTRAIT_MAX_LINES : LANDSCAPE_MAX_LINES);
}

/**
 * The visible line window for one beat.
 *
 * Active lines are centred with `visibleLineCount` lines around them, clamped to the source line
 * range. A window that already contains every active line is kept (no scroll), which avoids
 * pointless movement between consecutive beats in the same area.
 */
export function resolveCodeViewport(input: {
  totalLines: number;
  visibleLineCount: number;
  activeLines: number[];
  previousStartLine?: number;
}): CodeViewport {
  const totalLines = positiveInteger(input.totalLines, 1);
  const visible = clamp(positiveInteger(input.visibleLineCount, 1), 1, totalLines);
  const maxStart = Math.max(1, totalLines - visible + 1);
  const previousStart = Number.isFinite(input.previousStartLine) ? clamp(Math.round(input.previousStartLine as number), 1, maxStart) : undefined;
  const active = [...new Set((Array.isArray(input.activeLines) ? input.activeLines : [])
    .filter(line => Number.isInteger(line) && line >= 1 && line <= totalLines))]
    .sort((a, b) => a - b);
  if (!active.length) {
    const start = previousStart ?? 1;
    return { startLine: start, endLine: start + visible - 1 };
  }
  const first = active[0];
  const last = active[active.length - 1];
  if (previousStart !== undefined && first >= previousStart && last <= previousStart + visible - 1) {
    return { startLine: previousStart, endLine: previousStart + visible - 1 };
  }
  // Centre the active block inside the window; `round` gives a stable, deterministic start.
  const start = clamp(Math.round((first + last - visible + 1) / 2), 1, maxStart);
  return { startLine: start, endLine: start + visible - 1 };
}

/**
 * Frame keyframes for smooth viewport scrolling.
 *
 * The first keyframe is the first beat start. A viewport change inserts the previous `startLine`
 * at `beat.startFrame - transitionFrames` (clamped to 8–15 frames and to the previous keyframe)
 * followed by the new `startLine` exactly at `beat.startFrame`, so scrolling finishes in the same
 * frame the highlight switches — code is never highlighted while it is still off screen.
 */
export function resolveCodeScrollKeyframes(input: {
  beats: CodeBeatFrame[];
  totalLines: number;
  visibleLineCount: number;
  transitionFrames?: number;
}): CodeScrollKeyframe[] {
  const beats = Array.isArray(input.beats) ? input.beats : [];
  if (!beats.length) return [];
  const totalLines = positiveInteger(input.totalLines, 1);
  const visible = positiveInteger(input.visibleLineCount, 1);
  const transition = clamp(
    Number.isFinite(input.transitionFrames) ? Math.round(input.transitionFrames as number) : DEFAULT_TRANSITION_FRAMES,
    MIN_TRANSITION_FRAMES,
    MAX_TRANSITION_FRAMES,
  );
  const keyframes: CodeScrollKeyframe[] = [];
  let viewport: CodeViewport | null = null;
  for (const beat of beats) {
    const next = resolveCodeViewport({
      totalLines,
      visibleLineCount: visible,
      activeLines: beat.lines,
      ...(viewport ? { previousStartLine: viewport.startLine } : {}),
    });
    const beatFrame = Math.max(0, Math.round(Number.isFinite(beat.startFrame) ? beat.startFrame : 0));
    if (!viewport) {
      viewport = next;
      keyframes.push({ frame: beatFrame, startLine: next.startLine });
      continue;
    }
    if (next.startLine !== viewport.startLine) {
      const previousFrame = keyframes.length ? keyframes[keyframes.length - 1].frame : 0;
      const scrollFrame = Math.max(previousFrame, beatFrame - transition);
      keyframes.push({ frame: scrollFrame, startLine: viewport.startLine });
      keyframes.push({ frame: Math.max(scrollFrame, beatFrame), startLine: next.startLine });
      viewport = next;
    } else {
      viewport = next;
    }
  }
  return keyframes;
}
