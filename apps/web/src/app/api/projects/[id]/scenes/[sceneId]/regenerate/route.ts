import { NextResponse } from 'next/server';
import { regenerateScene } from '@/lib/pipeline';
import { db } from '@/lib/db';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';
export async function POST(_request: Request, { params }: { params: Promise<{ id: string; sceneId: string }> }) {
  const { id, sceneId } = await params; const lock = await getProjectLock(id); if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 }); if (lock.locked) return projectLockedResponse(lock.reason); const job = await db.job.create({ data: { projectId: id, kind: 'scene-regenerate', sceneId, status: 'running', stage: 'storyboarding' } });
  try { const storyboard = await regenerateScene(id, sceneId); await db.job.update({ where: { id: job.id }, data: { status: 'completed', stage: 'awaiting_review' } }); return NextResponse.json({ storyboard, jobId: job.id }); }
  catch (error) { const message = error instanceof Error ? error.message : '场景再生成失败'; await db.job.update({ where: { id: job.id }, data: { status: 'failed', stage: 'storyboarding', error: message } }); return NextResponse.json({ error: message, jobId: job.id }, { status: 400 }); }
}
