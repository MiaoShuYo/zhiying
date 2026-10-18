import { resolve } from 'node:path';

export const SHARED_VIDEO = 'final.mp4';
export const PER_JOB_VIDEO = /^[a-zA-Z0-9_-]+\.mp4$/;

/** Every render of a project lives next to the database, keyed by job id. */
export function outputDirFor(projectId: string) {
  return resolve(process.cwd(), '..', '..', 'data', 'projects', projectId, 'output');
}

// V1.0 rendered every export over the same final.mp4 and never recorded Job.outputPath,
// so a project can hold several completed renders while the disk holds one video. That
// shared file belongs to the newest completed render only; the older records never had
// their own video, and handing them the same bytes made every download indistinguishable.
export function sharedVideoOwner<T extends { id: string; kind: string; status: string; outputPath: string | null; createdAt: Date | string }>(jobs: T[]) {
  if (jobs.some(job => job.kind === 'render' && job.outputPath === SHARED_VIDEO)) return null;
  const legacy = jobs.filter(job => job.kind === 'render' && job.status === 'completed' && !job.outputPath);
  return legacy.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]?.id ?? null;
}

type RenderJob = { id: string; kind: string; status: string; outputPath: string | null; createdAt: Date | string };

/** The file this export record owns, or `null` when a newer render replaced the shared one. */
export function ownedVideoPath(job: { id: string; outputPath: string | null }, renders: RenderJob[]) {
  if (job.outputPath && PER_JOB_VIDEO.test(job.outputPath)) return job.outputPath;
  return job.id === sharedVideoOwner(renders) ? SHARED_VIDEO : null;
}

/** A shared final.mp4 is only trustworthy when it is not older than the render that
 * claims it; per-job files are already unambiguous. */
export function videoFileIsCurrent(owned: string, job: { createdAt: Date | string }, mtimeMs: number) {
  return owned !== SHARED_VIDEO || mtimeMs + 1000 >= new Date(job.createdAt).getTime();
}

/** Project names may hold anything; downloads keep letters, digits and simple separators. */
export function safeFileBaseName(name: string, fallback = '项目') {
  return name.replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/[.\s]+$/g, '') || fallback;
}

/** Local time stamp used by every exported file name: 20240131-0930. */
export function fileStamp(date: Date | string) {
  const at = date instanceof Date ? date : new Date(date);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}
