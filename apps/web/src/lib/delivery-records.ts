import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QcStatus } from '@m2v/schema';

export type DeliveryStep = 'render' | 'validation' | 'qc' | 'video' | 'subtitles' | 'cover' | 'backup' | 'package';

export type DeliveryMissing = { step: DeliveryStep; message: string };

/** The QC verdict the archive was built under, kept so later verdicts cannot retroactively bless it. */
export type DeliveryQcSnapshot = { status: QcStatus; errors: number; warnings: number };

export type DeliveryRecord = {
  version: 1;
  projectId: string;
  jobId: string;
  status: 'ready' | 'failed';
  stamp: string;
  name?: string;
  /** File name inside `data/projects/<id>/delivery/`, never an absolute path. */
  file?: string;
  bytes?: number;
  files?: number;
  missing: DeliveryMissing[];
  error?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  /** Project revision the archive was built from; absent on records written before V1.4.1. */
  revision?: number;
  /** QC verdict at build time; absent on records written before V1.4.1. */
  qc?: DeliveryQcSnapshot;
};

export type DeliveryStaleReason = 'qc-blocking' | 'project-changed';

export type DeliveryRecordView = DeliveryRecord & {
  fileExists: boolean;
  /** Non-null when the archive no longer speaks for the current project or QC verdict. */
  stale: DeliveryStaleReason | null;
};

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const deliveryDirFor = (projectId: string) => {
  if (!SAFE_ID.test(projectId)) throw new Error('项目 ID 不合法');
  return resolve(process.cwd(), '..', '..', 'data', 'projects', projectId, 'delivery');
};

const recordPath = (projectId: string, jobId: string) => {
  if (!SAFE_ID.test(jobId)) throw new Error('任务 ID 不合法');
  return resolve(deliveryDirFor(projectId), `${jobId}.json`);
};

const isQcSnapshot = (value: unknown): value is DeliveryQcSnapshot => Boolean(value) && typeof value === 'object'
  && typeof (value as DeliveryQcSnapshot).status === 'string';

const isRecord = (value: unknown): value is DeliveryRecord => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<DeliveryRecord>;
  return record.version === 1
    && typeof record.projectId === 'string'
    && typeof record.jobId === 'string'
    && (record.status === 'ready' || record.status === 'failed')
    && Array.isArray(record.missing)
    && typeof record.attempts === 'number'
    && (record.revision === undefined || typeof record.revision === 'number')
    && (record.qc === undefined || isQcSnapshot(record.qc));
};

export async function readDeliveryRecord(projectId: string, jobId: string): Promise<DeliveryRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(recordPath(projectId, jobId), 'utf8'));
    if (!isRecord(parsed) || parsed.projectId !== projectId || parsed.jobId !== jobId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeDeliveryRecord(record: DeliveryRecord): Promise<void> {
  const file = recordPath(record.projectId, record.jobId);
  await mkdir(deliveryDirFor(record.projectId), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), 'utf8');
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readDeliveryRecords(projectId: string): Promise<Map<string, DeliveryRecord>> {
  const result = new Map<string, DeliveryRecord>();
  try {
    const names = await readdir(deliveryDirFor(projectId));
    await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
      const jobId = name.slice(0, -'.json'.length);
      const record = await readDeliveryRecord(projectId, jobId);
      if (record) result.set(jobId, record);
    }));
  } catch {
    // No delivery directory yet is the normal state for a project that never packaged.
  }
  return result;
}

export async function deliveryRecordExists(record: DeliveryRecord): Promise<boolean> {
  if (record.status !== 'ready' || !record.file) return false;
  try {
    const info = await stat(resolve(deliveryDirFor(record.projectId), record.file));
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

/**
 * An archive only speaks for the revision and QC verdict it was built from. A newer
 * blocking verdict expires it outright; a changed revision makes it out of date.
 * Records written before those fields existed cannot be dated, so only the QC gate applies.
 */
export function deliveryStaleReason(
  record: DeliveryRecord,
  current?: { revision?: number; qcStatus?: QcStatus },
): DeliveryStaleReason | null {
  if (record.status !== 'ready') return null;
  if (current?.qcStatus === 'blocking') return 'qc-blocking';
  if (current?.revision !== undefined && record.revision !== undefined && record.revision !== current.revision) {
    return 'project-changed';
  }
  return null;
}

export async function deliveryRecordView(
  record: DeliveryRecord,
  current?: { revision?: number; qcStatus?: QcStatus },
): Promise<DeliveryRecordView> {
  return { ...record, fileExists: await deliveryRecordExists(record), stale: deliveryStaleReason(record, current) };
}

/** Keeps the first creation time but always refreshes the attempt counter and updatedAt. */
export function nextDeliveryRecord(input: {
  previous: DeliveryRecord | null;
  projectId: string;
  jobId: string;
  stamp: string;
  status: 'ready' | 'failed';
  name?: string;
  file?: string;
  bytes?: number;
  files?: number;
  missing?: DeliveryMissing[];
  error?: string;
  revision?: number;
  qc?: DeliveryQcSnapshot;
}): DeliveryRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    projectId: input.projectId,
    jobId: input.jobId,
    status: input.status,
    stamp: input.stamp,
    name: input.name,
    file: input.file,
    bytes: input.bytes,
    files: input.files,
    missing: input.missing ?? [],
    error: input.error,
    attempts: (input.previous?.attempts ?? 0) + 1,
    createdAt: input.previous?.createdAt ?? now,
    updatedAt: now,
    revision: input.revision,
    qc: input.qc,
  };
}
