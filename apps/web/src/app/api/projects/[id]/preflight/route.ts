import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { projectPreflight } from '@/lib/preflight-server';
import { writePreflightPass } from '@/lib/preflight-state';
export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const preset = new URL(request.url).searchParams.get('preset') === 'draft' ? 'draft' : 'full';
  const data = await projectPreflight(id, preset);
  if (!data) {
    const exists = await db.project.count({ where: { id } });
    return NextResponse.json({ error: exists ? '请先生成并保存分镜' : '项目不存在' }, { status: exists ? 400 : 404 });
  }
  // A passing check is the first export step; remembering the revision it saw is what
  // lets the export flow say "分镜已修改，需要重新检查" instead of silently reusing it.
  if (data.result.blocking === 0) {
    const project = await db.project.findUnique({ where: { id }, select: { revision: true } });
    if (project) await writePreflightPass({ projectId: id, revision: project.revision, preset }).catch(() => {});
  }
  return NextResponse.json({ projectId: id, name: data.name, status: data.status, ...data.result });
}
