import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { qcStatusFor, type QcStatus } from '@m2v/schema';
import type { AudioQc, QcIssue, SubtitleQc } from '@m2v/video/qc';

export type QcRenderState = {
  jobId: string;
  status: string;
  error: string | null;
  createdAt: string;
  /** A synthetic issue so "latest render failed" cannot be reported as passed. */
  issue: QcIssue | null;
};

export type StoredQcReport = {
  version: 1;
  projectId: string;
  revision: number;
  checkedAt: string;
  summary: { total: number; errors: number; warnings: number; scenes: number };
  subtitles: SubtitleQc;
  audio: AudioQc & { available: boolean };
  render: QcRenderState | null;
  status: QcStatus;
};

const REPORT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function qcReportPath(projectId: string) {
  if (!REPORT_ID.test(projectId)) throw new Error('项目 ID 不合法');
  return resolve(process.cwd(), '..', '..', 'data', 'projects', projectId, 'qc-report.json');
}

const isReport = (value: unknown): value is StoredQcReport => {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<StoredQcReport>;
  return report.version === 1
    && typeof report.projectId === 'string'
    && typeof report.revision === 'number'
    && typeof report.checkedAt === 'string'
    && !!report.summary
    && !!report.subtitles
    && !!report.audio;
};

export async function readQcReport(projectId: string): Promise<StoredQcReport | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(qcReportPath(projectId), 'utf8'));
    if (!isReport(parsed) || parsed.projectId !== projectId) return null;
    return { ...parsed, status: qcStatusFor(parsed.summary) };
  } catch {
    return null;
  }
}

export async function writeQcReport(report: StoredQcReport): Promise<void> {
  const file = qcReportPath(report.projectId);
  await mkdir(resolve(file, '..'), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(report), 'utf8');
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export type QcCachedView = {
  projectId: string;
  revision: number;
  status: QcStatus;
  stale: boolean;
  reason?: 'never' | 'revision';
  checkedAt?: string;
  report?: StoredQcReport;
  previousSummary?: StoredQcReport['summary'];
};

/** The cached read never trusts a report from another revision. */
export function cachedQcView(projectId: string, revision: number, report: StoredQcReport | null): QcCachedView {
  if (!report) return { projectId, revision, status: 'pending', stale: true, reason: 'never' };
  if (report.revision !== revision) {
    return {
      projectId,
      revision,
      status: 'pending',
      stale: true,
      reason: 'revision',
      checkedAt: report.checkedAt,
      previousSummary: report.summary,
    };
  }
  return { projectId, revision, status: report.status, stale: false, checkedAt: report.checkedAt, report };
}
