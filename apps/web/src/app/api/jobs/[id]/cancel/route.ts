import { db } from '@/lib/db';
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await db.job.findUnique({ where: { id } });
  if (!job || job.kind !== 'render') return Response.json({ error: '渲染任务不存在' }, { status: 404 });
  await db.$transaction(async tx => {
    const cancelled = await tx.job.updateMany({ where: { id, status: 'queued' }, data: { status: 'cancelled', stage: 'cancelled' } });
    if (!cancelled.count) await tx.job.updateMany({ where: { id, status: 'running' }, data: { status: 'cancelling' } });
  });
  return Response.json(await db.job.findUnique({ where: { id } }));
}
