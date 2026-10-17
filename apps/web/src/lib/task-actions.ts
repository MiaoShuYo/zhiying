/** Task-centre vocabulary and retry routing. Pure so the aggregate API, the page and the editor all agree. */

export type RetryMode = 'step' | 'restart' | 'render' | 'voice' | 'recover';

export type RetryRequest = { url: string; method: 'POST'; body?: Record<string, unknown> };

export type ChapterEntry = { index: number; title: string; page?: number };
export type ChapterTask = { index: number; title: string; done: boolean; page?: number };

export type TaskProgress = { percent?: number; message?: string; completedChapters?: number; chapterCount?: number; currentChapter?: string };

export const activeTaskStatuses = ['queued', 'running', 'cancelling'];

export const taskKindLabels: Record<string, string> = { storyboard: '长文生成', tts: '语音生成', render: '视频渲染' };
export const taskStatusLabels: Record<string, string> = { queued: '排队中', running: '执行中', cancelling: '正在停止', cancelled: '已取消', completed: '已完成', failed: '失败' };
export const retryLabels: Record<RetryMode, string> = {
  step: '从失败步骤重试',
  restart: '从头重新执行',
  render: '重新渲染',
  voice: '重新生成语音',
  recover: '检查并释放占用',
};

export const isActiveTask = (status: string) => activeTaskStatuses.includes(status);

/** Only transcription-style jobs can be re-run from their failed step. */
export function retryModeFor(job: { kind?: string | null; status: string; ageMs?: number }, projectStatus?: string): RetryMode | null {
  if (job.status === 'failed') {
    if (job.kind === 'render') return 'render';
    if (job.kind === 'tts') return 'voice';
    return projectStatus === 'failed' ? 'step' : null;
  }
  if (job.status === 'cancelled') return job.kind === 'render' ? 'render' : null;
  // A job that has produced nothing for 15 minutes is treated as abandoned; the
  // recovery endpoint is the only way out of the project lock.
  if (activeTaskStatuses.includes(job.status) && (job.ageMs ?? 0) > 15 * 60_000) return 'recover';
  return null;
}

/** The task centre reuses the existing retry routes instead of a parallel path. */
export function retryRequest(mode: RetryMode, target: { projectId: string; jobId?: string; allowIssues?: boolean }): RetryRequest | null {
  // A render retry runs the export check server-side, so the retry button only
  // adds allowIssues after the user has seen and accepted the blocking issues.
  if (mode === 'render') return target.jobId ? { url: `/api/jobs/${target.jobId}`, method: 'POST', ...(target.allowIssues ? { body: { allowIssues: true } } : {}) } : null;
  if (mode === 'voice') return { url: `/api/projects/${target.projectId}/voice/generate`, method: 'POST', body: { speed: 1 } };
  if (mode === 'step') return { url: `/api/projects/${target.projectId}/retry`, method: 'POST', body: { mode: 'step' } };
  if (mode === 'restart') return { url: `/api/projects/${target.projectId}/retry`, method: 'POST', body: { mode: 'restart' } };
  return { url: `/api/projects/${target.projectId}/recover`, method: 'POST' };
}

/** `chapters.json` is authoritative; without it the counters in `progress` still separate done from pending. */
export function chapterProgress(entries: ChapterEntry[] | null | undefined, progress: TaskProgress | null | undefined): ChapterTask[] | undefined {
  const done = Math.max(0, progress?.completedChapters ?? 0);
  if (entries?.length) return entries.map(entry => ({ index: entry.index, title: entry.title, done: entry.index <= done, ...(entry.page ? { page: entry.page } : {}) }));
  const count = progress?.chapterCount ?? 0;
  if (count <= 0) return undefined;
  return Array.from({ length: count }, (_, index) => ({ index: index + 1, title: `第 ${index + 1} 章`, done: index + 1 <= done }));
}

export function readTaskProgress(raw?: string | null): TaskProgress {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const pick = (key: string) => typeof value[key] === 'number' ? value[key] as number : undefined;
    const text = (key: string) => typeof value[key] === 'string' ? value[key] as string : undefined;
    return { percent: pick('percent'), message: text('message'), completedChapters: pick('completedChapters'), chapterCount: pick('chapterCount'), currentChapter: text('currentChapter') };
  } catch { return {}; }
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
