import { after } from 'next/server';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { db } from '@/lib/db';
import { processProject } from '@/lib/pipeline';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await db.project.findUnique({ where: { id }, select: { sourceText: true, status: true } });
  if (!project) return Response.json({ error: '项目不存在' }, { status: 404 });
  let extraction: unknown = null;
  if (/^[a-zA-Z0-9_-]+$/.test(id)) {
    try { extraction = JSON.parse(await readFile(resolve(process.cwd(), '../../data/projects', id, 'extraction.json'), 'utf8')); } catch { extraction = null; }
  }
  return Response.json({ ...project, extraction });
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const lock = await getProjectLock(id);
  if (!lock.exists) return Response.json({ error: '项目不存在' }, { status: 404 });
  if (lock.locked) return projectLockedResponse(lock.reason);
  const body = await request.json();
  if (typeof body.text !== 'string' || body.text.trim().length < 30 || body.text.length > 2_000_000) return Response.json({ error: '正文需为 30 到 2000000 个字符' }, { status: 400 });
  await db.$transaction(async tx => { await tx.project.update({ where: { id }, data: { sourceText: body.text, status: 'analyzing' } }); await tx.job.create({ data: { projectId: id, kind: 'storyboard', stage: 'analyzing', status: 'queued' } }); });
  after(() => processProject(id, 'analyzing', body.preferLocalAI === true));
  return Response.json({ status: 'analyzing' }, { status: 202 });
}
