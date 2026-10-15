import { db } from './db';

// Workers refresh updatedAt every 15 seconds, including bundling and encoding.
// Render duration itself is unlimited; only missing heartbeats expire a job.
export async function recoverInterruptedRenderJobs(projectId?: string) {
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const jobs = await db.job.findMany({ where: { kind: 'render', ...(projectId ? { projectId } : {}), status: 'running', updatedAt: { lt: staleBefore } } });
  for (const job of jobs) {
    await db.$transaction(async tx => {
      const claimed = await tx.job.updateMany({ where: { id: job.id, status: 'running', updatedAt: { lt: staleBefore } }, data: { status: 'failed', stage: 'failed', error: '渲染进程已中断或超过 5 分钟未更新运行状态。请确认本地 Worker 已启动，然后重新导出。' } });
      if (!claimed.count) return;
      const active = await tx.job.count({ where: { projectId: job.projectId, status: { in: ['queued', 'running'] } } });
      if (!active) await tx.project.updateMany({ where: { id: job.projectId, status: { in: ['rendering', 'encoding'] } }, data: { status: 'failed' } });
    });
  }
  // Repair older partially-written terminal states as well.
  const projects = await db.project.findMany({ where: { ...(projectId ? { id: projectId } : {}), status: { in: ['rendering', 'encoding'] }, jobs: { none: { status: { in: ['queued', 'running'] } } } }, select: { id: true, jobs: { where: { kind: 'render' }, orderBy: { createdAt: 'desc' }, take: 1 } } });
  for (const project of projects) {
    const last = project.jobs[0];
    if (!last || !['failed', 'completed'].includes(last.status)) continue;
    await db.project.updateMany({ where: { id: project.id, status: { in: ['rendering', 'encoding'] }, jobs: { none: { status: { in: ['queued', 'running'] } } } }, data: { status: last.status } });
  }
}
