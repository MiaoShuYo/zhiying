import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SceneSchema, SoundEffectsSettingsSchema, SfxCueSchema, SfxCueIdSchema, StoryboardSchema, fullRenderPlan, preflight } from '@m2v/schema';
import { resolveAudioDuckGain, resolveBgmFrameGain, resolveSfxCueInstances, resolveSfxCueStartFrame, sfxCueFadeEnvelope, sfxCueOptions, sfxCueRegistry } from '../src/sfx';

const ids = ['soft-transition', 'emphasis-tick', 'data-pop', 'flow-pulse', 'success-chime', 'paper-tap'] as const;
const publicDir = resolve(process.cwd(), 'apps/web/public');

test('the six SFX cues have deterministic local WAV assets and provenance metadata', () => {
  assert.deepEqual(Object.keys(sfxCueRegistry).sort(), [...ids].sort());
  assert.equal(sfxCueOptions.length, ids.length);
  for (const id of ids) {
    assert.equal(SfxCueIdSchema.safeParse(id).success, true);
    const cue = sfxCueRegistry[id];
    assert.equal(cue.license.kind, 'procedural');
    assert.ok(cue.license.name.length > 0);
    assert.ok(cue.license.attribution.length > 0);
    const asset = resolve(publicDir, cue.src);
    assert.ok(existsSync(asset), `${id} asset exists offline`);
    const wav = readFileSync(asset);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.ok(wav.length > 44);
  }
});

test('SFX schema rejects remote assets, missing user licenses, unknown cue IDs and unsafe gains', () => {
  const valid = { id: 'tick', cueId: 'emphasis-tick', assetSrc: 'audio/sfx/emphasis-tick.wav' };
  assert.equal(SfxCueSchema.safeParse(valid).success, true);
  assert.equal(SfxCueSchema.safeParse({ ...valid, assetSrc: 'https://example.invalid/tick.wav' }).success, false);
  assert.equal(SfxCueSchema.safeParse({ ...valid, assetSrc: 'projects/v19/assets/custom.wav' }).success, false);
  assert.equal(SfxCueSchema.safeParse({ ...valid, assetSrc: 'projects/v19/assets/custom.wav', license: { kind: 'CC0', name: 'CC0', attribution: '' } }).success, true);
  assert.equal(SfxCueSchema.safeParse({ ...valid, cueId: 'boom' }).success, false);
  assert.equal(SfxCueSchema.safeParse({ ...valid, gain: 1.1 }).success, false);
});

test('beat references are validated and disabling sound effects is a valid silent fallback', () => {
  const base = {
    id: 'sfx-schema-scene', type: 'chart', title: '数据', narration: '显示第一组。', duration: 2,
    visual: { data: [{ label: 'A', value: 1 }] },
    visualBeats: [{ id: 'beat-a', narrationText: '显示第一组。', targetIds: ['chart-1'] }],
  };
  assert.equal(SceneSchema.safeParse({ ...base, sfxCues: [{ id: 'cue', cueId: 'data-pop', beatRef: 'beat-a' }] }).success, true);
  assert.equal(SceneSchema.safeParse({ ...base, sfxCues: [{ id: 'cue', cueId: 'data-pop', beatRef: 'missing' }] }).success, false);
  assert.equal(SoundEffectsSettingsSchema.safeParse({ enabled: false }).success, true);
  assert.equal(SoundEffectsSettingsSchema.safeParse({ enabled: true, voiceDuck: 0.95 }).success, false);
});

test('SFX cue frames follow explicit beats, target beats, motion beats, and regenerated TTS timing', () => {
  const scene = SceneSchema.parse({
    id: 'sfx-frame-resolution', type: 'chart', title: '请求量', narration: '显示第一组。显示第二组。', duration: 4, audioDuration: 4,
    visual: { data: [{ label: '第一组', value: 10 }, { label: '第二组', value: 20 }] },
    wordTimings: [{ text: '显示第一组。', start: 0, end: 1 }, { text: '显示第二组。', start: 2, end: 3 }],
    visualBeats: [
      { id: 'beat-a', narrationText: '显示第一组。', targetIds: ['chart-1'] },
      { id: 'beat-b', narrationText: '显示第二组。', targetIds: ['chart-2'] },
    ],
    visualPlan: {
      templateId: 'chart',
      motionPresets: [{ targetId: 'chart-bar-2', action: 'bar-grow', beatRef: 'beat-a', durationPolicy: 'beat' }],
    },
  });
  assert.equal(resolveSfxCueStartFrame(scene, { targetId: 'chart-2', offsetSeconds: .25 }), 68, 'target reference follows its narrated beat');
  assert.equal(resolveSfxCueStartFrame(scene, { beatRef: 'beat-a', targetId: 'chart-2', offsetSeconds: .25 }), 8, 'an explicit beat wins over a conflicting target beat');
  assert.equal(resolveSfxCueStartFrame(scene, { beatRef: 'expired', targetId: 'chart-2', offsetSeconds: .25 }), 68, 'an expired explicit beat falls back to the current target beat');
  assert.equal(resolveSfxCueStartFrame(scene, { targetId: 'chart-bar-2', offsetSeconds: .25 }), 8, 'motion target references follow the motion preset beat');
  assert.equal(resolveSfxCueStartFrame(scene, { targetId: 'missing-target', offsetSeconds: .25 }), 8, 'an unmapped target safely falls back to scene start plus cue offset');

  const regenerated = SceneSchema.parse({
    ...scene,
    wordTimings: [{ text: '显示第一组。', start: 0, end: 2 }, { text: '显示第二组。', start: 3, end: 3.5 }],
  });
  assert.equal(resolveSfxCueStartFrame(regenerated, { targetId: 'chart-2', offsetSeconds: .25 }), 98, 'cue target beat moves with regenerated TTS word timing');
});

test('SFX fade envelope reaches zero at both encoded endpoints, including zero-duration fades', () => {
  for (const fades of [{ fadeInFrames: 0, fadeOutFrames: 0 }, { fadeInFrames: 6, fadeOutFrames: 9 }]) {
    const envelope = (frame: number) => sfxCueFadeEnvelope({ frame, durationFrames: 30, ...fades });
    assert.equal(envelope(0), 0, 'first cue frame is silent');
    assert.ok(envelope(15) > 0 && envelope(15) <= 1, 'middle cue frame is audible without exceeding unity gain');
    assert.equal(envelope(29), 0, 'last cue frame is silent');
  }
  assert.equal(sfxCueFadeEnvelope({ frame: 0, durationFrames: 1, fadeInFrames: 0, fadeOutFrames: 0 }), 0);
});

test('duplicate SFX triggers resolve once per source/frame and keep the strongest, longest cue deterministically', () => {
  const scene = SceneSchema.parse({ id: 'sfx-dedupe', type: 'title', narration: '页面切换。', duration: 3, visual: {} });
  const short = SfxCueSchema.parse({ id: 'short', cueId: 'data-pop', offsetSeconds: .5, durationSeconds: .2, gain: .35 });
  const strongLong = SfxCueSchema.parse({ id: 'strong-long', cueId: 'data-pop', offsetSeconds: .5, durationSeconds: .8, gain: .85 });
  const resolve = (cues: typeof short[]) => resolveSfxCueInstances(scene, cues, 30).map(instance => ({
    src: instance.src,
    startFrame: instance.startFrame,
    durationFrames: instance.durationFrames,
    gain: instance.cue.gain,
  }));
  const forward = resolve([short, strongLong]);
  const reverse = resolve([strongLong, short]);
  assert.equal(forward.length, 1, 'same local source at the same resolved frame creates one player');
  assert.deepEqual(forward, reverse, 'cue input order does not change effective playback');
  assert.deepEqual(forward[0], { src: sfxCueRegistry['data-pop'].src, startFrame: 15, durationFrames: 24, gain: .85 });
});

test('BGM mute is retained in the render fingerprint and frame gains honor fades and ducking', () => {
  const scene = SceneSchema.parse({ id: 'bgm-mute', type: 'title', narration: '旁白继续播放。', duration: 3, audioSrc: 'audio/voice.wav', visual: {} });
  const common = { title: 'BGM mute', styleId: 'minimal-tech' as const, transition: 'none' as const, bgmSrc: 'audio/music.wav', scenes: [scene] };
  const defaultBoard = StoryboardSchema.parse(common);
  const mutedBoard = StoryboardSchema.parse({ ...common, bgmEnabled: false });
  assert.equal(defaultBoard.bgmEnabled, true, 'legacy boards keep BGM enabled by default');
  assert.equal(mutedBoard.bgmEnabled, false);
  assert.equal(mutedBoard.bgmSrc, common.bgmSrc, 'mute preserves the selected local asset');
  const enabledPlan = fullRenderPlan(defaultBoard);
  const mutedPlan = fullRenderPlan(mutedBoard);
  assert.notEqual(enabledPlan.segments[0]!.parts.global, mutedPlan.segments[0]!.parts.global, 'mute changes the render cache fingerprint');
  assert.notEqual(enabledPlan.segments[0]!.fingerprint, mutedPlan.segments[0]!.fingerprint);

  const gain = (frame: number, duckGain = 1) => resolveBgmFrameGain({
    frame, totalFrames: 90, baseVolume: .4, fadeInFrames: 15, fadeOutFrames: 15, duckGain,
  });
  assert.equal(gain(0), 0, 'BGM fade-in starts at silence');
  assert.equal(gain(89), 0, 'BGM fade-out reaches silence on the final frame');
  assert.ok(gain(45) > 0);
  assert.ok(gain(45, .25) < gain(45), 'ducking lowers the active BGM gain');
});

test('zero-config BGM fades still have silent endpoints and audio duck ramps are monotonic', () => {
  const bgmGain = (frame: number) => resolveBgmFrameGain({
    frame, totalFrames: 12, baseVolume: .5, fadeInFrames: 0, fadeOutFrames: 0,
  });
  assert.equal(bgmGain(0), 0, 'BGM starts at zero even when fade-in is configured as zero');
  assert.ok(bgmGain(1) > 0);
  assert.equal(bgmGain(11), 0, 'BGM ends at zero even when fade-out is configured as zero');

  const window = [{ startFrame: 10, endFrame: 20 }];
  const gain = (frame: number) => resolveAudioDuckGain(frame, window, .2, 3);
  const attack = [7, 8, 9, 10].map(gain);
  const release = [19, 20, 21, 22, 23].map(gain);
  assert.deepEqual(attack.slice(0, 1), [1]);
  assert.ok(attack.every((value, index) => index === 0 || value <= attack[index - 1]!));
  assert.equal(attack.at(-1), .2, 'duck is at full attenuation when voice begins');
  assert.ok(release.every((value, index) => index === 0 || value >= release[index - 1]!));
  assert.equal(release.at(-1), 1, 'duck returns smoothly to unity after voice ends');
});

test('server-side missing SFX checks warn without blocking export; disabled SFX skips the warning', () => {
  const cuePath = 'projects/p/assets/missing-sfx.wav';
  const scene = SceneSchema.parse({
    id: 'missing-sfx-warning', type: 'title', narration: '音效缺失时继续导出。', duration: 3, audioSrc: 'audio/voice.wav', audioDuration: 3, visual: {},
    sfxCues: [{ id: 'missing', cueId: 'paper-tap', assetSrc: cuePath, license: { kind: 'custom', name: 'Local test fixture', attribution: 'Not a distributed recording.' } }],
  });
  const board = StoryboardSchema.parse({ title: 'Missing SFX', styleId: 'minimal-tech', transition: 'none', soundEffects: { enabled: true }, scenes: [scene] });
  const checked = preflight(board, [], { exists: path => path !== cuePath });
  const warning = checked.issues.find(issue => issue.assetPath === cuePath);
  assert.ok(warning);
  assert.equal(warning.code, 'missing_file');
  assert.equal(warning.severity, 'warning');
  assert.equal(warning.assetKind, 'audio');
  assert.equal(checked.blocking, 0);
  assert.match(warning.message, /静音跳过/);
  const disabled = preflight(StoryboardSchema.parse({ ...board, soundEffects: { enabled: false } }), [], { exists: () => false });
  assert.equal(disabled.issues.some(issue => issue.assetPath === cuePath), false);
});
