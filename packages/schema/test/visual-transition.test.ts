import test from 'node:test';
import assert from 'node:assert/strict';
import { StoryboardSchema, sceneTransitionWindows, timelineFrames } from '../src/index';

const transitionTypes = ['crossfade', 'wipe', 'slide', 'match-move', 'shared-element-lite'] as const;
const base = (patch: Record<string, unknown> = {}) => StoryboardSchema.parse({
  title: 'V1.9.0 transition fixture',
  styleId: 'minimal-tech',
  aspectRatio: '16:9',
  transition: 'none',
  transitionDuration: 1.2,
  subtitles: { enabled: true, position: 'bottom' },
  scenes: [
    {
      id: 'intro-step', type: 'title', title: '请求进入服务', narration: '第一段旁白。',
      duration: 4, audioDuration: 3.5, audioSrc: 'projects/v190/assets/first.wav',
      subtitleCues: [{ text: '第一段旁白。', start: 0, end: 1 }], visual: { text: '入口' },
    },
    {
      id: 'result-step', type: 'title', title: '服务返回结果', narration: '第二段旁白。',
      duration: 6, audioDuration: 5.5, audioSrc: 'projects/v190/assets/second.wav',
      subtitleCues: [{ text: '第二段旁白。', start: 0, end: 1.5 }], visual: { text: '输出' },
    },
  ],
  ...patch,
});

test('six narrative transitions validate and map to deterministic frame windows', () => {
  const source = base();
  for (const transition of transitionTypes) {
    const board = StoryboardSchema.parse({ ...source, transition });
    const windows = sceneTransitionWindows(board, 30);
    assert.deepEqual(windows, sceneTransitionWindows(board, 30), transition);
    assert.equal(windows.length, 1, transition);
    assert.equal(windows[0]!.transition, transition);
    assert.equal(windows[0]!.fromIndex, 0);
    assert.equal(windows[0]!.toIndex, 1);
    assert.equal(windows[0]!.startFrame, 84);
    assert.equal(windows[0]!.frames, 36);
    assert.equal(windows[0]!.toStartFrame, 120);
  }
  for (const transition of ['none', 'fade'] as const) {
    assert.deepEqual(sceneTransitionWindows(StoryboardSchema.parse({ ...source, transition }), 30), []);
  }
  assert.equal(StoryboardSchema.safeParse({ ...source, transition: 'cut' }).success, true);
  assert.deepEqual(sceneTransitionWindows(StoryboardSchema.parse({ ...source, transition: 'cut' }), 30), []);
});

test('transition overlays preserve scene, subtitle and narration frame offsets and total duration', () => {
  const disabled = base({ transition: 'none' });
  const enabled = StoryboardSchema.parse({ ...disabled, transition: 'shared-element-lite' });
  const offTimeline = timelineFrames(disabled, 30);
  const onTimeline = timelineFrames(enabled, 30);
  assert.equal(onTimeline.totalFrames, offTimeline.totalFrames);
  assert.deepEqual(onTimeline.segments, offTimeline.segments);
  assert.deepEqual(enabled.scenes.map(scene => [scene.audioSrc, scene.audioDuration, scene.subtitleCues]),
    disabled.scenes.map(scene => [scene.audioSrc, scene.audioDuration, scene.subtitleCues]));
  const transition = sceneTransitionWindows(enabled, 30)[0]!;
  assert.ok(transition.startFrame < transition.toStartFrame);
  assert.equal(transition.startFrame + transition.frames, transition.toStartFrame);
});

test('transition windows recompute after TTS duration or scene order changes and clamp at short scenes', () => {
  const initial = StoryboardSchema.parse({ ...base(), transition: 'wipe' });
  const longerFirst = StoryboardSchema.parse({
    ...initial,
    scenes: [{ ...initial.scenes[0]!, audioDuration: 5 }, initial.scenes[1]!],
  });
  const reversed = StoryboardSchema.parse({ ...initial, scenes: [...initial.scenes].reverse() });
  assert.notEqual(sceneTransitionWindows(longerFirst, 30)[0]!.startFrame, sceneTransitionWindows(initial, 30)[0]!.startFrame);
  assert.deepEqual(sceneTransitionWindows(reversed, 30).map(window => [window.fromIndex, window.toIndex]), [[0, 1]]);

  const short = StoryboardSchema.parse({
    ...initial,
    transitionDuration: 2.5,
    scenes: initial.scenes.map(scene => ({ ...scene, duration: 3, audioDuration: undefined })),
  });
  const window = sceneTransitionWindows(short, 30)[0]!;
  assert.equal(window.frames, 75, 'scene duration policy supplies at least three seconds');
  assert.ok(window.frames <= Math.min(...timelineFrames(short, 30).segments.filter(segment => segment.kind === 'scene').map(segment => segment.frames)));
});

test('transition duration is constrained to a short visual bridge', () => {
  assert.equal(StoryboardSchema.safeParse({ ...base(), transitionDuration: .05 }).success, false);
  assert.equal(StoryboardSchema.safeParse({ ...base(), transitionDuration: 2.6 }).success, false);
});

test('transitions preserve HTML, Code and local PPT media scenes without forcing standard templates', () => {
  const scenes = [
    { id: 'ordinary', type: 'text', title: '普通正文', narration: '普通正文保持原样。', visual: { text: '保留正文' } },
    { id: 'html', type: 'html', title: 'HTML 原页', narration: 'HTML 页面保持原样。', visual: { html: '<main><h1>保留原页</h1></main>' } },
    { id: 'code', type: 'code', title: '代码原文', narration: '代码保持原样。', visual: { code: 'const result = 42;', language: 'typescript' } },
    { id: 'ppt', type: 'media', title: 'PPT 原页', narration: '幻灯片保持原样。', visual: { src: 'projects/demo/assets/slide-1.png', fullBleed: true } },
  ];
  const board = StoryboardSchema.parse({
    ...base(),
    transition: 'shared-element-lite',
    scenes,
  });
  assert.equal(board.scenes.length, 4);
  assert.deepEqual(board.scenes.map(scene => scene.visual), scenes.map(scene => scene.visual));
  assert.ok(board.scenes.every(scene => scene.visualPlan === undefined));
  assert.equal(sceneTransitionWindows(board, 30).length, 3);
});
