import { db } from '@/lib/db';
import { parseValidation } from '@/lib/render-validation';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobs = await db.job.findMany({ where: { projectId: id, kind: 'render' }, orderBy: { createdAt: 'desc' } });
  return Response.json(jobs.map(({ validationJson, ...job }) => ({ ...job, validation: parseValidation(validationJson) })));
}
