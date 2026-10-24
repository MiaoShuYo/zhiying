import { PrismaClient } from '@prisma/client';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition, makeCancelSignal, openBrowser } from '@remotion/renderer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, rm, stat, writeFile, copyFile, rename } from 'node:fs/promises';
import { cpus, freemem, tmpdir, totalmem } from 'node:os';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  RENDER_STAGES,
  RENDER_STAGE_LABELS,
  StoryboardSchema,
  evaluateRender,
  segmentFrameRange,
  segmentLabel,
  segmentPlan,
  type AudioSignature,
  type ExpectedRender,
  type RenderFailureCode,
  type RenderPlan,
  type RenderStage,
  type Storyboard,
} from '@m2v/schema';
import { probeVideoFile } from '@m2v/video/probe';
import dotenv from 'dotenv';
import { JOB_ID_PATTERN, jobLogFileName, openJobLog } from './job-log';
import { ensureSegmentDir, pruneSegmentCache, readSegmentIndex, segmentBytes, segmentDir, segmentVideoPath, writeSegmentMeta } from './segment-cache';

const repo = resolve(process.cwd(), '../..');
dotenv.config({ path: resolve(repo, 'apps/web/.env') });
const prisma = new PrismaClient();
const outputRoot = resolve(repo, 'data/projects');
const publicRoot = resolve(repo, 'apps/web/public');
const entryPoint = resolve(repo, 'apps/worker/src/entry.tsx');
const browserExecutable = [process.env.REMOTION_BROWSER_EXECUTABLE, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path));
let bundleLocation: string | undefined;
let busy = false;
let previousCpuSample: { idle: number; total: number } | null = null;

const execFileAsync = promisify(execFile);

/** Carries the stage and a stable code so the UI can explain what failed. */
class RenderFailure extends Error {
  constructor(readonly stage: RenderStage, readonly code: RenderFailureCode, message: string) {
    super(message);
  }
}

const describeError = (error: unknown) => {
  if (error instanceof Error) {
    const stderr = (error as Error & { stderr?: string }).stderr?.trim().split('\n').slice(-4).join(' ') ?? '';
    return stderr ? `${error.message} ${stderr}` : error.message;
  }
  return String(error);
};

/** Classifies a failure for the retry UI; the stage decides the code unless the error is specific. */
function classifyFailure(error: unknown, stage: RenderStage): { code: RenderFailureCode; message: string } {
  if (error instanceof RenderFailure) return { code: error.code, message: error.message };
  const message = describeError(error);
  if (/渲染资源未能打包|ENOENT/.test(message)) return { code: 'asset_missing', message };
  const codes: Record<string, RenderFailureCode> = { bundling: 'render_failed', rendering: 'render_failed', concatenating: 'concat_failed', encoding: 'encode_failed', validating: 'validate_failed' };
  return { code: codes[stage] ?? 'unknown', message };
}

async function encode(raw: string, final: string, signal: AbortSignal, progress: (seconds: number) => void) {
  // Async FFmpeg leaves the event loop free to update the render heartbeat.
  const run = (args: string[]) => { const child = execFileAsync('ffmpeg', args, { windowsHide: true, signal, maxBuffer: 8 * 1024 * 1024 }); child.child.stdout?.on('data', (chunk: Buffer) => { for (const match of chunk.toString().matchAll(/out_time_us=(\d+)/g)) progress(Number(match[1]) / 1e6); }); return child; };
  const { stdout } = await run(['-hide_banner', '-encoders']);
  if (/h264_qsv/.test(stdout)) {
    try { await run(['-progress', 'pipe:1', '-nostats', '-y', '-i', raw, '-c:v', 'h264_qsv', '-global_quality', '23', '-c:a', 'aac', '-movflags', '+faststart', final]); return; } catch (error) { if (signal.aborted) throw error; /* QSV unavailable: software fallback. */ }
  }
  await run(['-progress', 'pipe:1', '-nostats', '-y', '-i', raw, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-movflags', '+faststart', final]);
}

/** Joins the cached segments; `forSeamlessAacConcatenation` makes a stream copy gapless. */
async function concatSegments(listPath: string, files: string[], raw: string, signal: AbortSignal) {
  const quote = (file: string) => {
    if (file.includes("'")) throw new Error(`片段路径包含非法字符：${file}`);
    return `file '${file.split(sep).join('/')}'`;
  };
  await writeFile(listPath, `${files.map(quote).join('\n')}\n`, 'utf8');
  await execFileAsync('ffmpeg', ['-hide_banner', '-nostats', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', raw], { windowsHide: true, signal, maxBuffer: 8 * 1024 * 1024 });
}

async function syncPublicAssets(projectId: string, assetsJson: string) {
  const assets = (JSON.parse(assetsJson || '[]') as { name: string; path: string; archived?: boolean }[]).filter(asset => !asset.archived);
  const assetDir = join(outputRoot, projectId, 'assets');
  const publicAssetDir = join(publicRoot, 'projects', projectId, 'assets');
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
  for (const asset of (JSON.parse(assetsJson || '[]') as { name: string; archived?: boolean }[]).filter(item => !item.archived)) paths.push(`projects/${projectId}/assets/${asset.name}`);
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
  bundleLocation = await bundle({ entryPoint, publicDir: publicRoot, webpackOverride: config => config });
  if (oldBundle && oldBundle !== bundleLocation) await rm(oldBundle, { recursive: true, force: true }).catch(() => {});
  if (!(await bundleHasAssets(storyboard, projectId, assetsJson))) {
    throw new Error('渲染资源未能打包：请重新生成场景语音或重新导入缺失图片');
  }
  return bundleLocation;
}

/** File identity for narration, so regenerating a voice with the same name invalidates its segment. */
async function audioSignatures(storyboard: Storyboard): Promise<Record<string, AudioSignature>> {
  const result: Record<string, AudioSignature> = {};
  for (const scene of storyboard.scenes) {
    const src = scene.audioSrc;
    if (!src || result[src]) continue;
    const info = await stat(resolve(publicRoot, src)).catch(() => null);
    if (info) result[src] = { bytes: info.size, mtimeMs: info.mtimeMs };
  }
  return result;
}

/** Segments from the last two finished renders stay cached so switching back is instant. */
async function keepFingerprints(projectId: string, jobId: string, plan: RenderPlan): Promise<Set<string>> {
  const keep = new Set(plan.segments.map(segment => segment.fingerprint));
  const recent = await prisma.job.findMany({ where: { projectId, kind: 'render', status: 'completed', id: { not: jobId } }, orderBy: { createdAt: 'desc' }, take: 2, select: { renderPlanJson: true } }).catch(() => []);
  for (const job of recent) {
    if (!job.renderPlanJson) continue;
    try {
      for (const segment of (JSON.parse(job.renderPlanJson) as RenderPlan).segments) keep.add(segment.fingerprint);
    } catch {
      // A plan written by an older worker is simply ignored.
    }
  }
  return keep;
}

async function renderJob(jobId: string, projectId: string) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  if (!project.storyboardJson) throw new Error('项目尚无分镜');
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  const input = job.inputJson ? JSON.parse(job.inputJson) : { storyboard: JSON.parse(project.storyboardJson), preset: 'full' };
  const storyboard = StoryboardSchema.parse(input.storyboard);
  const preset: 'full' | 'draft' = input.preset === 'draft' ? 'draft' : 'full';
  const abort = new AbortController();
  const { cancel, cancelSignal } = makeCancelSignal();
  const check = async () => { const current = await prisma.job.findUnique({ where: { id: jobId } }); if (!current || current.status !== 'running') { abort.abort(); cancel(); } };

  const dir = join(outputRoot, projectId, 'output');
  await mkdir(dir, { recursive: true });
  const log = await openJobLog(dir, jobId);
  let stage: RenderStage = 'bundling';
  let lastTick = 0;
  // Percent stays stage-local; the UI maps each stage to a slice of the bar.
  const enterStage = async (next: RenderStage) => {
    stage = next;
    await prisma.job.updateMany({ where: { id: jobId, status: 'running' }, data: { stage: next, progress: JSON.stringify({ phase: next, percent: 0, message: RENDER_STAGE_LABELS[next] }) } });
    await log.info(`阶段：${RENDER_STAGE_LABELS[next]}`);
  };
  const tick = async (percent: number) => {
    if (Date.now() - lastTick < 500) return;
    lastTick = Date.now();
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    await prisma.job.updateMany({ where: { id: jobId, status: 'running' }, data: { progress: JSON.stringify({ phase: stage, percent: value, message: RENDER_STAGE_LABELS[stage] }) } });
  };
  const ensureActive = async () => { await check(); if (abort.signal.aborted) throw new RenderFailure(stage, 'cancelled', '已取消渲染'); };

  const temp = await mkdtemp(join(tmpdir(), 'm2v-render-'));
  const raw = join(temp, 'raw.mp4');
  const concatList = join(temp, 'segments.txt');
  const final = join(dir, `${jobId}.mp4`);
  const partial = join(dir, `${jobId}.partial.mp4`);
  const cacheDir = segmentDir(dir, preset);
  const watcher = setInterval(() => void check().catch(console.error), 500);
  let width = 0;
  let height = 0;
  try {
    await log.info('开始渲染', { projectId, preset, attempt: job.attempt });
    await enterStage('bundling');
    await ensureActive();
    const serveUrl = await ensureBundle(storyboard, projectId, project.assetsJson);
    await log.info('渲染资源已就绪');
    await ensureActive();

    await ensureSegmentDir(cacheDir);
    // `noCache` comes from the "ignore cache and re-render" retry option.
    const cached = input.noCache === true ? [] : await readSegmentIndex(cacheDir);
    if (input.noCache === true) await log.warn('已忽略片段缓存，重新渲染全部画面');
    const plan = segmentPlan({ storyboard, preset, cached, audioSignatures: await audioSignatures(storyboard) });
    await prisma.job.updateMany({ where: { id: jobId, status: 'running' }, data: { renderPlanJson: JSON.stringify(plan) } });
    await log.info('渲染计划已生成', { segments: plan.segments.length, reused: plan.reusedCount, rendered: plan.renderedCount, totalSeconds: plan.totalSeconds, renderedSeconds: plan.renderedSeconds });
    for (const segment of plan.segments.filter(item => !item.reuse)) await log.info(`待渲染：${segmentLabel(segment, storyboard)}`, { frames: segment.frames, reason: segment.reason });

    const inputProps = { storyboard };
    const pending = plan.segments.filter(segment => !segment.reuse);
    const browser = await openBrowser('chrome', { browserExecutable: browserExecutable ?? null });
    try {
      const composition = await selectComposition({ serveUrl, id: 'ExplainerVideo', inputProps, browserExecutable, puppeteerInstance: browser });
      width = composition.width;
      height = composition.height;
      if (Math.abs(composition.durationInFrames - plan.totalFrames) > 1) {
        await log.warn('时间轴与渲染计划不一致', { compositionFrames: composition.durationInFrames, planFrames: plan.totalFrames });
      }
      const scale = preset === 'draft' ? .5 : 1;
      const renderedFrames = pending.reduce((total, segment) => total + segment.frames, 0) || 1;
      let doneFrames = 0;
      await enterStage('rendering');
      for (const segment of pending) {
        await ensureActive();
        const target = segmentVideoPath(cacheDir, segment);
        const label = segmentLabel(segment, storyboard);
        try {
          await renderMedia({
            composition,
            serveUrl,
            codec: 'h264',
            outputLocation: target,
            inputProps,
            browserExecutable,
            puppeteerInstance: browser,
            scale,
            crf: 16,
            frameRange: segmentFrameRange(segment),
            enforceAudioTrack: true,
            forSeamlessAacConcatenation: true,
            cancelSignal,
            onProgress: ({ progress }) => { void tick(((doneFrames + segment.frames * progress) / renderedFrames) * 100).catch(console.error); },
          });
        } catch (error) {
          await rm(target, { force: true }).catch(() => {});
          throw new RenderFailure('rendering', 'render_failed', `片段「${label}」渲染失败：${describeError(error)}`);
        }
        const bytes = await segmentBytes(target);
        await writeSegmentMeta(cacheDir, segment, bytes, preset);
        doneFrames += segment.frames;
        await log.info(`片段完成：${label}`, { frames: segment.frames, bytes, fingerprint: segment.fingerprint });
        await tick((doneFrames / renderedFrames) * 100);
      }
      if (plan.reusedCount > 0) await log.info(`复用 ${plan.reusedCount} 个已缓存片段`, { reusedSeconds: plan.reusedSeconds });
    } finally {
      await browser.close({ silent: true }).catch(error => console.warn('[worker] browser close failed', error));
    }

    await ensureActive();
    await enterStage('concatenating');
    try {
      await concatSegments(concatList, plan.segments.map(segment => segmentVideoPath(cacheDir, segment)), raw, abort.signal);
    } catch (error) {
      throw new RenderFailure('concatenating', 'concat_failed', `片段拼接失败：${describeError(error)}`);
    }
    await log.info('片段拼接完成', { segments: plan.segments.length, bytes: await segmentBytes(raw) });

    await ensureActive();
    await prisma.$transaction(async tx => {
      const updated = await tx.job.updateMany({ where: { id: jobId, status: 'running' }, data: { stage: 'encoding' } });
      if (!updated.count) throw new Error('渲染任务已结束或被恢复，停止写入旧状态');
      await tx.project.update({ where: { id: projectId }, data: { status: 'encoding' } });
    });
    await enterStage('encoding');
    try {
      await encode(raw, partial, abort.signal, seconds => { void tick(Math.min(99, (seconds / (plan.totalFrames / plan.fps)) * 100)).catch(console.error); });
    } catch (error) {
      throw new RenderFailure('encoding', 'encode_failed', `视频编码失败：${describeError(error)}`);
    }
    await ensureActive();
    await rename(partial, final);
    await log.info('成片已编码', { bytes: await segmentBytes(final) });
    await enterStage('validating');
    // The file is already complete; a failed probe must not turn this job red, so the
    // verdict is written when available and skipped otherwise.
    const validation = await validateRender(final, {
      width: Math.round(width * (preset === 'draft' ? .5 : 1)),
      height: Math.round(height * (preset === 'draft' ? .5 : 1)),
      duration: plan.totalFrames / plan.fps,
      requireAudio: storyboard.scenes.some(scene => scene.narration.trim().length > 0 || Boolean(scene.audioSrc)) || Boolean(storyboard.bgmSrc),
    });
    await prisma.job.updateMany({
      where: { id: jobId, status: 'running' },
      data: { outputPath: `${jobId}.mp4`, ...(validation ? { validationJson: JSON.stringify(validation) } : {}) },
    });
    if (validation) await log.info('成片校验完成', { issues: validation.issues.length });
    await finishJob(jobId, projectId, 'completed', null);
    await log.info('渲染完成');
    const terminal = await prisma.job.findUnique({ where: { id: jobId } });
    if (terminal?.status === 'cancelling') { await rm(final, { force: true }); await finishJob(jobId, projectId, 'cancelled', null); await log.warn('成片已按取消请求删除'); }
    const pruned = await pruneSegmentCache(cacheDir, await keepFingerprints(projectId, jobId, plan)).catch(() => null);
    if (pruned) await log.info('片段缓存已整理', pruned);
  } finally {
    clearInterval(watcher);
    await rm(partial, { force: true }).catch(() => {});
    await rm(temp, { recursive: true, force: true }).catch(error => console.warn('[worker] temporary cleanup failed', error));
    await log.close();
  }
}

/** Best-effort file check; returns `null` when the probe itself fails so the job still completes. */
async function validateRender(file: string, expected: ExpectedRender) {
  try {
    const bytes = (await stat(file).catch(() => null))?.size ?? 0;
    const probed = await probeVideoFile(file);
    return evaluateRender(probed?.probe ?? null, expected, probed?.bytes ?? bytes);
  } catch (error) {
    console.warn('[worker] render validation skipped', error);
    return null;
  }
}

async function finishJob(jobId: string, projectId: string, status: 'completed' | 'failed' | 'cancelled', error: string | null, failure?: { stage: RenderStage; code: RenderFailureCode }) {
  await prisma.$transaction(async tx => {
    const updated = await tx.job.updateMany({
      where: { id: jobId, status: { in: status === 'cancelled' ? ['cancelling', 'running'] : ['running'] } },
      data: {
        status,
        stage: status,
        error,
        progress: JSON.stringify({ phase: status, percent: status === 'completed' ? 100 : undefined }),
        ...(failure ? { failedStage: failure.stage, failureCode: failure.code } : {}),
      },
    });
    if (updated.count) await tx.project.update({ where: { id: projectId }, data: { status: status === 'cancelled' ? 'awaiting_review' : status } });
  });
}

const isRenderStage = (value: string | null | undefined): value is RenderStage => Boolean(value) && (RENDER_STAGES as readonly string[]).includes(value as string);

async function poll() {
  if (busy) return;
  busy = true;
  try {
    const job = await prisma.job.findFirst({ where: { kind: 'render', status: 'queued' }, orderBy: { createdAt: 'asc' } });
    if (!job) return;
    const claimed = await prisma.$transaction(async tx => {
      const result = await tx.job.updateMany({
        where: { id: job.id, status: 'queued' },
        data: {
          status: 'running',
          stage: 'bundling',
          // Attempt is assigned once when the job is created (retries pass previous + 1);
          // bumping it here as well made a single retry count as two.
          attempt: job.attempt > 0 ? job.attempt : 1,
          error: null,
          failedStage: null,
          failureCode: null,
          startedAt: new Date(),
          logPath: JOB_ID_PATTERN.test(job.id) ? jobLogFileName(job.id) : null,
        },
      });
      if (result.count) await tx.project.update({ where: { id: job.projectId }, data: { status: 'rendering' } });
      return result.count;
    });
    if (!claimed) return;
    const heartbeat = setInterval(() => {
      void prisma.job.updateMany({ where: { id: job.id, status: { in: ['running', 'cancelling'] } }, data: { updatedAt: new Date() } }).catch(error => console.error('[worker] heartbeat failed', error));
    }, 15_000);
    try { await renderJob(job.id, job.projectId); }
    catch (error) {
      const latest = await prisma.job.findUnique({ where: { id: job.id } });
      const cancelled = latest?.status === 'cancelling';
      const stage = isRenderStage(latest?.stage) ? latest.stage : 'bundling';
      const failure = cancelled ? { code: 'cancelled' as RenderFailureCode, message: '已取消渲染' } : classifyFailure(error, stage);
      await finishJob(job.id, job.projectId, cancelled ? 'cancelled' : 'failed', cancelled ? null : `阶段 ${RENDER_STAGE_LABELS[stage] ?? stage}：${failure.message}`, { stage, code: failure.code });
      console.error(`[worker] job ${job.id}: ${failure.message}`);
    } finally { clearInterval(heartbeat); }
  } finally { busy = false; }
}

console.log('[worker] polling local SQLite render queue');
setInterval(() => void poll().catch((error) => console.error('[worker] poll failed', error)), 2500);
void poll();

// The estimate panel needs to know which encoder a render will actually use.
let encoder: 'qsv' | 'x264' | null = null;
async function detectEncoder() {
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-encoders'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    encoder = /h264_qsv/.test(stdout) ? 'qsv' : 'x264';
  } catch { encoder = 'x264'; }
}
async function heartbeat() {
  await mkdir(resolve(repo, 'data'), { recursive: true });
  const cpuTimes = cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((all, value) => all + value, 0) }), { idle: 0, total: 0 });
  const cpuPercent = previousCpuSample && cpuTimes.total > previousCpuSample.total
    ? Math.max(0, Math.min(100, Math.round((1 - (cpuTimes.idle - previousCpuSample.idle) / (cpuTimes.total - previousCpuSample.total)) * 100)))
    : null;
  previousCpuSample = cpuTimes;
  await writeFile(resolve(repo, 'data/worker-heartbeat.json'), JSON.stringify({
    pid: process.pid, time: Date.now(), busy, encoder,
    resources: { cpuPercent, memoryAvailableBytes: freemem(), memoryTotalBytes: totalmem(), workerRssBytes: process.memoryUsage().rss },
  }));
}
void detectEncoder().then(heartbeat);
setInterval(() => void heartbeat().catch(console.error), 5000);
