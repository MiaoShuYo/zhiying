import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { parseProject, saveStoryboard } from '@/lib/pipeline';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { const { id } = await params; const lock = await getProjectLock(id); if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 }); if (lock.locked) return projectLockedResponse(lock.reason); await db.project.findUniqueOrThrow({ where: { id } }); const storyboard = await saveStoryboard(id, await request.json()); const project = await db.project.findUniqueOrThrow({ where: { id }, include: { scenes: { orderBy: { orderIndex: 'asc' } }, jobs: { orderBy: { createdAt: 'desc' }, take: 10 } } }); return NextResponse.json({ ...parseProject(project), storyboard }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : '保存失败' }, { status: 400 }); }
}
