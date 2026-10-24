import { readdir, readFile, stat, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  RENDER_FPS,
  blockingFindings,
  estimateRender,
  planReasons,
  segmentPlan,
  type AudioSignature,
  type CachedSegment,
  type PlanReasonSummary,
  type RenderEstimate,
  type RenderPlan,
  type RenderSample,
  type Storyboard,
} from '@m2v/schema';
import { db } from '@/lib/db';
import { parseProject } from '@/lib/pipeline';

/** The web app runs from `apps/web`; data and public assets live at the repo root. */
const repoRoot = () => resolve(process.cwd(), '../..');
const dataRoot = () => resolve(repoRoot(), 'data');
const publicRoot = () => resolve(process.cwd(), 'public');

export const workerHeartbeatPath = () => resolve(dataRoot(), 'worker-heartbeat.json');

/** Segments are cached per preset so a draft render never invalidates the final one. */
export const segmentCacheDir = (projectId: string, preset: string) =>
  resolve(dataRoot(), 'projects', projectId, 'output', 'segments', preset === 'draft' ? 'draft' : 'full');

type WorkerHeartbeat = { time?: number; pid?: number; busy?: boolean; encoder?: string | null; resources?: { cpuPercent?: number | null; memoryAvailableBytes?: number; memoryTotalBytes?: number; workerRssBytes?: number } };

export type WorkerState = { online: boolean; busy: boolean; encoder: string | null; ageMs: number | null; resources: NonNullable<WorkerHeartbeat['resources']> };

const WORKER_STALE_MS = 20_000;

/** Mirrors the environment check: a heartbeat older than 20 seconds means no worker is listening. */
export async function workerState(): Promise<WorkerState> {
  const raw = await readFile(workerHeartbeatPath(), 'utf8').catch(() => null);
  const emptyResources = {};
  if (!raw) return { online: false, busy: false, encoder: null, ageMs: null, resources: emptyResources };
  let parsed: WorkerHeartbeat = {};
  try { parsed = JSON.parse(raw) as WorkerHeartbeat; } catch { return { online: false, busy: false, encoder: null, ageMs: null, resources: emptyResources }; }
  const time = typeof parsed.time === 'number' ? parsed.time : 0;
  const ageMs = time > 0 ? Date.now() - time : null;
  return {
    online: ageMs !== null && ageMs >= 0 && ageMs < WORKER_STALE_MS,
    busy: parsed.busy === true,
    encoder: typeof parsed.encoder === 'string' ? parsed.encoder : null,
    ageMs,
    resources: ageMs !== null && ageMs >= 0 && ageMs < WORKER_STALE_MS ? parsed.resources ?? emptyResources : emptyResources,
  };
}

/** Sidecar driven index; a sidecar without its segment file is treated as missing. */
export async function readCachedSegments(projectId: string, preset: string): Promise<CachedSegment[]> {
  const dir = segmentCacheDir(projectId, preset);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const result: CachedSegment[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const meta = await readFile(join(dir, entry), 'utf8').catch(() => null);
    if (!meta) continue;
    let parsed: CachedSegment | null = null;
    try { parsed = JSON.parse(meta) as CachedSegment; } catch { continue; }
    if (!parsed?.key || !parsed.fingerprint) continue;
    const video = await stat(join(dir, entry.replace(/\.json$/, '.mp4'))).catch(() => null);
    if (!video?.isFile()) continue;
    result.push({ ...parsed, bytes: video.size });
  }
  return result;
}

export const segmentCacheBytes = (segments: CachedSegment[]) => segments.reduce((total, segment) => total + (segment.bytes ?? 0), 0);

/** Cheap cache probe (file names only) so the task list can say whether a retry can reuse segments. */
export async function countCachedSegments(projectId: string, preset: string): Promise<number> {
  const entries = await readdir(segmentCacheDir(projectId, preset)).catch(() => [] as string[]);
  return entries.filter(entry => entry.endsWith('.mp4')).length;
}

/** Same identity the worker uses, so the plan computed here matches the render that follows. */
async function narrationSignatures(storyboard: Storyboard): Promise<Record<string, AudioSignature>> {
  const result: Record<string, AudioSignature> = {};
  for (const scene of storyboard.scenes) {
    const src = scene.audioSrc;
    if (!src || result[src]) continue;
    const absolute = resolve(publicRoot(), src.replace(/^[/\\]+/, ''));
    if (!absolute.startsWith(publicRoot())) continue;
    const info = await stat(absolute).catch(() => null);
    if (info?.isFile()) result[src] = { bytes: info.size, mtimeMs: info.mtimeMs };
  }
  return result;
}

/** Finished renders feed the estimate so the second render of a project is no longer a guess. */
export async function renderSamples(limit = 12): Promise<RenderSample[]> {
  const jobs = await db.job.findMany({
    where: { kind: 'render', status: 'completed', renderPlanJson: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { createdAt: true, updatedAt: true, startedAt: true, renderPlanJson: true, outputPath: true, projectId: true },
  });
  const samples: RenderSample[] = [];
  for (const job of jobs) {
    if (!job.renderPlanJson) continue;
    let plan: Pick<RenderPlan, 'preset' | 'totalSeconds'> | null = null;
    try { plan = JSON.parse(job.renderPlanJson) as Pick<RenderPlan, 'preset' | 'totalSeconds'>; } catch { continue; }
    const videoSeconds = typeof plan?.totalSeconds === 'number' ? plan.totalSeconds : 0;
    if (videoSeconds <= 0) continue;
    const started = job.startedAt ?? job.createdAt;
    const durationSeconds = (job.updatedAt.getTime() - started.getTime()) / 1000;
    if (durationSeconds <= 0) continue;
    const output = job.outputPath ? await stat(resolve(repoRoot(), 'data', 'projects', job.projectId, 'output', job.outputPath)).catch(() => null) : null;
    samples.push({ preset: plan?.preset === 'draft' ? 'draft' : 'full', videoSeconds, durationSeconds, outputBytes: output?.size ?? null });
  }
  return samples;
}

/** Free space on the volume that receives the render output. */
export async function freeDiskBytes(): Promise<number | null> {
  try {
    const info = await statfs(dataRoot());
    const available = Number(info.bavail) * Number(info.bsize);
    return Number.isFinite(available) && available > 0 ? available : null;
  } catch { return null; }
}

export type RenderEstimatePayload = {
  projectId: string;
  preset: 'full' | 'draft';
  plan: RenderPlan;
  estimate: RenderEstimate;
  reasons: PlanReasonSummary[];
  worker: WorkerState;
  cache: { segments: number; bytes: number };
  samples: number;
};

/**
 * Single source for the export panel and the POST gate: the plan says which
 * segments can be reused, the estimate says what the render costs.
 */
export async function buildRenderEstimate(projectId: string, preset: string = 'full', options: { ignoreCache?: boolean } = {}): Promise<RenderEstimatePayload | null> {
  const project = await db.project.findUnique({ where: { id: projectId }, include: { scenes: true } });
  if (!project?.storyboardJson) return null;
  const storyboard = parseProject(project).storyboard;
  if (!storyboard) return null;
  const resolvedPreset = preset === 'draft' ? 'draft' : 'full';
  const cached = await readCachedSegments(projectId, resolvedPreset);
  // `ignoreCache` answers "what would a full re-render cost?" for the restart option.
  const plan = segmentPlan({ storyboard, preset: resolvedPreset, fps: RENDER_FPS, cached: options.ignoreCache ? [] : cached, audioSignatures: await narrationSignatures(storyboard) });
  const [worker, samples, free, queuedJobs] = await Promise.all([
    workerState(),
    renderSamples(),
    freeDiskBytes(),
    db.job.count({ where: { status: { in: ['queued', 'running', 'cancelling'] } } }),
  ]);
  const estimate = estimateRender({ plan, samples, freeDiskBytes: free, workerOnline: worker.online, workerBusy: worker.busy, queuedJobs, encoder: worker.encoder, resources: worker.resources });
  return {
    projectId,
    preset: resolvedPreset,
    plan,
    estimate,
    reasons: planReasons(plan),
    worker,
    cache: { segments: cached.length, bytes: segmentCacheBytes(cached) },
    samples: samples.length,
  };
}

/** Gate rule lives in the shared schema so the export panel and the API agree. */
export { blockingFindings };

/** Compact summary stored on the job so retries and the task centre can show reuse. */
export const planSummary = (plan: RenderPlan) => ({
  segments: plan.segments.length,
  reused: plan.reusedCount,
  rendered: plan.renderedCount,
  renderedSeconds: plan.renderedSeconds,
  totalSeconds: plan.totalSeconds,
});
