import { db } from '@/lib/db';
import { StoryboardSchema } from '@m2v/schema';
import { exportSubtitles } from '@m2v/video/subtitles';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const format = new URL(request.url).searchParams.get('format') ?? 'srt';
  if (!['srt', 'vtt', 'ass'].includes(format)) return Response.json({ error: '字幕格式无效' }, { status: 400 });
  const project = await db.project.findUnique({ where: { id } });
  if (!project?.storyboardJson) return Response.json({ error: '没有可导出的分镜' }, { status: 404 });
  return new Response(exportSubtitles(StoryboardSchema.parse(JSON.parse(project.storyboardJson)), format as 'srt' | 'vtt' | 'ass'), { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="subtitles.${format}"` } });
}
