import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

async function main() {
  const repo = process.cwd();
  const directory = resolve(repo, 'data', `test-v16-brand-render-${randomUUID()}`);
  const publicDir = join(directory, 'public');
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE;
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, 'brand-logo.png'), solidPng(24, 16, [255, 0, 0, 255]));

  const legacy = StoryboardSchema.parse({
    title: '品牌渲染验收', styleId: 'minimal-tech', aspectRatio: '16:9',
    scenes: [{ id: 'scene', type: 'title', title: '快照渲染', narration: '颜色和字体由项目快照提供。', duration: 3 }],
  });
  const snapshot = {
    name: '项目私有品牌',
    baseStyleId: 'academic' as const,
    colors: { bg: '#102030', fg: '#f8f8f8', muted: '#b0b8c0', accent: '#fa8058', card: '#203040', secondary: '#405060' },
    typography: { headingFont: 'Arial', bodyFont: 'Arial' },
  };
  const branded = StoryboardSchema.parse({ ...legacy, brandKitId: 'deleted-kit', brand: snapshot });
  const brandedWithLogo = StoryboardSchema.parse({
    ...branded,
    brand: { ...snapshot, logo: { src: 'brand-logo.png', position: 'top-left', width: 120, margin: 24 } },
  });

  try {
    const serveUrl = await bundle({
      entryPoint: resolve(repo, 'apps/worker/src/entry.tsx'),
      publicDir,
      outDir: join(directory, 'bundle'),
    });
    const renderFrame = async (storyboard: typeof legacy, filename: string) => {
      const inputProps = { storyboard };
      const composition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps, browserExecutable });
      await renderStill({ composition, serveUrl, inputProps, browserExecutable, output: join(directory, filename), frame: 30, scale: .25 });
      return readFile(join(directory, filename));
    };
    const legacyFrame = await renderFrame(legacy, 'legacy.png');
    const brandFrame = await renderFrame(branded, 'brand.png');
    const brandWithLogoFrame = await renderFrame(brandedWithLogo, 'brand-with-logo.png');
    assert.notDeepEqual(brandFrame, legacyFrame, 'saved Brand Snapshot colors change the rendered frame even when brandKitId is stale');
    assert.notDeepEqual(brandWithLogoFrame, brandFrame, 'the optional snapshot Logo is rendered from its static project asset');
    console.log('PASS: legacy and branded Remotion frames differ as expected; stale Brand Kit IDs need no library lookup and the snapshot Logo loads');
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
