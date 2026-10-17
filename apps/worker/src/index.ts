import { PrismaClient } from '@prisma/client';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition, makeCancelSignal } from '@remotion/renderer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, rm, writeFile, copyFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StoryboardSchema } from '@m2v/schema';
import dotenv from 'dotenv';

const repo = resolve(process.cwd(), '../..');
dotenv.config({ path: resolve(repo, 'apps/web/.env') });
const prisma = new PrismaClient();
const outputRoot = resolve(repo, 'data/projects');
const entryPoint = resolve(repo, 'apps/worker/src/entry.tsx');
const browserExecutable = [process.env.REMOTION_BROWSER_EXECUTABLE, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path));
let bundleLocation: string | undefined;
let busy = false;

const execFileAsync = promisify(execFile);
async function encode(raw: string, final: string, signal: AbortSignal, progress: (seconds: number) => void) {
  // Async FFmpeg leaves the event loop free to update the render heartbeat.
  const run = (args: string[]) => { const child = execFileAsync('ffmpeg', args, { windowsHide: true, signal, maxBuffer: 8 * 1024 * 1024 }); child.child.stdout?.on('data', (chunk: Buffer) => { for (const match of chunk.toString().matchAll(/out_time_us=(\d+)/g)) progress(Number(match[1]) / 1e6); }); return child; };
  const { stdout } = await run(['-hide_banner', '-encoders']);
  if (/h264_qsv/.test(stdout)) {
    try { await run(['-progress', 'pipe:1', '-nostats', '-y', '-i', raw, '-c:v', 'h264_qsv', '-global_quality', '23', '-c:a', 'aac', '-movflags', '+faststart', final]); return; }
    catch (error) { if (signal.aborted) throw error; /* QSV unavailable: software fallback. */ }
  }
  await run(['-progress', 'pipe:1', '-nostats', '-y', '-i', raw, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-movflags', '+faststart', final]);
}

async function syncPublicAssets(projectId: string, assetsJson: string) {
  const assets = JSON.parse(assetsJson || '[]') as { name: string; path: string }[];
  const assetDir = join(outputRoot, projectId, 'assets');
  const publicAssetDir = join(repo, 'apps/web/public/projects', projectId, 'assets');
  await mkdir(publicAssetDir, { recursive: true });
  for (const asset of assets) {
    if (!asset.name || asset.name !== asset.name.split(/[\\/]/).at(-1) || asset.name === '.' || asset.name === '..') throw new Error(`素材文件名无效：${asset.name}`);
    await copyFile(join(assetDir, asset.name), join(publicAssetDir, asset.name));
  }
}

async function bundleHasAssets(storyboard: { scenes: { audioSrc?: string; visual?: unknown }[] }, projectId: string, assetsJson: string) {
  if (!bundleLocation) return false;
  const paths = storyboard.scenes.flatMap(scene => {
    const result: string[] = [];
    if (scene.audioSrc) result.push(scene.audioSrc);
    const visit = (value: unknown) => {
      if (typeof value === 'string' && value.startsWith(`projects/${projectId}/assets/`)) result.push(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(scene.visual);
    return result;
  });
  for (const asset of JSON.parse(assetsJson || '[]') as { name: string }[]) paths.push(`projects/${projectId}/assets/${asset.name}`);
  for (const path of paths) {
    if (!/^(?:audio|projects\/[a-zA-Z0-9_-]+\/assets)\/[a-zA-Z0-9_.-]+$/.test(path)) throw new Error(`渲染素材路径无效：${path}`);
    try { await access(join(bundleLocation, 'public', path)); } catch { return false; }
  }
  return true;
}

async function ensureBundle(storyboard: { scenes: { audioSrc?: string; visual?: unknown }[] }, projectId: string, assetsJson: string): Promise<string> {
  await syncPublicAssets(projectId, assetsJson);
  if (await bundleHasAssets(storyboard, projectId, assetsJson)) return bundleLocation!;
  const oldBundle = bundleLocation;
  bundleLocation = await bundle({ entryPoint, publicDir: resolve(repo, 'apps/web/public'), webpackOverride: config => config });
  if (oldBundle && oldBundle !== bundleLocation) await rm(oldBundle, { recursive: true, force: true }).catch(() => {});
  if (!(await bundleHasAssets(storyboard, projectId, assetsJson))) {
    throw new Error('渲染资源未能打包：请重新生成场景语音或重新导入缺失图片');
  }
  return bundleLocation;
}

async function renderJob(jobId: string, projectId: string) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  if (!project.storyboardJson) throw new Error('项目尚无分镜');
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  const input = job.inputJson ? JSON.parse(job.inputJson) : { storyboard: JSON.parse(project.storyboardJson), preset: 'full' };
  const storyboard = StoryboardSchema.parse(input.storyboard);
  const abort = new AbortController(); const { cancel, cancelSignal } = makeCancelSignal();
  const check = async () => { const current = await prisma.job.findUnique({ where: { id: jobId } }); if (!current || current.status !== 'running') { abort.abort(); cancel(); } };

  let lastProgress = 0;
  const progress = async (phase: string, percent?: number) => { if (percent !== undefined && Date.now() - lastProgress < 500) return; lastProgress = Date.now(); await prisma.job.updateMany({ where: { id: jobId, status: 'running' }, data: { stage: phase, progress: JSON.stringify({ phase, percent, message: ({ bundling: '准备渲染资源', rendering: '渲染画面', encoding: '编码视频' } as Record<string,string>)[phase] }) } }); };
  const ensureActive = async () => { await check(); if (abort.signal.aborted) throw new Error('已取消渲染'); };
  const dir = join(outputRoot, projectId, 'output'); await mkdir(dir, { recursive: true });
  const temp = await mkdtemp(join(tmpdir(), 'm2v-render-')); const raw = join(temp, 'raw.mp4'); const final = join(dir, `${jobId}.mp4`); const partial = join(dir, `${jobId}.partial.mp4`);
  const watcher = setInterval(() => void check().catch(console.error), 500);
  try {
    await progress('bundling'); await ensureActive();
    const serveUrl = await ensureBundle(storyboard, projectId, project.assetsJson);
    await ensureActive();
    const inputProps = { storyboard };
    const composition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps, browserExecutable });
    await ensureActive(); await progress('rendering');
    await renderMedia({ composition, serveUrl, codec: 'h264', outputLocation: raw, inputProps, browserExecutable, scale: input.preset === 'draft' ? .5 : 1, cancelSignal, onProgress: ({ progress: value }) => { void progress('rendering', Math.round(value * 100)).catch(console.error); } });
    await ensureActive();
    await prisma.$transaction(async tx => {
      const updated = await tx.job.updateMany({ where: { id: jobId, status: 'running' }, data: { stage: 'encoding' } });
      if (!updated.count) throw new Error('渲染任务已结束或被恢复，停止写入旧状态');
      await tx.project.update({ where: { id: projectId }, data: { status: 'encoding' } });
    });
    await progress('encoding');
    await encode(raw, partial, abort.signal, seconds => { void progress('encoding', Math.min(99, Math.round(seconds / (composition.durationInFrames / composition.fps) * 100))).catch(console.error); });
    await ensureActive(); await rename(partial, final);
    await prisma.job.updateMany({ where: { id: jobId, status: 'running' }, data: { outputPath: `${jobId}.mp4` } });
    await finishJob(jobId, projectId, 'completed', null);
    const terminal = await prisma.job.findUnique({ where: { id: jobId } });
    if (terminal?.status === 'cancelling') { await rm(final, { force: true }); await finishJob(jobId, projectId, 'cancelled', null); }
  } finally { clearInterval(watcher); await rm(partial, { force: true }).catch(() => {}); await rm(temp, { recursive: true, force: true }).catch(error => console.warn('[worker] temporary cleanup failed', error)); }
}

async function finishJob(jobId: string, projectId: string, status: 'completed' | 'failed' | 'cancelled', error: string | null) {
  await prisma.$transaction(async tx => {
    const updated = await tx.job.updateMany({ where: { id: jobId, status: { in: status === 'cancelled' ? ['cancelling', 'running'] : ['running'] } }, data: { status, stage: status, error, progress: JSON.stringify({ phase: status, percent: status === 'completed' ? 100 : undefined }) } });
    if (updated.count) await tx.project.update({ where: { id: projectId }, data: { status: status === 'cancelled' ? 'awaiting_review' : status } });
  });
}

async function poll() {
  if (busy) return;
  busy = true;
  try {
    const job = await prisma.job.findFirst({ where: { kind: 'render', status: 'queued' }, orderBy: { createdAt: 'asc' } });
    if (!job) return;
    const claimed = await prisma.$transaction(async tx => {
      const result = await tx.job.updateMany({ where: { id: job.id, status: 'queued' }, data: { status: 'running', stage: 'rendering', attempt: { increment: 1 }, error: null } });
      if (result.count) await tx.project.update({ where: { id: job.projectId }, data: { status: 'rendering' } });
      return result.count;
    });
    if (!claimed) return;
    const heartbeat = setInterval(() => {
      void prisma.job.updateMany({ where: { id: job.id, status: { in: ['running', 'cancelling'] } }, data: { updatedAt: new Date() } }).catch(error => console.error('[worker] heartbeat failed', error));
    }, 15_000);
    try { await renderJob(job.id, job.projectId); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const latest = await prisma.job.findUnique({ where: { id: job.id } });
      await finishJob(job.id, job.projectId, latest?.status === 'cancelling' ? 'cancelled' : 'failed', latest?.status === 'cancelling' ? null : `阶段 ${latest?.stage ?? 'unknown'}：${message}`);
      console.error(`[worker] job ${job.id}: ${message}`);
    } finally { clearInterval(heartbeat); }
  } finally { busy = false; }
}

console.log('[worker] polling local SQLite render queue');
setInterval(() => void poll().catch((error) => console.error('[worker] poll failed', error)), 2500);
void poll();

async function heartbeat() { await mkdir(resolve(repo, 'data'), { recursive: true }); await writeFile(resolve(repo, 'data/worker-heartbeat.json'), JSON.stringify({ pid: process.pid, time: Date.now() })); }
void heartbeat(); setInterval(() => void heartbeat().catch(console.error), 5000);
