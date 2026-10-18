import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { validateExport } from '@/lib/render-validation';

export const runtime = 'nodejs';

export async function POST(_request: Request, { params }: { params: Promise<{ id: string; jobId: string }> }) {
  const { id, jobId } = await params;
  if (!(await db.project.count({ where: { id } }))) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const outcome = await validateExport(id, jobId);
  if (!outcome) return NextResponse.json({ error: '找不到这条导出记录' }, { status: 404 });
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  return NextResponse.json({ jobId, validation: outcome.validation });
}
