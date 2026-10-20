import { NextResponse } from 'next/server';
import { qcStatusFor } from '@m2v/schema';
import { checkAudio, checkSubtitles, renderFailedIssue } from '@m2v/video/qc';
import { db } from '@/lib/db';
import { audioToolsReady, measureAudioSource, measureSceneAudio } from '@/lib/audio-qc';
import { parseProject } from '@/lib/pipeline';
import { cachedQcView, readQcReport, writeQcReport, type QcRenderState, type StoredQcReport } from '@/lib/qc-report';
export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const query = new URL(request.url).searchParams;
  const refresh = query.get('refresh') === '1';
  const cached = query.get('cached') === '1';
  const project = await db.project.findUnique({ where: { id }, include: { scenes: true } });
  if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  if (!project.storyboardJson) return NextResponse.json({ error: '请先生成并保存分镜' }, { status: 400 });

  if (cached) {
    return NextResponse.json(cachedQcView(id, project.revision, await readQcReport(id)));
  }

  const parsed = parseProject(project);
  if (!parsed.storyboard) return NextResponse.json({ error: '请先生成并保存分镜' }, { status: 400 });
  const board = parsed.storyboard;
  const subtitles = checkSubtitles(board);
  const available = await audioToolsReady();
  const probes = available ? await measureSceneAudio(board.scenes, refresh) : new Map();
  const bgmProbe = available && board.bgmSrc ? await measureAudioSource(board.bgmSrc, refresh) : undefined;
  const audio = checkAudio(board, probes, bgmProbe);

  const latest = await db.job.findFirst({
    where: { projectId: id, kind: 'render' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, error: true, createdAt: true },
  });
  const render: QcRenderState | null = latest
    ? {
        jobId: latest.id,
        status: latest.status,
        error: latest.error,
        createdAt: latest.createdAt.toISOString(),
        issue: latest.status === 'failed' ? renderFailedIssue(latest) : null,
      }
    : null;

  const issues = [...subtitles.issues, ...audio.issues, ...(render?.issue ? [render.issue] : [])];
  const summary = {
    total: issues.length,
    errors: issues.filter(issue => issue.severity === 'error').length,
    warnings: issues.filter(issue => issue.severity === 'warning').length,
    scenes: board.scenes.length,
  };
  const report: StoredQcReport = {
    version: 1,
    projectId: id,
    revision: project.revision,
    checkedAt: new Date().toISOString(),
    summary,
    subtitles,
    audio: { ...audio, available },
    render,
    status: qcStatusFor(summary),
  };
  let persisted = true;
  try { await writeQcReport(report); } catch { persisted = false; }
  return NextResponse.json({ ...report, persisted });
}
