import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { bundle } from '@remotion/bundler';
import { openBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { visualQaChromiumOptions } from '../src/visual-qa';
import {
  StoryboardSchema,
  applyVisualDensity,
  estimateVisualDensity,
  getVisualBeatTimingDiagnostic,
  layoutMetrics,
  resolveVisualBeatTimeline,
  visualQualityAudit,
  type Scene,
  type Storyboard,
  type VisualTemplateId,
} from '@m2v/schema';
import { visualQualitySourceSamples } from '../../../packages/video/test/fixtures/v19-visual-quality';

const repo = process.cwd();
const screenshots = resolve(repo, 'docs', 'screenshots', 'v1.9.0', 'density-motion');
const media = resolve(repo, 'docs', 'outputs', 'V1.9.0');
const edgeBrowserExecutable = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const requestedBrowserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE?.trim();
const browserExecutable = requestedBrowserExecutable === 'bundled'
  ? undefined
  : requestedBrowserExecutable || (process.platform === 'win32' && existsSync(edgeBrowserExecutable) ? edgeBrowserExecutable : undefined);
const webRequire = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const sharp = webRequire('sharp') as (input: unknown) => any;
const fps = 30;
const templates: VisualTemplateId[] = ['hero', 'comparison', 'diagram', 'timeline', 'chart'];
const outputs: { path: string; sha256: string; width: number; height: number; duration: number }[] = [];

type Capture = {
  frame: number;
  width: number;
  height: number;
  backgrounds: string[];
  layout: {
    sceneId: string;
    beatId?: string;
    targetId?: string;
    frame: number;
    elementType: 'text' | 'subtitle' | 'logo' | 'visual';
    bounds: { x: number; y: number; width: number; height: number };
    fontSizePx?: number;
    textContent?: string;
    contrastRatio?: number;
    overflow?: boolean;
  }[];
};

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function pixelHash(file: string): Promise<string> {
  return sharp(file).removeAlpha().raw().toBuffer().then((pixels: Buffer) => createHash('sha256').update(pixels).digest('hex'));
}

async function pixelDifference(left: string, right: string): Promise<number> {
  const a = await sharp(left).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(right).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual(a.info, b.info, 'pixel comparisons use the same rendered frame dimensions');
  let total = 0;
  let samples = 0;
  for (let index = 0; index < a.data.length; index += 97) {
    total += Math.abs(a.data[index]! - b.data[index]!);
    samples += 1;
  }
  return samples ? total / samples : 0;
}

function probe(file: string): { width: number; height: number; duration: number } {
  const result = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file,
  ], { encoding: 'utf8', windowsHide: true }));
  return { width: result.streams[0].width, height: result.streams[0].height, duration: Number(result.format.duration) };
}

function dimensions(aspect: '16:9' | '9:16') {
  return aspect === '16:9' ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
}

function board(aspect: '16:9' | '9:16', scene: Scene, reducedMotion = false): Storyboard {
  return StoryboardSchema.parse({
    title: 'V1.9.0 density and motion render samples', aspectRatio: aspect, styleId: 'minimal-tech',
    transition: 'none', reducedMotion, subtitles: { enabled: true, position: 'bottom' }, scenes: [scene],
  });
}

async function renderCapture(input: {
  serveUrl: string;
  browser: Awaited<ReturnType<typeof openBrowser>>;
  storyboard: Storyboard;
  frame: number;
  output: string;
}): Promise<Capture> {
  const inputProps = { storyboard: input.storyboard, visualQaCapture: true };
  const composition = await selectComposition({ serveUrl: input.serveUrl, id: 'ExplainerVideo', inputProps, browserExecutable, puppeteerInstance: input.browser });
  let capture: Capture | undefined;
  await renderStill({
    composition, serveUrl: input.serveUrl, inputProps, browserExecutable, puppeteerInstance: input.browser,
    output: input.output, frame: input.frame, scale: 1, imageFormat: 'png', overwrite: true, logLevel: 'error',
    onBrowserLog: log => {
      const marker = '__M2V_VISUAL_QA__';
      const index = log.text.indexOf(marker);
      if (index < 0) return;
      try { capture = JSON.parse(log.text.slice(index + marker.length)) as Capture; } catch { /* Assert after the still is rendered. */ }
    },
  });
  assert.ok(capture && capture.layout.length, `browser DOM layout evidence exists for ${input.output}`);
  assert.deepEqual({ width: capture.width, height: capture.height }, dimensions(input.storyboard.aspectRatio));
  return capture;
}

async function makeContactSheet(files: string[], output: string, labels: string[]): Promise<void> {
  const tileWidth = 480;
  const tileHeight = 300;
  const header = 40;
  const columns = 2;
  const rows = Math.ceil(files.length / columns);
  const layers: { input: Buffer; left: number; top: number }[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const tile = await sharp(files[index]!).resize({ width: tileWidth, height: tileHeight - header, fit: 'contain', background: '#111827' }).png().toBuffer();
    const label = Buffer.from(`<svg width="${tileWidth}" height="${header}"><rect width="100%" height="100%" fill="#0b1020"/><text x="12" y="26" font-size="16" font-family="Arial, sans-serif" fill="#f3f7ff">${labels[index]!.replace(/[&<>]/g, '')}</text></svg>`);
    const left = (index % columns) * tileWidth;
    const top = Math.floor(index / columns) * tileHeight;
    layers.push({ input: label, left, top }, { input: tile, left, top: top + header });
  }
  await sharp({ create: { width: tileWidth * columns, height: rows * tileHeight, channels: 4, background: '#111827' } }).composite(layers).png().toFile(output);
}

async function renderDensitySamples(serveUrl: string, browser: Awaited<ReturnType<typeof openBrowser>>, aspect: '16:9' | '9:16') {
  const longFactText = visualQualitySourceSamples.longText.facts.join('\n\n');
  const stressText = Array.from({ length: 3 }, () => longFactText).join('\n\n');
  const longScene = StoryboardSchema.parse({
    title: 'V1.9 density source', aspectRatio: aspect, styleId: 'minimal-tech', transition: 'none',
    scenes: [{
      id: 'v190-long-text-stress', type: 'text', title: visualQualitySourceSamples.longText.title,
      narration: stressText, duration: 12, audioDuration: 12, visual: { text: stressText },
    }],
  }).scenes[0]!;
  const tableScene = StoryboardSchema.parse({
    title: 'V1.9 density source', aspectRatio: aspect, styleId: 'minimal-tech', transition: 'none',
    scenes: [{
      id: 'v190-twelve-row-table', type: 'table', title: visualQualitySourceSamples.longTable.title,
      narration: '下表记录十二个月的服务可用率与维护窗口。', duration: 12, audioDuration: 12,
      visual: { headers: [...visualQualitySourceSamples.longTable.headers], rows: visualQualitySourceSamples.longTable.rows.map(row => [...row]) },
    }],
  }).scenes[0]!;
  const listItems = visualQualitySourceSamples.nestedBullets.items.map(item => ({ text: item.text, children: [...item.children] }));
  const listScene = StoryboardSchema.parse({
    title: 'V1.9 density source', aspectRatio: aspect, styleId: 'minimal-tech', transition: 'none',
    scenes: [{
      id: 'v190-five-by-four-nested-list', type: 'bullets', title: visualQualitySourceSamples.nestedBullets.title,
      narration: listItems.map(item => item.text).join(''), duration: 12, audioDuration: 12, layout: 'auto',
      visual: { items: listItems },
    }],
  }).scenes[0]!;
  const flowNodes = visualQualitySourceSamples.flow.nodes.map(node => ({ ...node }));
  const flowScene = StoryboardSchema.parse({
    title: 'V1.9 density source', aspectRatio: aspect, styleId: 'minimal-tech', transition: 'none',
    scenes: [{
      id: 'v190-twelve-node-flow', type: 'diagram', title: visualQualitySourceSamples.flow.title,
      narration: flowNodes.map(node => `${node.label}。`).join(''), duration: 12, audioDuration: 12, layout: 'auto',
      visual: { nodes: flowNodes },
    }],
  }).scenes[0]!;
  const densityStressScenes = new Set([listScene.id, flowScene.id]);
  const samples: { file: string; label: string }[] = [];

  for (const source of [longScene, tableScene, listScene, flowScene]) {
    const density = estimateVisualDensity(source, aspect);
    assert.equal(density.overBudget, true, `${source.id} fixed stress fixture exceeds visual density budget in ${aspect}`);
    if (densityStressScenes.has(source.id)) {
      assert.equal(source.layout, 'auto', `${source.id} is explicitly a non-compact layout`);
      assert.equal(layoutMetrics(source, aspect === '9:16').density, 1, `${source.id} keeps the authored font scale when over budget`);
    }
    const repaired = applyVisualDensity(source, aspect, { autoSplit: true, strategy: 'balanced' });
    assert.ok((repaired.visualBeats?.length ?? 0) > 1, `${source.id} receives rule beats in ${aspect}`);
    assert.equal(repaired.narration, source.narration, `${source.id} narration is unchanged`);
    assert.deepEqual(repaired.visual, source.visual, `${source.id} visual facts and all table rows are unchanged`);
    if (source.id === 'v190-long-text-stress') {
      assert.equal((repaired.visualBeats ?? []).map(beat => beat.contentText ?? '').join(''), stressText, 'long-text visual beats reconstruct the exact source content');
      assert.equal((repaired.visualBeats ?? []).map(beat => beat.narrationText).join(''), stressText, 'long-text narration beats reconstruct the exact source narration');
    }
    if (source.id === listScene.id) {
      assert.deepEqual(repaired.visual.items, source.visual.items, 'all five parent items and twenty nested facts are retained');
      assert.deepEqual([...new Set(repaired.visualBeats?.flatMap(beat => beat.targetIds).filter(id => id.startsWith('bullet-')) ?? [])], Array.from({ length: 5 }, (_, index) => `bullet-${index + 1}`));
    }
    if (source.id === flowScene.id) {
      assert.deepEqual(repaired.visual.nodes, source.visual.nodes, 'all twelve ordered process nodes are retained');
      assert.deepEqual([...new Set(repaired.visualBeats?.flatMap(beat => beat.targetIds).filter(id => id.startsWith('flow-step-')) ?? [])], flowNodes.map(node => node.id));
    }
    if (densityStressScenes.has(source.id)) {
      const timing = getVisualBeatTimingDiagnostic(repaired);
      assert.equal(timing?.source, 'uniform-fallback', `${source.id} has no real TTS/caption timing fixture`);
      assert.equal(timing?.minimumDwellSeconds, 1.25);
      assert.ok(timing!.effectiveDurationSeconds >= repaired.visualBeats!.length * timing!.minimumDwellSeconds);
      assert.equal(repaired.duration, timing!.effectiveDurationSeconds, `${source.id} duration matches its fallback visual beat timeline`);
    }

    const beforeFile = join(screenshots, `v1.9.0_${aspect.replace(':', '-')}_${source.id}_before.png`);
    const beforeBoard = board(aspect, source);
    const beforeCapture = await renderCapture({ serveUrl, browser, storyboard: beforeBoard, frame: 60, output: beforeFile });
    const beforeLayout = beforeCapture.layout.map(item => ({ ...item, screenshotPath: beforeFile.replace(/\\/g, '/') }));
    const beforeReport = visualQualityAudit(beforeBoard, {
      fps,
      renderEvidence: { layout: beforeLayout, frames: [], subtitleTiming: [], transitions: [] },
      renderOverflowSceneIds: beforeLayout.filter(item => item.overflow).map(item => item.sceneId),
    });
    assert.ok(beforeReport.findings.some(finding => finding.code === 'density-over-budget'), `${source.id} pre-render QA diagnoses density and locates the source`);
    if (densityStressScenes.has(source.id)) {
      const floor = aspect === '9:16' ? 20 : 18;
      const tinyText = beforeLayout.filter(item => item.sceneId === source.id && item.elementType === 'text' && item.fontSizePx !== undefined && item.fontSizePx < floor);
      assert.ok(tinyText.every(sample => beforeReport.findings.some(finding => finding.code === 'font-too-small' && finding.sceneId === source.id && finding.location.frame === sample.frame && finding.location.screenshotPath)), `${source.id} reports any rendered sub-floor text with screenshot/frame location`);
      const safeAreaTolerance = 1e-6;
      assert.ok(!beforeLayout.some(item => item.elementType === 'subtitle' && (item.bounds.x < .05 - safeAreaTolerance || item.bounds.y < .05 - safeAreaTolerance || item.bounds.x + item.bounds.width > .95 + safeAreaTolerance || item.bounds.y + item.bounds.height > .95 + safeAreaTolerance)), `${source.id} subtitle stays inside the safe area`);
    }
    samples.push({ file: beforeFile, label: `${source.id} / unbroken` });

    const repairedBoard = board(aspect, repaired);
    const beatFrames = resolveVisualBeatTimeline(repaired, fps);
    const expectedHeroBeats = source.id === 'v190-long-text-stress'
      ? (repaired.visualBeats ?? []).filter(beat => beat.contentText?.trim())
      : [];
    const selectedBeats = source.id === 'v190-long-text-stress'
      ? beatFrames.filter(beat => expectedHeroBeats.some(contentBeat => contentBeat.id === beat.id))
      : beatFrames;
    if (source.id === 'v190-long-text-stress') {
      assert.equal(selectedBeats.length, expectedHeroBeats.length, 'every content-bearing long-text beat is included in the actual-frame matrix');
      assert.ok(expectedHeroBeats.length > 1, 'long-text fixture produces multiple renderable body beats');
    }
    const allAfterEvidence: Capture['layout'] = [];
    const tableFrameHashes = new Set<string>();
    if (beatFrames[0]) {
      const firstBeat = beatFrames[0];
      const file = join(screenshots, `v1.9.0_${aspect.replace(':', '-')}_${source.id}_after_${firstBeat.id}_start.png`);
      const capture = await renderCapture({ serveUrl, browser, storyboard: repairedBoard, frame: firstBeat.startFrame, output: file });
      const evidenceLayout = capture.layout.map(item => ({ ...item, screenshotPath: file.replace(/\\/g, '/') }));
      allAfterEvidence.push(...evidenceLayout);
      samples.push({ file, label: `${source.id} / ${firstBeat.id} start ${firstBeat.startFrame}` });
    }
    for (const beat of selectedBeats) {
      const frame = Math.floor((beat.startFrame + beat.endFrame - 1) / 2);
      const file = join(screenshots, `v1.9.0_${aspect.replace(':', '-')}_${source.id}_after_${beat.id}.png`);
      const capture = await renderCapture({ serveUrl, browser, storyboard: repairedBoard, frame, output: file });
      const sceneSamples = capture.layout.filter(item => item.sceneId === source.id);
      assert.ok(sceneSamples.some(item => item.beatId === beat.id), `${source.id} rendered frame ${frame} is mapped to ${beat.id}`);
      if (source.id === 'v190-long-text-stress') {
        const expected = expectedHeroBeats.find(contentBeat => contentBeat.id === beat.id)!;
        const body = sceneSamples.find(item => item.beatId === beat.id && item.targetId === expected.targetIds[0] && item.elementType === 'text');
        assert.ok(body, `${source.id}/${beat.id} has a visible DOM text target ${expected.targetIds[0]}`);
        assert.ok(body!.bounds.width > 0 && body!.bounds.height > 0, `${source.id}/${beat.id} visible text target has nonzero bounds`);
        assert.equal(body!.textContent, expected.contentText!.trim(), `${source.id}/${beat.id} DOM text equals the complete source visual slice`);
      }
      if (source.id === 'v190-twelve-row-table') {
        const cellLines = new Set(sceneSamples
          .filter(item => item.elementType === 'text' && item.targetId !== 'subtitle' && (item.fontSizePx ?? Infinity) <= 26)
          .map(item => item.bounds.y.toFixed(3)));
        assert.ok(cellLines.size <= 3, `table beat ${beat.id} renders only the header and current row group; visible row baselines=${cellLines.size}`);
        assert.ok(!sceneSamples.some(item => item.overflow), `table beat ${beat.id} has no stale overflow from Remotion's initial probe viewport`);
        tableFrameHashes.add(await pixelHash(file));
      }
      if (source.id === listScene.id) {
        const expectedTargets = new Set(beat.targetIds.filter(targetId => targetId.startsWith('bullet-')));
        const visibleItems = sceneSamples.filter(item => item.targetId?.startsWith('bullet-') && item.textContent);
        const visibleTargets = new Set(visibleItems.map(item => item.targetId!));
        assert.deepEqual(visibleTargets, expectedTargets, `${source.id}/${beat.id} exposes exactly the active parent list groups`);
        const capturedFacts = visibleItems.map(item => item.textContent!.replace(/\s+/gu, '')).join('');
        for (const targetId of expectedTargets) {
          const sourceItem = listItems[Number(targetId.slice('bullet-'.length)) - 1]!;
          assert.ok(capturedFacts.includes(sourceItem.text.replace(/\s+/gu, '')), `${source.id}/${beat.id} shows parent fact ${targetId}`);
          for (const child of sourceItem.children) assert.ok(capturedFacts.includes(child.replace(/\s+/gu, '')), `${source.id}/${beat.id} shows child fact under ${targetId}`);
        }
        for (const [index, sourceItem] of listItems.entries()) {
          if (expectedTargets.has(`bullet-${index + 1}`)) continue;
          assert.ok(!capturedFacts.includes(sourceItem.text.replace(/\s+/gu, '')), `${source.id}/${beat.id} hides inactive parent fact bullet-${index + 1}`);
          for (const child of sourceItem.children) assert.ok(!capturedFacts.includes(child.replace(/\s+/gu, '')), `${source.id}/${beat.id} hides inactive child fact under bullet-${index + 1}`);
        }
        if (aspect === '9:16' && beat.id === 'density-1') {
          const expectedFirstCaption = listItems[0]!.text;
          const caption = sceneSamples.find(item => item.elementType === 'subtitle' && item.textContent?.includes(expectedFirstCaption));
          assert.ok(caption, `${source.id}/${beat.id} portrait subtitle retains the complete first sentence through “边界条件。”`);
          assert.equal(caption!.overflow, false, `${source.id}/${beat.id} portrait subtitle is not clipped`);
          assert.ok(caption!.bounds.x >= .05 - 1e-6 && caption!.bounds.x + caption!.bounds.width <= .95 + 1e-6 && caption!.bounds.y >= .05 - 1e-6 && caption!.bounds.y + caption!.bounds.height <= .95 + 1e-6, `${source.id}/${beat.id} complete portrait caption stays inside the safe area`);
        }
      }
      if (source.id === flowScene.id) {
        const visibleTargets = new Set(sceneSamples.filter(item => item.targetId?.startsWith('flow-step-')).map(item => item.targetId!));
        assert.ok([...visibleTargets].some(targetId => flowNodes.some(node => node.id === targetId)), `${source.id}/${beat.id} renders a flow node`);
      }
      const textSizes = sceneSamples.filter(item => item.elementType === 'text' && item.fontSizePx !== undefined).map(item => item.fontSizePx!);
      assert.ok(textSizes.length > 0, `${source.id} browser reports rendered text font sizes`);
      const readableFloor = aspect === '9:16' ? 20 : 18;
      const allReadable = textSizes.every(size => size >= readableFloor);
      const evidenceLayout = capture.layout.map(item => ({ ...item, screenshotPath: file.replace(/\\/g, '/') }));
      allAfterEvidence.push(...evidenceLayout);
      const sampleReport = visualQualityAudit(repairedBoard, {
        fps,
        renderEvidence: { layout: evidenceLayout, frames: [], subtitleTiming: [], transitions: [] },
        renderOverflowSceneIds: evidenceLayout.filter(item => item.overflow).map(item => item.sceneId),
      });
      const diagnosed = sampleReport.findings.filter(finding => finding.sceneId === source.id && ['font-too-small', 'render-overflow', 'density-over-budget'].includes(finding.code));
      assert.ok(allReadable || diagnosed.some(finding => finding.location.screenshotPath && finding.location.frame === frame), `${source.id} uses readable rendered text or reports a scene/frame-specific fallback diagnosis`);
      if (densityStressScenes.has(source.id)) {
        const floor = aspect === '9:16' ? 20 : 18;
        const tinyText = sceneSamples.filter(item => item.elementType === 'text' && item.fontSizePx !== undefined && item.fontSizePx < floor);
        assert.ok(tinyText.every(sample => sampleReport.findings.some(finding => finding.code === 'font-too-small' && finding.sceneId === source.id && finding.location.frame === frame && finding.location.screenshotPath)), `${source.id}/${beat.id} never hides sub-floor text; QA locates it`);
        const safeAreaTolerance = 1e-6;
        assert.ok(!sceneSamples.some(item => item.elementType === 'subtitle' && (item.bounds.x < .05 - safeAreaTolerance || item.bounds.y < .05 - safeAreaTolerance || item.bounds.x + item.bounds.width > .95 + safeAreaTolerance || item.bounds.y + item.bounds.height > .95 + safeAreaTolerance)), `${source.id}/${beat.id} keeps subtitle within the 5% safe area`);
      }
      samples.push({ file, label: `${source.id} / ${beat.id} / min ${Math.min(...textSizes).toFixed(1)}px` });
    }
    if (source.id === 'v190-twelve-row-table') assert.ok(tableFrameHashes.size > 1, `${aspect} table beat frames visibly change as row groups advance`);
    const postReport = visualQualityAudit(repairedBoard, {
      fps,
      phase: 'post-render',
      renderEvidence: { layout: allAfterEvidence, frames: [], subtitleTiming: [], transitions: [] },
      renderOverflowSceneIds: allAfterEvidence.filter(item => item.overflow).map(item => item.sceneId),
    });
    for (const finding of postReport.findings.filter(item => item.sceneId === source.id && ['font-too-small', 'render-overflow'].includes(item.code))) {
      assert.ok(finding.location.beatId && finding.location.frame >= 0 && finding.location.screenshotPath, `${finding.code} has scene, beat, frame, and screenshot locator`);
    }
    console.log(`${aspect} ${source.id}: density ratio ${density.ratio.toFixed(2)}, ${beatFrames.length} beats, preflight/post-render findings ${beforeReport.findings.length}/${postReport.findings.length}`);
    if (densityStressScenes.has(source.id)) {
      const inputProps = { storyboard: repairedBoard };
      const composition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps, browserExecutable, puppeteerInstance: browser });
      const stem = source.id === listScene.id ? 'nested-list' : 'twelve-node-flow';
      const video = join(media, `V1.9.0_${aspect.replace(':', '-')}_density-${stem}.mp4`);
      await renderMedia({ composition, serveUrl, inputProps, browserExecutable, puppeteerInstance: browser, codec: 'h264', outputLocation: video, concurrency: 2, scale: 1, logLevel: 'error' });
      const result = probe(video);
      assert.deepEqual({ width: result.width, height: result.height }, dimensions(aspect), `${source.id} MP4 dimensions`);
      const durationFromFrames = composition.durationInFrames / composition.fps;
      assert.ok(result.duration >= durationFromFrames - .1, `${source.id} MP4 covers the extended fallback beat timeline (${result.duration}s vs ${durationFromFrames}s)`);
      outputs.push({ path: video, sha256: sha256(video), ...result });
      const timing = getVisualBeatTimingDiagnostic(repaired)!;
      console.log(`${aspect} ${source.id}: rendered ${video} (${result.duration.toFixed(2)}s; ${repaired.visualBeats!.length} fallback beats at ${timing.minimumDwellSeconds}s minimum; layout floor ${aspect === '9:16' ? 20 : 18}px).`);
    }
  }
  await makeContactSheet(samples.map(item => item.file), join(screenshots, `v1.9.0_${aspect.replace(':', '-')}_density-contact.png`), samples.map(item => item.label));
}

function motionScene(templateId: VisualTemplateId): Scene {
  const common = {
    duration: 4,
    audioDuration: 4,
    wordTimings: [
      { text: '请求先经过校验。', start: 0, end: 2 },
      { text: '随后将结果返回。', start: 2, end: 4 },
    ],
  };
  const definitions: Record<VisualTemplateId, { type: string; title: string; visual: Record<string, unknown>; targetA: string; targetB: string; actionA: string; actionB: string }> = {
    hero: { type: 'title', title: '延迟降低 28%', visual: { text: '请求先经过校验，延迟降低 28%。' }, targetA: 'hero-copy', targetB: 'hero-stat-number', actionA: 'reveal', actionB: 'number-count' },
    comparison: { type: 'comparison', title: '同步与异步处理', visual: { columns: [{ title: '同步', items: ['等待结果返回'] }, { title: '异步', items: ['允许调用方继续执行'] }] }, targetA: 'compare-1', targetB: 'compare-2', actionA: 'stagger', actionB: 'focus-dim' },
    diagram: { type: 'diagram', title: '请求处理路径', visual: { nodes: [{ id: 'request', label: '接收请求' }, { id: 'validate', label: '校验参数' }, { id: 'response', label: '返回结果' }] }, targetA: 'flow-1', targetB: 'validate', actionA: 'arrow-flow', actionB: 'group-expand' },
    timeline: { type: 'timeline', title: '请求处理顺序', visual: { items: [{ date: '第一步', label: '接收请求' }, { date: '第二步', label: '读取数据' }, { date: '第三步', label: '返回结果' }] }, targetA: 'timeline-1', targetB: 'timeline-2', actionA: 'highlight', actionB: 'annotation' },
    chart: { type: 'chart', title: '季度请求量变化', visual: { data: [{ label: '第一季度', value: 120 }, { label: '第二季度', value: 160 }, { label: '第三季度', value: 210 }] }, targetA: 'chart-bar-1', targetB: 'chart-bar-2', actionA: 'bar-grow', actionB: 'line-draw' },
  };
  const definition = definitions[templateId];
  const action = (actionName: string, targetId: string, beatRef: string) => ({
    targetId, action: actionName, beatRef, durationPolicy: 'beat', easingPreset: 'ease-in-out', reducedMotionFallback: 'static', parameters: {},
  });
  return StoryboardSchema.parse({
    title: `V1.9.0 ${templateId} two-action motion sample`, aspectRatio: '16:9', styleId: 'minimal-tech', transition: 'none',
    scenes: [{
      id: `v190-motion-${templateId}`, ...common, type: definition.type, title: definition.title,
      narration: '请求先经过校验。随后将结果返回。', visual: definition.visual,
      visualPlan: {
        templateId, narrativeIntent: templateId === 'hero' ? 'hook' : templateId === 'comparison' ? 'comparison' : templateId === 'diagram' ? 'flow' : templateId === 'timeline' ? 'timeline' : 'data-story',
        keyFocus: definition.title, manualOverride: false, provenance: 'rule',
        beats: [
          { id: 'beat-a', narrationText: '请求先经过校验。', targetIds: [definition.targetA] },
          { id: 'beat-b', narrationText: '随后将结果返回。', targetIds: [definition.targetB] },
        ],
        motionPresets: [action(definition.actionA, definition.targetA, 'beat-a'), action(definition.actionB, definition.targetB, 'beat-b')],
      },
    }],
  }).scenes[0]!;
}

async function extractFrame(video: string, frame: number, output: string): Promise<void> {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', video, '-vf', `select=eq(n\\,${frame})`, '-fps_mode', 'passthrough', '-frames:v', '1', output], { windowsHide: true });
  const metadata = await sharp(output).metadata();
  assert.ok(metadata.width && metadata.height, `MP4 frame ${frame} can be decoded from ${video}`);
}

function auditAdjacentMp4Frames(video: string, label: string): { frameCount: number; maxAdjacentMeanDiff: number; maxDiffFrame: number; minMeanLuminance: number } {
  const width = 96, height = 54, frameBytes = width * height * 3;
  const pixels = execFileSync('ffmpeg', [
    '-v', 'error', '-i', video, '-vf', `scale=${width}:${height}:flags=area`, '-fps_mode', 'passthrough',
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
  ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const frameCount = Math.floor(pixels.length / frameBytes);
  assert.ok(frameCount >= 119, `${label} exports enough decoded frames to audit adjacent motion (${frameCount})`);
  const means: number[] = [];
  const diffs: number[] = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * frameBytes;
    let sum = 0;
    for (let index = start; index < start + frameBytes; index += 3) sum += (pixels[index]! + pixels[index + 1]! + pixels[index + 2]!) / 3;
    means.push(sum / (width * height));
    if (frame === 0) continue;
    let delta = 0;
    const previous = start - frameBytes;
    for (let index = 0; index < frameBytes; index += 1) delta += Math.abs(pixels[previous + index]! - pixels[start + index]!);
    diffs.push(delta / frameBytes);
  }
  const withinBeat = diffs.filter((_, index) => index !== 59);
  const maxAdjacentMeanDiff = Math.max(...withinBeat);
  const maxDiffFrame = withinBeat.indexOf(maxAdjacentMeanDiff) + 1;
  const minMeanLuminance = Math.min(...means);
  assert.ok(minMeanLuminance > 3, `${label} has no black/empty flash across ${frameCount} decoded frames (minimum mean RGB ${minMeanLuminance.toFixed(2)})`);
  assert.ok(maxAdjacentMeanDiff < 24, `${label} has no abrupt within-beat frame jump (max adjacent mean RGB delta ${maxAdjacentMeanDiff.toFixed(2)} at frame ${maxDiffFrame})`);
  const beatBoundaryDiff = diffs[59];
  assert.ok(beatBoundaryDiff !== undefined && beatBoundaryDiff < 64, `${label} beat boundary has no full-frame flash (59→60 mean RGB delta ${beatBoundaryDiff?.toFixed(2) ?? 'missing'})`);
  return { frameCount, maxAdjacentMeanDiff, maxDiffFrame, minMeanLuminance };
}

async function renderMotionSamples(serveUrl: string, browser: Awaited<ReturnType<typeof openBrowser>>, evidenceTemp: string) {
  for (const aspect of ['16:9', '9:16'] as const) {
    for (const templateId of templates) {
      const scene = motionScene(templateId);
      const baseBoard = board(aspect, scene);
      const beatFrames = resolveVisualBeatTimeline(scene, fps);
      assert.deepEqual(beatFrames.map(beat => [beat.startFrame, beat.endFrame]), [[0, 60], [60, 120]], `${templateId} word timings map the two semantic beats to exact frame boundaries`);
      const inputProps = { storyboard: baseBoard };
      const composition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps, browserExecutable, puppeteerInstance: browser });
      assert.deepEqual({ width: composition.width, height: composition.height }, dimensions(aspect));
      const video = join(media, `V1.9.0_${aspect.replace(':', '-')}_motion-${templateId}.mp4`);
      await renderMedia({ composition, serveUrl, inputProps, browserExecutable, puppeteerInstance: browser, codec: 'h264', outputLocation: video, concurrency: 2, scale: 1 });
      const probed = probe(video);
      assert.deepEqual({ width: probed.width, height: probed.height }, dimensions(aspect));
      assert.ok(Math.abs(probed.duration - 4) < .3, `${templateId} ${aspect} motion MP4 is four seconds`);
      outputs.push({ path: video, sha256: sha256(video), ...probed });
      const continuity = auditAdjacentMp4Frames(video, `${templateId}/${aspect}`);
      console.log(`${templateId}/${aspect}: decoded ${continuity.frameCount} consecutive MP4 frames; max within-beat adjacent RGB delta ${continuity.maxAdjacentMeanDiff.toFixed(2)} at frame ${continuity.maxDiffFrame}; minimum frame mean RGB ${continuity.minMeanLuminance.toFixed(2)}.`);

      const frameFiles: string[] = [];
      const labels: string[] = [];
      const previewExportFiles: string[] = [];
      const previewExportLabels: string[] = [];
      for (const frame of [1, 11, 30, 58, 59, 60, 61, 71, 90, 118, 119]) {
        const image = join(screenshots, `v1.9.0_${aspect.replace(':', '-')}_motion-${templateId}_frame-${String(frame).padStart(3, '0')}.png`);
        await extractFrame(video, frame, image);
        frameFiles.push(image);
        labels.push(`MP4 frame ${frame}`);
        const stats = await sharp(image).stats();
        const deviation = stats.channels.reduce((sum: number, channel: { stdev: number }) => sum + channel.stdev, 0) / stats.channels.length;
        assert.ok(deviation > .25, `${templateId}/${aspect} frame ${frame} contains rendered scene content (stdev ${deviation.toFixed(2)})`);
      }
      for (const [first, last, label] of [[1, 59, 'beat-a'], [61, 119, 'beat-b']] as const) {
        const difference = await pixelDifference(frameFiles[[1, 11, 30, 58, 59, 60, 61, 71, 90, 118, 119].indexOf(last)]!, frameFiles[[1, 11, 30, 58, 59, 60, 61, 71, 90, 118, 119].indexOf(first)]!);
        assert.ok(difference > 0, `${templateId}/${aspect} ${label} rendered frames change across its motion window`);
      }
      await makeContactSheet(frameFiles, join(screenshots, `v1.9.0_${aspect.replace(':', '-')}_motion-${templateId}-strip.png`), labels);

      {
        const boardFor = (reduced: boolean) => board(aspect, scene, reduced);
        const comparisonDir = join(evidenceTemp, `${aspect.replace(':', '-')}-${templateId}`);
        await mkdir(comparisonDir, { recursive: true });
        const captured = new Map<number, { file: string; result: Capture }>();
        const stillFrames = [11, 59, 60, 71, 90, 119];
        const previewExportDiffs: number[] = [];
        for (const frame of stillFrames) {
          const file = join(comparisonDir, `preview-${frame}.png`);
          const result = await renderCapture({ serveUrl, browser, storyboard: baseBoard, frame, output: file });
          captured.set(frame, { file, result });
          const exportedFrame = join(comparisonDir, `mp4-${frame}.png`);
          await extractFrame(video, frame, exportedFrame);
          const meanRgbDiff = await pixelDifference(file, exportedFrame);
          previewExportDiffs.push(meanRgbDiff);
          assert.ok(meanRgbDiff < 3, `${templateId}/${aspect} preview and MP4 frame ${frame} match within H.264 tolerance (MAE ${meanRgbDiff.toFixed(3)})`);
          previewExportFiles.push(file, exportedFrame);
          previewExportLabels.push(`Preview ${frame}`, `MP4 ${frame}`);
        }
        const startBeat = captured.get(59)!.result.layout;
        const nextBeat = captured.get(60)!.result.layout;
        assert.ok(startBeat.some(item => item.beatId === 'beat-a'), `${templateId} frame 59 reports beat-a`);
        assert.ok(nextBeat.some(item => item.beatId === 'beat-b'), `${templateId} frame 60 switches exactly to beat-b`);
        const repeatFile = join(comparisonDir, 'preview-71-repeat.png');
        await renderCapture({ serveUrl, browser, storyboard: baseBoard, frame: 71, output: repeatFile });
        assert.equal(await pixelHash(captured.get(71)!.file), await pixelHash(repeatFile), `${templateId} repeated frame-71 renders are pixel-deterministic`);

        // Compare reduced motion at the midpoint of each active beat so the static fallback is distinct from an in-progress action.
        for (const frame of [11, 90]) {
          const reducedFile = join(comparisonDir, `reduced-${frame}.png`);
          await renderCapture({ serveUrl, browser, storyboard: boardFor(true), frame, output: reducedFile });
          const normalFile = frame === 11 ? captured.get(11)!.file : captured.get(71)!.file;
          const difference = await pixelDifference(normalFile, reducedFile);
          assert.ok(difference > 0, `${templateId} reduced-motion output follows the static fallback at frame ${frame}`);
          frameFiles.push(reducedFile);
          labels.push(`Reduced motion ${frame}`);
        }
        await makeContactSheet(frameFiles, join(screenshots, `v1.9.0_${aspect.replace(':', '-')}_motion-${templateId}-strip.png`), labels);
        await makeContactSheet(previewExportFiles, join(screenshots, `v1.9.0_${aspect.replace(':', '-')}_motion-${templateId}-preview-export-strip.png`), previewExportLabels);

        const actionAStart = frameFiles[0]!;
        const actionAEnd = frameFiles[4]!;
        const actionBStart = frameFiles[6]!;
        const actionBEnd = frameFiles[10]!;
        assert.ok(await pixelDifference(actionAStart, actionAEnd) > 0, `${templateId} first action changes the rendered frame`);
        assert.ok(await pixelDifference(actionBStart, actionBEnd) > 0, `${templateId} second action changes the rendered frame`);
        assert.ok(previewExportDiffs.every(value => value < 3), `${templateId}/${aspect} all preview/MP4 still pairs are within H.264 tolerance`);
        console.log(`${templateId}/${aspect}: composition preview vs MP4 frame RGB MAE ${Math.min(...previewExportDiffs).toFixed(3)}–${Math.max(...previewExportDiffs).toFixed(3)} across ${previewExportDiffs.length} frames.`);
      }
    }
  }
  console.log(`Motion verification covered ${templates.length * 2} template/aspect MP4s and ${templates.length * 2} distinct actions.`);
}

async function main() {
  await mkdir(screenshots, { recursive: true });
  await mkdir(media, { recursive: true });
  const temp = await mkdtemp(join(resolve(repo, 'data'), 'test-render-v19-density-motion-'));
  try {
    const publicDir = join(temp, 'public');
    await mkdir(publicDir, { recursive: true });
    const serveUrl = await bundle({ entryPoint: resolve(repo, 'apps', 'worker', 'src', 'entry.tsx'), publicDir, outDir: join(temp, 'bundle') });
    const chromiumOptions = visualQaChromiumOptions();
    const browser = await openBrowser('chrome', { browserExecutable: browserExecutable ?? null, chromiumOptions });
    console.log(`Motion/density MP4 rendering uses ${chromiumOptions ? 'SwiftShader CPU-only Chromium' : 'the default Chromium backend'}.`);
    try {
      for (const aspect of ['16:9', '9:16'] as const) await renderDensitySamples(serveUrl, browser, aspect);
      await renderMotionSamples(serveUrl, browser, temp);
    } finally {
      await browser.close({ silent: true });
    }
    await writeFile(join(screenshots, 'v1.9.0_density-motion-summary.json'), JSON.stringify({ outputs }, null, 2), 'utf8');
    console.log('V1.9.0 density and motion MP4s:');
    for (const output of outputs) console.log(`${output.path}\n  SHA-256 ${output.sha256}\n  ${output.width}x${output.height}, ${output.duration.toFixed(2)}s`);
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
