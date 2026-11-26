import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { StoryboardSchema, preflight, type Storyboard, type VisualTemplateId } from '@m2v/schema';

const repo = process.cwd();
const screenshots = resolve(repo, 'docs', 'screenshots', 'v1.9.0');
const media = resolve(repo, 'docs', 'outputs', 'V1.9.0');
const edgeBrowserExecutable = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const requestedBrowserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE?.trim();
const browserExecutable = requestedBrowserExecutable === 'bundled'
  ? undefined
  : requestedBrowserExecutable || (process.platform === 'win32' && existsSync(edgeBrowserExecutable) ? edgeBrowserExecutable : undefined);
const webRequire = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const sharp = webRequire('sharp') as (input: unknown) => any;
const stylePacks = ['editorial-tech', 'clean-data', 'paper-collage-lite'] as const;
const visualTemplates: VisualTemplateId[] = ['hero', 'comparison', 'diagram', 'timeline', 'chart'];
const cueIds = ['soft-transition', 'emphasis-tick', 'data-pop', 'flow-pulse', 'success-chime', 'paper-tap'] as const;
const cueStarts = [.35, 1.8, 3, 4.3, 5.6, 7.4];
const cueDurations = [1.1, .18, .42, .72, 1.05, .22];
// DOM rectangles are normalized floats; for example .05 + .9 can evaluate to .9500000000000001.
const safeAreaEpsilon = 1e-9;
const outputs: { path: string; sha256: string; width: number; height: number; duration: number }[] = [];

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function pixelHash(file: string): Promise<string> {
  const pixels = await sharp(file).removeAlpha().raw().toBuffer();
  return createHash('sha256').update(pixels).digest('hex');
}

function decodeFrame(video: string, frame: number, fps: number, output: string): void {
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-i', video, '-ss', (frame / fps).toFixed(6), '-frames:v', '1', output,
  ], { windowsHide: true, stdio: 'pipe' });
}

function probe(file: string): { width: number; height: number; duration: number } {
  const value = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file,
  ], { encoding: 'utf8', windowsHide: true }));
  return { width: value.streams[0].width, height: value.streams[0].height, duration: Number(value.format.duration) };
}

function probeAudio(file: string): { codec: string; duration: number } {
  const value = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,duration', '-of', 'json', file,
  ], { encoding: 'utf8', windowsHide: true }));
  const stream = value.streams[0];
  assert.ok(stream, `${file} has a decodable audio stream`);
  return { codec: stream.codec_name, duration: Number(stream.duration) };
}

function decodeAudio(file: string): Buffer {
  return execFileSync('ffmpeg', [
    '-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', '1', '-ar', '22050', 'pipe:1',
  ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}

function windowRms(audio: Buffer, startSeconds: number, durationSeconds: number): number {
  const first = Math.floor(startSeconds * 22050);
  const count = Math.floor(durationSeconds * 22050);
  let sum = 0;
  for (let i = first; i < first + count; i += 1) {
    const value = audio.readFloatLE(i * 4);
    sum += value * value;
  }
  return Math.sqrt(sum / count);
}

function rmsDifference(left: Buffer, right: Buffer, startSeconds: number, durationSeconds: number): number {
  const count = Math.floor(durationSeconds * 22050);
  const first = Math.floor(startSeconds * 22050);
  assert.ok(left.length >= (first + count) * 4 && right.length >= (first + count) * 4, 'decoded audio covers analysis window');
  let sum = 0;
  for (let i = first; i < first + count; i += 1) {
    const difference = left.readFloatLE(i * 4) - right.readFloatLE(i * 4);
    sum += difference * difference;
  }
  return Math.sqrt(sum / count);
}

function peakLevel(audio: Buffer): number {
  let peak = 0;
  for (let offset = 0; offset + 4 <= audio.length; offset += 4) peak = Math.max(peak, Math.abs(audio.readFloatLE(offset)));
  return peak;
}

async function makeContactSheet(files: string[], output: string, labels: string[]): Promise<void> {
  const tileWidth = 480;
  const tileHeight = 300;
  const header = 42;
  const rows = Math.ceil(files.length / 2);
  const layers: { input: Buffer; left: number; top: number }[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const tile = await sharp(files[index]).resize({ width: tileWidth, height: tileHeight - header, fit: 'contain', background: '#111827' }).png().toBuffer();
    const label = Buffer.from(`<svg width="${tileWidth}" height="${header}"><rect width="100%" height="100%" fill="#0b1020"/><text x="14" y="28" font-size="18" font-family="Arial, sans-serif" fill="#f3f7ff">${labels[index]!.replace(/[&<>]/g, '')}</text></svg>`);
    const left = (index % 2) * tileWidth;
    const top = Math.floor(index / 2) * tileHeight;
    layers.push({ input: label, left, top }, { input: tile, left, top: top + header });
  }
  await sharp({ create: { width: tileWidth * 2, height: rows * tileHeight, channels: 4, background: '#111827' } }).composite(layers).png().toFile(output);
}

function expectedSize(aspectRatio: '16:9' | '9:16') {
  return aspectRatio === '16:9' ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
}

function styleBoard(aspectRatio: '16:9' | '9:16', stylePack: typeof stylePacks[number]): Storyboard {
  const sharedBrand = {
    name: 'V1.9 Offline Style Brand',
    baseStyleId: 'minimal-tech',
    colors: { bg: '#102033', fg: '#f4f7fb', muted: '#99adc1', accent: '#e66b5b', card: '#1b3048', secondary: '#bd9960' },
    typography: { headingFont: 'Arial', bodyFont: 'Arial' },
    logo: { src: 'brand-logo.png', position: 'bottom-right', width: 150, opacity: 1, margin: 36 },
  };
  return StoryboardSchema.parse({
    title: 'V1.9.0 三套风格固定图表', aspectRatio, styleId: 'minimal-tech', stylePack,
    brandKitId: 'v190-offline-style-brand', brand: sharedBrand,
    transition: 'none', subtitles: { enabled: true, position: 'bottom' },
    scenes: [{
      id: 'v190-style-fixed-chart', type: 'chart', title: '季度活跃用户', narration: '四个季度的数据依次上升。', duration: 3,
      visual: { data: [{ id: 'q1', label: '第一季度', value: 120 }, { id: 'q2', label: '第二季度', value: 150 }, { id: 'q3', label: '第三季度', value: 180 }, { id: 'q4', label: '第四季度', value: 210 }] },
      visualPlan: { templateId: 'chart', narrativeIntent: 'data-story', keyFocus: '活跃用户增长', provenance: 'user', manualOverride: true },
    }],
  });
}

function templateStyleBoard(aspectRatio: '16:9' | '9:16', templateId: VisualTemplateId, stylePack?: typeof stylePacks[number]): Storyboard {
  const definitions: Record<VisualTemplateId, { type: string; visual: Record<string, unknown>; narration: string }> = {
    hero: { type: 'title', visual: { text: '本地计算让请求延迟降低 28%。' }, narration: '本地计算让请求延迟降低百分之二十八。' },
    comparison: { type: 'comparison', visual: { columns: [{ title: '同步', items: ['调用等待结果返回'] }, { title: '异步', items: ['调用方可以继续执行'] }] }, narration: '同步等待结果，异步允许继续执行。' },
    diagram: { type: 'diagram', visual: { nodes: [{ id: 'source', label: '接收请求' }, { id: 'validate', label: '校验参数' }, { id: 'response', label: '返回结果' }] }, narration: '请求先进入系统，再经过校验，最后返回结果。' },
    timeline: { type: 'timeline', visual: { items: [{ date: '第一步', label: '接收请求' }, { date: '第二步', label: '读取数据' }, { date: '第三步', label: '返回结果' }] }, narration: '处理过程依次接收请求、读取数据并返回结果。' },
    chart: { type: 'chart', visual: { data: [{ id: 'q1', label: '第一季度', value: 120 }, { id: 'q2', label: '第二季度', value: 160 }, { id: 'q3', label: '第三季度', value: 210 }] }, narration: '三个季度的活跃用户持续增长。' },
  };
  const definition = definitions[templateId];
  const sharedBrand = {
    name: 'V1.9 Offline Style Brand', baseStyleId: 'minimal-tech',
    colors: { bg: '#102033', fg: '#f4f7fb', muted: '#99adc1', accent: '#e66b5b', card: '#1b3048', secondary: '#bd9960' },
    typography: { headingFont: 'Arial', bodyFont: 'Arial' },
    logo: { src: 'brand-logo.png', position: 'bottom-right', width: 150, opacity: 1, margin: 36 },
  };
  return StoryboardSchema.parse({
    title: `V1.9.0 ${templateId} style matrix`, aspectRatio, styleId: 'minimal-tech', ...(stylePack ? { stylePack } : {}),
    brandKitId: 'v190-offline-style-brand', brand: sharedBrand, transition: 'none',
    subtitles: { enabled: true, position: 'bottom' },
    scenes: [{
      id: `v190-style-matrix-${templateId}`, type: definition.type, title: '固定内容：请求处理与季度指标', narration: definition.narration,
      duration: 3, subtitleCues: [{ text: '本地固定字幕：请求处理与季度指标。', start: 0, end: 3 }], visual: definition.visual,
      visualPlan: { templateId, narrativeIntent: templateId === 'hero' ? 'hook' : templateId === 'comparison' ? 'comparison' : templateId === 'diagram' ? 'flow' : templateId === 'timeline' ? 'timeline' : 'data-story', keyFocus: '请求处理与数据变化', provenance: 'user', manualOverride: true },
    }],
  });
}

type QaCapture = { frame: number; width: number; height: number; backgrounds: string[]; layout: { sceneId: string; targetId?: string; elementType: 'text' | 'subtitle' | 'logo' | 'visual'; bounds: { x: number; y: number; width: number; height: number }; fontSizePx?: number; overflow?: boolean }[] };

async function renderStillWithQa(serveUrl: string, storyboard: Storyboard, output: string, frame = 36): Promise<QaCapture> {
  const inputProps = { storyboard, visualQaCapture: true };
  const composition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps, browserExecutable });
  let capture: QaCapture | undefined;
  await renderStill({
    composition, serveUrl, inputProps, browserExecutable, output, frame, scale: 1,
    onBrowserLog: log => {
      const marker = '__M2V_VISUAL_QA__';
      const index = log.text.indexOf(marker);
      if (index < 0) return;
      try { capture = JSON.parse(log.text.slice(index + marker.length)) as QaCapture; } catch { /* A malformed browser marker fails below. */ }
    },
  });
  assert.ok(capture && capture.layout.length > 0, `browser layout capture was received for ${output}`);
  assert.deepEqual({ width: capture.width, height: capture.height }, expectedSize(storyboard.aspectRatio));
  return capture;
}

async function assertLogoVisible(file: string, aspectRatio: '16:9' | '9:16'): Promise<void> {
  const width = aspectRatio === '16:9' ? 1920 : 1080;
  const height = aspectRatio === '16:9' ? 1080 : 1920;
  const crop = await sharp(file).extract({ left: width - 250, top: height - 500, width: 240, height: 400 }).removeAlpha().raw().toBuffer();
  let accentPixels = 0;
  for (let index = 0; index < crop.length; index += 3) if (crop[index]! < 100 && crop[index + 1]! > 150 && crop[index + 2]! < 240) accentPixels += 1;
  assert.ok(accentPixels > 100, `${aspectRatio} Brand Kit logo pixels are visible in ${file}`);
}

async function renderStyleTemplateMatrix(serveUrl: string, aspectRatio: '16:9' | '9:16') {
  const matrixFiles: string[] = [];
  const labels: string[] = [];
  const baseStyleFiles: string[] = [];
  const capturesByTemplate = new Map<VisualTemplateId, Map<string, QaCapture>>();
  let cases = 0;
  for (const templateId of visualTemplates) {
    const packHashes = new Set<string>();
    const templateCaptures = new Map<string, QaCapture>();
    for (const stylePack of stylePacks) {
      const storyboard = templateStyleBoard(aspectRatio, templateId, stylePack);
      const output = join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_style-matrix_${templateId}_${stylePack}.png`);
      const capture = await renderStillWithQa(serveUrl, storyboard, output);
      templateCaptures.set(stylePack, capture);
      await assertLogoVisible(output, aspectRatio);
      const sceneId = storyboard.scenes[0]!.id;
      const sceneSamples = capture.layout.filter(sample => sample.sceneId === sceneId);
      const logo = sceneSamples.find(sample => sample.elementType === 'logo');
      const subtitle = sceneSamples.find(sample => sample.elementType === 'subtitle');
      const heading = sceneSamples.find(sample => sample.targetId === 'scene-title');
      assert.ok(logo && logo.bounds.x >= .05 - safeAreaEpsilon && logo.bounds.y >= .05 - safeAreaEpsilon && logo.bounds.x + logo.bounds.width <= .95 + safeAreaEpsilon && logo.bounds.y + logo.bounds.height <= .95 + safeAreaEpsilon, `${templateId}/${stylePack} logo stays inside 5% safe area (float epsilon ${safeAreaEpsilon})`);
      assert.ok(subtitle && subtitle.bounds.x >= .05 - safeAreaEpsilon && subtitle.bounds.y >= .05 - safeAreaEpsilon && subtitle.bounds.x + subtitle.bounds.width <= .95 + safeAreaEpsilon && subtitle.bounds.y + subtitle.bounds.height <= .95 + safeAreaEpsilon, `${templateId}/${stylePack} subtitle stays inside 5% safe area (float epsilon ${safeAreaEpsilon})`);
      assert.ok(heading?.fontSizePx && heading.fontSizePx >= (aspectRatio === '9:16' ? 20 : 18), `${templateId}/${stylePack} title has readable measured size`);
      assert.ok(!logo || !subtitle || (Math.max(0, Math.min(logo.bounds.x + logo.bounds.width, subtitle.bounds.x + subtitle.bounds.width) - Math.max(logo.bounds.x, subtitle.bounds.x)) * Math.max(0, Math.min(logo.bounds.y + logo.bounds.height, subtitle.bounds.y + subtitle.bounds.height) - Math.max(logo.bounds.y, subtitle.bounds.y))) < .08 * Math.min(logo.bounds.width * logo.bounds.height, subtitle.bounds.width * subtitle.bounds.height), `${templateId}/${stylePack} logo does not collide with subtitles`);
      assert.ok(capture.backgrounds.includes('#102033'), `${templateId}/${stylePack} retains Brand Kit background color`);
      const hash = sha256(output);
      assert.ok(!packHashes.has(hash), `${templateId}/${stylePack} renders distinct pixels`);
      packHashes.add(hash);
      matrixFiles.push(output);
      labels.push(`${templateId} / ${stylePack}`);
      cases += 1;
    }
    capturesByTemplate.set(templateId, templateCaptures);

    const base = templateStyleBoard(aspectRatio, templateId);
    const baseOutput = join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_style-base_${templateId}.png`);
    const baseCapture = await renderStillWithQa(serveUrl, base, baseOutput);
    assert.ok(baseCapture.layout.some(sample => sample.sceneId === base.scenes[0]!.id && sample.targetId === 'scene-title'), `${templateId} still renders with the existing base Style`);
    await assertLogoVisible(baseOutput, aspectRatio);
    baseStyleFiles.push(baseOutput);
  }
  for (const templateId of visualTemplates) {
    const byPack = capturesByTemplate.get(templateId)!;
    const fingerprints = stylePacks.map(stylePack => {
      const capture = byPack.get(stylePack)!;
      return new Map(capture.layout
        .filter(sample => sample.sceneId === `v190-style-matrix-${templateId}` && sample.targetId && sample.elementType !== 'logo' && sample.elementType !== 'subtitle')
        .map(sample => [sample.targetId!, { bounds: sample.bounds, fontSizePx: sample.fontSizePx }]));
    });
    let hasStructuralDifference = false;
    for (let left = 0; left < fingerprints.length; left += 1) for (let right = left + 1; right < fingerprints.length; right += 1) {
      const a = fingerprints[left]!;
      const b = fingerprints[right]!;
      for (const [targetId, aSample] of a) {
        const bSample = b.get(targetId);
        if (!bSample) continue;
        const geometry = ['x', 'y', 'width', 'height'] as const;
        if (geometry.some(key => Math.abs(aSample.bounds[key] - bSample.bounds[key]) > .01)
          || (aSample.fontSizePx !== undefined && bSample.fontSizePx !== undefined && Math.abs(aSample.fontSizePx - bSample.fontSizePx) > 2)) {
          hasStructuralDifference = true;
        }
      }
    }
    assert.ok(hasStructuralDifference, `${templateId} style packs change measured target geometry or typography under the same Brand Kit, not only colors`);
  }
  await makeContactSheet(matrixFiles, join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_style-template-matrix.png`), labels);
  await makeContactSheet(baseStyleFiles, join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_style-base-templates.png`), [...visualTemplates.map(template => `${template} / base Style`)]);
  assert.equal(cases, visualTemplates.length * stylePacks.length, `${aspectRatio} five-template by three-style matrix is complete`);
  console.log(`${aspectRatio} style template matrix: ${cases} stills, ${baseStyleFiles.length} base Style stills, Brand Kit Logo/subtitle layout checks passed`);
}

function sfxBoard(aspectRatio: '16:9' | '9:16', mode: 'on' | 'off' | 'high-duck' | 'duck-control' | 'missing' | 'missing-control' | 'bgm-on' | 'bgm-muted'): Storyboard {
  const withVoiceAndMusic = mode === 'on' || mode === 'off' || mode === 'high-duck' || mode === 'duck-control' || mode === 'bgm-on' || mode === 'bgm-muted';
  const cues = mode === 'missing'
    ? [{ id: 'missing-cue', cueId: 'paper-tap', assetSrc: 'projects/v19/assets/missing-cue.wav', offsetSeconds: .8, license: { kind: 'custom', name: 'Missing local test fixture', attribution: 'Local test placeholder, not a distributed asset.' } }]
    : mode === 'on' || mode === 'high-duck' || mode === 'duck-control'
      ? cueIds.map((cueId, index) => ({ id: `cue-${cueId}`, cueId, offsetSeconds: cueStarts[index], durationSeconds: cueDurations[index], gain: .9 }))
      : [];
  return StoryboardSchema.parse({
    title: `V1.9.0 离线音效 ${mode}`, aspectRatio, styleId: 'minimal-tech', transition: 'none',
    ...(withVoiceAndMusic ? { bgmSrc: 'projects/v19/assets/music-880.wav', bgmVolume: .35, bgmFadeIn: 0, bgmFadeOut: 0 } : {}),
    ...(mode === 'bgm-muted' ? { bgmEnabled: false } : {}),
    soundEffects: {
      enabled: mode !== 'off' && mode !== 'missing-control', volume: mode === 'duck-control' ? 0 : .35,
      voiceDuck: mode === 'high-duck' ? .8 : .15, bgmDuck: .35, fadeIn: .01, fadeOut: .04,
    },
    subtitles: { enabled: false },
    scenes: [{
      id: 'v190-sfx-chart', type: 'chart', title: '本地音效混音', narration: '旁白音轨保持连续。', duration: 9,
      audioSrc: 'projects/v19/assets/voice-440.wav', audioDuration: 9,
      visual: { data: [{ label: '在线请求', value: 180 }, { label: '可用率', value: 99.9 }] },
      sfxCues: cues,
    }],
  });
}

async function renderOne(serveUrl: string, storyboard: Storyboard, output: string, scale = 1) {
  const inputProps = { storyboard };
  const composition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps, browserExecutable });
  const resultSize = expectedSize(storyboard.aspectRatio);
  assert.deepEqual({ width: composition.width, height: composition.height }, resultSize, `${storyboard.aspectRatio} composition`);
  await renderMedia({ composition, serveUrl, inputProps, browserExecutable, codec: 'h264', outputLocation: output, concurrency: 2, scale });
  const result = probe(output);
  assert.deepEqual({ width: result.width, height: result.height }, resultSize, `${output} dimensions`);
  outputs.push({ path: output, sha256: sha256(output), ...result });
  return result;
}

async function renderStylePacks(serveUrl: string, aspectRatio: '16:9' | '9:16', tempDir: string) {
  const files: string[] = [];
  const hashes = new Set<string>();
  for (const stylePack of stylePacks) {
    const storyboard = styleBoard(aspectRatio, stylePack);
    const inputProps = { storyboard };
    const composition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps, browserExecutable });
    const still = join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_style-pack_${stylePack}.png`);
    await renderStill({ composition, serveUrl, inputProps, browserExecutable, output: still, frame: 36, scale: 1 });
    const duplicate = join(tempDir, `${aspectRatio.replace(':', '-')}-${stylePack}-repeat.png`);
    await renderStill({ composition, serveUrl, inputProps, browserExecutable, output: duplicate, frame: 36, scale: 1 });
    assert.equal(await pixelHash(duplicate), await pixelHash(still), `${stylePack}/${aspectRatio} offline repeat still export is pixel-identical`);
    const stillHash = sha256(still);
    assert.ok(!hashes.has(stillHash), `${stylePack} has visually distinct rendered pixels`);
    hashes.add(stillHash);
    files.push(still);
    const output = join(media, `V1.9.0_${aspectRatio.replace(':', '-')}_style-pack_${stylePack}.mp4`);
    const result = await renderOne(serveUrl, storyboard, output);
    assert.ok(Math.abs(result.duration - 3) < .3, `${stylePack} duration ${result.duration}`);
    if (stylePack === 'clean-data') {
      const repeatOutput = join(tempDir, `${aspectRatio.replace(':', '-')}-${stylePack}-repeat.mp4`);
      await renderMedia({ composition, serveUrl, inputProps, browserExecutable, codec: 'h264', outputLocation: repeatOutput, concurrency: 2 });
      const firstFrame = join(tempDir, `${aspectRatio.replace(':', '-')}-${stylePack}-first-frame.png`);
      const repeatFrame = join(tempDir, `${aspectRatio.replace(':', '-')}-${stylePack}-repeat-frame.png`);
      decodeFrame(output, 36, composition.fps, firstFrame);
      decodeFrame(repeatOutput, 36, composition.fps, repeatFrame);
      assert.equal(await pixelHash(firstFrame), await pixelHash(repeatFrame), `${stylePack}/${aspectRatio} independently re-exported H.264 frame is pixel-identical`);
    }
  }
  await makeContactSheet(files, join(screenshots, `v1.9.0_${aspectRatio.replace(':', '-')}_style-pack_contact.png`), [...stylePacks]);
}

async function renderSfx(serveUrl: string, aspectRatio: '16:9' | '9:16') {
  const outputsForMode: Record<string, string> = {};
  for (const mode of ['on', 'off', 'high-duck', 'duck-control', 'missing', 'missing-control', 'bgm-on', 'bgm-muted'] as const) {
    const output = join(media, `V1.9.0_${aspectRatio.replace(':', '-')}_sfx-${mode}.mp4`);
    const storyboard = sfxBoard(aspectRatio, mode);
    await renderOne(serveUrl, storyboard, output);
    const audio = probeAudio(output);
    assert.equal(audio.codec, 'aac');
    assert.ok(Math.abs(audio.duration - 9) < .3, `${mode} audio duration ${audio.duration}`);
    outputsForMode[mode] = output;
  }

  const missingBoard = sfxBoard(aspectRatio, 'missing');
  const missingPath = missingBoard.scenes[0]!.sfxCues![0]!.assetSrc!;
  const missingIssue = preflight(missingBoard, [], { exists: path => path !== missingPath }).issues.find(issue => issue.assetPath === missingPath);
  assert.ok(missingIssue, 'server filesystem validation reports the missing cue before render');
  assert.equal(missingIssue.severity, 'warning');
  assert.equal(missingIssue.assetKind, 'audio');
  assert.match(missingIssue.message, /静音跳过/);

  const active = decodeAudio(outputsForMode.on!);
  const off = decodeAudio(outputsForMode.off!);
  const highDuck = decodeAudio(outputsForMode['high-duck']!);
  const duckControl = decodeAudio(outputsForMode['duck-control']!);
  const missing = decodeAudio(outputsForMode.missing!);
  const missingControl = decodeAudio(outputsForMode['missing-control']!);
  const bgmOn = decodeAudio(outputsForMode['bgm-on']!);
  const bgmMuted = decodeAudio(outputsForMode['bgm-muted']!);
  const perCue: { cueId: string; rmsDifference: number; highDuckDifference: number }[] = [];
  for (let index = 0; index < cueIds.length; index += 1) {
    const start = cueStarts[index]! + Math.min(.04, cueDurations[index]! / 3);
    const duration = Math.max(.06, Math.min(.18, cueDurations[index]! - .08));
    const onOffDifference = rmsDifference(active, off, start, duration);
    const difference = rmsDifference(active, duckControl, start, duration);
    const duckedDifference = rmsDifference(highDuck, duckControl, start, duration);
    assert.ok(onOffDifference > .002, `${cueIds[index]} contributes audible signal against SFX-off output (${onOffDifference.toFixed(5)})`);
    assert.ok(difference > .002, `${cueIds[index]} is audible in its MP4 cue window (difference=${difference.toFixed(5)})`);
    assert.ok(duckedDifference < difference * .75, `${cueIds[index]} respects stronger voice-ducking (${duckedDifference.toFixed(5)} < ${difference.toFixed(5)})`);
    perCue.push({ cueId: cueIds[index]!, rmsDifference: difference, highDuckDifference: duckedDifference });
  }
  const missingDifference = rmsDifference(missing, missingControl, .5, 1);
  assert.ok(missingDifference < .0005, `missing local cue adds no audible signal (${missingDifference.toFixed(6)})`);
  const bgmDifference = rmsDifference(bgmOn, bgmMuted, .5, 1);
  assert.ok(bgmDifference > .01, `bgmEnabled=false removes the player BGM while preserving the voice track (${bgmDifference.toFixed(6)})`);
  assert.ok(windowRms(bgmMuted, .5, 1) > .01, 'voice remains audible when BGM is muted');
  const peak = peakLevel(active);
  assert.ok(peak > .05 && peak < .98, `mixed SFX output remains audible without clipping (peak=${peak.toFixed(4)})`);
  console.log(`${aspectRatio} SFX cue RMS differences against volume-zero duck control: ${JSON.stringify(perCue)}`);
  console.log(`${aspectRatio} missing-cue RMS difference ${missingDifference.toFixed(6)}, mix peak ${peak.toFixed(4)}`);
  console.log(`${aspectRatio} BGM enabled/muted RMS difference ${bgmDifference.toFixed(6)}; muted mix RMS ${windowRms(bgmMuted, .5, 1).toFixed(6)}`);
}

async function main() {
  await mkdir(screenshots, { recursive: true });
  await mkdir(media, { recursive: true });
  const repoTmp = await mkdtemp(join(resolve(repo, 'data'), 'test-render-v19-style-sfx-'));
  try {
    const publicDir = join(repoTmp, 'public');
    const projectAssets = join(publicDir, 'projects', 'v19', 'assets');
    const sfxDir = join(publicDir, 'audio', 'sfx');
    await mkdir(projectAssets, { recursive: true });
    await mkdir(sfxDir, { recursive: true });
    await sharp(Buffer.from('<svg width="240" height="80" xmlns="http://www.w3.org/2000/svg"><rect width="240" height="80" rx="16" fill="#10253a"/><path d="M18 40h30M33 25v30" stroke="#2dd4bf" stroke-width="8" stroke-linecap="round"/><text x="62" y="51" font-size="28" font-family="Arial,sans-serif" font-weight="700" fill="#f3f7ff">M2V STUDIO</text></svg>')).png().toFile(join(publicDir, 'brand-logo.png'));
    for (const cueId of cueIds) await copyFile(resolve(repo, 'apps', 'web', 'public', 'audio', 'sfx', `${cueId}.wav`), join(sfxDir, `${cueId}.wav`));
    const makeTone = async (file: string, frequency: number, duration: number) => {
      const sampleRate = 22050;
      const count = Math.round(sampleRate * duration);
      const byteLength = count * 2;
      const wav = Buffer.alloc(44 + byteLength);
      wav.write('RIFF', 0); wav.writeUInt32LE(36 + byteLength, 4); wav.write('WAVE', 8);
      wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
      wav.write('data', 36); wav.writeUInt32LE(byteLength, 40);
      for (let index = 0; index < count; index += 1) wav.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * frequency * index / sampleRate)), 44 + index * 2);
      await writeFile(file, wav);
    };
    const voiceFixturePath = join(projectAssets, 'voice-440.wav');
    const realVoiceFile = process.env.V19_TEST_VOICE_FILE?.trim();
    if (realVoiceFile) {
      const resolvedVoiceFile = resolve(realVoiceFile);
      if (!existsSync(resolvedVoiceFile)) throw new Error(`V19_TEST_VOICE_FILE does not exist: ${resolvedVoiceFile}`);
      await copyFile(resolvedVoiceFile, voiceFixturePath);
    } else {
      await makeTone(voiceFixturePath, 440, 9);
    }
    await makeTone(join(projectAssets, 'music-880.wav'), 880, 3);
    const serveUrl = await bundle({ entryPoint: resolve(repo, 'apps', 'worker', 'src', 'entry.tsx'), publicDir, outDir: join(repoTmp, 'bundle') });
    const speechMixOnly = Boolean(process.env.V19_TEST_VOICE_FILE?.trim());
    for (const aspectRatio of ['16:9', '9:16'] as const) {
      if (!speechMixOnly) {
        await renderStylePacks(serveUrl, aspectRatio, repoTmp);
        await renderStyleTemplateMatrix(serveUrl, aspectRatio);
      }
      await renderSfx(serveUrl, aspectRatio);
    }
    console.log('V1.9.0 style-pack and SFX MP4 outputs:');
    for (const output of outputs) console.log(`${output.path}\n  SHA-256 ${output.sha256}\n  ${output.width}x${output.height}, ${output.duration.toFixed(2)}s`);
  } finally {
    await rm(repoTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
