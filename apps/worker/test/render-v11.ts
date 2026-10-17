import { bundle } from '@remotion/bundler';
import { makeCancelSignal, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { StoryboardSchema } from '@m2v/schema';
import { mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

async function main() {
  const repo = process.cwd(), directory = resolve(repo, 'data', `test-render-v11-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE;
  const storyboard = StoryboardSchema.parse({ title: '排版检查', styleId: 'minimal-tech', aspectRatio: '9:16', subtitles: { fontSize: 48, preset: 'boxed' }, scenes: [{ id: 'dense', type: 'bullets', title: '竖屏长正文排版', narration: '这一段字幕用于验证中文排版，以及视频和字幕时间轴。', duration: 3, sceneGap: .5, visual: { items: Array.from({ length: 5 }, (_, i) => `${i + 1}. 一段需要自动换行并调整大小的长正文。`.repeat(5)) } }] });
  const landscape = StoryboardSchema.parse({ title: '横屏排版检查', styleId: 'minimal-tech', aspectRatio: '16:9', subtitles: { fontSize: 34, preset: 'boxed', color: '#ffcc00', background: '#112233', backgroundOpacity: .65 }, scenes: [{ id: 'wide', type: 'bullets', title: '横屏长正文排版', narration: '这一段字幕用于验证横屏中文排版与字幕时间轴。', duration: 3, visual: { items: Array.from({ length: 4 }, (_, i) => `${i + 1}. 一段需要自动换行并调整大小的长正文。`.repeat(5)) } }] });
  const probe = (file: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file], { encoding: 'utf8', windowsHide: true })).streams[0];
  try {
    const serveUrl = await bundle({ entryPoint: resolve(repo, 'apps/worker/src/entry.tsx'), publicDir: null, outDir: join(directory, 'bundle') });
    const inputProps = { storyboard };
    const composition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps, browserExecutable });
    assert.equal(composition.durationInFrames, 105);
    assert.equal(composition.width, 1080); assert.equal(composition.height, 1920);
    await renderStill({ composition, serveUrl, inputProps, browserExecutable, output: join(directory, 'portrait.png'), frame: 40, scale: .5 });
    await renderMedia({ composition, serveUrl, inputProps, browserExecutable, codec: 'h264', outputLocation: join(directory, 'draft.mp4'), scale: .5, concurrency: 2 });
    const portrait = probe(join(directory, 'draft.mp4'));
    assert.equal(portrait.width, 540); assert.equal(portrait.height, 960);
    const wideProps = { storyboard: landscape };
    const wideComposition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps: wideProps, browserExecutable });
    assert.equal(wideComposition.width, 1920); assert.equal(wideComposition.height, 1080);
    await renderStill({ composition: wideComposition, serveUrl, inputProps: wideProps, browserExecutable, output: join(directory, 'landscape.png'), frame: 40, scale: .5 });
    await renderMedia({ composition: wideComposition, serveUrl, inputProps: wideProps, browserExecutable, codec: 'h264', outputLocation: join(directory, 'wide-draft.mp4'), scale: .5, concurrency: 2 });
    const wide = probe(join(directory, 'wide-draft.mp4'));
    assert.equal(wide.width, 960); assert.equal(wide.height, 540);
    const { cancel, cancelSignal } = makeCancelSignal();
    let cancelled = false;
    await assert.rejects(renderMedia({ composition, serveUrl, inputProps, browserExecutable, codec: 'h264', outputLocation: join(directory, 'cancelled.mp4'), scale: .5, concurrency: 1, cancelSignal, onProgress: () => { if (!cancelled) { cancelled = true; cancel(); } } }), /cancel/i);
    assert.ok(cancelled);
    console.log(`PASS: portrait draft 540×960, landscape draft 960×540, scene gap duration, Remotion cancellation. Preview: ${join(directory, 'portrait.png')}`);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
