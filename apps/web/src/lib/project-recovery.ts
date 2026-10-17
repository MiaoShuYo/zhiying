import { db } from './db';
import type { ProjectStage } from './pipeline';
import { recoverInterruptedRenderJobs } from './render-recovery';

const stages: ProjectStage[] = ['extracting', 'analyzing', 'storyboarding'];
const activeStatuses = ['queued', 'running', 'cancelling'];
// A synthesis run writes its job once per scene and a single scene request can
// take minutes, so only a much longer silence means the run is really gone.
const audioStaleBefore = () => new Date(Date.now() - 15 * 60_000);

/** Requeue pending storyboard jobs and jobs whose worker stopped heartbeating. */
export async function recoverInterruptedStoryboardJobs(projectId?: string) {
  const staleBefore = new Date(Date.now() - 45_000);
  const jobs = await db.job.findMany({
    where: {
      kind: 'storyboard',
      ...(projectId ? { projectId } : {}),
      OR: [{ status: 'queued', createdAt: { lt: staleBefore } }, { status: 'running', updatedAt: { lt: staleBefore } }],
    },
    orderBy: { createdAt: 'asc' },
  });
  const recoverable: { projectId: string; stage: ProjectStage }[] = [];
  for (const job of jobs) {
    if (!stages.includes(job.stage as ProjectStage)) continue;
    const changed = await db.job.updateMany({
      where: job.status === 'running'
        ? { id: job.id, status: 'running', updatedAt: { lt: staleBefore } }
        : { id: job.id, status: 'queued', createdAt: { lt: staleBefore } },
      data: { status: 'running', error: null, progress: null },
    });
    if (!changed.count) continue;
    await db.project.update({ where: { id: job.projectId }, data: { status: job.stage } });
    recoverable.push({ projectId: job.projectId, stage: job.stage as ProjectStage });
  }
  return recoverable;
}

/**
 * Fail synthesis runs whose process died. The stale job is what keeps its
 * project busy forever, and a busy project cannot be edited or regenerated at
 * all, so the run has to be closed out before anything else can recover it.
 */
export async function recoverInterruptedAudioJobs(projectId?: string) {
  const staleBefore = audioStaleBefore();
  const jobs = await db.job.findMany({ where: { kind: 'tts', ...(projectId ? { projectId } : {}), OR: [{ status: 'queued', createdAt: { lt: staleBefore } }, { status: 'running', updatedAt: { lt: staleBefore } }] } });
  let failed = 0;
  for (const job of jobs) {
    const claimed = await db.job.updateMany({
      where: job.status === 'queued' ? { id: job.id, status: 'queued', createdAt: { lt: staleBefore } } : { id: job.id, status: 'running', updatedAt: { lt: staleBefore } },
      data: { status: 'failed', stage: 'generating_audio', error: '语音生成已中断或长时间没有进展。请确认本地语音服务正在运行，然后重新生成语音。' },
    });
    failed += claimed.count;
  }
  return failed;
}

/**
 * Release projects whose status claims a running step but that have no job left.
 * Every busy status counts as locked, so without this the project can never be
 * edited, retried or re-rendered again.
 */
export async function recoverStuckProjects(projectId?: string) {
  const stuck = await db.project.findMany({
    where: { ...(projectId ? { id: projectId } : {}), status: { in: [...stages, 'generating_audio'] }, jobs: { none: { status: { in: activeStatuses } } } },
    select: { id: true, status: true, sourceText: true, storyboardJson: true },
  });
  const released: string[] = [];
  for (const project of stuck) {
    const status = project.storyboardJson ? 'awaiting_review' : project.sourceText.trim().length >= 30 ? 'awaiting_source_review' : 'failed';
    const fixed = await db.project.updateMany({ where: { id: project.id, status: project.status, jobs: { none: { status: { in: activeStatuses } } } }, data: { status } });
    if (fixed.count) released.push(project.id);
  }
  return released;
}

/** Single entry point for every interrupted long task: extraction, synthesis and rendering. */
export async function recoverInterruptedJobs(projectId?: string) {
  await recoverInterruptedRenderJobs(projectId);
  await recoverInterruptedAudioJobs(projectId);
  return { restarted: await recoverInterruptedStoryboardJobs(projectId), released: await recoverStuckProjects(projectId) };
}
