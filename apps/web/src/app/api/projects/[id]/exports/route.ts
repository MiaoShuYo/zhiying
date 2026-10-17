import { db } from '@/lib/db';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return Response.json(await db.job.findMany({ where: { projectId: id, kind: 'render' }, orderBy: { createdAt: 'desc' } }));
}
