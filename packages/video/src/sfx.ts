import { resolveVisualBeatTimeline, type Scene, type SfxCue, type SfxCueId } from '@m2v/schema';

export type SfxCueDefinition = { cueId: SfxCueId; src: string; durationSeconds: number; license: { kind: 'procedural'; name: string; attribution: string } };

/** Offline, locally synthesized audio cues with an explicit provenance record. */
export const sfxCueRegistry: Record<SfxCueId, SfxCueDefinition> = {
  'soft-transition': { cueId: 'soft-transition', src: 'audio/sfx/soft-transition.wav', durationSeconds: 1.1, license: { kind: 'procedural', name: 'M2V procedural audio', attribution: 'Generated locally from synthesized tones; no third-party recording.' } },
  'emphasis-tick': { cueId: 'emphasis-tick', src: 'audio/sfx/emphasis-tick.wav', durationSeconds: 0.18, license: { kind: 'procedural', name: 'M2V procedural audio', attribution: 'Generated locally from synthesized tones; no third-party recording.' } },
  'data-pop': { cueId: 'data-pop', src: 'audio/sfx/data-pop.wav', durationSeconds: 0.42, license: { kind: 'procedural', name: 'M2V procedural audio', attribution: 'Generated locally from synthesized tones; no third-party recording.' } },
  'flow-pulse': { cueId: 'flow-pulse', src: 'audio/sfx/flow-pulse.wav', durationSeconds: 0.72, license: { kind: 'procedural', name: 'M2V procedural audio', attribution: 'Generated locally from synthesized tones; no third-party recording.' } },
  'success-chime': { cueId: 'success-chime', src: 'audio/sfx/success-chime.wav', durationSeconds: 1.05, license: { kind: 'procedural', name: 'M2V procedural audio', attribution: 'Generated locally from synthesized tones; no third-party recording.' } },
  'paper-tap': { cueId: 'paper-tap', src: 'audio/sfx/paper-tap.wav', durationSeconds: 0.22, license: { kind: 'procedural', name: 'M2V procedural audio', attribution: 'Generated locally from synthesized tones; no third-party recording.' } },
};

export const sfxCueOptions = Object.values(sfxCueRegistry).map(({ cueId, durationSeconds }) => ({ cueId, durationSeconds }));

export type ResolvedSfxCueInstance = { cue: SfxCue; startFrame: number; durationFrames: number; src: string };
export type AudioDuckWindow = { startFrame: number; endFrame: number };

/** Smoothly changes gain around voice/SFX windows to avoid a click at duck boundaries. */
export function resolveAudioDuckGain(frameInput: number, windows: readonly AudioDuckWindow[], attenuationInput: number, rampFramesInput = 3): number {
  const frame = Math.floor(frameInput);
  const attenuation = Math.max(0, Math.min(1, attenuationInput));
  const rampFrames = Math.max(1, Math.floor(rampFramesInput));
  let gain = 1;
  for (const window of windows) {
    const start = Math.max(0, Math.floor(window.startFrame));
    const end = Math.max(start, Math.floor(window.endFrame));
    let windowGain = 1;
    if (frame >= start && frame < end) windowGain = attenuation;
    else if (frame >= start - rampFrames && frame < start) {
      const progress = (frame - (start - rampFrames)) / rampFrames;
      windowGain = 1 - (1 - attenuation) * progress;
    } else if (frame >= end && frame < end + rampFrames) {
      const progress = (frame - end) / rampFrames;
      windowGain = attenuation + (1 - attenuation) * progress;
    }
    gain = Math.min(gain, windowGain);
  }
  return gain;
}

/** Resolve a semantic SFX cue to the current scene frame; beat timing is recalculated from current TTS data. */
export function resolveSfxCueStartFrame(scene: Scene, cue: Pick<SfxCue, 'beatRef' | 'targetId' | 'offsetSeconds'>, fpsInput = 30): number {
  const fps = Number.isFinite(fpsInput) && fpsInput > 0 ? fpsInput : 30;
  const beats = resolveVisualBeatTimeline(scene, fps);
  const explicitBeat = cue.beatRef ? beats.find(beat => beat.id === cue.beatRef) : undefined;
  const targetBeat = cue.targetId
    ? beats.find(beat => beat.targetIds.includes(cue.targetId!) || scene.visualPlan?.motionPresets.some(action => action.targetId === cue.targetId && action.beatRef === beat.id))
    : undefined;
  const actionBeat = cue.targetId
    ? beats.find(beat => scene.visualPlan?.motionPresets.some(action => action.targetId === cue.targetId && action.beatRef === beat.id))
    : undefined;
  const start = explicitBeat?.startFrame ?? targetBeat?.startFrame ?? actionBeat?.startFrame ?? 0;
  return Math.max(0, start + Math.round(cue.offsetSeconds * fps));
}

/** Resolves cue instances once per semantic trigger; exact duplicate source/frame cues are idempotent. */
export function resolveSfxCueInstances(scene: Scene, cues: readonly SfxCue[], fpsInput = 30): ResolvedSfxCueInstance[] {
  const fps = Number.isFinite(fpsInput) && fpsInput > 0 ? fpsInput : 30;
  const unique = new Map<string, ResolvedSfxCueInstance>();
  for (const cue of cues) {
    const definition = sfxCueRegistry[cue.cueId];
    const src = cue.assetSrc ?? definition.src;
    const startFrame = resolveSfxCueStartFrame(scene, cue, fps);
    // Leave at least three frames for a fade envelope even when a custom cue asks for < 100 ms.
    const durationFrames = Math.max(3, Math.round((cue.durationSeconds ?? definition.durationSeconds) * fps));
    const key = `${src}\u0000${startFrame}`;
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, { cue, startFrame, durationFrames, src });
    } else if (cue.gain > existing.cue.gain || durationFrames > existing.durationFrames) {
      unique.set(key, {
        ...existing,
        cue: { ...existing.cue, gain: Math.max(existing.cue.gain, cue.gain) },
        durationFrames: Math.max(existing.durationFrames, durationFrames),
      });
    }
  }
  return [...unique.values()];
}

/** Linear frame envelope with zero-valued endpoints when fades are enabled. */
export function sfxCueFadeEnvelope(input: { frame: number; durationFrames: number; fadeInFrames: number; fadeOutFrames: number }): number {
  const duration = Math.max(1, Math.floor(input.durationFrames));
  if (duration <= 1) return 0;
  const frame = Math.min(duration - 1, Math.max(0, Math.floor(input.frame)));
  // Even when a caller requests no fade, reserve one frame at each edge to
  // avoid a hard sample discontinuity at a cue boundary.
  const fadeIn = Math.max(1, Math.floor(input.fadeInFrames));
  const fadeOut = Math.max(1, Math.floor(input.fadeOutFrames));
  const attack = fadeIn ? Math.min(1, frame / (fadeIn + 1)) : 1;
  const release = fadeOut ? Math.min(1, (duration - 1 - frame) / (fadeOut + 1)) : 1;
  return Math.max(0, Math.min(1, attack * release));
}

/** Pure frame gain for a continuous BGM track; the last encoded frame reaches zero when fading out. */
export function resolveBgmFrameGain(input: {
  frame: number;
  totalFrames: number;
  baseVolume: number;
  fadeInFrames: number;
  fadeOutFrames: number;
  duckGain?: number;
}): number {
  const totalFrames = Math.max(1, Math.floor(input.totalFrames));
  const frame = Math.min(totalFrames - 1, Math.max(0, Math.floor(input.frame)));
  const fadeInFrames = Math.max(1, Math.floor(input.fadeInFrames));
  const fadeOutFrames = Math.max(1, Math.floor(input.fadeOutFrames));
  const attack = Math.min(1, frame / (fadeInFrames + 1));
  const release = Math.max(0, Math.min(1, (totalFrames - 1 - frame) / (fadeOutFrames + 1)));
  const volume = Math.max(0, Math.min(1, input.baseVolume));
  const duckGain = Math.max(0, Math.min(1, input.duckGain ?? 1));
  return volume * Math.min(attack, release) * duckGain;
}

/** Backwards-compatible descriptive alias used by render components. */
export const resolveSfxCueFadeEnvelope = sfxCueFadeEnvelope;
