import { NextResponse } from 'next/server';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { db } from '@/lib/db';
import { outputDirFor, fileStamp, ownedVideoPath, safeFileBaseName, videoFileIsCurrent } from '@/lib/job-video';
import { videoHeaders, videoStreamResponse } from '@/lib/video-range';
export const runtime = 'nodejs';

type Located =
  | { ok: true; path: string; size: number; readableName: string; asciiName: string }
  | { ok: false; status: number; error: string };

async function locate(id: string, jobId: string | null): Promise<Located> {
  const [job, project, renders] = await Promise.all([
    db.job.findFirst({ where: { projectId: id, kind: 'render', status: 'completed', ...(jobId ? { id: jobId } : {}) }, orderBy: { updatedAt: 'desc' } }),
    db.project.findUnique({ where: { id }, select: { name: true } }),
    db.job.findMany({ where: { projectId: id, kind: 'render' }, select: { id: true, kind: true, status: true, outputPath: true, createdAt: true } }),
  ]);
  if (!job) return { ok: false, status: 404, error: '视频尚未渲染完成' };
  if (!project) return { ok: false, status: 404, error: '项目不存在' };
  const safeProjectName = safeFileBaseName(project.name);
  let preset = 'full';
  try { preset = JSON.parse(job.inputJson ?? '{}').preset === 'draft' ? 'draft' : 'full'; } catch {}
  const stamp = fileStamp(job.updatedAt);
  // The name has to say which render this is. When every download of a project is
  // called <project>.mp4, an old file is indistinguishable from the one just made.
  const readableName = `${safeProjectName}-${preset === 'draft' ? '草稿' : '成片'}-${stamp}.mp4`;
  const asciiName = `video-${preset}-${stamp}.mp4`;
  const owned = ownedVideoPath(job, renders);
  if (!owned) return { ok: false, status: 409, error: '这条导出记录的视频已被后续导出覆盖，只有最近一次导出可以下载，请重新导出后再试' };
  const path = resolve(outputDirFor(id), owned);
  try {
    const info = await stat(path);
    // A shared final.mp4 is only trustworthy when it is not older than the render that
    // claims it; per-job files are already unambiguous.
    if (info.isFile() && videoFileIsCurrent(owned, job, info.mtimeMs)) return { ok: true, path, size: info.size, readableName, asciiName };
  } catch { /* The file is gone, reported below. */ }
  return { ok: false, status: 404, error: '找不到本次渲染的视频文件，请重新渲染后再下载' };
}

/** `inline=1` lets the player stream the file instead of offering it as a download. */
const dispositionFor = (found: Extract<Located, { ok: true }>, inline: boolean) =>
  `${inline ? 'inline' : 'attachment'}; filename="${found.asciiName}"; filename*=UTF-8''${encodeURIComponent(found.readableName)}`;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(request.url);
  const found = await locate(id, url.searchParams.get('jobId'));
  if (!found.ok) return NextResponse.json({ error: found.error }, { status: found.status });
  return videoStreamResponse(found.path, found.size, request.headers.get('range'), videoHeaders(found.size, dispositionFor(found, url.searchParams.get('inline') === '1')));
}

export async function HEAD(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(request.url);
  const found = await locate(id, url.searchParams.get('jobId'));
  if (!found.ok) return new Response(null, { status: found.status });
  return new Response(null, { status: 200, headers: videoHeaders(found.size, dispositionFor(found, url.searchParams.get('inline') === '1')) });
}
