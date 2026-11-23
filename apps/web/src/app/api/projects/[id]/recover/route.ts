import { after, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { processProject } from '@/lib/pipeline';
import { recoverInterruptedJobs } from '@/lib/project-recovery';

export const runtime = 'nodejs';

/**
 * Manual escape hatch for a project stuck in a busy status. Deliberately skips
 * the project lock: releasing the lock is exactly what this route is for.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!await db.project.count({ where: { id } })) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const { released, restarted } = await recoverInterruptedJobs(id);
  // #289: restarted storyboard jobs were marked running but never executed, leaving the project
  // stalled and locked. Schedule them; recovery stays scoped to this project.
  if (restarted.length) after(async () => { await Promise.all(restarted.map(job => processProject(job.projectId, job.stage))); });
  const project = await db.project.findUniqueOrThrow({ where: { id }, select: { status: true } });
  const active = await db.job.count({ where: { projectId: id, status: { in: ['queued', 'running', 'cancelling'] } } });
  return NextResponse.json({ status: project.status, released, active, resumed: restarted.length });
}
