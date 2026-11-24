import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bundle } from '@remotion/bundler';
import { openBrowser, renderStill, selectComposition } from '@remotion/renderer';
import { StoryboardSchema } from '@m2v/schema';
import { visualQaChromiumOptions } from '../src/visual-qa';

const repo = process.cwd();
const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE?.trim()
  || (process.platform === 'win32' && existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
    ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
    : undefined);
async function main() {
  const temp = await mkdtemp(join(resolve(repo, 'data', 'tmp'), 'v19-qa-capture-'));
  let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
  try {
  const publicDir = join(temp, 'public');
  await mkdir(publicDir, { recursive: true });
  const serveUrl = await bundle({ entryPoint: resolve(repo, 'apps/worker/src/entry.tsx'), publicDir, outDir: join(temp, 'bundle') });
  const storyboard = StoryboardSchema.parse({
    title: 'V1.9.0 Visual QA capture smoke',
    styleId: 'minimal-tech',
    aspectRatio: '9:16',
    scenes: [{ id: 'qa-capture-smoke', type: 'title', title: '可读标题', narration: '布局捕获验证', duration: 3, visual: { text: '布局捕获验证' } }],
  });
  const inputProps = { storyboard, visualQaCapture: true };
  const chromiumOptions = visualQaChromiumOptions();
  browser = await openBrowser('chrome', { browserExecutable: browserExecutable ?? null, chromiumOptions });
  // Mirror the Worker: select a regular composition for the MP4 and a separate
  // QA-enabled composition for renderStill.
  await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps: { storyboard }, browserExecutable, puppeteerInstance: browser });
  const composition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps, browserExecutable, puppeteerInstance: browser });
  let capture: { layout?: unknown[]; width?: number; height?: number } | undefined;
  const output = join(temp, 'capture.png');
  await renderStill({
    composition, serveUrl, inputProps, browserExecutable, puppeteerInstance: browser,
    output, frame: 0, imageFormat: 'png', overwrite: true, logLevel: 'error',
    onBrowserLog: log => {
      const marker = '__M2V_VISUAL_QA__';
      const index = log.text.indexOf(marker);
      if (index < 0) return;
      try { capture = JSON.parse(log.text.slice(index + marker.length)) as typeof capture; } catch { /* Assert below with the missing capture. */ }
    },
  });
  assert.ok(capture, 'browser emits the QA capture marker');
  assert.equal(capture.width, 1080);
  assert.equal(capture.height, 1920);
  assert.ok(capture.layout?.length, 'browser DOM layout capture is non-empty');
  console.log(`QA capture smoke passed${chromiumOptions ? ' (SwiftShader CPU-only)' : ''}: ${capture.layout.length} layout entries at ${capture.width}×${capture.height}.`);
  } finally {
    await browser?.close({ silent: true }).catch(() => {});
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
