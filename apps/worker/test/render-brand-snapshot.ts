import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import { StoryboardSchema } from '@m2v/schema';

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const payload = Buffer.concat([typeBytes, data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, payload, checksum]);
}

function solidPng(width: number, height: number, color: [number, number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x += 1) color.forEach((channel, index) => { row[1 + x * 4 + index] = channel; });
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const pngSize = (bytes: Buffer) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });

type DecodedPng = { width: number; height: number; channels: 3 | 4; data: Buffer };

/** Minimal 8-bit, non-interlaced PNG decoder so full-size renders can assert real pixels. */
function decodePng(bytes: Buffer): DecodedPng {
  assert.equal(bytes.readUInt32BE(0), 0x89504e47, 'PNG signature');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  assert.equal(bitDepth, 8, 'test decoder expects an 8-bit PNG');
  assert.equal(interlace, 0, 'test decoder expects a non-interlaced PNG');
  let channels: 3 | 4;
  if (colorType === 6) channels = 4;
  else if (colorType === 2) channels = 3;
  else throw new Error(`unsupported PNG color type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source++]!;
    const row = y * stride;
    const previous = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[source++]!;
      const left = x >= channels ? out[row + x - channels]! : 0;
      const up = y > 0 ? out[previous + x]! : 0;
      const upLeft = y > 0 && x >= channels ? out[previous + x - channels]! : 0;
      let decoded: number;
      switch (filter) {
        case 0: decoded = value; break;
        case 1: decoded = (value + left) & 0xff; break;
        case 2: decoded = (value + up) & 0xff; break;
        case 3: decoded = (value + ((left + up) >> 1)) & 0xff; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          decoded = (value + predictor) & 0xff;
          break;
        }
        default: throw new Error(`unsupported PNG filter ${filter}`);
      }
      out[row + x] = decoded;
    }
  }
  return { width, height, channels, data: out };
}

function pixelAt(png: DecodedPng, x: number, y: number): [number, number, number, number] {
  const index = (y * png.width + x) * png.channels;
  return [png.data[index]!, png.data[index + 1]!, png.data[index + 2]!, png.channels === 4 ? png.data[index + 3]! : 255];
}

/** Shared brand palette: every case varies exactly one dimension so the frame diff has one cause. */
const COLORS = { bg: '#102030', fg: '#f8f8f8', muted: '#b0b8c0', accent: '#e11d48', card: '#203040', secondary: '#405060' };

const snapshot = (patch: Record<string, unknown> = {}) => ({
  name: '项目私有品牌',
  baseStyleId: 'minimal-tech' as const,
  colors: { ...COLORS },
  typography: { headingFont: 'Georgia', bodyFont: 'Georgia' },
  ...patch,
});

const board = (scenes: unknown[], extra: Record<string, unknown> = {}) =>
  StoryboardSchema.parse({ title: '品牌渲染验收', styleId: 'minimal-tech', aspectRatio: '16:9', scenes, ...extra });
const titleScene = (extra: Record<string, unknown> = {}) => ({
  id: randomUUID(), type: 'title', title: 'Brand Font Test', narration: 'Serif or sans, brand colors only.', duration: 3, visual: {}, ...extra,
});
const chartScene = () => ({
  id: randomUUID(), type: 'chart', title: 'Accent Color', narration: 'Chart bars use the brand accent.',
  duration: 3, visual: { data: [{ label: 'Alpha', value: 3 }, { label: 'Beta', value: 7 }, { label: 'Gamma', value: 5 }] },
});
const fullBleedScene = () => ({
  id: randomUUID(), type: 'media', title: 'Slide', narration: 'Full bleed slide.',
  duration: 3, visual: { src: 'projects/test/assets/slide-1.png', fullBleed: true },
});
const htmlScene = () => ({
  id: randomUUID(), type: 'html', title: 'HTML scene', narration: 'HTML scene narration.',
  duration: 3, visual: { html: '<h1>HTML Heading</h1><p>Brand background, foreground and body font apply outside the HTML snippet.</p>' },
});

async function main() {
  const repo = process.cwd();
  const directory = resolve(repo, 'data', `test-v16-brand-render-${randomUUID()}`);
  const publicDir = join(directory, 'public');
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE;
  const keepArtifacts = process.env.M2V_KEEP_RENDER_ARTIFACTS === '1';
  const artifactsDir = resolve(repo, 'outputs', 'V1.6.6', 'render');
  await mkdir(join(publicDir, 'projects', 'test', 'assets'), { recursive: true });
  await writeFile(join(publicDir, 'brand-logo.png'), solidPng(24, 16, [255, 0, 0, 255]));
  await writeFile(join(publicDir, 'projects', 'test', 'assets', 'slide-1.png'), solidPng(32, 18, [20, 90, 180, 255]));
  if (keepArtifacts) await mkdir(artifactsDir, { recursive: true });

  // #43 1: legacy storyboard, no brand at all.
  const legacy = board([{ id: 'scene', type: 'title', title: '快照渲染', narration: '颜色和字体由项目快照提供。', duration: 3, visual: {} }]);
  const snapshotValue = snapshot();
  // Existing V1.6 behaviour: a saved snapshot renders even when its source kit no longer exists.
  const branded = board([{ id: 'scene', type: 'title', title: '快照渲染', narration: '颜色和字体由项目快照提供。', duration: 3, visual: {} }], { brandKitId: 'deleted-kit', brand: snapshotValue });
  const brandedWithLogo = board(
    [{ id: 'scene', type: 'title', title: '快照渲染', narration: '颜色和字体由项目快照提供。', duration: 3, visual: {} }],
    { brandKitId: 'deleted-kit', brand: snapshot({ logo: { src: 'brand-logo.png', position: 'top-left', width: 120, margin: 24 } }) },
  );

  // #43 2: identical chart, only the brand accent changes (red vs blue).
  const redAccent = board([chartScene()], { brand: snapshot({ colors: { ...COLORS, accent: '#e11d48' } }) });
  const blueAccent = board([chartScene()], { brand: snapshot({ colors: { ...COLORS, accent: '#2563eb' } }) });
  // #43 4: identical Latin title, only the brand typography changes (serif vs sans).
  const serifTitle = board([titleScene()], { brand: snapshot({ typography: { headingFont: 'Georgia', bodyFont: 'Georgia' } }) });
  const sansTitle = board([titleScene()], { brand: snapshot({ typography: { headingFont: 'Arial', bodyFont: 'Arial' } }) });
  // #43 6 / #44 5: same content in 16:9 and 9:16.
  const landscapeBoard = board([titleScene()], { brand: snapshot() });
  const portraitBoard = board([titleScene()], { aspectRatio: '9:16', brand: snapshot() });
  // #43 7 / #44 6: a full-bleed PPT/media slide must keep its own image and still take the Logo.
  const fullBleedPlain = board([fullBleedScene()]);
  const fullBleedBranded = board([fullBleedScene()], { brand: snapshot() });
  const fullBleedLogo = board([fullBleedScene()], { brand: snapshot({ logo: { src: 'brand-logo.png', position: 'bottom-right', width: 160, margin: 40 } }) });
  // #44 3: enabled=false must render exactly like no Logo at all.
  const logoDisabled = board([titleScene()], { brand: snapshot({ logo: { src: 'brand-logo.png', enabled: false, position: 'top-left', width: 120, margin: 24 } }) });
  const noLogo = board([titleScene()], { brand: snapshot() });
  // #43 HTML: brand background/foreground/body font outside the HTML snippet.
  const htmlPlain = board([htmlScene()]);
  const htmlBranded = board([htmlScene()], { brand: snapshot() });
  // #44 8: three identical scenes at three different points in time.
  const stableScenes = [titleScene(), titleScene(), titleScene()];
  const stableBoard = board(stableScenes, { brand: snapshot({ logo: { src: 'brand-logo.png', position: 'top-right', width: 140, margin: 32 } }) });
  // 1080p pixel baseline: solid style background, full-bleed source image and Logo placement.
  const fullScaleBrand = StoryboardSchema.parse({
    title: '1080p 品牌像素基线',
    styleId: 'whiteboard',
    aspectRatio: '16:9',
    brand: snapshot({ colors: { ...COLORS, bg: '#112233' } }),
    scenes: [{ id: 'scene', type: 'title', title: 'Full Scale', narration: 'Full scale brand background.', duration: 3, visual: {} }],
  });
  const fullScaleFullBleed = StoryboardSchema.parse({
    title: '1080p full-bleed 像素基线',
    styleId: 'minimal-tech',
    aspectRatio: '16:9',
    brand: snapshot(),
    scenes: [fullBleedScene()],
  });
  const fullScaleLogo = StoryboardSchema.parse({
    title: '1080p Logo 像素基线',
    styleId: 'whiteboard',
    aspectRatio: '16:9',
    brand: snapshot({ logo: { src: 'brand-logo.png', position: 'top-left', width: 120, margin: 24 } }),
    scenes: [{ id: 'scene', type: 'title', title: 'Logo', narration: 'Full scale Logo.', duration: 3, visual: {} }],
  });

  try {
    const serveUrl = await bundle({
      entryPoint: resolve(repo, 'apps/worker/src/entry.tsx'),
      publicDir,
      outDir: join(directory, 'bundle'),
    });
    const renderFrame = async (storyboard: typeof legacy, filename: string, frame = 45, scale = .25) => {
      const inputProps = { storyboard };
      const composition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps, browserExecutable });
      const output = join(directory, filename);
      await renderStill({ composition, serveUrl, inputProps, browserExecutable, output, frame, scale });
      const bytes = await readFile(output);
      if (keepArtifacts) await copyFile(output, join(artifactsDir, filename));
      return bytes;
    };

    // ── 既有回归：legacy / branded / branded+Logo ──────────────────────
    const legacyFrame = await renderFrame(legacy, 'legacy.png');
    const brandFrame = await renderFrame(branded, 'brand.png');
    const brandWithLogoFrame = await renderFrame(brandedWithLogo, 'brand-with-logo.png');
    assert.notDeepEqual(brandFrame, legacyFrame, 'saved Brand Snapshot colors change the rendered frame even when brandKitId is stale');
    assert.notDeepEqual(brandWithLogoFrame, brandFrame, 'the optional snapshot Logo is rendered from its static project asset');

    // ── #43 2: accent red vs blue ──────────────────────────────────────
    const redAccentFrame = await renderFrame(redAccent, 'chart-accent-red.png');
    const blueAccentFrame = await renderFrame(blueAccent, 'chart-accent-blue.png');
    assert.notDeepEqual(redAccentFrame, blueAccentFrame, 'a red vs blue brand accent changes the chart frame');

    // ── #43 4: heading/body font serif vs sans ─────────────────────────
    const serifFrame = await renderFrame(serifTitle, 'title-serif.png');
    const sansFrame = await renderFrame(sansTitle, 'title-sans.png');
    assert.notDeepEqual(serifFrame, sansFrame, 'brand serif vs sans typography changes the title frame');

    // ── #43 6 / #44 5: 16:9 与 9:16 ────────────────────────────────────
    const landscapeFrame = await renderFrame(landscapeBoard, 'landscape.png');
    const portraitFrame = await renderFrame(portraitBoard, 'portrait.png');
    assert.deepEqual(pngSize(landscapeFrame), { width: 480, height: 270 }, '16:9 renders at the scaled landscape size');
    assert.deepEqual(pngSize(portraitFrame), { width: 270, height: 480 }, '9:16 renders at the scaled portrait size');
    assert.notDeepEqual(landscapeFrame, portraitFrame, 'landscape and portrait both render and produce their own frame');

    // ── #43 7 / #44 6: full-bleed slide 保留原图，但仍显示 Logo ─────────
    const fullBleedPlainFrame = await renderFrame(fullBleedPlain, 'fullbleed-no-brand.png');
    const fullBleedBrandedFrame = await renderFrame(fullBleedBranded, 'fullbleed-brand.png');
    assert.deepEqual(fullBleedBrandedFrame, fullBleedPlainFrame, 'a full-bleed slide keeps the source image and is not covered by the brand background');
    const fullBleedLogoFrame = await renderFrame(fullBleedLogo, 'fullbleed-logo.png');
    assert.notDeepEqual(fullBleedLogoFrame, fullBleedPlainFrame, 'the video-level Logo still renders on top of a full-bleed slide');

    // ── #44 3: enabled=false 等于无 Logo ───────────────────────────────
    const logoDisabledFrame = await renderFrame(logoDisabled, 'logo-disabled.png');
    const noLogoFrame = await renderFrame(noLogo, 'logo-none.png');
    assert.deepEqual(logoDisabledFrame, noLogoFrame, 'enabled=false renders exactly like a storyboard without a Logo');

    // ── #43 HTML 场景使用品牌背景/前景/正文字体 ─────────────────────────
    const htmlPlainFrame = await renderFrame(htmlPlain, 'html-no-brand.png');
    const htmlBrandedFrame = await renderFrame(htmlBranded, 'html-brand.png');
    assert.notDeepEqual(htmlBrandedFrame, htmlPlainFrame, 'HTML scenes take the brand background/foreground/body font outside the snippet');

    // ── #44 8: 三个相同场景在不同时间点帧相同（Logo 不随场景跳动）──────────
    const stableFrames = [
      await renderFrame(stableBoard, 'stable-scene-1.png', 45),
      await renderFrame(stableBoard, 'stable-scene-2.png', 45 + 90),
      await renderFrame(stableBoard, 'stable-scene-3.png', 45 + 180),
    ];
    assert.deepEqual(stableFrames[1], stableFrames[0], 'the Logo and scene stay identical in the second scene');
    assert.deepEqual(stableFrames[2], stableFrames[0], 'the Logo and scene stay identical in the third scene');

    // ── 1080p 全尺寸关键像素基线（不是只看尺寸/字节差异）────────────────
    const fullBrandFrame = await renderFrame(fullScaleBrand, 'full-scale-brand.png', 45, 1);
    const fullBrandPng = decodePng(fullBrandFrame);
    assert.deepEqual(pngSize(fullBrandFrame), { width: 1920, height: 1080 }, 'the pixel baseline renders at full 1080p');
    assert.deepEqual(pixelAt(fullBrandPng, 5, 5), [0x11, 0x22, 0x33, 255], '1080p brand background pixel matches the snapshot bg');
    const fullBleedFrame = await renderFrame(fullScaleFullBleed, 'full-scale-fullbleed.png', 45, 1);
    const fullBleedPng = decodePng(fullBleedFrame);
    assert.deepEqual(pngSize(fullBleedFrame), { width: 1920, height: 1080 });
    assert.deepEqual(pixelAt(fullBleedPng, 960, 540), [20, 90, 180, 255], 'the full-bleed center pixel keeps the source slide image at 1080p');
    const fullLogoFrame = await renderFrame(fullScaleLogo, 'full-scale-logo.png', 45, 1);
    const fullLogoPng = decodePng(fullLogoFrame);
    assert.deepEqual(pngSize(fullLogoFrame), { width: 1920, height: 1080 });
    assert.deepEqual(pixelAt(fullLogoPng, 34, 34), [255, 0, 0, 255], 'the brand Logo renders at its configured full-size placement');

    console.log('PASS: legacy/branded/logo frames plus accent, typography, 16:9|9:16, full-bleed, logo-disabled, HTML brand background and multi-scene Logo stability behave as expected');
    console.log('PASS: 1080p pixel baseline verifies brand background, full-bleed source pixels and Logo placement at full size');
    if (keepArtifacts) console.log('kept render artifacts under outputs/V1.6.6/render');
  } finally {
    if (!keepArtifacts) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
