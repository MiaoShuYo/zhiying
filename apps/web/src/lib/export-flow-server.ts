import { exportFlow, renderValidationLabels, type ExportFlow, type ExportFlowDelivery, type ExportFlowJob, type PreflightPreset } from '@m2v/schema';
import { db } from '@/lib/db';
import { deliveryRecordView, readDeliveryRecord } from '@/lib/delivery-records';
import { currentQcView } from '@/lib/qc-report';
import { projectPreflight } from '@/lib/preflight-server';
import { readPreflightPass } from '@/lib/preflight-state';
import { exportVideoState, parseValidation } from '@/lib/render-validation';

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
    // #251: carry the verdict, not just its existence. An unparseable report counts as failed too.
    const verdict = job.validationJson ? parseValidation(job.validationJson) : null;
    const blocking = verdict?.issues.filter(issue => issue.blocking) ?? [];
    const validationFailure = !job.validationJson ? null
      : !verdict ? '校验结果无法读取，请重新校验'
        : blocking.length ? blocking.map(issue => `${renderValidationLabels[issue.code]}：${issue.message}`).join('；') : null;
    jobView = {
      id: job.id,
      status: job.status,
      stage: job.stage,
      error: job.error,
      updatedAt: job.updatedAt.toISOString(),
      hasValidation: Boolean(job.validationJson),
      validationFailure,
      videoState: await exportVideoState(projectId, job, renders),
    };
    const record = await readDeliveryRecord(projectId, job.id).catch(() => null);
    if (record) {
      // #247: judge the record against the project as it stands now, like the exports endpoint.
      // A ready record whose ZIP is gone or which no longer matches the current revision/QC
      // verdict is an unfinished packaging step, so the flow offers packaging again.
      const qc = await currentQcView(projectId, project.revision);
      const view = await deliveryRecordView(record, { revision: project.revision, qcStatus: qc?.status });
      if (record.status !== 'ready') delivery = { status: record.status, message: record.error, at: record.updatedAt };
      else if (!view.fileExists) delivery = { status: 'missing', message: '交付包文件已不存在，请重新打包。', at: record.updatedAt };
      else if (view.stale) delivery = { status: 'missing', message: view.stale === 'qc-blocking' ? '质检出现阻断项，交付包已失效，请处理后重新打包。' : '项目在打包之后又有修改，请重新打包。', at: record.updatedAt };
      else delivery = { status: 'ready', message: record.error, at: record.updatedAt };
    }
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
