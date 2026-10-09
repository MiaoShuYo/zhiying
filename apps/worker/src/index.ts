import { PrismaClient } from '@prisma/client';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { spawnSync } from 'node:child_process';
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

async function encode(raw: string, final: string) {
  const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  if (encoders.status !== 0) throw new Error('找不到 FFmpeg，请安装后将其加入 PATH');
  if (/h264_qsv/.test(encoders.stdout)) {
    const qsv = spawnSync('ffmpeg', ['-y', '-i', raw, '-c:v', 'h264_qsv', '-global_quality', '23', '-c:a', 'aac', '-movflags', '+faststart', final], { encoding: 'utf8' });
    if (qsv.status === 0) return;
  }
  const sw = spawnSync('ffmpeg', ['-y', '-i', raw, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-movflags', '+faststart', final], { encoding: 'utf8' });
  if (sw.status !== 0) throw new Error(`FFmpeg 编码失败：${sw.stderr.slice(-1200)}`);
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

async function renderJob(jobId: string, projectId: string) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  if (!project.storyboardJson) throw new Error('项目尚无分镜');
  const storyboard = StoryboardSchema.parse(JSON.parse(project.storyboardJson));
  const dir = join(outputRoot, projectId, 'output'); await mkdir(dir, { recursive: true });
  const temp = await mkdtemp(join(tmpdir(), 'm2v-render-')); const raw = join(temp, 'raw.mp4'); const final = join(dir, 'final.mp4');
  await prisma.job.update({ where: { id: jobId }, data: { status: 'running', stage: 'rendering', attempt: { increment: 1 } } });
  await prisma.project.update({ where: { id: projectId }, data: { status: 'rendering' } });
  try {
    bundleLocation ??= await bundle({ entryPoint, publicDir: resolve(repo, 'apps/web/public'), webpackOverride: (config) => config });
    await syncBundleAudio(storyboard);
    const inputProps = { storyboard };
    const composition = await selectComposition({ serveUrl: bundleLocation, id: 'ExplainerVideo', inputProps });
    await renderMedia({ composition, serveUrl: bundleLocation, codec: 'h264', outputLocation: raw, inputProps, onProgress: ({ progress }) => { if (progress > 0.02 && progress < 0.99) void prisma.job.update({ where: { id: jobId }, data: { stage: 'rendering' } }); } });
    await prisma.job.update({ where: { id: jobId }, data: { stage: 'encoding' } });
    await prisma.project.update({ where: { id: projectId }, data: { status: 'encoding' } });
    await encode(raw, final);
    await prisma.job.update({ where: { id: jobId }, data: { status: 'completed', stage: 'completed', error: null } });
    await prisma.project.update({ where: { id: projectId }, data: { status: 'completed' } });
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function poll() {
  if (busy) return;
  const job = await prisma.job.findFirst({ where: { kind: 'render', status: 'queued' }, orderBy: { createdAt: 'asc' } });
  if (!job) return;
  busy = true;
  try { await renderJob(job.id, job.projectId); }
  catch (error) { const message = error instanceof Error ? error.message : String(error); await prisma.job.update({ where: { id: job.id }, data: { status: 'failed', stage: 'failed', error: message } }); await prisma.project.update({ where: { id: job.projectId }, data: { status: 'failed' } }); console.error(`[worker] job ${job.id}: ${message}`); }
  finally { busy = false; }
}

console.log('[worker] polling local SQLite render queue');
setInterval(() => void poll().catch((error) => console.error('[worker] poll failed', error)), 2500);
void poll();
