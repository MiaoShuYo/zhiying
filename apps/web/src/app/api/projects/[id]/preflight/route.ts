import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { projectPreflight } from '@/lib/preflight-server';
export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const preset = new URL(request.url).searchParams.get('preset') === 'draft' ? 'draft' : 'full';
  const data = await projectPreflight(id, preset);
  if (!data) {
    const exists = await db.project.count({ where: { id } });
    return NextResponse.json({ error: exists ? '请先生成并保存分镜' : '项目不存在' }, { status: exists ? 400 : 404 });
  }
  return NextResponse.json({ projectId: id, name: data.name, status: data.status, ...data.result });
}
