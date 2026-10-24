import { NextResponse } from 'next/server';
import { projectExportFlow } from '@/lib/export-flow-server';

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const preset = new URL(request.url).searchParams.get('preset') === 'draft' ? 'draft' : 'full';
  const data = await projectExportFlow(id, preset);
  if (!data) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  // The panel reads the flow fields flat, next to the job and revision they belong to.
  return NextResponse.json({ projectId: id, ...data.flow, revision: data.revision, jobId: data.jobId, checkedAt: data.checkedAt });
}
