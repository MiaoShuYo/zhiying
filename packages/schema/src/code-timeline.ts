import { codeVisualOf, type CodeBeat, type CodeTraceStateEntry } from './code-visual';
import {
  resolveCodeBuildSteps,
  resolveCodeDiffView,
  resolveCodeTraceSteps,
} from './code-mode';

export type CodeBeatFrame = { startFrame: number; endFrame: number; lines: number[]; label?: string };

/** One frame window of a `mode: 'build'` step (#25); the union of reveal lines drives what is shown. */
export type CodeBuildStepFrame = {
  startFrame: number;
  endFrame: number;
  index: number;
  revealLines: number[];
  focusLines: number[];
  label?: string;
};

/** One frame window of a `mode: 'trace'` step (#27), carrying the verified execution state. */
export type CodeTraceStepFrame = {
  startFrame: number;
  endFrame: number;
  index: number;
  lines: number[];
  label?: string;
  narrationText?: string;
  state?: CodeTraceStateEntry[];
  output?: string;
  callDepth?: number;
};

/** One frame window of a `mode: 'diff'` beat (#26), selected by its hunk ids. */
export type CodeDiffBeatFrame = {
  startFrame: number;
  endFrame: number;
  index: number;
  hunkIds: string[];
  label?: string;
  narrationText?: string;
};

type WordTimingLike = { text: string; start: number; end: number };
type CaptionCueLike = { text: string; start: number; end: number };
type FrameWindow = { start: number; end: number };

type TimelineScene = {
  duration?: number;
  audioDuration?: number;
  wordTimings?: WordTimingLike[];
  subtitleCues?: CaptionCueLike[];
  visual?: Record<string, unknown>;
};

/** A beat never flashes for less than 0.6s, so a spotlight does not strobe between lines. */
const MINIMUM_BEAT_SECONDS = 0.6;

/** Narration matching ignores whitespace, punctuation and symbols so `直接返回。` matches `直接返回`. */
function normalizeAlignmentText(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function isValidWindow(window: FrameWindow | null): window is FrameWindow {
  return Boolean(window && Number.isFinite(window.start) && Number.isFinite(window.end) && window.end > window.start);
}

/** Match a beat's narration against the word-level alignments; first matching start to last matching end. */
function wordWindow(narrationText: string, words: WordTimingLike[], fps: number): FrameWindow | null {
  const target = normalizeAlignmentText(narrationText);
  if (!target) return null;
  const spans: { from: number; to: number; start: number; end: number }[] = [];
  let joined = '';
  for (const word of words) {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start || word.start < 0 || word.end < 0) continue;
    const key = normalizeAlignmentText(word.text);
    if (!key) continue;
    spans.push({ from: joined.length, to: joined.length + key.length - 1, start: word.start, end: word.end });
    joined += key;
  }
  const position = joined.indexOf(target);
  if (position < 0) return null;
  const endPosition = position + target.length - 1;
  const first = spans.find(span => span.from <= position && position <= span.to);
  const last = [...spans].reverse().find(span => span.from <= endPosition && endPosition <= span.to);
  if (!first || !last) return null;
  const window = { start: Math.round(first.start * fps), end: Math.round(last.end * fps) };
  return isValidWindow(window) ? window : null;
}

/** Locate a beat by matching its narration against subtitle cues (mutual containment). */
function cueWindow(narrationText: string, cues: CaptionCueLike[], fps: number): FrameWindow | null {
  const target = normalizeAlignmentText(narrationText);
  if (!target) return null;
  const matches = cues.map(cue => {
    const text = normalizeAlignmentText(cue.text);
    return Boolean(text) && (text.includes(target) || target.includes(text));
  });
  const firstIndex = matches.indexOf(true);
  if (firstIndex < 0) return null;
  let lastIndex = firstIndex;
  while (lastIndex + 1 < cues.length && matches[lastIndex + 1]) lastIndex += 1;
  const first = cues[firstIndex];
  const last = cues[lastIndex];
  if (!Number.isFinite(first.start) || !Number.isFinite(last.end) || last.end <= first.start) return null;
  const window = { start: Math.round(Math.max(0, first.start) * fps), end: Math.round(last.end * fps) };
  return isValidWindow(window) ? window : null;
}

/** Ascending, de-duplicated line numbers; dirty `<= 0` values are ignored instead of throwing. */
function normalizedLines(lines: number[]): number[] {
  const valid = lines.filter(line => Number.isInteger(line) && line > 0);
  return [...new Set(valid)].sort((a, b) => a - b);
}

/**
 * Shared "narration-anchored step timeline" used by every code mode.
 *
 * Priority per step: `wordTimings` → `subtitleCues` → even distribution over the scene duration.
 * A step never gets less than 0.6s when the scene is long enough; when it is not, even distribution
 * wins. Windows are monotonically increasing and the last one ends exactly at the scene duration.
 */
function resolveAnchoredWindows(scene: TimelineScene, narrations: Array<string | undefined>, fpsInput: number): FrameWindow[] {
  const count = narrations.length;
  if (!count) return [];
  const safeFps = Number.isFinite(fpsInput) && fpsInput > 0 ? fpsInput : 30;
  const durationSeconds = scene.audioDuration ?? Math.max(3, scene.duration ?? 6);
  const durationFrames = Math.max(1, Math.round((Number.isFinite(durationSeconds) ? durationSeconds : 6) * safeFps));
  const minimumFrames = Math.max(1, Math.round(safeFps * MINIMUM_BEAT_SECONDS));
  // When the steps cannot each hold the minimum window, distribution wins over the minimum.
  const minimumFeasible = count * minimumFrames <= durationFrames;
  const words = Array.isArray(scene.wordTimings) ? scene.wordTimings : [];
  const cues = Array.isArray(scene.subtitleCues) ? scene.subtitleCues : [];
  const windows = narrations.map((narrationText, index): FrameWindow => {
    if (narrationText) {
      const aligned = wordWindow(narrationText, words, safeFps) ?? cueWindow(narrationText, cues, safeFps);
      if (aligned) return aligned;
    }
    return {
      start: Math.round(durationFrames * index / count),
      end: Math.round(durationFrames * (index + 1) / count),
    };
  });
  const frames: FrameWindow[] = [];
  let cursor = 0;
  // #164: every step keeps the full minimum when it fits (one frame otherwise). Starts and ends are
  // bounded by the time the remaining steps need, so a late anchor can no longer squeeze the
  // following steps below the minimum or make their windows overlap.
  const need = minimumFeasible ? minimumFrames : 1;
  windows.forEach((window, index) => {
    const last = index === count - 1;
    const remaining = count - index;
    let start = Math.max(0, Math.round(window.start), cursor);
    start = Math.min(start, Math.max(cursor, durationFrames - remaining * need));
    let end = Math.max(Math.round(window.end), start + need);
    if (last) {
      end = durationFrames;
    } else {
      const reserved = Math.max(start + need, durationFrames - (remaining - 1) * need);
      end = Math.min(end, reserved);
    }
    cursor = end;
    frames.push({ start, end });
  });
  const lastFrame = frames[frames.length - 1];
  if (lastFrame.end <= lastFrame.start) lastFrame.start = Math.max(0, lastFrame.end - 1);
  return frames;
}

const asTimelineScene = (sceneInput: Record<string, unknown>): TimelineScene => sceneInput as TimelineScene;

/**
 * Pure mapping from narration-anchored code beats to Remotion frame windows.
 *
 * Priority per beat: `wordTimings` → `subtitleCues` → even distribution over the scene duration.
 * Nothing is written back into `scene.visual.beats`, so regenerating the audio or changing the
 * speech speed only requires calling this again with the new `audioDuration` / `wordTimings`.
 *
 * The input is typed loosely so callers may pass a `Scene` or a persisted scene record; only the
 * timing and `visual` fields are read (missing/invalid data falls back safely).
 */
export function resolveCodeBeatTimeline(
  sceneInput: Record<string, unknown>,
  fps = 30,
): CodeBeatFrame[] {
  const scene = asTimelineScene(sceneInput);
  const beats: CodeBeat[] = codeVisualOf(scene.visual)?.beats ?? [];
  if (!beats.length) return [];
  const windows = resolveAnchoredWindows(scene, beats.map(beat => beat.narrationText), fps);
  return windows.map((window, index) => {
    const beat = beats[index];
    return {
      startFrame: window.start,
      endFrame: window.end,
      lines: normalizedLines(beat.lines),
      ...(beat.label ? { label: beat.label } : {}),
    };
  });
}

/**
 * Frame windows for `mode: 'build'` steps (#25).
 *
 * Reads the resolver-validated `buildSteps`; the mode/data must be valid (otherwise `[]`). Timing is
 * identical to `resolveCodeBeatTimeline`: `narrationText` alignment first, even distribution as the
 * fallback. Steps carry `revealLines`/`focusLines` so a renderer can reveal code incrementally.
 */
export function resolveCodeBuildStepTimeline(
  sceneInput: Record<string, unknown>,
  fps = 30,
): CodeBuildStepFrame[] {
  const scene = asTimelineScene(sceneInput);
  const steps = resolveCodeBuildSteps(codeVisualOf(scene.visual));
  if (!steps?.length) return [];
  const windows = resolveAnchoredWindows(scene, steps.map(step => step.narrationText), fps);
  return windows.map((window, index) => {
    const step = steps[index];
    return {
      startFrame: window.start,
      endFrame: window.end,
      index,
      revealLines: [...step.revealLines],
      focusLines: [...step.focusLines],
      ...(step.label ? { label: step.label } : {}),
    };
  });
}

/**
 * Frame windows for `mode: 'trace'` steps (#27).
 *
 * Timing rules are shared with the beat timeline. Each window carries the step's verified
 * `state`/`output`/`callDepth` (when the source material provided them) so both renderers can show
 * the execution state that belongs to the highlighted lines.
 */
export function resolveCodeTraceStepTimeline(
  sceneInput: Record<string, unknown>,
  fps = 30,
): CodeTraceStepFrame[] {
  const scene = asTimelineScene(sceneInput);
  const steps = resolveCodeTraceSteps(codeVisualOf(scene.visual));
  if (!steps?.length) return [];
  const windows = resolveAnchoredWindows(scene, steps.map(step => step.narrationText), fps);
  return windows.map((window, index) => {
    const step = steps[index];
    return {
      startFrame: window.start,
      endFrame: window.end,
      index,
      lines: [...step.lines],
      ...(step.label ? { label: step.label } : {}),
      ...(step.narrationText ? { narrationText: step.narrationText } : {}),
      ...(step.state ? { state: step.state } : {}),
      ...(step.output !== undefined ? { output: step.output } : {}),
      ...(step.callDepth !== undefined ? { callDepth: step.callDepth } : {}),
    };
  });
}

/**
 * Frame windows for `mode: 'diff'` beats (#26).
 *
 * The beats come from `resolveCodeDiffView`, which also supplies the default "one beat per hunk"
 * sequence when the model did not provide `diffBeats`, so the highlight always advances through the
 * changed hunks in order.
 */
export function resolveCodeDiffBeatTimeline(
  sceneInput: Record<string, unknown>,
  fps = 30,
): CodeDiffBeatFrame[] {
  const scene = asTimelineScene(sceneInput);
  const view = resolveCodeDiffView(codeVisualOf(scene.visual));
  if (!view?.beats.length) return [];
  const windows = resolveAnchoredWindows(scene, view.beats.map(beat => beat.narrationText), fps);
  return windows.map((window, index) => {
    const beat = view.beats[index];
    return {
      startFrame: window.start,
      endFrame: window.end,
      index,
      hunkIds: [...beat.hunkIds],
      ...(beat.label ? { label: beat.label } : {}),
      ...(beat.narrationText ? { narrationText: beat.narrationText } : {}),
    };
  });
}
