import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { findOrphanOutputs, recoverInterruptedRenderJobs } from '@/lib/render-recovery';
import { countCachedSegments } from '@/lib/render-plan-server';
import { failureCodeHint, failureInfo, isActiveTask, readTaskProgress, renderPercent, renderRecovery, renderStageLabel, retryModeFor, activeTaskStatuses, chapterProgress, storyboardRetryAllowed, type ChapterEntry } from '@/lib/task-actions';

export const runtime = 'nodejs';

// Only a hint threshold for "任务疑似中断" on kinds nothing sweeps automatically.
// Render jobs are closed out at RENDER_STALE_MS, so they surface as failed long before this.
const staleAfterMs = 15 * 60_000;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const status = params.get('status') ?? '';
  const kind = params.get('kind') ?? '';
  const projectId = params.get('projectId') ?? '';
  // A dead render must show up here as failed-stage + retry, not as a task that silently never moves.
  await recoverInterruptedRenderJobs(projectId || undefined);
  const requested = Number(params.get('limit'));
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(100, requested) : 30;
  const jobs = await db.job.findMany({
    where: {
      ...(projectId ? { projectId } : {}),
      ...(kind ? { kind } : {}),
      ...(status === 'active' ? { status: { in: activeTaskStatuses } } : status === 'failed' ? { status: 'failed' } : status === 'completed' ? { status: 'completed' } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, projectId: true, kind: true, status: true, stage: true, attempt: true, error: true, progress: true, inputJson: true, renderPlanJson: true, failedStage: true, failureCode: true, startedAt: true, createdAt: true, updatedAt: true, project: { select: { name: true, status: true, storyboardJson: true } } },
  });
  const latestStoryboardByProject = new Map<string, { id: string; status: string }>();
  await Promise.all([...new Set(jobs.filter(job => job.kind === 'storyboard').map(job => job.projectId))].map(async id => {
    const latest = await db.job.findFirst({ where: { projectId: id, kind: 'storyboard' }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true } });
    if (latest) latestStoryboardByProject.set(id, latest);
  }));
  const active = await db.job.count({ where: { status: { in: activeTaskStatuses } } });
  const chapterCache = new Map<string, ChapterEntry[] | null>();
  const chaptersOf = async (id: string) => {
    if (!chapterCache.has(id)) {
      try {
        const parsed = JSON.parse(await readFile(resolve(process.cwd(), '../../data/projects', id, 'chapters.json'), 'utf8')) as unknown;
        chapterCache.set(id, Array.isArray(parsed) ? parsed as ChapterEntry[] : null);
      } catch { chapterCache.set(id, null); }
    }
    return chapterCache.get(id) ?? null;
  };
  // One cache probe per project/preset keeps the aggregate cheap even with 30 render jobs.
  const cacheCounts = new Map<string, number>();
  const cacheOf = async (projectId: string, preset: string) => {
    const key = `${projectId}:${preset}`;
    if (!cacheCounts.has(key)) cacheCounts.set(key, await countCachedSegments(projectId, preset));
    return cacheCounts.get(key) ?? 0;
  };
  const now = Date.now();
  const tasks = await Promise.all(jobs.map(async job => {
    const progress = readTaskProgress(job.progress);
    const since = new Date(isActiveTask(job.status) ? job.updatedAt : job.createdAt).getTime();
    const ageMs = now - since;
    const isRender = job.kind === 'render';
    const latestStoryboard = latestStoryboardByProject.get(job.projectId);
    const canRetryStoryboard = job.kind === 'storyboard' && storyboardRetryAllowed({
      jobId: job.id,
      latestJobId: latestStoryboard?.id,
      jobStatus: job.status,
      projectStatus: job.project.status,
      hasStoryboard: Boolean(job.project.storyboardJson),
      failedStage: job.stage,
    });
    const preset = job.inputJson?.includes('"preset":"draft"') ? 'draft' : 'full';
    const cachedSegments = isRender ? await cacheOf(job.projectId, preset) : 0;
    const plan = isRender ? readRenderPlan(job.renderPlanJson) : null;
    const orphans = isRender && ['failed', 'cancelled'].includes(job.status) ? await findOrphanOutputs(job.projectId, [job.id]) : [];
    return {
      id: job.id,
      projectId: job.projectId,
      projectName: job.project.name,
      projectStatus: job.project.status,
      kind: job.kind,
      status: job.status,
      stage: job.stage,
      stageLabel: renderStageLabel(job.stage),
      failedStage: job.failedStage,
      failedStageLabel: renderStageLabel(job.failedStage),
      failureCode: job.failureCode,
      failureCodeHint: failureCodeHint(job.failureCode),
      attempt: job.attempt,
      percent: progress.percent,
      // Render stages are stage-local; the bar needs an overall value.
      overallPercent: isRender ? renderPercent(job.stage, progress.percent) : progress.percent,
      message: progress.message ?? null,
      error: job.error,
      startedAt: job.startedAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      logUrl: `/api/jobs/${job.id}/logs`,
      plan,
      cachedSegments,
      recovery: isRender && ['failed', 'cancelled'].includes(job.status) ? renderRecovery({ failedStage: job.failedStage, failureCode: job.failureCode, hasCache: cachedSegments > 0 }) : null,
      orphanOutput: orphans[0] ? { bytes: orphans[0].bytes } : null,
      retryMode: retryModeFor({ kind: job.kind, status: job.status, ageMs }, job.project.status, canRetryStoryboard),
      failure: failureInfo({ kind: job.kind, status: job.status, stage: job.stage, failedStage: job.failedStage, failureCode: job.failureCode, error: job.error, ageMs }, job.project.status, canRetryStoryboard),
      // A render job carries the whole storyboard in inputJson; a substring test avoids parsing it.
      confirmed: isRender && Boolean(job.inputJson?.includes('"allowIssues":true')),
      chapters: job.kind === 'storyboard' ? chapterProgress(await chaptersOf(job.projectId), progress) : undefined,
    };
  }));
  return NextResponse.json({ tasks, active, staleAfterMs });
}

/** Reuse summary stored on the job; it is the plan the worker actually ran. */
function readRenderPlan(raw?: string | null) {
  if (!raw) return null;
  try {
    const plan = JSON.parse(raw) as { segments?: unknown[]; reusedCount?: number; renderedCount?: number; renderedSeconds?: number; totalSeconds?: number; preset?: string };
    if (!Array.isArray(plan.segments)) return null;
    return {
      preset: plan.preset === 'draft' ? 'draft' : 'full',
      segments: plan.segments.length,
      reused: plan.reusedCount ?? 0,
      rendered: plan.renderedCount ?? plan.segments.length,
      renderedSeconds: plan.renderedSeconds ?? 0,
      totalSeconds: plan.totalSeconds ?? 0,
    };
  } catch { return null; }
}
