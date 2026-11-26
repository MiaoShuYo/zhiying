import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { bundle } from '@remotion/bundler';
import { openBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { applyVisualDensity, getVisualBeatTimingDiagnostic, resolveCaptionCues, resolveVisualBeatTimeline, StoryboardSchema, type Scene, type Storyboard } from '@m2v/schema';
import { visualQualitySourceSamples } from '../../../packages/video/test/fixtures/v19-visual-quality';
import { visualQaChromiumOptions } from '../src/visual-qa';

type SapiTimingFile = {
  voice: string;
  engine: string;
  rate: number;
  timingKind: string;
  narration: string;
  events: { characterPosition: number; characterCount: number; startSeconds: number }[];
};
type Capture = {
  frame: number;
  width: number;
  height: number;
  layout: { sceneId: string; beatId?: string; targetId?: string; elementType: string; textContent?: string; overflow?: boolean; bounds: { x: number; y: number; width: number; height: number } }[];
};

const repo = process.cwd();
const outputRoot = resolve(repo, 'docs', 'outputs', 'V1.9.0', 'density-sapi');
const screenshotRoot = resolve(repo, 'docs', 'screenshots', 'v1.9.0', 'density-sapi');
const ffmpeg = 'ffmpeg';
const ffprobe = 'ffprobe';
const edgeExecutable = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE === 'bundled'
  ? undefined
  : process.env.REMOTION_BROWSER_EXECUTABLE?.trim() || (process.platform === 'win32' && existsSync(edgeExecutable) ? edgeExecutable : undefined);
const webRequire = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const sharp = webRequire('sharp') as (input: unknown) => any;
const fps = 30;

function normalized(text: string): string {
  return text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function mediaInfo(path: string): { width: number; height: number; duration: number; hasAudio: boolean } {
  const value = JSON.parse(execFileSync(ffprobe, [
    '-v', 'error', '-show_entries', 'stream=codec_type,width,height,duration:format=duration', '-of', 'json', path,
  ], { encoding: 'utf8', windowsHide: true }));
  const video = value.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video');
  const audio = value.streams.find((stream: { codec_type: string }) => stream.codec_type === 'audio');
  return { width: video?.width ?? 0, height: video?.height ?? 0, duration: Number(value.format.duration), hasAudio: Boolean(audio) };
}

function makeBoard(aspectRatio: Storyboard['aspectRatio'], scene: Scene): Storyboard {
  return StoryboardSchema.parse({
    title: 'V1.9.0 SAPI density audio evidence', aspectRatio, styleId: 'minimal-tech', transition: 'none',
    subtitles: { enabled: true, position: 'bottom' }, scenes: [scene],
  });
}

function wordTimingsFromSapi(data: SapiTimingFile, duration: number): Scene['wordTimings'] {
  assert.equal(data.voice, 'Microsoft Huihui Desktop');
  assert.equal(data.engine, 'Windows System.Speech / SAPI');
  assert.equal(data.narration, data.narration.trim());
  const source = data.narration;
  const events = [...data.events].sort((left, right) => left.startSeconds - right.startSeconds || left.characterPosition - right.characterPosition);
  assert.ok(events.length > 0, 'SAPI returned progress timestamps');
  const lastEventTime = events.at(-1)!.startSeconds;
  assert.ok(lastEventTime > 0, 'SAPI progress spans have positive duration');
  // The SAPI progress clock differs slightly from the encoded WAV clock on Windows.
  // Preserve the event ordering while normalizing its last event to the measured WAV duration.
  const scale = duration / lastEventTime;
  const timings = events.map((event, index) => {
    assert.ok(event.characterPosition >= 0 && event.characterCount > 0 && event.characterPosition + event.characterCount <= source.length, 'SAPI character span is within the source narration');
    const text = source.slice(event.characterPosition, event.characterPosition + event.characterCount);
    const start = event.startSeconds * scale;
    const nextStart = events[index + 1]?.startSeconds;
    const end = nextStart === undefined ? duration : nextStart * scale;
    return { text, start: Math.min(start, duration - 0.02), end: Math.min(duration, Math.max(start + 0.02, end)) };
  }).filter(item => normalized(item.text));
  assert.equal(timings.map(item => normalized(item.text)).join(''), normalized(source), 'SAPI character spans cover every spoken source character exactly once');
  return timings;
}

async function renderCapture(input: { serveUrl: string; browser: Awaited<ReturnType<typeof openBrowser>>; board: Storyboard; frame: number; file: string }): Promise<Capture> {
  const inputProps = { storyboard: input.board, visualQaCapture: true };
  const composition = await selectComposition({ serveUrl: input.serveUrl, id: 'ExplainerVideo', inputProps, browserExecutable, puppeteerInstance: input.browser });
  let capture: Capture | undefined;
  await renderStill({
    composition, serveUrl: input.serveUrl, inputProps, browserExecutable, puppeteerInstance: input.browser,
    output: input.file, frame: input.frame, scale: 1, imageFormat: 'png', overwrite: true, logLevel: 'error',
    onBrowserLog: log => {
      const marker = '__M2V_VISUAL_QA__';
      const index = log.text.indexOf(marker);
      if (index < 0) return;
      try { capture = JSON.parse(log.text.slice(index + marker.length)) as Capture; } catch { /* Assert after render completes. */ }
    },
  });
  assert.ok(capture, `browser layout capture is available for ${input.file}`);
  const expected = input.board.aspectRatio === '16:9' ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
  assert.deepEqual({ width: capture!.width, height: capture!.height }, expected);
  return capture!;
}

async function makeContactSheet(files: string[], output: string, labels: string[]): Promise<void> {
  const tileWidth = 480;
  const tileHeight = 360;
  const header = 36;
  const columns = 2;
  const rows = Math.ceil(files.length / columns);
  const layers: { input: Buffer; left: number; top: number }[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const tile = await sharp(files[index]!).resize({ width: tileWidth, height: tileHeight - header, fit: 'contain', background: '#111827' }).png().toBuffer();
    const label = Buffer.from(`<svg width="${tileWidth}" height="${header}"><rect width="100%" height="100%" fill="#0b1020"/><text x="12" y="25" font-size="16" font-family="Arial,sans-serif" fill="#f3f7ff">${labels[index]!.replace(/[&<>]/g, '')}</text></svg>`);
    layers.push({ input: label, left: index % columns * tileWidth, top: Math.floor(index / columns) * tileHeight });
    layers.push({ input: tile, left: index % columns * tileWidth, top: Math.floor(index / columns) * tileHeight + header });
  }
  await sharp({ create: { width: tileWidth * columns, height: rows * tileHeight, channels: 4, background: '#111827' } }).composite(layers).png().toFile(output);
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('The SAPI density runner requires Windows System.Speech.');
  await mkdir(outputRoot, { recursive: true });
  await mkdir(screenshotRoot, { recursive: true });
  const temp = await mkdtemp(join(resolve(repo, 'data'), 'test-v19-density-sapi-'));
  const narration = visualQualitySourceSamples.nestedBullets.items.map(item => item.text).join('');
  const inputJson = join(temp, 'sapi-input.json');
  const wavOutput = join(outputRoot, 'nested-list-microsoft-huihui-sapi.wav');
  const timingOutput = join(outputRoot, 'nested-list-microsoft-huihui-sapi-timings.json');
  await writeFile(inputJson, JSON.stringify({ narration }), 'utf8');
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(repo, 'apps', 'worker', 'test', 'fixtures', 'synthesize-sapi-timings.ps1'),
      '-InputJson', inputJson, '-OutputWav', wavOutput, '-OutputJson', timingOutput,
    ], { cwd: repo, stdio: 'inherit', windowsHide: true });
    const timingJson = JSON.parse((await readFile(timingOutput, 'utf8')).replace(/^\uFEFF/u, '')) as SapiTimingFile;
    assert.equal(timingJson.narration, narration, 'SAPI spoke the exact source fixture narration');
    const wavProbe = mediaInfo(wavOutput);
    assert.equal(wavProbe.hasAudio, true, 'synthesized WAV contains audio');
    const wordTimings = wordTimingsFromSapi(timingJson, wavProbe.duration);
    assert.ok(wordTimings && wordTimings.length > 10);
    const stagingRoot = join(temp, 'public');
    const audioPublicPath = 'projects/v190-density-sapi/assets/nested-list.wav';
    const audioPublicFile = join(stagingRoot, audioPublicPath);
    await mkdir(join(stagingRoot, 'projects', 'v190-density-sapi', 'assets'), { recursive: true });
    await copyFile(wavOutput, audioPublicFile);
    const serveUrl = await bundle({ entryPoint: resolve(repo, 'apps', 'worker', 'src', 'entry.tsx'), publicDir: stagingRoot, outDir: join(temp, 'bundle') });
    const browser = await openBrowser('chrome', { browserExecutable: browserExecutable ?? null, chromiumOptions: visualQaChromiumOptions() });
    const outputs: Record<string, unknown>[] = [];
    try {
      for (const aspect of ['16:9', '9:16'] as const) {
        const source = StoryboardSchema.parse({
          title: 'SAPI density source', aspectRatio: aspect, styleId: 'minimal-tech', transition: 'none',
          scenes: [{
            id: 'v190-sapi-nested-list', type: 'bullets', title: visualQualitySourceSamples.nestedBullets.title,
            narration, duration: wavProbe.duration, audioDuration: wavProbe.duration, audioSrc: audioPublicPath,
            wordTimings, layout: 'auto', visual: { items: visualQualitySourceSamples.nestedBullets.items },
          }],
        }).scenes[0]!;
        const denseScene = applyVisualDensity(source, aspect, { autoSplit: true, strategy: 'balanced' });
        assert.ok((denseScene.visualBeats?.length ?? 0) > 1, `${aspect} produces multiple semantic density beats`);
        assert.equal(denseScene.narration, narration, `${aspect} preserves the entire source narration`);
        const densityBeats = denseScene.visualBeats!;
        const orderedParentTargets = densityBeats.flatMap(beat => beat.targetIds.filter(targetId => /^bullet-\d+$/u.test(targetId)));
        assert.deepEqual(orderedParentTargets, visualQualitySourceSamples.nestedBullets.items.map((_, index) => `bullet-${index + 1}`), `${aspect} groups every parent visual in source order exactly once`);
        for (const beat of densityBeats) {
          const parentNarration = beat.targetIds
            .filter(targetId => /^bullet-\d+$/u.test(targetId))
            .map(targetId => visualQualitySourceSamples.nestedBullets.items[Number(targetId.slice('bullet-'.length)) - 1]!.text)
            .join('');
          assert.ok(parentNarration, `${aspect}/${beat.id} has an active narrated parent visual`);
          assert.equal(normalized(beat.narrationText), normalized(parentNarration), `${aspect}/${beat.id} narration describes exactly its active parent visual group`);
        }
        assert.equal(getVisualBeatTimingDiagnostic(denseScene)?.source, 'wordTimings', `${aspect} density beats are covered by native SAPI timings`);
        assert.deepEqual(denseScene.wordTimings, wordTimings, `${aspect} retains SAPI audio timing data`);
        const board = makeBoard(aspect, denseScene);
        const beatFrames = resolveVisualBeatTimeline(denseScene, fps);
        const audioFrames = Math.ceil(wavProbe.duration * fps);
        assert.equal(beatFrames.length, denseScene.visualBeats!.length);
        assert.ok(beatFrames.every(beat => beat.startFrame >= 0 && beat.endFrame <= audioFrames && beat.endFrame > beat.startFrame), `${aspect} all density beat windows fit inside the measured audio window`);
        const cues = resolveCaptionCues(denseScene, wavProbe.duration, aspect === '9:16', 30);
        assert.ok(cues.length > 0);
        assert.equal(cues.map(cue => cue.text).join(''), narration, `${aspect} captions reconstruct the spoken narration without omissions`);
        assert.ok(cues.every(cue => cue.start >= 0 && cue.end <= wavProbe.duration && cue.end > cue.start), `${aspect} caption cues remain within audio duration`);

        const stillFiles: string[] = [];
        const labels: string[] = [];
        const composition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps: { storyboard: board }, browserExecutable, puppeteerInstance: browser });
        const video = join(outputRoot, `V1.9.0_${aspect.replace(':', '-')}_density-nested-list-sapi.mp4`);
        await renderMedia({ composition, serveUrl, inputProps: { storyboard: board }, browserExecutable, puppeteerInstance: browser, codec: 'h264', outputLocation: video, concurrency: 2, scale: 1, logLevel: 'error' });
        const videoInfo = mediaInfo(video);
        assert.equal(videoInfo.hasAudio, true, `${aspect} exported MP4 contains an audio stream`);
        assert.deepEqual({ width: videoInfo.width, height: videoInfo.height }, aspect === '16:9' ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 });
        assert.ok(Math.abs(videoInfo.duration - wavProbe.duration) < 0.12, `${aspect} video duration matches the synthesized narration duration`);
        execFileSync(ffmpeg, ['-v', 'error', '-i', video, '-map', '0:a:0', '-f', 'null', '-'], { cwd: repo, stdio: 'ignore', windowsHide: true });

        for (const beat of beatFrames) {
          const frame = Math.floor((beat.startFrame + beat.endFrame - 1) / 2);
          const file = join(screenshotRoot, `v1.9.0_${aspect.replace(':', '-')}_sapi_density-${beat.id}.png`);
          const capture = await renderCapture({ serveUrl, browser, board, frame, file });
          const sceneSamples = capture.layout.filter(item => item.sceneId === denseScene.id);
          const currentBeat = sceneSamples.some(item => item.beatId === beat.id);
          assert.ok(currentBeat, `${aspect}/${beat.id} rendered layout identifies active density beat`);
          const expectedCaption = cues.find(cue => frame / fps >= cue.start && frame / fps < cue.end)?.text;
          const renderedCaption = sceneSamples.find(item => item.elementType === 'subtitle' && item.targetId === 'subtitle');
          assert.ok(expectedCaption, `${aspect}/${beat.id} sample frame has a scheduled subtitle cue`);
          assert.equal(renderedCaption?.textContent, expectedCaption, `${aspect}/${beat.id} displayed subtitle matches its timed cue exactly`);
          assert.equal(renderedCaption?.overflow, false, `${aspect}/${beat.id} caption is not clipped`);
          stillFiles.push(file);
          labels.push(`${aspect} ${beat.id} · ${(frame / fps).toFixed(2)}s`);
        }
        const sheet = join(screenshotRoot, `v1.9.0_${aspect.replace(':', '-')}_sapi_density-contact.png`);
        await makeContactSheet(stillFiles, sheet, labels);
        outputs.push({
          aspectRatio: aspect, video, sha256: digest(video), width: videoInfo.width, height: videoInfo.height,
          durationSeconds: videoInfo.duration, hasAudio: videoInfo.hasAudio, audioDecoded: true, beatFrames,
          sourceNarration: narration, captionCount: cues.length, subtitleCues: cues, screenshotPaths: stillFiles, contactSheet: sheet,
        });
        console.log(`${aspect}: ${denseScene.visualBeats!.length} density beats fit within ${wavProbe.duration.toFixed(3)}s SAPI audio; full caption track retained; MP4 audio decoded.`);
      }
    } finally {
      await browser.close({ silent: true });
    }
    const summary = {
      engine: timingJson.engine, voice: timingJson.voice, rate: timingJson.rate, timingKind: timingJson.timingKind,
      wav: wavOutput, wavSha256: digest(wavOutput), audioDurationSeconds: wavProbe.duration,
      timingEventCount: timingJson.events.length, wordTimingSpanCount: wordTimings.length,
      narration, outputs,
      note: 'Local Windows SAPI validation voice only; this is not the product F5-TTS engine.',
    };
    await writeFile(join(outputRoot, 'density-sapi-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
    console.log(`SAPI density audio sample complete: ${outputs.length} aspect ratios. This is Windows System.Speech validation audio, not product F5-TTS.`);
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
