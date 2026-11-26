import type { Scene } from './index';
import type { VisualBeat } from './visual-plan';
import type { VisualBeatTimingDiagnostic } from './visual-density';

export type VisualBeatFrame = { id: string; startFrame: number; endFrame: number; targetIds: string[]; label?: string; narrationText: string };
type FrameWindow = { start: number; end: number };
type WordTiming = { text: string; start: number; end: number };
type CaptionCue = { text: string; start: number; end: number };

export const MIN_FALLBACK_BEAT_DWELL_SECONDS = 1.25;

function normalized(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function wordWindow(text: string, words: WordTiming[], fps: number): FrameWindow | null {
  const target = normalized(text);
  if (!target) return null;
  let joined = '';
  const ranges: { from: number; to: number; start: number; end: number }[] = [];
  for (const word of words) {
    if (!word || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start || word.start < 0) continue;
    const chunk = normalized(word.text);
    if (!chunk) continue;
    ranges.push({ from: joined.length, to: joined.length + chunk.length - 1, start: word.start, end: word.end });
    joined += chunk;
  }
  const offset = joined.indexOf(target);
  if (offset < 0) return null;
  const lastPosition = offset + target.length - 1;
  const first = ranges.find(range => range.from <= offset && offset <= range.to);
  const last = [...ranges].reverse().find(range => range.from <= lastPosition && lastPosition <= range.to);
  if (!first || !last) return null;
  const window = { start: Math.round(first.start * fps), end: Math.round(last.end * fps) };
  return window.end > window.start ? window : null;
}

function cueWindow(text: string, cues: CaptionCue[], fps: number): FrameWindow | null {
  const target = normalized(text);
  if (!target) return null;
  const matching = cues.map(cue => {
    const value = normalized(cue.text);
    return Boolean(value) && (value.includes(target) || target.includes(value));
  });
  const firstIndex = matching.indexOf(true);
  if (firstIndex < 0) return null;
  let lastIndex = firstIndex;
  while (lastIndex + 1 < cues.length && matching[lastIndex + 1]) lastIndex += 1;
  const first = cues[firstIndex];
  const last = cues[lastIndex];
  if (!Number.isFinite(first?.start) || !Number.isFinite(last?.end) || last.end <= first.start) return null;
  return { start: Math.round(Math.max(0, first.start) * fps), end: Math.round(last.end * fps) };
}

/** True when a full narration group maps to a word or subtitle interval. */
export function hasVisualBeatTimingForText(scene: Scene, text: string): boolean {
  const words = Array.isArray(scene.wordTimings) ? scene.wordTimings as WordTiming[] : [];
  const cues = Array.isArray(scene.subtitleCues) ? scene.subtitleCues as CaptionCue[] : [];
  return wordWindow(text, words, 30) !== null || cueWindow(text, cues, 30) !== null;
}

function resolveWindows(beats: VisualBeat[], durationFrames: number, scene: Scene, fps: number): FrameWindow[] {
  const words = Array.isArray(scene.wordTimings) ? scene.wordTimings as WordTiming[] : [];
  const cues = Array.isArray(scene.subtitleCues) ? scene.subtitleCues as CaptionCue[] : [];
  const windows = beats.map((beat, index) => {
    if (beat.narrationText.trim()) {
      const aligned = wordWindow(beat.narrationText, words, fps) ?? cueWindow(beat.narrationText, cues, fps);
      if (aligned) return aligned;
    }
    return { start: Math.round(durationFrames * index / beats.length), end: Math.round(durationFrames * (index + 1) / beats.length) };
  });
  let cursor = 0;
  return windows.map((window, index) => {
    const start = Math.min(Math.max(cursor, window.start, 0), Math.max(0, durationFrames - 1));
    const reserve = Math.max(start + 1, durationFrames - (beats.length - 1 - index));
    const end = index === beats.length - 1 ? durationFrames : Math.min(Math.max(start + 1, window.end), reserve);
    cursor = end;
    return { start, end };
  });
}

/**
 * Describes which timing source can cover the current semantic beats. Uniform
 * fallback gets a readable minimum dwell and may extend the visual scene; real
 * word/caption windows always keep their original times.
 */
export function getVisualBeatTimingDiagnostic(scene: Scene, originalDurationOverride?: number): VisualBeatTimingDiagnostic {
  const beats = (scene.visualBeats?.length ? scene.visualBeats : scene.visualPlan?.beats ?? []) as VisualBeat[];
  const spokenBeats = beats.filter(beat => beat.narrationText.trim());
  const words = Array.isArray(scene.wordTimings) ? scene.wordTimings as WordTiming[] : [];
  const cues = Array.isArray(scene.subtitleCues) ? scene.subtitleCues as CaptionCue[] : [];
  const wordMatches = spokenBeats.map(beat => wordWindow(beat.narrationText, words, 30) !== null);
  const cueMatches = spokenBeats.map(beat => cueWindow(beat.narrationText, cues, 30) !== null);
  const all = (matches: boolean[]) => matches.length > 0 && matches.every(Boolean);
  const any = (matches: boolean[]) => matches.some(Boolean);
  const source: VisualBeatTimingDiagnostic['source'] = all(wordMatches) ? 'wordTimings'
    : all(cueMatches) ? 'subtitleCues'
      : any(wordMatches) || any(cueMatches) ? 'mixed' : 'uniform-fallback';
  const previous = scene.visualBeatTimingDiagnostic;
  const originalDurationSeconds = Math.max(
    3,
    originalDurationOverride ?? (previous?.fallbackDurationExtended ? previous.originalDurationSeconds : scene.duration ?? 6),
    scene.audioDuration ?? 0,
  );
  const effectiveDurationSeconds = source === 'uniform-fallback'
    ? Math.max(originalDurationSeconds, beats.length * MIN_FALLBACK_BEAT_DWELL_SECONDS)
    : originalDurationSeconds;
  const extensionSeconds = Math.max(0, effectiveDurationSeconds - originalDurationSeconds);
  return {
    source,
    minimumDwellSeconds: MIN_FALLBACK_BEAT_DWELL_SECONDS,
    originalDurationSeconds,
    effectiveDurationSeconds,
    fallbackDurationExtended: extensionSeconds > 0,
    extensionSeconds,
  };
}

/** Pure semantic beat → word/caption timing → Remotion frame conversion. */
export function resolveVisualBeatTimeline(scene: Scene, fpsInput = 30): VisualBeatFrame[] {
  const beats = (scene.visualBeats?.length ? scene.visualBeats : scene.visualPlan?.beats ?? []) as VisualBeat[];
  if (!beats.length) return [];
  const fps = Number.isFinite(fpsInput) && fpsInput > 0 ? fpsInput : 30;
  const seconds = getVisualBeatTimingDiagnostic(scene).effectiveDurationSeconds;
  const durationFrames = Math.max(1, Math.round((Number.isFinite(seconds) ? seconds : 6) * fps));
  const windows = resolveWindows(beats, durationFrames, scene, fps);
  return beats.map((beat, index) => ({
    id: beat.id,
    startFrame: windows[index].start,
    endFrame: windows[index].end,
    targetIds: [...new Set(beat.targetIds)],
    ...(beat.label ? { label: beat.label } : {}),
    narrationText: beat.narrationText,
  }));
}
