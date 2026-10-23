import { timelineFor } from './timeline';
import type { Storyboard } from './index';

export type WordTiming = { text: string; start: number; end: number };
export type CaptionCue = { text: string; start: number; end: number };

/** Use original words and punctuation, even when the aligner returns letters. */
export function buildCaptionCues(narration: string, timings: WordTiming[] = [], duration = 6, portrait = false): CaptionCue[] {
  const units = [...narration.matchAll(/[A-Za-z0-9]+(?:['’.-][A-Za-z0-9]+)*|[^\s]/gu)];
  if (!units.length) return [];
  const source = [...narration.matchAll(/[\p{L}\p{N}]/gu)];
  const searchable = source.map(item => item[0].toLowerCase()).join('');
  const mapped: { offset: number; start: number; end: number }[] = [];
  let cursor = 0;
  for (const item of timings) {
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.end <= item.start || item.start < 0) continue;
    const key = [...item.text.matchAll(/[\p{L}\p{N}]/gu)].map(match => match[0].toLowerCase()).join('');
    if (!key) continue;
    const index = searchable.indexOf(key, cursor);
    if (index < 0) continue;
    for (let i = 0; i < key.length; i++) mapped.push({ offset: source[index + i]?.index ?? narration.length, start: item.start, end: item.end });
    cursor = index + key.length;
  }
  const groups: { text: string; from: number; to: number }[] = [];
  let from = units[0].index!;
  let length = 0;
  // Two short lines at most. Never split an English word into letters.
  const limit = portrait ? 24 : 38;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const weight = /^[A-Za-z0-9]/.test(unit[0]) ? unit[0].length * 0.55 : 1;
    if (length && length + weight > limit && !/^[，。！？、；：,.!?;:]$/.test(unit[0])) {
      groups.push({ text: narration.slice(from, unit.index).trim(), from, to: unit.index! });
      from = unit.index!;
      length = 0;
    }
    length += weight;
    if (/[。！？.!?；;]$/.test(unit[0]) || (/[，,：:]$/.test(unit[0]) && length >= limit / 2) || i === units.length - 1) {
      const to = unit.index! + unit[0].length;
      groups.push({ text: narration.slice(from, to).trim(), from, to });
      from = units[i + 1]?.index ?? to;
      length = 0;
    }
  }
  const totalWeight = groups.reduce((sum, group) => sum + group.text.length, 0);
  let elapsed = 0;
  let previousStart = 0;
  const cues = groups.map(group => {
    const matches = mapped.filter(item => item.offset >= group.from && item.offset < group.to);
    const estimate = duration * elapsed / totalWeight;
    elapsed += group.text.length;
    const start = Math.min(duration, Math.max(previousStart, matches[0]?.start ?? estimate));
    previousStart = start;
    return { text: group.text, start, end: Math.min(duration, Math.max(start, ...matches.map(item => item.end))) };
  });
  for (let i = 0; i < cues.length; i++) {
    // Keep each phrase until the next phrase starts, including tiny CTC gaps.
    cues[i].end = cues[i + 1]?.start ?? Math.max(duration, cues[i].end);
  }
  const timedCoverage = mapped.length / Math.max(1, source.length);
  if (timedCoverage < 0.65 || cues.some(cue => cue.end - cue.start < 0.12)) {
    let offset = 0;
    return groups.map((group, index) => {
      const start = duration * offset / totalWeight;
      offset += group.text.length;
      return { text: group.text, start, end: index === groups.length - 1 ? duration : duration * offset / totalWeight };
    });
  }
  return cues;
}

export function captionDuration(scene: { duration?: number; audioDuration?: number }): number {
  return scene.audioDuration ?? Math.max(3, scene.duration ?? 6);
}

export type CaptionScene = {
  type: string;
  narration: string;
  visual: Record<string, unknown>;
  wordTimings?: WordTiming[];
  subtitleCues?: CaptionCue[];
  duration?: number;
  audioDuration?: number;
};

/** Manual cues stay relative to the scene start; they are clamped, never dropped by gaps. */
function manualCues(cues: CaptionCue[], limit: number): CaptionCue[] {
  const resolved: CaptionCue[] = [];
  let previousStart = 0;
  for (const cue of [...cues].sort((a, b) => a.start - b.start)) {
    const text = cue.text.trim();
    if (!text || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start) continue;
    const start = Math.min(Math.max(previousStart, Math.max(0, cue.start)), Math.max(0, limit - 0.05));
    resolved.push({ text, start, end: Math.min(Math.max(limit, start + 0.05), Math.max(start + 0.05, cue.end)) });
    previousStart = start;
  }
  return resolved;
}

/** Single source of truth for captions in the preview, the export and the delivery check. */
export function resolveCaptionCues(scene: CaptionScene, duration = captionDuration(scene), portrait = false): CaptionCue[] {
  const manual = manualCues(scene.subtitleCues ?? [], duration);
  if (manual.length) return manual;
  return buildCaptionCues(captionNarration(scene), scene.wordTimings, duration, portrait);
}

export function hasManualCues(scene: { subtitleCues?: CaptionCue[] }): boolean {
  return (scene.subtitleCues ?? []).length > 0;
}

export function captionAt(cues: CaptionCue[], seconds: number): string {
  return cues.find(cue => seconds >= cue.start && seconds < cue.end)?.text ?? '';
}

export function captionNarration(scene: { type: string; narration: string; visual: Record<string, unknown> }): string {
  const attribution = String(scene.visual.attribution ?? '') + '，' + String(scene.visual.license ?? '');
  const narration = scene.type === 'media' && attribution !== '，' && scene.narration.startsWith(attribution) ? scene.narration.slice(attribution.length).replace(/^[，,。\s]+/, '') : scene.narration;
  return narration.trim() === '请添加图片讲解。' ? '' : narration;
}

export type SubtitleLayerCue = CaptionCue & {
  /** Scene the cue belongs to, so the player can jump to the clip that shows it. */
  sceneIndex: number;
  /** Position inside the scene's own cue list. */
  cueIndex: number;
};

/** Every cue of the finished video, on the video's own clock. */
export function subtitleCues(board: Storyboard): SubtitleLayerCue[] {
  const timeline = timelineFor(board);
  const portrait = board.aspectRatio === '9:16';
  return board.scenes.flatMap((scene, sceneIndex) => {
    const offset = timeline.scenes[sceneIndex]?.start ?? 0;
    return resolveCaptionCues(scene, captionDuration(scene), portrait)
      .map((cue, cueIndex) => ({ ...cue, start: cue.start + offset, end: cue.end + offset, sceneIndex, cueIndex }));
  });
}

/** The cue visible at a moment of the finished video. */
export function cueAt(cues: CaptionCue[], seconds: number): CaptionCue | null {
  return cues.find(cue => seconds >= cue.start && seconds < cue.end) ?? null;
}

/** Which scene the player is showing at a moment of the finished video. */
export function cueSceneIndex(board: Storyboard, seconds: number): number | null {
  const segment = timelineFor(board).scenes.find(item => seconds >= item.start && seconds < item.end);
  return segment ? segment.index : null;
}

/** Scene start times on the video's clock, for drawing the cue track. */
export function sceneStartTimes(board: Storyboard): number[] {
  return timelineFor(board).scenes.map(segment => segment.start);
}
