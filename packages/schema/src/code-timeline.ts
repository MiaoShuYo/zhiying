import { codeVisualOf, type CodeBeat } from './code-visual';

export type CodeBeatFrame = { startFrame: number; endFrame: number; lines: number[]; label?: string };

type WordTimingLike = { text: string; start: number; end: number };
type CaptionCueLike = { text: string; start: number; end: number };
type FrameWindow = { start: number; end: number };

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
  const scene = sceneInput as {
    duration?: number;
    audioDuration?: number;
    wordTimings?: WordTimingLike[];
    subtitleCues?: CaptionCueLike[];
    visual?: Record<string, unknown>;
  };
  const beats: CodeBeat[] = codeVisualOf(scene.visual)?.beats ?? [];
  if (!beats.length) return [];
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const durationSeconds = scene.audioDuration ?? Math.max(3, scene.duration ?? 6);
  const durationFrames = Math.max(1, Math.round((Number.isFinite(durationSeconds) ? durationSeconds : 6) * safeFps));
  const minimumFrames = Math.max(1, Math.round(safeFps * MINIMUM_BEAT_SECONDS));
  // When the beats cannot each hold the minimum window, distribution wins over the minimum.
  const minimumFeasible = beats.length * minimumFrames <= durationFrames;
  const words = Array.isArray(scene.wordTimings) ? scene.wordTimings : [];
  const cues = Array.isArray(scene.subtitleCues) ? scene.subtitleCues : [];
  const windows = beats.map((beat, index): FrameWindow => {
    if (beat.narrationText) {
      const aligned = wordWindow(beat.narrationText, words, safeFps) ?? cueWindow(beat.narrationText, cues, safeFps);
      if (aligned) return aligned;
    }
    return {
      start: Math.round(durationFrames * index / beats.length),
      end: Math.round(durationFrames * (index + 1) / beats.length),
    };
  });
  const frames: CodeBeatFrame[] = [];
  let cursor = 0;
  windows.forEach((window, index) => {
    const last = index === beats.length - 1;
    let start = Math.max(0, Math.round(window.start), cursor);
    start = Math.min(start, Math.max(0, durationFrames - 1));
    let end = Math.max(Math.round(window.end), start + 1);
    if (last) {
      end = durationFrames;
    } else {
      // Reserve one frame for every remaining beat so the sequence can never be inverted.
      const reserved = Math.max(start + 1, durationFrames - (beats.length - 1 - index));
      if (minimumFeasible) end = Math.max(end, start + minimumFrames);
      end = Math.min(Math.max(end, start + 1), reserved);
    }
    cursor = end;
    const beat = beats[index];
    frames.push({
      startFrame: start,
      endFrame: end,
      lines: normalizedLines(beat.lines),
      ...(beat.label ? { label: beat.label } : {}),
    });
  });
  const lastFrame = frames[frames.length - 1];
  if (lastFrame.endFrame <= lastFrame.startFrame) lastFrame.startFrame = Math.max(0, lastFrame.endFrame - 1);
  return frames;
}
