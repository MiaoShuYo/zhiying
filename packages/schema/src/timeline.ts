import type { Storyboard } from './index';
import { sceneSeconds } from './editor';

export type TimelineSegmentKind = 'intro' | 'scene' | 'outro';

export type TimelineSegment = {
  kind: TimelineSegmentKind;
  /** Scene index for `scene` segments, -1 for the intro and `scenes.length` for the outro. */
  index: number;
  start: number;
  duration: number;
  end: number;
};

export type Timeline = {
  segments: TimelineSegment[];
  scenes: TimelineSegment[];
  intro?: TimelineSegment;
  outro?: TimelineSegment;
  totalSeconds: number;
};

export type FrameSegment = TimelineSegment & { startFrame: number; frames: number };

export type SceneTransitionWindow = {
  fromIndex: number;
  toIndex: number;
  startFrame: number;
  frames: number;
  fromStartFrame: number;
  toStartFrame: number;
  transition: Exclude<Storyboard['transition'], 'none' | 'fade' | 'cut'>;
};

/**
 * Single timing authority for the preview, the subtitle export and the delivery
 * check. Intro and outro are real segments so every consumer offsets identically.
 */
export function timelineFor(storyboard: Storyboard): Timeline {
  const introSeconds = storyboard.intro?.enabled ? storyboard.intro.duration : 0;
  const outroSeconds = storyboard.outro?.enabled ? storyboard.outro.duration : 0;
  const segments: TimelineSegment[] = [];
  let cursor = 0;
  if (introSeconds > 0) {
    segments.push({ kind: 'intro', index: -1, start: 0, duration: introSeconds, end: introSeconds });
    cursor = introSeconds;
  }
  const scenes = storyboard.scenes.map((scene, index) => {
    const duration = sceneSeconds(scene);
    const segment: TimelineSegment = { kind: 'scene', index, start: cursor, duration, end: cursor + duration };
    cursor += duration;
    segments.push(segment);
    return segment;
  });
  if (outroSeconds > 0) segments.push({ kind: 'outro', index: storyboard.scenes.length, start: cursor, duration: outroSeconds, end: cursor + outroSeconds });
  return {
    segments,
    scenes,
    intro: segments.find(segment => segment.kind === 'intro'),
    outro: segments.find(segment => segment.kind === 'outro'),
    totalSeconds: cursor + outroSeconds,
  };
}

/** Frame-aligned view of the timeline; rounding happens once per segment. */
export function timelineFrames(storyboard: Storyboard, fps = 30): { segments: FrameSegment[]; totalFrames: number } {
  let cursor = 0;
  const segments = timelineFor(storyboard).segments.map(segment => {
    const frames = Math.round(segment.duration * fps);
    const aligned: FrameSegment = { ...segment, startFrame: cursor, frames };
    cursor += frames;
    return aligned;
  });
  return { segments, totalFrames: cursor };
}

/**
 * Visual-only transition overlays share the delivery frame timeline. They begin
 * during the tail of the outgoing scene, while narration and subtitles remain
 * anchored to the original scene segments and the project duration is unchanged.
 */
export function sceneTransitionWindows(storyboard: Storyboard, fps = 30): SceneTransitionWindow[] {
  const transition = storyboard.transition;
  if (transition === 'none' || transition === 'fade' || transition === 'cut') return [];
  const { segments } = timelineFrames(storyboard, fps);
  const scenes = segments.filter(segment => segment.kind === 'scene');
  const requested = Math.max(1, Math.round((storyboard.transitionDuration ?? 0.5) * fps));
  const windows: SceneTransitionWindow[] = [];
  for (let index = 1; index < scenes.length; index += 1) {
    const from = scenes[index - 1];
    const to = scenes[index];
    const frames = Math.min(requested, from.frames, to.frames);
    if (frames < 1) continue;
    windows.push({
      fromIndex: index - 1,
      toIndex: index,
      startFrame: to.startFrame - frames,
      frames,
      fromStartFrame: from.startFrame,
      toStartFrame: to.startFrame,
      transition,
    });
  }
  return windows;
}
