import { db } from '@/lib/db';
import { deliveryRecordView, readDeliveryRecords } from '@/lib/delivery-records';
import { cachedQcView, readQcReport } from '@/lib/qc-report';
import { ensureExportValidation, exportVideoState, parseValidation } from '@/lib/render-validation';

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const autoValidate = new URL(request.url).searchParams.get('validate') !== '0';
  let jobs = await db.job.findMany({ where: { projectId: id, kind: 'render' }, orderBy: { createdAt: 'desc' } });
  if (autoValidate) {
    const newest = jobs.find(job => job.status === 'completed');
    if (newest && !parseValidation(newest.validationJson)) {
      const validation = await ensureExportValidation(id, newest);
      if (validation) {
        jobs = jobs.map(job => job.id === newest.id ? { ...job, validationJson: JSON.stringify(validation) } : job);
      }
    }
  }
  const renders = jobs.map(({ id: jobId, kind, status, outputPath, createdAt }) => ({ id: jobId, kind, status, outputPath, createdAt }));
  const records = await readDeliveryRecords(id);
  // Stored archives are judged against the project as it stands now, not when they were built.
  const project = await db.project.findUnique({ where: { id }, select: { revision: true } });
  const qc = project
    ? cachedQcView(id, project.revision, await readQcReport(id).catch(() => null))
    : null;
  const current = project && qc ? { revision: project.revision, qcStatus: qc.status } : undefined;
  const payload = await Promise.all(jobs.map(async job => {
    const record = records.get(job.id);
    const { validationJson, ...rest } = job;
    return {
      ...rest,
      validation: parseValidation(validationJson),
      videoState: await exportVideoState(id, job, renders),
      delivery: record ? await deliveryRecordView(record, current) : null,
    };
  }));
  return Response.json(payload);
}
