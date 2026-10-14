import { PrismaClient } from '@prisma/client';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StoryboardSchema } from '@m2v/schema';
import dotenv from 'dotenv';

const repo = resolve(process.cwd(), '../..');
dotenv.config({ path: resolve(repo, 'apps/web/.env') });
const prisma = new PrismaClient();
const outputRoot = resolve(repo, 'data/projects');
const entryPoint = resolve(repo, 'apps/worker/src/entry.tsx');
let bundleLocation: string | undefined;
let busy = false;

const execFileAsync = promisify(execFile);
async function encode(raw: string, final: string) {
  // Async FFmpeg leaves the event loop free to update the render heartbeat.
  const run = (args: string[]) => execFileAsync('ffmpeg', args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const { stdout } = await run(['-hide_banner', '-encoders']);
  if (/h264_qsv/.test(stdout)) {
    try { await run(['-y', '-i', raw, '-c:v', 'h264_qsv', '-global_quality', '23', '-c:a', 'aac', '-movflags', '+faststart', final]); return; }
    catch { /* Fall back to software encoding. */ }
  }
  await run(['-y', '-i', raw, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-movflags', '+faststart', final]);
}

async function syncBundleAudio(storyboard: { scenes: { audioSrc?: string }[] }) {
  if (!bundleLocation) return;
  const publicDir = resolve(repo, 'apps/web/public');
  const bundlePublicDir = join(bundleLocation, 'public');
  for (const scene of storyboard.scenes) {
    if (!scene.audioSrc) continue;
    const filename = scene.audioSrc.startsWith('audio/') ? scene.audioSrc.slice('audio/'.length) : '';
    if (!filename || filename !== filename.split(/[\\/]/).at(-1) || filename === '.' || filename === '..') {
      throw new Error(`场景音频路径无效：${scene.audioSrc}`);
    }
    const source = join(publicDir, 'audio', filename);
    const target = join(bundlePublicDir, 'audio', filename);
    try { await access(source); } catch { throw new Error(`找不到场景音频文件：${source}`); }
    await mkdir(join(bundlePublicDir, 'audio'), { recursive: true });
    await copyFile(source, target);
  }
}

async function syncBundleAssets(projectId: string, assetsJson: string) {
  if (!bundleLocation) return;
  const assets = JSON.parse(assetsJson || '[]') as { name: string; path: string }[];
  const assetDir = join(outputRoot, projectId, 'assets');
  const publicAssetDir = join(bundleLocation, 'public', 'projects', projectId, 'assets');
  await mkdir(publicAssetDir, { recursive: true });
  for (const asset of assets) {
    if (!asset.name || asset.name !== asset.name.split(/[\\/]/).at(-1) || asset.name === '.' || asset.name === '..') throw new Error(`素材文件名无效：${asset.name}`);
    await copyFile(join(assetDir, asset.name), join(publicAssetDir, asset.name));
  }
}

async function renderJob(jobId: string, projectId: string) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  if (!project.storyboardJson) throw new Error('项目尚无分镜');
  const storyboard = StoryboardSchema.parse(JSON.parse(project.storyboardJson));
  const dir = join(outputRoot, projectId, 'output'); await mkdir(dir, { recursive: true });
  const temp = await mkdtemp(join(tmpdir(), 'm2v-render-')); const raw = join(temp, 'raw.mp4'); const final = join(dir, 'final.mp4');
  try {
    bundleLocation ??= await bundle({ entryPoint, publicDir: resolve(repo, 'apps/web/public'), webpackOverride: (config) => config });
    await syncBundleAudio(storyboard);
    await syncBundleAssets(projectId, project.assetsJson);
    const inputProps = { storyboard };
    const composition = await selectComposition({ serveUrl: bundleLocation, id: 'ExplainerVideo', inputProps });
    await renderMedia({ composition, serveUrl: bundleLocation, codec: 'h264', outputLocation: raw, inputProps });
    await prisma.$transaction(async tx => {
      const updated = await tx.job.updateMany({ where: { id: jobId, status: 'running' }, data: { stage: 'encoding' } });
      if (!updated.count) throw new Error('渲染任务已结束或被恢复，停止写入旧状态');
      await tx.project.update({ where: { id: projectId }, data: { status: 'encoding' } });
    });
    await encode(raw, final);
    await finishJob(jobId, projectId, 'completed', null);
  } finally { await rm(temp, { recursive: true, force: true }).catch(error => console.warn('[worker] temporary cleanup failed', error)); }
}

async function finishJob(jobId: string, projectId: string, status: 'completed' | 'failed', error: string | null) {
  await prisma.$transaction(async tx => {
    const updated = await tx.job.updateMany({ where: { id: jobId, status: 'running' }, data: { status, stage: status, error } });
    if (updated.count) await tx.project.update({ where: { id: projectId }, data: { status } });
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
      void prisma.job.updateMany({ where: { id: job.id, status: 'running' }, data: { updatedAt: new Date() } }).catch(error => console.error('[worker] heartbeat failed', error));
    }, 15_000);
    try { await renderJob(job.id, job.projectId); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await finishJob(job.id, job.projectId, 'failed', message);
      console.error(`[worker] job ${job.id}: ${message}`);
    } finally { clearInterval(heartbeat); }
  } finally { busy = false; }
}

console.log('[worker] polling local SQLite render queue');
setInterval(() => void poll().catch((error) => console.error('[worker] poll failed', error)), 2500);
void poll();
