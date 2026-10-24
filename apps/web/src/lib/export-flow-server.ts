import { exportFlow, type ExportFlow, type ExportFlowDelivery, type ExportFlowJob, type PreflightPreset } from '@m2v/schema';
import { db } from '@/lib/db';
import { readDeliveryRecord } from '@/lib/delivery-records';
import { projectPreflight } from '@/lib/preflight-server';
import { readPreflightPass } from '@/lib/preflight-state';
import { exportVideoState } from '@/lib/render-validation';

export type ProjectExportFlow = { flow: ExportFlow; revision: number; jobId: string | null; checkedAt: string | null };

/** Gathers the four export steps from the database, the output folder and the state files. */
export async function projectExportFlow(projectId: string, preset: PreflightPreset = 'full'): Promise<ProjectExportFlow | null> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { revision: true } });
  if (!project) return null;
  const job = await db.job.findFirst({ where: { projectId, kind: 'render' }, orderBy: { createdAt: 'desc' } });
  const renders = await db.job.findMany({
    where: { projectId, kind: 'render' },
    select: { id: true, kind: true, status: true, outputPath: true, createdAt: true },
  });
  const [check, pass] = await Promise.all([projectPreflight(projectId, preset), readPreflightPass(projectId)]);
  let jobView: ExportFlowJob | null = null;
  let delivery: ExportFlowDelivery | null = null;
  if (job) {
    jobView = {
      id: job.id,
      status: job.status,
      stage: job.stage,
      error: job.error,
      updatedAt: job.updatedAt.toISOString(),
      hasValidation: Boolean(job.validationJson),
      videoState: await exportVideoState(projectId, job, renders),
    };
    const record = await readDeliveryRecord(projectId, job.id).catch(() => null);
    if (record) delivery = { status: record.status, message: record.error, at: record.updatedAt };
  }
  return {
    revision: project.revision,
    jobId: job?.id ?? null,
    checkedAt: pass?.at ?? null,
    flow: exportFlow({
      blocking: check?.result.blocking ?? 0,
      checkedRevision: pass?.revision ?? null,
      revision: project.revision,
      job: jobView,
      delivery,
    }),
  };
}
