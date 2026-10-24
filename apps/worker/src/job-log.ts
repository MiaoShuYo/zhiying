import { appendFile, open, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Job ids come from Prisma cuid(); anything else must never be turned into a path. */
export const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Long renders can log a lot; the file is capped so a stuck job cannot fill the disk. */
export const MAX_JOB_LOG_BYTES = 2 * 1024 * 1024;

const stamp = () => new Date().toISOString();

export const jobLogFileName = (jobId: string) => `${jobId}.log`;

export const jobLogPath = (outputDir: string, jobId: string) => {
  if (!JOB_ID_PATTERN.test(jobId)) throw new Error(`任务 ID 无效：${jobId}`);
  return join(outputDir, jobLogFileName(jobId));
};

export type JobLogLevel = 'info' | 'warn' | 'error';

export type JobLog = {
  /** Path written into `Job.logPath`; relative to the project output directory. */
  file: string;
  path: string;
  bytes: () => number;
  info: (message: string, detail?: unknown) => Promise<void>;
  warn: (message: string, detail?: unknown) => Promise<void>;
  error: (message: string, detail?: unknown) => Promise<void>;
  close: () => Promise<void>;
};

export const formatJobLogLine = (level: JobLogLevel, message: string, detail?: unknown) => {
  const suffix = detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  return `[${stamp()}] ${level.toUpperCase()} ${message}${suffix}\n`;
};

/**
 * Appends to `data/projects/<id>/output/<jobId>.log`. Writes are serialised so
 * concurrent progress ticks never interleave, and a full log stops recording
 * instead of failing the render.
 */
export async function openJobLog(outputDir: string, jobId: string): Promise<JobLog> {
  await mkdir(outputDir, { recursive: true });
  const path = jobLogPath(outputDir, jobId);
  let bytes = (await stat(path).catch(() => null))?.size ?? 0;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  const write = (level: JobLogLevel, message: string, detail?: unknown) => {
    chain = chain.then(async () => {
      if (closed) return;
      if (bytes >= MAX_JOB_LOG_BYTES) {
        if (bytes === MAX_JOB_LOG_BYTES) {
          const notice = formatJobLogLine('warn', '日志已达到大小上限，后续内容不再记录');
          await appendFile(path, notice, 'utf8').catch(() => {});
          bytes += Buffer.byteLength(notice);
        }
        return;
      }
      const line = formatJobLogLine(level, message, detail);
      await appendFile(path, line, 'utf8').catch(() => {});
      bytes += Buffer.byteLength(line);
    });
    return chain;
  };
  return {
    file: jobLogFileName(jobId),
    path,
    bytes: () => bytes,
    info: (message, detail) => write('info', message, detail),
    warn: (message, detail) => write('warn', message, detail),
    error: (message, detail) => write('error', message, detail),
    close: async () => { closed = true; await chain.catch(() => {}); },
  };
}

const TAIL_WINDOW_BYTES = 512 * 1024;

/**
 * Reads the tail of a job log without loading a huge file into memory.
 * `truncated` reports that the beginning of the file was skipped.
 */
export async function readJobLogTail(file: string, tail = 200): Promise<{ lines: string[]; total: number; truncated: boolean; bytes: number }> {
  const size = (await stat(file).catch(() => null))?.size ?? 0;
  if (size === 0) return { lines: [], total: 0, truncated: false, bytes: 0 };
  const start = size > TAIL_WINDOW_BYTES ? size - TAIL_WINDOW_BYTES : 0;
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    const all = text.split('\n').filter(line => line.trim().length > 0);
    const lines = tail > 0 ? all.slice(-tail) : all;
    return { lines, total: all.length, truncated: start > 0, bytes: size };
  } finally {
    await handle.close();
  }
}
