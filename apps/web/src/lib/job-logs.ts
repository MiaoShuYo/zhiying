import { open, stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';

/** Ids come from the database, but the log path is built from them, so validate the shape first. */
export const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const MAX_TAIL_LINES = 1000;
const DEFAULT_TAIL_LINES = 200;
const READ_WINDOW_BYTES = 512 * 1024;

export const clampTail = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(MAX_TAIL_LINES, parsed) : DEFAULT_TAIL_LINES;
};

/**
 * Absolute log path for a job, or `null` when the ids could escape the output
 * directory. Both the resolved parent and the file name are checked.
 */
export function resolveJobLogPath(dataRoot: string, projectId: string, jobId: string): string | null {
  if (!JOB_ID_PATTERN.test(projectId) || !JOB_ID_PATTERN.test(jobId)) return null;
  const dir = resolve(dataRoot, 'projects', projectId, 'output');
  const file = resolve(dir, `${jobId}.log`);
  if (basename(file) !== `${jobId}.log`) return null;
  if (!file.startsWith(`${dir}${sep}`)) return null;
  return file;
}

/** Keeps the last `count` lines; the first line is dropped when the read window cut it in half. */
export function tailLines(text: string, count: number, windowed = false): string[] {
  const lines = text.split(/\r?\n/);
  if (windowed && lines.length > 0) lines.shift();
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
  return lines.slice(-Math.max(1, count));
}

export type JobLogTail = { exists: boolean; lines: string[]; bytes: number; windowed: boolean };

/** Reads only the end of the log so a long render does not load the whole file. */
export async function readJobLog(file: string, tail: number): Promise<JobLogTail> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return { exists: false, lines: [], bytes: 0, windowed: false };
  const start = Math.max(0, info.size - READ_WINDOW_BYTES);
  const length = info.size - start;
  if (length <= 0) return { exists: true, lines: [], bytes: info.size, windowed: start > 0 };
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return { exists: true, lines: tailLines(buffer.subarray(0, bytesRead).toString('utf8'), tail, start > 0), bytes: info.size, windowed: start > 0 };
  } finally { await handle.close(); }
}
