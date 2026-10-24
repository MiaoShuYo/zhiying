import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RENDER_STAGES, RENDER_STAGE_LABELS } from '@m2v/schema';
import { db } from './db';

const dataRoot = () => resolve(process.cwd(), '../../data');

const isRenderStage = (value: string | null | undefined): value is (typeof RENDER_STAGES)[number] =>
  Boolean(value) && (RENDER_STAGES as readonly string[]).includes(value as string);

/** A render job that stops heartbeating for this long is treated as dead. */
export const RENDER_STALE_MS = 5 * 60_000;

export type RenderRecovery = {
  /** Render jobs this call closed out as failed. */
  failed: number;
  /** Projects that had a render job closed out. */
  projectIds: string[];
  /** Still-running render jobs inside the grace window; explains a zero result. */
  pending: number;
};

/**
 * A stale job keeps the stage it was in, so the retry UI can say which step
 * stopped instead of a generic "render failed".
 */
export async function recoverInterruptedRenderJobs(projectId?: string): Promise<RenderRecovery> {
  const staleBefore = new Date(Date.now() - RENDER_STALE_MS);
  const jobs = await db.job.findMany({ where: { kind: 'render', ...(projectId ? { projectId } : {}), status: { in: ['running', 'cancelling'] }, updatedAt: { lt: staleBefore } } });
  const projectIds: string[] = [];
  for (const job of jobs) {
    const stage = isRenderStage(job.stage) ? job.stage : 'bundling';
    const label = RENDER_STAGE_LABELS[stage] ?? stage;
    const closedOut = await db.$transaction(async tx => {
      const claimed = await tx.job.updateMany({
        where: { id: job.id, status: { in: ['running', 'cancelling'] }, updatedAt: { lt: staleBefore } },
        data: {
          status: 'failed',
          stage: 'failed',
          failedStage: stage,
          failureCode: 'worker_lost',
          error: `阶段 ${label}：渲染进程已中断或超过 ${RENDER_STALE_MS / 60_000} 分钟未更新运行状态。请确认本地 Worker 已启动，然后从已完成片段继续。`,
        },
      });
      if (!claimed.count) return false;
      const active = await tx.job.count({ where: { projectId: job.projectId, status: { in: ['queued', 'running', 'cancelling'] } } });
      if (!active) await tx.project.updateMany({ where: { id: job.projectId, status: { in: ['rendering', 'encoding'] } }, data: { status: 'failed' } });
      return true;
    });
    if (closedOut) projectIds.push(job.projectId);
  }
  const pending = await db.job.count({ where: { kind: 'render', ...(projectId ? { projectId } : {}), status: { in: ['running', 'cancelling'] }, updatedAt: { gte: staleBefore } } });
  // Repair older partially-written terminal states as well.
  const projects = await db.project.findMany({ where: { ...(projectId ? { id: projectId } : {}), status: { in: ['rendering', 'encoding'] }, jobs: { none: { status: { in: ['queued', 'running', 'cancelling'] } } } }, select: { id: true, jobs: { where: { kind: 'render' }, orderBy: { createdAt: 'desc' }, take: 1 } } });
  for (const project of projects) {
    const last = project.jobs[0];
    if (!last || !['failed', 'completed', 'cancelled'].includes(last.status)) continue;
    await db.project.updateMany({ where: { id: project.id, status: { in: ['rendering', 'encoding'] }, jobs: { none: { status: { in: ['queued', 'running', 'cancelling'] } } } }, data: { status: last.status === 'cancelled' ? 'awaiting_review' : last.status } });
  }
  return { failed: projectIds.length, projectIds, pending };
}

export type OrphanOutput = { jobId: string; bytes: number };

/**
 * Files left behind by an interrupted run. They are never presented as an
 * export, because only a completed job reaches the delivery records.
 */
export async function findOrphanOutputs(projectId: string, jobIds: string[]): Promise<OrphanOutput[]> {
  const found: OrphanOutput[] = [];
  for (const jobId of jobIds) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) continue;
    const info = await stat(resolve(dataRoot(), 'projects', projectId, 'output', `${jobId}.mp4`)).catch(() => null);
    if (info?.isFile()) found.push({ jobId, bytes: info.size });
  }
  return found;
}
