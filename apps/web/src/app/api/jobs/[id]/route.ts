import { recoverInterruptedRenderJobs } from '@/lib/render-recovery';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) { const { id } = await params; await recoverInterruptedRenderJobs(); const job = await db.job.findUnique({ where: { id } }); return job ? NextResponse.json(job) : NextResponse.json({ error: '作业不存在' }, { status: 404 }); }
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const job = await db.job.findUnique({ where: { id } });
  if (!job || job.kind !== 'render' || !['failed', 'cancelled'].includes(job.status)) return NextResponse.json({ error: '只能重试失败或取消的渲染任务' }, { status: 409 });
  const lock = await getProjectLock(job.projectId); if (lock.locked) return projectLockedResponse(lock.reason);
  const retried = await db.job.create({ data: { projectId: job.projectId, kind: 'render', status: 'queued', stage: 'queued', attempt: job.attempt + 1, inputJson: job.inputJson } });
  return NextResponse.json(retried, { status: 202 });
}
