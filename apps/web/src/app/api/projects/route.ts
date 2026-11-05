import { after, NextResponse } from 'next/server';
import { createProject, processProject } from '@/lib/pipeline';
import { recoverInterruptedJobs } from '@/lib/project-recovery';
import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const { restarted } = await recoverInterruptedJobs();
  if (restarted.length) after(async () => Promise.all(restarted.map(job => processProject(job.projectId, job.stage))));
  const search = new URL(request.url).searchParams;
  const q = search.get('q')?.trim() ?? '';
  const status = search.get('status')?.trim() ?? '';
  const sortParam = search.get('sort') ?? 'updated';
  const sort = sortParam === 'created' || sortParam === 'name' ? sortParam : 'updated';
  const order = search.get('order') === 'asc' ? 'asc' : 'desc';
  const orderBy: Prisma.ProjectOrderByWithRelationInput = sort === 'name' ? { name: order } : sort === 'created' ? { createdAt: order } : { updatedAt: order };
  const projects = await db.project.findMany({
    where: { ...(q ? { OR: [{ name: { contains: q } }, { sourceText: { contains: q } }] } : {}), ...(status ? { status } : {}) },
    orderBy,
    include: { scenes: { select: { id: true } }, jobs: { where: { status: { in: ['queued', 'running', 'cancelling'] } }, select: { stage: true }, take: 1, orderBy: { createdAt: 'desc' } } },
  });
  const activeStatuses = ['created', 'extracting', 'analyzing', 'storyboarding', 'generating_audio', 'rendering', 'encoding'];
  return NextResponse.json(projects.map(project => ({ id: project.id, name: project.name, status: project.status, styleId: project.styleId, createdAt: project.createdAt.toISOString(), sceneCount: project.scenes.length, busy: project.jobs.length > 0 || activeStatuses.includes(project.status), busyStage: project.jobs[0]?.stage ?? null })));
}
export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const input = { name: String(form.get('name') ?? ''), text: String(form.get('text') ?? ''), styleId: String(form.get('styleId') ?? 'minimal-tech'), aspectRatio: String(form.get('aspectRatio') ?? '16:9'), importMode: String(form.get('importMode') ?? 'rebuild'), generationMode: String(form.get('generationMode') ?? 'standard'), file: form.get('file') instanceof File ? form.get('file') as File : null, preferLocalAI: form.get('preferLocalAI') === 'true' };
    const project = await createProject(input);
    after(async () => processProject(project.id, 'extracting', input.preferLocalAI));
    return NextResponse.json({ id: project.id, status: project.status }, { status: 202 });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : '创建失败' }, { status: 400 }); }
}
