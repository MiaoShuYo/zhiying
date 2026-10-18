import { NextResponse } from 'next/server';
import { checkAudio, checkSubtitles } from '@m2v/video/qc';
import { db } from '@/lib/db';
import { audioToolsReady, measureSceneAudio } from '@/lib/audio-qc';
import { parseProject } from '@/lib/pipeline';
export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const refresh = new URL(request.url).searchParams.get('refresh') === '1';
  const project = await db.project.findUnique({ where: { id }, include: { scenes: true } });
  if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  if (!project.storyboardJson) return NextResponse.json({ error: '请先生成并保存分镜' }, { status: 400 });

  const parsed = parseProject(project);
  if (!parsed.storyboard) return NextResponse.json({ error: '请先生成并保存分镜' }, { status: 400 });
  const board = parsed.storyboard;
  const subtitles = checkSubtitles(board);
  const available = await audioToolsReady();
  const probes = available ? await measureSceneAudio(board.scenes, refresh) : new Map();
  const audio = checkAudio(board, probes);

  const issues = [...subtitles.issues, ...audio.issues];
  return NextResponse.json({
    projectId: id,
    checkedAt: new Date().toISOString(),
    summary: {
      total: issues.length,
      errors: issues.filter(issue => issue.severity === 'error').length,
      warnings: issues.filter(issue => issue.severity === 'warning').length,
      scenes: board.scenes.length,
    },
    subtitles,
    audio: { available, measurable: audio.measurable, issues: audio.issues },
  });
}
