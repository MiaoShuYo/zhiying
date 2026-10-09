import { db } from './db';

export async function getProjectLock(projectId: string) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: {
      status: true,
      jobs: { where: { status: { in: ['queued', 'running'] } }, select: { id: true, kind: true, stage: true, status: true }, take: 1, orderBy: { createdAt: 'desc' } },
    },
  });
  if (!project) return { exists: false, locked: false, reason: null as string | null };
  const activeStatuses = ['created', 'extracting', 'analyzing', 'storyboarding', 'generating_audio', 'rendering', 'encoding'];
  const job = project.jobs[0];
  const locked = Boolean(job) || activeStatuses.includes(project.status);
  return { exists: true, locked, reason: job ? `${job.stage} · ${job.status}` : locked ? project.status : null };
}

export function projectLockedResponse(reason: string | null) {
  return Response.json({ error: `项目正在执行${reason ? `（${reason}）` : ''}，完成前不能进行手动修改。` }, { status: 409 });
}
