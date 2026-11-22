import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { StoryboardSchema, sceneTransitionWindows, timelineFrames, type Storyboard, type VisualTemplateId } from '@m2v/schema';
import { visualQualityStoryboard } from '../../../packages/video/test/fixtures/v19-visual-quality';

const repo = process.cwd();
const screenshots = resolve(repo, 'docs', 'screenshots', 'v1.9.0');
const media = resolve(repo, 'docs', 'outputs', 'V1.9.0');
const edgeBrowserExecutable = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE?.trim()
  || (process.platform === 'win32' && existsSync(edgeBrowserExecutable) ? edgeBrowserExecutable : undefined);
const webRequire = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const sharp = webRequire('sharp') as (input: unknown) => any;
const templates: Record<string, VisualTemplateId> = {
  'v190-hero': 'hero',
  'v190-comparison': 'comparison',
  'v190-diagram': 'diagram',
  'v190-timeline': 'timeline',
  'v190-chart': 'chart',
};

function boardsForAspect(aspectRatio: '16:9' | '9:16'): { before: Storyboard; after: Storyboard } {
  const base = visualQualityStoryboard.scenes.map(scene => ({ ...scene, duration: 2 }));
  const after = base.map(scene => {
    const templateId = templates[scene.id];
    if (!templateId) return scene;
    return {
      ...scene,
      visualPlan: {
        templateId,
        narrativeIntent: templateId === 'hero' ? 'hook' : templateId === 'comparison' ? 'comparison' : templateId === 'diagram' ? 'flow' : templateId === 'timeline' ? 'timeline' : 'data-story',
        keyFocus: scene.title,
        beats: [],
        elementMap: {},
        manualOverride: false,
        provenance: 'rule',
      },
    };
  });
  const shared = {
    title: visualQualityStoryboard.title,
    aspectRatio,
    styleId: visualQualityStoryboard.styleId,
    transition: 'none' as const,
    brand: {
      name: 'V1.9 Test Brand',
      baseStyleId: 'minimal-tech',
      colors: { bg: '#0b1020', fg: '#f3f7ff', muted: '#91a4be', accent: '#2dd4bf', card: '#14243a', secondary: '#a78bfa' },
      typography: { headingFont: 'Arial', bodyFont: 'Arial' },
      logo: { src: 'brand-logo.png', position: 'bottom-right', width: 150, opacity: 1, margin: 36 },
    },
    subtitles: { ...visualQualityStoryboard.subtitles, enabled: true },
  };
  return {
    before: StoryboardSchema.parse({ ...shared, scenes: base }),
    after: StoryboardSchema.parse({ ...shared, scenes: after }),
  };
}

function transitionBoard(aspectRatio: '16:9' | '9:16', transition: Storyboard['transition'], reducedMotion = false): Storyboard {
  const from = {
    id: 'v190-transition-from', type: 'diagram', title: '一次请求进入服务', narration: '请求速率保持稳定。',
    duration: 3, audioDuration: 3, audioSrc: 'projects/v19/assets/voice-440.wav', subtitleCues: [{ text: '请求速率保持稳定。', start: 0, end: 1.4 }],
    visual: { nodes: [{ id: 'shared-throughput', label: '每秒请求数' }, { id: 'source', label: '接收请求' }] },
    visualPlan: { templateId: 'diagram', narrativeIntent: 'flow', keyFocus: '请求入口', elementMap: { metric: 'shared-throughput' }, manualOverride: true, provenance: 'user' },
  };
  const to = {
    id: 'v190-transition-to', type: 'chart', title: '服务处理指标', narration: '请求速率为每秒一百八十次。',
    duration: 3, audioDuration: 3, audioSrc: 'projects/v19/assets/voice-660.wav', subtitleCues: [{ text: '请求速率为每秒一百八十次。', start: 0, end: 1.6 }],
    visual: { data: [{ id: 'shared-throughput', label: '每秒请求数', value: 180 }, { id: 'latency', label: 'P99 延迟', value: 42 }] },
    visualPlan: { templateId: 'chart', narrativeIntent: 'data-story', keyFocus: '服务指标', elementMap: { metric: 'shared-throughput' }, manualOverride: true, provenance: 'user' },
  };
  return StoryboardSchema.parse({
    title: 'V1.9.0 转场边界样例', aspectRatio, styleId: 'minimal-tech', transition,
    transitionDuration: .6, reducedMotion,
    subtitles: { enabled: true, position: 'bottom' },
    scenes: [from, to],
  });
}

function preserveTransitionBoard(aspectRatio: '16:9' | '9:16'): Storyboard {
  return StoryboardSchema.parse({
    title: 'V1.9.0 Preserve 转场回退', aspectRatio, styleId: 'minimal-tech',
    transition: 'wipe', transitionDuration: .6, subtitles: { enabled: true, position: 'bottom' },
    scenes: [
      { id: 'preserve-html', type: 'html', title: 'HTML 原场景', narration: '手工 HTML 内容继续保留。', duration: 3, visual: { html: '<main style="padding:24px"><h1>手工 HTML</h1><p>HTML scene remains intact</p></main>' } },
      { id: 'preserve-code', type: 'code', title: 'Code 原场景', narration: '结构化代码继续保留。', duration: 3, visual: { code: 'const requestCount = 180;\nconst isHealthy = requestCount < 250;\nconsole.log(isHealthy);', language: 'typescript', filename: 'health.ts' } },
      { id: 'preserve-ppt', type: 'media', title: 'PPT 原页', narration: '原始幻灯片继续保留。', duration: 3, visual: { src: 'projects/v19/assets/slide-1.png', fullBleed: true } },
    ],
  });
}

function fallbackMotionBoard(aspectRatio: '16:9' | '9:16', staticFallback: boolean): Storyboard {
  const beat = { id: 'growth', narrationText: '活跃用户持续增长。', targetIds: ['chart-bar-1'] };
  return StoryboardSchema.parse({
    title: 'V1.9.0 静态动作回退', aspectRatio, styleId: 'minimal-tech', transition: 'none',
    subtitles: { enabled: false },
    scenes: [{
      id: 'v190-static-fallback-render', type: 'chart', title: '活跃用户', narration: '活跃用户持续增长。', duration: 3,
      visual: { data: [{ id: 'users', label: '活跃用户', value: 120 }] },
      visualBeats: [beat],
      visualPlan: {
        templateId: 'chart', beats: [beat],
        motionPresets: [{ targetId: 'chart-bar-1', beatRef: beat.id, durationPolicy: 'fixed', durationFrames: 30, action: 'bar-grow' }],
      },
      ...(staticFallback ? { visualStaticFallback: true, visualStaticFallbackReason: '渲染检查后的静态回退样例。' } : {}),
    }],
  });
}

function probe(file: string): { width: number; height: number; duration: number } {
  const value = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file,
  ], { encoding: 'utf8', windowsHide: true }));
  return { width: value.streams[0].width, height: value.streams[0].height, duration: Number(value.format.duration) };
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function writeTone(file: string, frequency: number, durationSeconds = 3): Promise<void> {
  const sampleRate = 22050;
  const sampleCount = Math.round(sampleRate * durationSeconds);
  const dataBytes = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const edgeFade = Math.min(1, index / 441, (sampleCount - 1 - index) / 441);
    const sample = Math.round(10000 * edgeFade * Math.sin(2 * Math.PI * frequency * index / sampleRate));
    wav.writeInt16LE(sample, 44 + index * 2);
  }
  await writeFile(file, wav);
}

function probeAudio(file: string): { codec: string; sampleRate: string; duration: number } {
  const value = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,duration', '-of', 'json', file,
  ], { encoding: 'utf8', windowsHide: true }));
  const stream = value.streams[0];
  assert.ok(stream, `${file} includes audio stream`);
  return { codec: stream.codec_name, sampleRate: stream.sample_rate, duration: Number(stream.duration) };
}

function toneMagnitude(samples: Buffer, startSeconds: number, durationSeconds: number, frequency: number): number {
  const sampleRate = 22050;
  const start = Math.floor(startSeconds * sampleRate);
  const count = Math.floor(durationSeconds * sampleRate);
  const coefficient = 2 * Math.cos(2 * Math.PI * frequency / sampleRate);
  let previous = 0;
  let previousPrevious = 0;
  for (let offset = 0; offset < count; offset += 1) {
    const sample = samples.readFloatLE((start + offset) * 4);
    const current = sample + coefficient * previous - previousPrevious;
    previousPrevious = previous;
    previous = current;
  }
  return Math.sqrt(Math.max(0, previous * previous + previousPrevious * previousPrevious - coefficient * previous * previousPrevious)) / count;
}

function decodeAudio(file: string): Buffer {
  return execFileSync('ffmpeg', [
    '-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', '1', '-ar', '22050', 'pipe:1',
  ], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
}

async function assertNoBlankFrame(file: string, label: string): Promise<void> {
  const { width, height } = await sharp(file).metadata();
  if (!width || !height) throw new Error(`${label}: rendered image has no dimensions`);
  const pixels = await sharp(file).removeAlpha().raw().toBuffer();
  const background = [pixels[0]!, pixels[1]!, pixels[2]!];
  let backgroundPixels = 0;
  for (let index = 0; index < pixels.length; index += 3) {
    if (Math.abs(pixels[index]! - background[0]!) <= 2 && Math.abs(pixels[index + 1]! - background[1]!) <= 2 && Math.abs(pixels[index + 2]! - background[2]!) <= 2) backgroundPixels += 1;
  }
  const blankPixelRatio = backgroundPixels / (width * height);
  const stats = await sharp(file).stats();
  const averageDeviation = stats.channels.reduce((sum: number, channel: { stdev: number }) => sum + channel.stdev, 0) / stats.channels.length;
  assert.ok(blankPixelRatio < .99 && averageDeviation > .25, `${label} is a blank/background-only frame (blank pixel ratio ${blankPixelRatio.toFixed(4)}, deviation ${averageDeviation.toFixed(3)})`);
}

async function assertLogoVisible(file: string, aspectRatio: '16:9' | '9:16'): Promise<void> {
  const width = aspectRatio === '16:9' ? 1920 : 1080;
  const height = aspectRatio === '16:9' ? 1080 : 1920;
  const crop = await sharp(file).extract({ left: width - 250, top: height - 500, width: 240, height: 400 }).removeAlpha().raw().toBuffer();
  let accentPixels = 0;
  for (let index = 0; index < crop.length; index += 3) {
    if (crop[index]! < 100 && crop[index + 1]! > 150 && crop[index + 2]! < 240) accentPixels += 1;
  }
  assert.ok(accentPixels > 100, `${aspectRatio} bottom-right Brand Kit Logo should be visible above the subtitle area`);
}

async function makeContactSheet(files: string[], output: string, labels: string[]): Promise<void> {
  const width = 960;
  const tileWidth = 480;
  const tileHeight = 300;
  const header = 42;
  const rows = Math.ceil(files.length / 2);
  const layers: { input: Buffer; left: number; top: number }[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const tile = await sharp(files[index]!).resize({ width: tileWidth, height: tileHeight - header, fit: 'contain', background: '#111827' }).png().toBuffer();
    const label = Buffer.from(`<svg width="${tileWidth}" height="${header}"><rect width="100%" height="100%" fill="#0b1020"/><text x="14" y="28" font-size="18" font-family="Arial, sans-serif" fill="#f3f7ff">${labels[index]!.replace(/[&<>]/g, '')}</text></svg>`);
    const left = (index % 2) * tileWidth;
    const top = Math.floor(index / 2) * tileHeight;
    layers.push({ input: label, left, top });
    layers.push({ input: tile, left, top: top + header });
  }
  await sharp({ create: { width, height: rows * tileHeight, channels: 4, background: '#111827' } }).composite(layers).png().toFile(output);
}

async function renderTransitionEvidence(serveUrl: string, aspectRatio: '16:9' | '9:16', outputs: { path: string; sha256: string; width: number; height: number; duration: number }[]): Promise<void> {
  const transitionTypes: Storyboard['transition'][] = ['none', 'cut', 'crossfade', 'wipe', 'slide', 'match-move', 'shared-element-lite'];
  const shotFiles: string[] = [];
  const shotLabels: string[] = [];
  const expected = aspectRatio === '16:9' ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
  let deterministicShot: { composition: Awaited<ReturnType<typeof selectComposition>>; storyboard: Storyboard; frame: number; file: string } | undefined;

  for (const transition of transitionTypes) {
    const storyboard = transitionBoard(aspectRatio, transition);
    const inputProps = { storyboard };
    const composition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps, browserExecutable });
    assert.deepEqual({ width: composition.width, height: composition.height }, expected, `${aspectRatio} ${transition} canvas`);
    const windows = sceneTransitionWindows(storyboard, composition.fps);
    const boundary = timelineFrames(storyboard, composition.fps).segments.filter(segment => segment.kind === 'scene')[1]!.startFrame;
    const frames = windows.length
      ? [windows[0]!.startFrame, windows[0]!.startFrame + Math.floor(windows[0]!.frames / 2), windows[0]!.startFrame + windows[0]!.frames - 1, boundary, Math.min(composition.durationInFrames - 1, boundary + 1)]
      : [Math.max(0, boundary - 1), boundary, Math.min(composition.durationInFrames - 1, boundary + 1)];

    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index]!;
      const file = join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_transition_${transition}_${index}.png`);
      await renderStill({ composition, serveUrl, inputProps, browserExecutable, output: file, frame, scale: 1 });
      const metadata = await sharp(file).metadata();
      assert.deepEqual({ width: metadata.width, height: metadata.height }, expected, `${transition} frame ${frame}`);
      await assertNoBlankFrame(file, `${aspectRatio} ${transition} frame ${frame}`);
      shotFiles.push(file);
      shotLabels.push(`${transition} · frame ${frame}`);
      if (transition === 'match-move' && index === 1) deterministicShot = { composition, storyboard, frame, file };
    }
  }

  assert.ok(deterministicShot, 'match-move midpoint rendered');
  const repeatFile = join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_transition_match-move_repeat.png`);
  await renderStill({
    composition: deterministicShot.composition,
    serveUrl,
    inputProps: { storyboard: deterministicShot.storyboard },
    browserExecutable,
    output: repeatFile,
    frame: deterministicShot.frame,
    scale: 1,
  });
  assert.equal(sha256(repeatFile), sha256(deterministicShot.file), 'same transition frame renders deterministically');

  for (const transition of ['wipe', 'slide'] as const) {
    const reduced = transitionBoard(aspectRatio, transition, true);
    const crossfade = transitionBoard(aspectRatio, 'crossfade', true);
    const reducedComposition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps: { storyboard: reduced }, browserExecutable });
    const crossfadeComposition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps: { storyboard: crossfade }, browserExecutable });
    const frame = sceneTransitionWindows(reduced, reducedComposition.fps)[0]!.startFrame + Math.floor(sceneTransitionWindows(reduced, reducedComposition.fps)[0]!.frames / 2);
    const reducedFile = join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_transition_${transition}_reduced.png`);
    const crossfadeFile = join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_transition_${transition}_reduced_crossfade_reference.png`);
    await renderStill({ composition: reducedComposition, serveUrl, inputProps: { storyboard: reduced }, browserExecutable, output: reducedFile, frame, scale: 1 });
    await renderStill({ composition: crossfadeComposition, serveUrl, inputProps: { storyboard: crossfade }, browserExecutable, output: crossfadeFile, frame, scale: 1 });
    assert.equal(sha256(reducedFile), sha256(crossfadeFile), `${transition} reduced-motion fallback is crossfade`);
    shotFiles.push(reducedFile);
    shotLabels.push(`${transition} reduced → crossfade`);
  }

  await makeContactSheet(shotFiles, join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_transition_motion-strip.png`), shotLabels);

  const preserve = preserveTransitionBoard(aspectRatio);
  const preserveInputProps = { storyboard: preserve };
  const preserveComposition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps: preserveInputProps, browserExecutable });
  const preserveShots: string[] = [];
  const preserveLabels: string[] = [];
  const preserveWindows = sceneTransitionWindows(preserve, preserveComposition.fps);
  for (const [index, transition] of preserveWindows.entries()) {
    const frame = transition.startFrame + Math.floor(transition.frames / 2);
    const file = join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_preserve-wipe-${transition.fromIndex}-${transition.toIndex}.png`);
    await renderStill({ composition: preserveComposition, serveUrl, inputProps: preserveInputProps, browserExecutable, output: file, frame, scale: 1 });
    await assertNoBlankFrame(file, `${aspectRatio} Preserve wipe frame ${frame}`);
    preserveShots.push(file);
    preserveLabels.push(index === 0 ? 'HTML → Code' : 'Code → PPT Preserve');
  }
  await makeContactSheet(preserveShots, join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_preserve-transition-strip.png`), preserveLabels);

  for (const [name, transition] of [['off', 'none'], ['shared-element', 'shared-element-lite']] as const) {
    const storyboard = transitionBoard(aspectRatio, transition);
    const inputProps = { storyboard };
    const composition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps, browserExecutable });
    const file = join(media, `V1.9.0_${aspectRatio.replace(':', '-')}_transition-${name}.mp4`);
    await renderMedia({ composition, serveUrl, inputProps, browserExecutable, codec: 'h264', outputLocation: file, concurrency: 2, scale: 1 });
    const boundary = timelineFrames(storyboard, composition.fps).segments.filter(segment => segment.kind === 'scene')[1]!.startFrame;
    for (const frame of [boundary - 1, boundary, boundary + 1]) {
      const boundaryShot = join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_transition-${name}_mp4-frame-${frame}.png`);
      execFileSync('ffmpeg', ['-y', '-i', file, '-vf', `select=eq(n\\,${frame})`, '-fps_mode', 'passthrough', '-frames:v', '1', boundaryShot], { windowsHide: true, stdio: 'ignore' });
      await assertNoBlankFrame(boundaryShot, `${aspectRatio} ${name} MP4 frame ${frame}`);
    }
    const result = probe(file);
    assert.deepEqual({ width: result.width, height: result.height }, expected);
    assert.ok(Math.abs(result.duration - 6) <= .5, `${name} transition video duration ${result.duration}`);
    const audio = probeAudio(file);
    assert.equal(audio.codec, 'aac');
    assert.ok(Math.abs(audio.duration - 6) <= .5, `${name} audio duration ${audio.duration}`);
    const pcm = decodeAudio(file);
    const firstSegment = { expected: toneMagnitude(pcm, 2.45, .25, 440), unexpected: toneMagnitude(pcm, 2.45, .25, 660) };
    const secondSegment = { expected: toneMagnitude(pcm, 3.25, .25, 660), unexpected: toneMagnitude(pcm, 3.25, .25, 440) };
    assert.ok(firstSegment.expected > firstSegment.unexpected * 2, `${name} outgoing audio remains alone before the cut: ${JSON.stringify(firstSegment)}`);
    assert.ok(secondSegment.expected > secondSegment.unexpected * 2, `${name} incoming audio remains alone after the cut: ${JSON.stringify(secondSegment)}`);
    outputs.push({ path: file, sha256: sha256(file), ...result });
  }
}

async function renderStaticFallbackEvidence(serveUrl: string, aspectRatio: '16:9' | '9:16'): Promise<void> {
  const normal = fallbackMotionBoard(aspectRatio, false);
  const fallback = fallbackMotionBoard(aspectRatio, true);
  const normalProps = { storyboard: normal };
  const fallbackProps = { storyboard: fallback };
  const normalComposition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps: normalProps, browserExecutable });
  const fallbackComposition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps: fallbackProps, browserExecutable });
  const expected = aspectRatio === '16:9' ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
  assert.deepEqual({ width: fallbackComposition.width, height: fallbackComposition.height }, expected);
  const files = {
    normalStart: join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_motion-normal-frame-0.png`),
    normalMiddle: join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_motion-normal-frame-20.png`),
    fallbackStart: join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_motion-static-fallback-frame-0.png`),
    fallbackMiddle: join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_motion-static-fallback-frame-20.png`),
  };
  await renderStill({ composition: normalComposition, serveUrl, inputProps: normalProps, browserExecutable, output: files.normalStart, frame: 0, scale: 1 });
  await renderStill({ composition: normalComposition, serveUrl, inputProps: normalProps, browserExecutable, output: files.normalMiddle, frame: 20, scale: 1 });
  await renderStill({ composition: fallbackComposition, serveUrl, inputProps: fallbackProps, browserExecutable, output: files.fallbackStart, frame: 0, scale: 1 });
  await renderStill({ composition: fallbackComposition, serveUrl, inputProps: fallbackProps, browserExecutable, output: files.fallbackMiddle, frame: 20, scale: 1 });
  assert.notEqual(sha256(files.normalStart), sha256(files.normalMiddle), 'normal motion changes the chart between start and midpoint');
  assert.equal(sha256(files.fallbackStart), sha256(files.fallbackMiddle), 'static fallback keeps the rendered visual identical across frames');
  console.log(`${aspectRatio} static motion fallback: normal frame images differ; fallback frames 0/20 are identical`);
}

async function main() {
  await mkdir(screenshots, { recursive: true });
  await mkdir(media, { recursive: true });
  const repoTmp = await mkdtemp(join(resolve(repo, 'data'), 'test-render-v19-'));
  const outputs: { path: string; sha256: string; width: number; height: number; duration: number }[] = [];
  try {
    const publicDir = join(repoTmp, 'public');
    const projectAssets = join(publicDir, 'projects', 'v19', 'assets');
    await mkdir(projectAssets, { recursive: true });
    await sharp(Buffer.from('<svg width="240" height="80" xmlns="http://www.w3.org/2000/svg"><rect width="240" height="80" rx="16" fill="#10253a"/><path d="M18 40h30M33 25v30" stroke="#2dd4bf" stroke-width="8" stroke-linecap="round"/><text x="62" y="51" font-size="28" font-family="Arial,sans-serif" font-weight="700" fill="#f3f7ff">M2V STUDIO</text></svg>')).png().toFile(join(publicDir, 'brand-logo.png'));
    await sharp({ create: { width: 640, height: 360, channels: 4, background: '#31577d' } }).png().toFile(join(projectAssets, 'slide-1.png'));
    await writeTone(join(projectAssets, 'voice-440.wav'), 440);
    await writeTone(join(projectAssets, 'voice-660.wav'), 660);
    const serveUrl = await bundle({ entryPoint: resolve(repo, 'apps', 'worker', 'src', 'entry.tsx'), publicDir, outDir: join(repoTmp, 'bundle') });
    for (const aspectRatio of ['16:9', '9:16'] as const) {
      const { before, after } = boardsForAspect(aspectRatio);
      for (const [version, storyboard] of [['before', before], ['after', after]] as const) {
        const inputProps = { storyboard };
        const composition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps, browserExecutable });
        const expected = aspectRatio === '16:9' ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
        assert.deepEqual({ width: composition.width, height: composition.height }, expected, `${aspectRatio} ${version} canvas`);
        const rendered: string[] = [];
        const labels: string[] = [];
        const segments = timelineFrames(storyboard, composition.fps).segments;
        let previewExportSample: { file: string; frame: number } | undefined;
        for (const scene of storyboard.scenes.filter(item => templates[item.id])) {
          const sceneIndex = storyboard.scenes.findIndex(item => item.id === scene.id);
          const segment = segments.find(item => item.kind === 'scene' && item.index === sceneIndex)!;
          const frame = Math.min(composition.durationInFrames - 1, segment.startFrame + Math.floor(segment.frames / 2));
          const file = join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_${version}_${scene.id}.png`);
          await renderStill({ composition, serveUrl, inputProps, browserExecutable, output: file, frame, scale: 1 });
          rendered.push(file);
          labels.push(`${aspectRatio} ${version} · ${scene.id}`);
          if (version === 'after' && scene.id === 'v190-hero') {
            previewExportSample = { file, frame };
            await assertLogoVisible(file, aspectRatio);
          }
        }
        await makeContactSheet(rendered, join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_${version}_contact.png`), labels);

        if (version === 'after') {
          const file = join(media, `V1.9.0_${aspectRatio.replace(':', '-')}_visual-quality.mp4`);
          await renderMedia({ composition, serveUrl, inputProps, browserExecutable, codec: 'h264', outputLocation: file, concurrency: 2, scale: 1 });
          const result = probe(file);
          assert.equal(result.width, expected.width);
          assert.equal(result.height, expected.height);
          assert.ok(result.duration >= timelineFrames(storyboard, composition.fps).totalFrames / composition.fps - 0.5);
          outputs.push({ path: file, sha256: sha256(file), ...result });
          if (!previewExportSample) throw new Error(`${aspectRatio}: hero preview frame was not rendered`);
          const exportedFrame = join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_after_hero_mp4-frame.png`);
          execFileSync('ffmpeg', ['-y', '-i', file, '-vf', `select=eq(n\\,${previewExportSample.frame})`, '-fps_mode', 'passthrough', '-frames:v', '1', exportedFrame], { windowsHide: true, stdio: 'ignore' });
          const stillPixels = await sharp(previewExportSample.file).removeAlpha().raw().toBuffer();
          const mp4Pixels = await sharp(exportedFrame).removeAlpha().raw().toBuffer();
          assert.equal(stillPixels.length, mp4Pixels.length, 'preview and MP4 keyframe canvas match');
          let pixelDiff = 0;
          for (let index = 0; index < stillPixels.length; index += 1) pixelDiff += Math.abs(stillPixels[index]! - mp4Pixels[index]!);
          const meanPixelDiff = pixelDiff / stillPixels.length;
          assert.ok(meanPixelDiff < 8, `${aspectRatio} preview/MP4 frame pixel difference ${meanPixelDiff.toFixed(3)} exceeds H.264 tolerance`);
          console.log(`${aspectRatio} hero preview/MP4 frame ${previewExportSample.frame} mean RGB diff: ${meanPixelDiff.toFixed(3)}`);
        }
      }
      await renderTransitionEvidence(serveUrl, aspectRatio, outputs);
      await renderStaticFallbackEvidence(serveUrl, aspectRatio);
    }
    console.log('V1.9.0 MP4 outputs (local ignored artifacts):');
    for (const output of outputs) console.log(`${output.path}\n  SHA-256 ${output.sha256}\n  ${output.width}x${output.height}, ${output.duration.toFixed(2)}s`);
    console.log(`PNG snapshots and contact sheets: ${screenshots}`);
  } finally {
    await rm(repoTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
