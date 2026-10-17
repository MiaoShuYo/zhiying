import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';
export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const lock = await getProjectLock(id); if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 }); if (lock.locked) return projectLockedResponse(lock.reason); const project = await db.project.findUnique({ where: { id }, include: { scenes: true } });
  if (!project?.storyboardJson) return NextResponse.json({ error: '请先生成并保存分镜' }, { status: 400 });
  const body = await request.json().catch(() => ({}));
  const preset = body.preset === 'draft' ? 'draft' : 'full';
  const job = await db.$transaction(async tx => {
    if (await tx.job.count({ where: { projectId: id, status: { in: ['queued', 'running', 'cancelling'] } } })) throw new Error('项目已有运行中的任务');
    return tx.job.create({ data: { projectId: id, kind: 'render', status: 'queued', stage: 'queued', inputJson: JSON.stringify({ storyboard: JSON.parse(project.storyboardJson!), preset }) } });
  });
  // Rendering is executed by the local worker; queue record is durable for retry/status polling.
  return NextResponse.json({ jobId: job.id, status: job.status, projectId: id, output: `data/projects/${id}/output/${job.id}.mp4`, requestId: randomUUID() }, { status: 202 });
}
