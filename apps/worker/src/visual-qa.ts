import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { renderStill, type RenderStillOptions } from '@remotion/renderer';
import {
  VisualQaRenderEvidenceSchema,
  captionDuration,
  resolveCaptionCues,
  resolveVisualBeatTimeline,
  sceneTransitionWindows,
  timelineFrames,
  visualQualityAudit,
  type Storyboard,
  type VisualQaRenderEvidence,
} from '@m2v/schema';

const execFileAsync = promisify(execFile);
const captureMarker = '__M2V_VISUAL_QA__';
const frameName = (frame: number) => 'frame-' + String(frame).padStart(6, '0') + '.png';
const clampFrame = (frame: number, totalFrames: number) => Math.max(0, Math.min(totalFrames - 1, Math.round(frame)));

type CaptureLayout = VisualQaRenderEvidence['layout'][number];
type CapturePayload = { frame: number; width: number; height: number; backgrounds: string[]; layout: CaptureLayout[] };
type FramePlanEntry = {
  frame: number;
  sceneId: string;
  roles: string[];
  preflight: boolean;
  afterRender: boolean;
  fromSceneId?: string;
  toSceneId?: string;
  transition?: string;
};
type TransitionPlan = { fromSceneId: string; toSceneId: string; startFrame: number; frames: number; transition: string };
type VisualQaPlan = { entries: FramePlanEntry[]; transitions: TransitionPlan[] };

/** Force Chromium's software GL backend for reproducible CPU-only QA runs. */
export function visualQaChromiumOptions(cpuOnly = process.env.M2V_VISUAL_QA_CPU_ONLY === '1') {
  return cpuOnly ? { gl: 'swiftshader' as const } : undefined;
}

function makeFramePlan(board: Storyboard, fps: number): VisualQaPlan {
  const { segments, totalFrames } = timelineFrames(board, fps);
  const sceneSegments = segments.filter(segment => segment.kind === 'scene');
  const entries = new Map<number, FramePlanEntry>();
  const add = (rawFrame: number, role: string, options: {
    preflight?: boolean;
    fromSceneId?: string;
    toSceneId?: string;
    transition?: string;
  } = {}) => {
    const frame = clampFrame(rawFrame, totalFrames);
    if (totalFrames < 1) return;
    const current = entries.get(frame);
    const sceneSegment = sceneSegments.find(segment => frame >= segment.startFrame && frame < segment.startFrame + segment.frames);
    const sceneId = current?.sceneId ?? (sceneSegment ? board.scenes[sceneSegment.index]?.id : undefined) ?? options.toSceneId ?? options.fromSceneId ?? 'unknown';
    entries.set(frame, {
      frame,
      sceneId,
      roles: [...new Set([...(current?.roles ?? []), role])],
      preflight: Boolean(current?.preflight || options.preflight !== false),
      afterRender: true,
      ...(options.fromSceneId ?? current?.fromSceneId ? { fromSceneId: options.fromSceneId ?? current?.fromSceneId } : {}),
      ...(options.toSceneId ?? current?.toSceneId ? { toSceneId: options.toSceneId ?? current?.toSceneId } : {}),
      ...(options.transition ?? current?.transition ? { transition: options.transition ?? current?.transition } : {}),
    });
  };

  for (let index = 0; index < sceneSegments.length; index += 1) {
    const segment = sceneSegments[index]!;
    const scene = board.scenes[segment.index];
    if (!scene || segment.frames < 1) continue;
    const start = segment.startFrame;
    const end = start + segment.frames - 1;
    add(start, 'scene');
    add(start + 1, 'scene');
    add(Math.floor((start + end) / 2), 'scene');
    add(end - 1, 'scene');
    add(end, 'scene');
    for (const beat of resolveVisualBeatTimeline(scene, fps)) {
      add(start + beat.startFrame, 'beat');
      add(start + beat.endFrame - 1, 'beat');
    }
    if (index > 0) {
      const previous = board.scenes[sceneSegments[index - 1]!.index];
      if (previous) {
        add(start - 1, 'boundary', { fromSceneId: previous.id, toSceneId: scene.id, transition: board.transition ?? 'none' });
        add(start, 'boundary', { fromSceneId: previous.id, toSceneId: scene.id, transition: board.transition ?? 'none' });
        add(start + 1, 'boundary', { fromSceneId: previous.id, toSceneId: scene.id, transition: board.transition ?? 'none' });
      }
    }
  }

  const transitions = sceneTransitionWindows(board, fps).flatMap(window => {
    const fromScene = board.scenes[window.fromIndex];
    const toScene = board.scenes[window.toIndex];
    if (!fromScene || !toScene) return [];
    const transition: TransitionPlan = { fromSceneId: fromScene.id, toSceneId: toScene.id, startFrame: window.startFrame, frames: window.frames, transition: window.transition };
    const lastFrame = window.startFrame + window.frames - 1;
    add(window.startFrame - 1, 'transition-boundary', { fromSceneId: fromScene.id, toSceneId: toScene.id, transition: window.transition });
    add(window.startFrame, 'transition', { fromSceneId: fromScene.id, toSceneId: toScene.id, transition: window.transition });
    add(Math.floor((window.startFrame + lastFrame) / 2), 'transition', { fromSceneId: fromScene.id, toSceneId: toScene.id, transition: window.transition });
    add(lastFrame, 'transition', { fromSceneId: fromScene.id, toSceneId: toScene.id, transition: window.transition });
    const middleFrame = Math.floor((window.startFrame + lastFrame) / 2);
    add(middleFrame - 1, 'transition-sample-previous', { fromSceneId: fromScene.id, toSceneId: toScene.id, transition: window.transition });
    add(lastFrame - 1, 'transition-sample-previous', { fromSceneId: fromScene.id, toSceneId: toScene.id, transition: window.transition });
    return [transition];
  });

  return { entries: [...entries.values()].sort((a, b) => a.frame - b.frame), transitions };
}

function parseCapturePayload(text: string): CapturePayload | null {
  const offset = text.indexOf(captureMarker);
  if (offset < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(offset + captureMarker.length)) as Record<string, unknown>;
    if (!Number.isInteger(parsed.frame) || !Array.isArray(parsed.layout)) return null;
    return {
      frame: Number(parsed.frame),
      width: Number(parsed.width) || 0,
      height: Number(parsed.height) || 0,
      backgrounds: Array.isArray(parsed.backgrounds) ? parsed.backgrounds.filter((color): color is string => typeof color === 'string') : [],
      layout: parsed.layout as CaptureLayout[],
    };
  } catch {
    return null;
  }
}

function relativeReportPath(path: string) {
  return path.replace(/\\/g, '/');
}

export async function captureVisualQaPreflight(input: {
  board: Storyboard;
  fps: number;
  composition: RenderStillOptions['composition'];
  serveUrl: string;
  browser: NonNullable<RenderStillOptions['puppeteerInstance']>;
  browserExecutable?: RenderStillOptions['browserExecutable'];
  artifactDir: string;
  audioWarnings?: string[];
  log: (message: string, details?: Record<string, unknown>) => Promise<void>;
}) {
  const plan = makeFramePlan(input.board, input.fps);
  const preflightDir = join(input.artifactDir, 'preflight');
  await mkdir(preflightDir, { recursive: true });
  const captures = new Map<number, CapturePayload>();
  const warnings: string[] = [];
  for (const entry of plan.entries.filter(item => item.preflight)) {
    const output = join(preflightDir, frameName(entry.frame));
    try {
      await renderStill({
        composition: input.composition,
        serveUrl: input.serveUrl,
        output,
        frame: entry.frame,
        inputProps: { storyboard: input.board, visualQaCapture: true },
        imageFormat: 'png',
        overwrite: true,
        browserExecutable: input.browserExecutable,
        puppeteerInstance: input.browser,
        logLevel: 'error',
        onBrowserLog: log => {
          const payload = parseCapturePayload(log.text);
          if (payload) captures.set(entry.frame, payload);
        },
      });
      if (!captures.has(entry.frame)) warnings.push('No browser layout capture was received for frame ' + entry.frame);
    } catch (error) {
      const message = 'Visual QA preflight screenshot failed for frame ' + entry.frame + ': ' + String(error);
      warnings.push(message);
      await input.log(message);
    }
  }
  const layout = [...captures.values()].flatMap(capture => capture.layout.map(sample => ({
    ...sample,
    screenshotPath: relativeReportPath(join(preflightDir, frameName(capture.frame))),
  })));
  const evidence = VisualQaRenderEvidenceSchema.parse({ layout });
  const overflowSceneIds = [...new Set(evidence.layout.filter(item => item.overflow).map(item => item.sceneId))];
  const report = visualQualityAudit(input.board, { fps: input.fps, phase: 'preflight', renderEvidence: evidence, renderOverflowSceneIds: overflowSceneIds });
  await writeFile(join(input.artifactDir, 'preflight-report.json'), JSON.stringify({
    ...report,
    audioWarnings: input.audioWarnings ?? [],
    captureWarnings: warnings,
    sampleFrames: [...captures.keys()].sort((a, b) => a - b),
  }, null, 2), 'utf8');
  await input.log('视觉 QA 预检完成', { frames: captures.size, findings: report.findings.length, warnings: warnings.length });
  return { plan, captures, evidence, report, warnings, audioWarnings: input.audioWarnings ?? [], preflightDir };
}

type DecodedPng = { width: number; height: number; rgb: Uint8Array; meanLuminance: number; blackPixelRatio: number };

function paeth(left: number, up: number, upperLeft: number) {
  const predictor = left + up - upperLeft;
  const leftDistance = Math.abs(predictor - left);
  const upDistance = Math.abs(predictor - up);
  const upperLeftDistance = Math.abs(predictor - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance ? left : upDistance <= upperLeftDistance ? up : upperLeft;
}

function decodePng(data: Buffer): DecodedPng | null {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.length < 24 || !data.subarray(0, 8).equals(signature)) return null;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const chunks: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > data.length) return null;
    if (type === 'IHDR') {
      width = data.readUInt32BE(start);
      height = data.readUInt32BE(start + 4);
      bitDepth = data[start + 8]!;
      colorType = data[start + 9]!;
      interlace = data[start + 12]!;
    } else if (type === 'IDAT') chunks.push(data.subarray(start, end));
    else if (type === 'IEND') break;
    offset = end + 4;
  }
  const channelCount = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!width || !height || bitDepth !== 8 || !channelCount || interlace !== 0 || !chunks.length) return null;
  const stride = width * channelCount;
  const inflated = inflateSync(Buffer.concat(chunks));
  if (inflated.length < (stride + 1) * height) return null;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const source = y * (stride + 1);
    const target = y * stride;
    const filter = inflated[source]!;
    for (let x = 0; x < stride; x += 1) {
      const value = inflated[source + 1 + x]!;
      const left = x >= channelCount ? raw[target + x - channelCount]! : 0;
      const up = y > 0 ? raw[target + x - stride]! : 0;
      const upperLeft = y > 0 && x >= channelCount ? raw[target + x - stride - channelCount]! : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, upperLeft) : 0;
      raw[target + x] = (value + predictor) & 255;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  let luminanceTotal = 0;
  let blackPixels = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * channelCount;
    const target = pixel * 3;
    const red = raw[source]!;
    const green = colorType === 0 || colorType === 4 ? red : raw[source + 1]!;
    const blue = colorType === 0 || colorType === 4 ? red : raw[source + 2]!;
    rgb[target] = red;
    rgb[target + 1] = green;
    rgb[target + 2] = blue;
    luminanceTotal += (.2126 * red + .7152 * green + .0722 * blue) / 255;
    if (red < 5 && green < 5 && blue < 5) blackPixels += 1;
  }
  return { width, height, rgb, meanLuminance: luminanceTotal / (width * height), blackPixelRatio: blackPixels / (width * height) };
}

function colorFromCss(value: string): [number, number, number] | null {
  const match = value.match(/^#([0-9a-f]{6})$/i);
  if (!match) return null;
  return [parseInt(match[1]!.slice(0, 2), 16), parseInt(match[1]!.slice(2, 4), 16), parseInt(match[1]!.slice(4, 6), 16)];
}

function backgroundMatchRatio(image: DecodedPng, backgrounds: string[]) {
  const candidates = backgrounds.map(colorFromCss).filter((color): color is [number, number, number] => Boolean(color));
  if (!candidates.length) return undefined;
  let matched = 0;
  const pixelCount = image.width * image.height;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 3;
    const red = image.rgb[offset]!;
    const green = image.rgb[offset + 1]!;
    const blue = image.rgb[offset + 2]!;
    if (candidates.some(color => Math.abs(red - color[0]) <= 5 && Math.abs(green - color[1]) <= 5 && Math.abs(blue - color[2]) <= 5)) matched += 1;
  }
  return matched / pixelCount;
}

function unmatchedPixelRatio(previous: DecodedPng | undefined, current: DecodedPng | undefined) {
  if (!previous || !current || previous.width !== current.width || previous.height !== current.height) return 0;
  let changed = 0;
  let checked = 0;
  for (let pixel = 0; pixel < previous.width * previous.height; pixel += 9) {
    const offset = pixel * 3;
    if (Math.abs(previous.rgb[offset]! - current.rgb[offset]!) > 24
      || Math.abs(previous.rgb[offset + 1]! - current.rgb[offset + 1]!) > 24
      || Math.abs(previous.rgb[offset + 2]! - current.rgb[offset + 2]!) > 24) changed += 1;
    checked += 1;
  }
  return checked ? changed / checked : 0;
}

function sharedElementDetected(board: Storyboard, fromSceneId: string, toSceneId: string) {
  const from = board.scenes.find(scene => scene.id === fromSceneId);
  const to = board.scenes.find(scene => scene.id === toSceneId);
  if (!from || !to) return false;
  const fromFocus = from.visualPlan?.keyFocus?.trim().toLowerCase();
  const toFocus = to.visualPlan?.keyFocus?.trim().toLowerCase();
  if (fromFocus && toFocus && fromFocus === toFocus) return true;
  const fromIds = new Set(Object.values(from.visualPlan?.elementMap ?? {}));
  return Object.values(to.visualPlan?.elementMap ?? {}).some(id => fromIds.has(id));
}

function normalizeText(value: string) {
  return value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

export async function finalizeVisualQaAfterRender(input: {
  board: Storyboard;
  fps: number;
  finalVideo: string;
  artifactDir: string;
  plan: VisualQaPlan;
  captures: Map<number, CapturePayload>;
  preflightReport: ReturnType<typeof visualQualityAudit>;
  audioWarnings?: string[];
  warnings?: string[];
}) {
  const warnings = [...(input.warnings ?? [])];
  const afterDir = join(input.artifactDir, 'after');
  await mkdir(afterDir, { recursive: true });
  const framesToExtract = input.plan.entries.filter(entry => entry.afterRender).map(entry => entry.frame);
  const expression = framesToExtract.map(frame => 'eq(n\\,' + frame + ')').join('+');
  const extractionPattern = join(afterDir, 'extract-%06d.png');
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input.finalVideo,
    '-vf', 'select=' + expression, '-fps_mode', 'vfr', '-start_number', '0', extractionPattern,
  ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const frameStats = new Map<number, { meanLuminance: number; blackFrame: boolean; blankPixelRatio?: number; backgroundMatched?: boolean }>();
  const adjacentChanges = new Map<number, number>();
  const screenshotPaths = new Map<number, string>();
  let previousImage: DecodedPng | undefined;
  let previousFrame: number | undefined;
  for (let index = 0; index < framesToExtract.length; index += 1) {
    const frame = framesToExtract[index]!;
    const extracted = join(afterDir, 'extract-' + String(index).padStart(6, '0') + '.png');
    const target = join(afterDir, frameName(frame));
    await rename(extracted, target);
    screenshotPaths.set(frame, target);
    const image = decodePng(await readFile(target));
    if (!image) {
      previousImage = undefined;
      previousFrame = undefined;
      continue;
    }
    if (previousFrame !== undefined && previousImage && frame === previousFrame + 1) adjacentChanges.set(frame, unmatchedPixelRatio(previousImage, image));
    const blankPixelRatio = backgroundMatchRatio(image, input.captures.get(frame)?.backgrounds ?? []);
    frameStats.set(frame, {
      meanLuminance: image.meanLuminance,
      blackFrame: image.blackPixelRatio > .995,
      ...(blankPixelRatio === undefined ? {} : { blankPixelRatio, backgroundMatched: blankPixelRatio > .99 }),
    });
    previousImage = image;
    previousFrame = frame;
  }
  if (frameStats.size < framesToExtract.length) warnings.push('Some extracted MP4 frames could not be decoded as PNG evidence');

  const layout = [...input.captures.values()].flatMap(capture => capture.layout.map(sample => ({
    ...sample,
    screenshotPath: screenshotPaths.get(capture.frame) ?? join(input.artifactDir, 'preflight', frameName(capture.frame)),
  })));
  const frames = input.plan.entries.filter(entry => entry.afterRender).map(entry => {
    const metrics = frameStats.get(entry.frame);
    return {
      sceneId: entry.sceneId,
      frame: entry.frame,
      ...(screenshotPaths.has(entry.frame) ? { screenshotPath: screenshotPaths.get(entry.frame) } : {}),
      ...(metrics ?? {}),
    };
  });
  const transitionSamples: VisualQaRenderEvidence['transitions'] = [];
  for (const entry of input.plan.entries) {
    if (!entry.fromSceneId || !entry.toSceneId || (!entry.roles.includes('transition') && !entry.roles.includes('boundary'))) continue;
    const metrics = frameStats.get(entry.frame);
    transitionSamples.push({
      fromSceneId: entry.fromSceneId,
      toSceneId: entry.toSceneId,
      frame: entry.frame,
      ...(screenshotPaths.has(entry.frame) ? { screenshotPath: screenshotPaths.get(entry.frame) } : {}),
      unmatchedPixelRatio: adjacentChanges.get(entry.frame) ?? 0,
      ...(metrics ? { blackFrame: metrics.blackFrame } : {}),
      sharedElementDetected: sharedElementDetected(input.board, entry.fromSceneId, entry.toSceneId),
    });
  }

  const { segments } = timelineFrames(input.board, input.fps);
  const sceneSegments = segments.filter(segment => segment.kind === 'scene');
  const subtitleTiming: VisualQaRenderEvidence['subtitleTiming'] = [];
  for (const segment of sceneSegments) {
    const scene = input.board.scenes[segment.index];
    if (!scene) continue;
    const beats = resolveVisualBeatTimeline(scene, input.fps);
    if (!beats.length) continue;
    const cues = resolveCaptionCues(scene, captionDuration(scene), input.board.aspectRatio === '9:16');
    for (const cue of cues) {
      const cueText = normalizeText(cue.text);
      const beat = beats.find(item => {
        const beatText = normalizeText(item.narrationText);
        return beatText && cueText && (cueText.includes(beatText) || beatText.includes(cueText));
      });
      if (!beat) continue;
      const frame = segment.startFrame + Math.round(cue.start * input.fps);
      const nearest = [...screenshotPaths.keys()].sort((left, right) => Math.abs(left - frame) - Math.abs(right - frame))[0];
      subtitleTiming.push({
        sceneId: scene.id,
        beatId: beat.id,
        frame,
        ...(nearest !== undefined ? { screenshotPath: screenshotPaths.get(nearest) } : {}),
        beatStartFrame: segment.startFrame + beat.startFrame,
        beatEndFrame: segment.startFrame + beat.endFrame,
        subtitleStartFrame: segment.startFrame + Math.round(cue.start * input.fps),
        subtitleEndFrame: segment.startFrame + Math.round(cue.end * input.fps),
      });
    }
  }
  const evidence = VisualQaRenderEvidenceSchema.parse({ layout, frames, subtitleTiming, transitions: transitionSamples });
  const overflowSceneIds = [...new Set(evidence.layout.filter(sample => sample.overflow).map(sample => sample.sceneId))];
  const report = visualQualityAudit(input.board, { fps: input.fps, phase: 'post-render', renderEvidence: evidence, renderOverflowSceneIds: overflowSceneIds });
  const frameCards = input.plan.entries.filter(entry => entry.roles.some(role => role === 'scene' || role === 'beat' || role === 'boundary' || role === 'transition'));
  const uniqueFrameCards = [...new Map(frameCards.map(entry => [entry.frame, entry])).values()];
  const cardHtml = uniqueFrameCards.map(entry => {
    const title = entry.sceneId + ' · frame ' + entry.frame + (entry.transition ? ' · ' + entry.transition : '');
    return '<figure><img loading="lazy" src="after/' + frameName(entry.frame) + '" alt="' + title.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"><figcaption>' + title.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</figcaption></figure>';
  }).join('\n');
  await writeFile(join(input.artifactDir, 'contact-sheet.html'), '<!doctype html><meta charset="utf-8"><title>Visual QA contact sheet</title><style>body{font:14px system-ui;background:#111827;color:#e5e7eb;margin:20px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}figure{margin:0;background:#1f2937;padding:8px;border-radius:8px}img{width:100%;aspect-ratio:16/9;object-fit:contain;background:#030712}figcaption{padding:6px}</style><main>' + cardHtml + '</main>', 'utf8');
  const motionCards = input.plan.entries.filter(entry => entry.roles.includes('transition')).map(entry => {
    return '<figure><img loading="lazy" src="after/' + frameName(entry.frame) + '" alt="' + entry.transition + ' frame ' + entry.frame + '"><figcaption>' + entry.fromSceneId + ' → ' + entry.toSceneId + ' · ' + entry.transition + ' · ' + entry.frame + '</figcaption></figure>';
  }).join('\n');
  await writeFile(join(input.artifactDir, 'motion-strip.html'), '<!doctype html><meta charset="utf-8"><title>Visual QA motion strip</title><style>body{font:13px system-ui;background:#111827;color:#e5e7eb;margin:20px}main{display:flex;flex-wrap:wrap;gap:8px}figure{width:260px;margin:0;background:#1f2937;padding:6px}img{width:100%;aspect-ratio:16/9;object-fit:contain;background:#030712}figcaption{padding:4px}</style><main>' + motionCards + '</main>', 'utf8');
  const finalReport = {
    ...report,
    audioWarnings: input.audioWarnings ?? [],
    completed: warnings.length === 0,
    captureWarnings: warnings,
    preflight: input.preflightReport,
    evidence,
    artifacts: {
      contactSheet: join(input.artifactDir, 'contact-sheet.html'),
      motionStrip: join(input.artifactDir, 'motion-strip.html'),
      preflightReport: join(input.artifactDir, 'preflight-report.json'),
      evidenceFrames: evidence.frames.length,
      transitionFrames: evidence.transitions.length,
    },
  };
  await writeFile(join(input.artifactDir, 'report.json'), JSON.stringify(finalReport, null, 2), 'utf8');
  return { report, evidence, warnings, artifactDir: input.artifactDir };
}
