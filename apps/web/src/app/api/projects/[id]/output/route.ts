import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { db } from '@/lib/db';
export const runtime = 'nodejs';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [job, project] = await Promise.all([
    db.job.findFirst({ where: { projectId: id, kind: 'render', status: 'completed' }, orderBy: { updatedAt: 'desc' } }),
    db.project.findUnique({ where: { id }, select: { name: true } }),
  ]);
  if (!job) return NextResponse.json({ error: '视频尚未渲染完成' }, { status: 404 });
  if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const safeProjectName = project.name
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/[.\s]+$/g, '') || '项目';
  const filename = `${safeProjectName}.mp4`;
  // The web app runs from apps/web, while the worker writes to <repo>/data.
  // Resolve from the monorepo root so both processes address the same output file.
  try { const bytes = await readFile(resolve(process.cwd(), '..', '..', 'data', 'projects', id, 'output', 'final.mp4')); return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'video/mp4', 'content-disposition': `attachment; filename="video.mp4"; filename*=UTF-8''${encodeURIComponent(filename)}`, 'content-length': String(bytes.byteLength) } }); }
  catch { return NextResponse.json({ error: '找不到渲染文件' }, { status: 404 }); }
}
