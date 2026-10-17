export const SHARED_VIDEO = 'final.mp4';
export const PER_JOB_VIDEO = /^[a-zA-Z0-9_-]+\.mp4$/;

// V1.0 rendered every export over the same final.mp4 and never recorded Job.outputPath,
// so a project can hold several completed renders while the disk holds one video. That
// shared file belongs to the newest completed render only; the older records never had
// their own video, and handing them the same bytes made every download indistinguishable.
export function sharedVideoOwner<T extends { id: string; kind: string; status: string; outputPath: string | null; createdAt: Date | string }>(jobs: T[]) {
  if (jobs.some(job => job.kind === 'render' && job.outputPath === SHARED_VIDEO)) return null;
  const legacy = jobs.filter(job => job.kind === 'render' && job.status === 'completed' && !job.outputPath);
  return legacy.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]?.id ?? null;
}
