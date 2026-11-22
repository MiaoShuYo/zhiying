import type { MotionAction, Scene } from '@m2v/schema';
import type { CSSProperties } from 'react';
import { resolveVisualBeatTimeline } from '@m2v/schema';

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function ease(value: number, preset: MotionAction['easingPreset']): number {
  const t = clamp01(value);
  switch (preset) {
    case 'linear': return t;
    case 'ease-in': return t * t;
    case 'ease-out': return 1 - (1 - t) * (1 - t);
    case 'ease-in-out': return t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    case 'spring-lite': return clamp01(1 - Math.cos(t * Math.PI * 1.5) * Math.exp(-5 * t));
    default: return t * t * (3 - 2 * t);
  }
}

function actionWindow(action: MotionAction, scene: Scene, fps: number, frames: ReturnType<typeof resolveVisualBeatTimeline>) {
  const beat = frames.find(window => window.id === action.beatRef);
  if (!beat) return null;
  const next = frames.find(window => window.startFrame > beat.startFrame);
  const duration = action.durationPolicy === 'fixed'
    ? Math.min(action.durationFrames ?? Math.round(fps * .4), Math.max(1, Math.round((scene.audioDuration ?? scene.duration ?? 6) * fps)))
    : action.durationPolicy === 'until-next'
      ? Math.max(1, (next?.startFrame ?? beat.endFrame) - beat.startFrame)
      : Math.max(1, beat.endFrame - beat.startFrame);
  return { start: beat.startFrame, end: beat.startFrame + duration };
}

function beatFocusStyle(targetId: string, frames: ReturnType<typeof resolveVisualBeatTimeline>, frame: number): CSSProperties {
  const stages = frames.filter(window => window.targetIds.includes(targetId));
  if (!stages.length) return {};
  const first = stages[0];
  if (frame < first.startFrame) return { opacity: .12 };
  const active = stages.find(window => frame >= window.startFrame && frame < window.endFrame);
  return active ? { opacity: 1 } : { opacity: .52 };
}

/** Frame-pure mapping from whitelisted action data to CSS primitives. */
export function motionStyleForTarget(input: { targetId: string; scene: Scene; frame: number; fps: number; reducedMotion?: boolean }): CSSProperties {
  const { targetId, scene, frame, fps } = input;
  const frames = resolveVisualBeatTimeline(scene, fps);
  const actions = (scene.visualPlan?.motionPresets ?? []).filter(action => action.targetId === targetId);
  const action = actions[actions.length - 1];
  if (input.reducedMotion) {
    if (action?.reducedMotionFallback === 'fade') return { opacity: 1 };
    if (action?.reducedMotionFallback === 'highlight') return { outline: '2px solid currentColor', outlineOffset: 4 };
    return {};
  }
  if (!action) return beatFocusStyle(targetId, frames, frame);
  const window = actionWindow(action, scene, fps, frames);
  if (!window) return {};
  const raw = clamp01((frame - window.start) / Math.max(1, window.end - window.start));
  const progress = ease(raw, action.easingPreset);
  switch (action.action) {
    case 'reveal': {
      const distance = (1 - progress) * 18;
      const direction = action.parameters.direction;
      const translate = direction === 'up' ? `translateY(${distance}px)` : direction === 'down' ? `translateY(${-distance}px)` : direction === 'left' ? `translateX(${distance}px)` : direction === 'right' ? `translateX(${-distance}px)` : `scale(${.96 + progress * .04})`;
      return { opacity: progress, transform: translate };
    }
    case 'stagger': return { opacity: clamp01((frame - window.start + action.parameters.delayFrames) / Math.max(1, window.end - window.start)) };
    case 'focus-dim': return raw >= 1
      ? beatFocusStyle(targetId, frames, frame)
      : { opacity: .12 + .88 * progress };
    case 'highlight': return { filter: `brightness(${1 + progress * action.parameters.strength * .35})`, transform: `scale(${1 + progress * .025})`, boxShadow: `0 0 ${Math.round(progress * 30)}px currentColor` };
    case 'number-count': return {};
    case 'bar-grow': return { transform: `scaleY(${action.parameters.startPercent / 100 + (1 - action.parameters.startPercent / 100) * progress})`, transformOrigin: 'bottom' };
    case 'line-draw': return { clipPath: `inset(0 ${100 - action.parameters.startPercent - (100 - action.parameters.startPercent) * progress}% 0 0)` };
    case 'arrow-flow': return { transform: `translateX(${Math.sin(progress * Math.PI * 2) * 3 * action.parameters.speed}px)` };
    case 'group-expand': return { transform: `scale(${action.parameters.startScale + (1 - action.parameters.startScale) * progress})` };
    case 'morph-lite': return { borderRadius: `${Math.round(8 + 20 * action.parameters.intensity * progress)}px` };
    case 'annotation': {
      const shift = Math.round((1 - progress) * 10);
      const side = action.parameters.placement;
      return { opacity: progress, transform: side === 'top' ? `translateY(${shift}px)` : side === 'bottom' ? `translateY(${-shift}px)` : side === 'left' ? `translateX(${shift}px)` : `translateX(${-shift}px)` };
    }
  }
}

export function animatedNumberValue(input: { targetId: string; value: number; scene: Scene; frame: number; fps: number; reducedMotion?: boolean }): string {
  const action = input.scene.visualPlan?.motionPresets.find(
    (item): item is Extract<MotionAction, { action: 'number-count' }> => item.targetId === input.targetId && item.action === 'number-count',
  );
  if (!action || input.reducedMotion) return input.value.toLocaleString();
  const frames = resolveVisualBeatTimeline(input.scene, input.fps);
  const window = actionWindow(action, input.scene, input.fps, frames);
  if (!window) return input.value.toLocaleString();
  const progress = ease((input.frame - window.start) / Math.max(1, window.end - window.start), action.easingPreset);
  const decimals = action.parameters.decimals;
  return (input.value * progress).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
