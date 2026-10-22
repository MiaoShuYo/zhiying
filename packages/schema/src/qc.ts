import { z } from 'zod';

/** Four states shown in the UI; computed from a stored QC report and the current revision. */
export const QcStatusSchema = z.enum(['pending', 'passed', 'warning', 'blocking']);
export type QcStatus = z.infer<typeof QcStatusSchema>;

export const qcStatusLabels: Record<QcStatus, string> = {
  pending: '待检查',
  passed: '通过',
  warning: '提醒',
  blocking: '阻断',
};

export const qcStatusHints: Record<QcStatus, string> = {
  pending: '分镜有修改或尚未检查，请重新检查后再交付。',
  passed: '没有发现问题，可以打包交付。',
  warning: '只有提醒项，可以继续，但建议先处理。',
  blocking: '存在阻断项，修复后才能打包交付。',
};

/** A stored report that belongs to an older revision must not claim "passed". */
export function qcStatusFor(summary: { errors?: number; warnings?: number } | null | undefined, checked = true): QcStatus {
  if (!checked || !summary) return 'pending';
  if ((summary.errors ?? 0) > 0) return 'blocking';
  if ((summary.warnings ?? 0) > 0) return 'warning';
  return 'passed';
}

export function qcStatusCountLabel(status: QcStatus, count = 0): string {
  if (status === 'warning') return `${qcStatusLabels.warning} ${count}`;
  if (status === 'blocking') return `${qcStatusLabels.blocking} ${count}`;
  return qcStatusLabels[status];
}
