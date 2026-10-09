import { db } from './db';
import type { ProjectStage } from './pipeline';

const stages: ProjectStage[] = ['extracting', 'analyzing', 'storyboarding'];

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
