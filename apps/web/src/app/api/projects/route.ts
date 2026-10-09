import { after, NextResponse } from 'next/server';
import { createProject, processProject } from '@/lib/pipeline';
import { db } from '@/lib/db';
export const runtime = 'nodejs';

export async function GET() {
  const projects = await db.project.findMany({ orderBy: { updatedAt: 'desc' }, include: { scenes: { select: { id: true } }, jobs: { where: { status: { in: ['queued', 'running'] } }, select: { stage: true }, take: 1, orderBy: { createdAt: 'desc' } } } });
  const activeStatuses = ['created', 'extracting', 'analyzing', 'storyboarding', 'generating_audio', 'rendering', 'encoding'];
  return NextResponse.json(projects.map(project => ({ id: project.id, name: project.name, status: project.status, styleId: project.styleId, createdAt: project.createdAt.toISOString(), sceneCount: project.scenes.length, busy: project.jobs.length > 0 || activeStatuses.includes(project.status), busyStage: project.jobs[0]?.stage ?? null })));
}
export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const input = { name: String(form.get('name') ?? ''), text: String(form.get('text') ?? ''), styleId: String(form.get('styleId') ?? 'minimal-tech'), file: form.get('file') instanceof File ? form.get('file') as File : null, preferLocalAI: form.get('preferLocalAI') === 'true' };
    const project = await createProject(input);
    after(async () => processProject(project.id, 'extracting', input.preferLocalAI));
    return NextResponse.json({ id: project.id, status: project.status }, { status: 202 });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : '创建失败' }, { status: 400 }); }
}
