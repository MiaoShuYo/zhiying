import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';
export const runtime = 'nodejs';
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const lock = await getProjectLock(id); if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 }); if (lock.locked) return projectLockedResponse(lock.reason); const project = await db.project.findUnique({ where: { id }, include: { scenes: true } });
  if (!project?.storyboardJson) return NextResponse.json({ error: '请先生成并保存分镜' }, { status: 400 });
  const job = await db.job.create({ data: { projectId: id, kind: 'render', status: 'queued', stage: 'rendering' } });
  // Rendering is executed by the local worker; queue record is durable for retry/status polling.
  return NextResponse.json({ jobId: job.id, status: job.status, projectId: id, output: `data/projects/${id}/output/final.mp4`, requestId: randomUUID() }, { status: 202 });
}
