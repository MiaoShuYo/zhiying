import { NextResponse } from 'next/server';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { db } from '@/lib/db';
import { PER_JOB_VIDEO, SHARED_VIDEO, sharedVideoOwner } from '@/lib/job-video';
export const runtime = 'nodejs';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = new URL(request.url).searchParams.get('jobId');
  const [job, project, renders] = await Promise.all([
    db.job.findFirst({ where: { projectId: id, kind: 'render', status: 'completed', ...(jobId ? { id: jobId } : {}) }, orderBy: { updatedAt: 'desc' } }),
    db.project.findUnique({ where: { id }, select: { name: true } }),
    db.job.findMany({ where: { projectId: id, kind: 'render' }, select: { id: true, kind: true, status: true, outputPath: true, createdAt: true } }),
  ]);
  if (!job) return NextResponse.json({ error: '视频尚未渲染完成' }, { status: 404 });
  if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const safeProjectName = project.name
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/[.\s]+$/g, '') || '项目';
  let preset = 'full';
  try { preset = JSON.parse(job.inputJson ?? '{}').preset === 'draft' ? 'draft' : 'full'; } catch {}
  const pad = (n: number) => String(n).padStart(2, '0');
  const at = new Date(job.updatedAt);
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
  // The name has to say which render this is. When every download of a project is
  // called <project>.mp4, an old file is indistinguishable from the one just made.
  const readableName = `${safeProjectName}-${preset === 'draft' ? '草稿' : '成片'}-${stamp}.mp4`;
  const asciiName = `video-${preset}-${stamp}.mp4`;
  const outputDir = resolve(process.cwd(), '..', '..', 'data', 'projects', id, 'output');
  const owned = job.outputPath && PER_JOB_VIDEO.test(job.outputPath) ? job.outputPath : job.id === sharedVideoOwner(renders) ? SHARED_VIDEO : null;
  if (!owned) return NextResponse.json({ error: '这条导出记录的视频已被后续导出覆盖，只有最近一次导出可以下载，请重新导出后再试' }, { status: 409 });
  let streamPath: string | null = null;
  let size = 0;
  const path = resolve(outputDir, owned);
  try {
    const info = await stat(path);
    // A shared final.mp4 is only trustworthy when it is not older than the render that
    // claims it; per-job files are already unambiguous.
    if (info.isFile() && (owned !== SHARED_VIDEO || info.mtimeMs + 1000 >= new Date(job.createdAt).getTime())) {
      streamPath = path;
      size = info.size;
    }
  } catch { /* The file is gone, reported below. */ }
  if (!streamPath) return NextResponse.json({ error: '找不到本次渲染的视频文件，请重新渲染后再下载' }, { status: 404 });
  const stream = Readable.toWeb(createReadStream(streamPath)) as ReadableStream;
  return new Response(stream, { headers: { 'content-type': 'video/mp4', 'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(readableName)}`, 'content-length': String(size), 'cache-control': 'no-store' } });
}
