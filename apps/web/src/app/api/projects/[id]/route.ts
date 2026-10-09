import { after, NextResponse } from 'next/server';
import { readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { db } from '@/lib/db';
import { parseProject, processProject } from '@/lib/pipeline';
import { recoverInterruptedStoryboardJobs } from '@/lib/project-recovery';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';
export const runtime = 'nodejs';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const recoverable = await recoverInterruptedStoryboardJobs(id);
  if (recoverable.length) after(async () => Promise.all(recoverable.map(job => processProject(job.projectId, job.stage))));
  const project = await db.project.findUnique({ where: { id }, include: { scenes: { orderBy: { orderIndex: 'asc' } }, jobs: { orderBy: { createdAt: 'desc' }, take: 10 } } });
  return project ? NextResponse.json(parseProject(project)) : NextResponse.json({ error: '项目不存在' }, { status: 404 });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lock = await getProjectLock(id);
  if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  if (lock.locked) return projectLockedResponse(lock.reason);
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: '请求内容不是有效 JSON' }, { status: 400 }); }
  const name = typeof body === 'object' && body !== null && 'name' in body && typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 100) return NextResponse.json({ error: '项目名称需为 1 到 100 个字符' }, { status: 400 });
  try {
    const project = await db.project.update({ where: { id }, data: { name } });
    return NextResponse.json({ id: project.id, name: project.name });
  } catch { return NextResponse.json({ error: '项目不存在' }, { status: 404 }); }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lock = await getProjectLock(id);
  if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  if (lock.locked) return projectLockedResponse(lock.reason);
  const project = await db.project.findUnique({ where: { id }, select: { id: true, jobs: { where: { status: { in: ['queued', 'running'] } }, select: { id: true } } } });
  if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  if (project.jobs.length) return NextResponse.json({ error: '项目有正在运行的任务，请等待任务结束后再删除' }, { status: 409 });

  await db.project.delete({ where: { id } });
  const repo = resolve(process.cwd(), '../..');
  const outputRoot = resolve(repo, 'data/projects');
  const projectOutput = resolve(outputRoot, id);
  try {
    if (projectOutput.startsWith(`${outputRoot}${process.platform === 'win32' ? '\\' : '/'}`)) await rm(projectOutput, { recursive: true, force: true });
  } catch { /* A missing or locked export must not undo database deletion. */ }
  const audioRoot = resolve(process.cwd(), 'public/audio');
  try {
    const files = await readdir(audioRoot);
    await Promise.all(files.filter((name) => name.startsWith(`${id}-`)).map((name) => rm(join(audioRoot, name), { force: true })));
  } catch { /* Generated audio may not exist. */ }
  return new Response(null, { status: 204 });
}
