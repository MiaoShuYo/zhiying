import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { deliveryRecordView } from '@/lib/delivery-records';
import { buildDelivery } from '@/lib/delivery';
import { cachedQcView, readQcReport } from '@/lib/qc-report';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Builds the archive and reports what was written. The ZIP is fetched separately from
 * `delivery/[jobId]` so a dropped download cannot be mistaken for a failed build.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await db.project.findUnique({ where: { id }, select: { revision: true } });
  if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  let jobId = '';
  try {
    jobId = String(((await request.json()) as { jobId?: unknown }).jobId ?? '');
  } catch { /* The newest finished render is the default. */ }
  if (!jobId) {
    const latest = await db.job.findFirst({
      where: { projectId: id, kind: 'render', status: 'completed' },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
    jobId = latest?.id ?? '';
  }
  if (!jobId) return NextResponse.json({ error: '还没有渲染完成的成片，无法生成交付包' }, { status: 409 });
  const result = await buildDelivery(id, jobId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error, missing: result.missing, record: result.record ?? null }, { status: result.status });
  }
  const qc = cachedQcView(id, project.revision, await readQcReport(id).catch(() => null));
  return NextResponse.json({
    ok: true,
    jobId,
    name: result.name,
    bytes: result.bytes,
    files: result.files,
    record: await deliveryRecordView(result.record, { revision: project.revision, qcStatus: qc.status }),
  });
}
