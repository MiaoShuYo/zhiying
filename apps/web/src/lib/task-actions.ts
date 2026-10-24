/** Task-centre vocabulary and retry routing. Pure so the aggregate API, the page and the editor all agree. */

import { RENDER_STAGE_LABELS } from '@m2v/schema';

export type RetryMode = 'step' | 'restart' | 'render' | 'voice' | 'recover';

/** A render retry either reuses the segment cache or ignores it. */
export type RenderRetryMode = 'resume' | 'restart';

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
export const shouldShowChapterProgress = (status: string) => isActiveTask(status) || status === 'completed';
export const shouldShowTaskPercent = (status: string) => isActiveTask(status) || status === 'completed';

export function storyboardRetryAllowed(input: {
  jobId: string;
  latestJobId?: string;
  jobStatus: string;
  projectStatus: string;
  hasStoryboard?: boolean;
  failedStage?: string | null;
}) {
  if (input.latestJobId !== input.jobId || !['failed', 'cancelled'].includes(input.jobStatus)) return false;
  if (input.projectStatus === 'failed') return true;
  return input.projectStatus === 'awaiting_review' && Boolean(input.hasStoryboard) && input.failedStage === 'storyboarding';
}

/** Only transcription-style jobs can be re-run from their failed step. */
export function retryModeFor(job: { kind?: string | null; status: string; ageMs?: number }, projectStatus?: string, canRetryStoryboard = job.status === 'cancelled' || projectStatus === 'failed'): RetryMode | null {
  if (job.status === 'failed') {
    if (job.kind === 'render') return 'render';
    if (job.kind === 'tts') return 'voice';
    return canRetryStoryboard ? 'step' : null;
  }
  if (job.status === 'cancelled') {
    if (job.kind === 'render') return 'render';
    if (job.kind === 'tts') return 'voice';
    return canRetryStoryboard ? 'step' : null;
  }
  // A job that has produced nothing for 15 minutes is treated as abandoned; the
  // recovery endpoint is the only way out of the project lock.
  if (activeTaskStatuses.includes(job.status) && (job.ageMs ?? 0) > 15 * 60_000) return 'recover';
  return null;
}

export type FailureInfo = { title: string; detail: string; hint: string; actions: RetryMode[] };

/** Human labels for the worker's render stages; `queued` and terminal states included. */
export const renderStageLabels: Record<string, string> = RENDER_STAGE_LABELS;
export const renderStageLabel = (stage?: string | null): string | null => (stage ? RENDER_STAGE_LABELS[stage] ?? stage : null);

export const renderRetryLabels: Record<RenderRetryMode, string> = {
  resume: '从已完成片段继续',
  restart: '忽略缓存重新渲染',
};

const failureCodeHints: Record<string, string> = {
  worker_lost: 'Worker 进程在渲染中途退出，已完成的片段仍然有效。',
  interrupted: '任务被中断，已完成的片段仍然有效。',
  cancelled: '任务被手动取消。',
  asset_missing: '有素材文件缺失或被移动，先补齐素材再重试。',
  render_failed: '画面渲染阶段失败，常见原因是本地浏览器或显存不足。',
  concat_failed: '片段拼接失败，通常是某个片段缺少音频轨或磁盘写入失败。',
  encode_failed: '视频编码失败，多为磁盘空间不足或编码器不可用。',
  validate_failed: '成片校验未通过，需要检查时长、分辨率或音频轨。',
  unknown: '没有识别到具体原因，请展开任务日志查看最后的输出。',
};

export const failureCodeHint = (code?: string | null): string | null => (code ? failureCodeHints[code] ?? null : null);

export type RenderRecovery = { kind: RenderRetryMode; label: string; hint: string; stageLabel: string | null };

const stageRecoveryHints: Record<string, string> = {
  bundling: '渲染资源准备阶段失败，重新渲染会先重新打包资源与素材。',
  rendering: '已完成的场景片段会被复用，只重渲染未完成的片段。',
  concatenating: '画面片段已全部生成，重新渲染只需重做拼接、编码与校验。',
  encoding: '画面片段已全部生成，重新渲染只需重做编码与校验。',
  validating: '成片已生成但未通过校验，重新渲染只需重做编码与校验。',
};

/**
 * What a retry after a failed render will actually redo. Without a usable
 * segment cache the honest answer is a full re-render.
 */
export function renderRecovery(input: { failedStage?: string | null; failureCode?: string | null; hasCache?: boolean }): RenderRecovery {
  const stageLabel = renderStageLabel(input.failedStage);
  const code = input.failureCode ?? '';
  const resumable = input.hasCache !== false && code !== 'asset_missing';
  const kind: RenderRetryMode = resumable ? 'resume' : 'restart';
  const hint = code === 'asset_missing'
    ? '缺失的素材需要先补齐，否则重渲染会在同一位置再次失败。'
    : input.hasCache === false
      ? '还没有可复用的场景片段，本次会重新渲染全部画面。'
      : stageRecoveryHints[input.failedStage ?? ''] ?? '已完成且未改动的场景片段会被复用，只重渲染未完成的部分。';
  return { kind, label: renderRetryLabels[kind], hint, stageLabel };
}

/** Why a task stopped and which of the existing retry routes can carry it forward. */
export function failureInfo(
  job: { kind?: string | null; status: string; stage?: string | null; failedStage?: string | null; failureCode?: string | null; error?: string | null; ageMs?: number },
  projectStatus?: string,
  canRetryStoryboard = projectStatus === 'failed',
): FailureInfo | null {
  const detail = job.error?.trim() || '';
  if (job.status === 'failed') {
    if (job.kind === 'render') {
      const stageLabel = renderStageLabel(job.failedStage);
      const codeHint = failureCodeHint(job.failureCode);
      return {
        title: stageLabel ? `视频渲染失败 · ${stageLabel}` : '视频渲染失败',
        detail: detail || '渲染进程在完成前意外结束。',
        hint: `重新渲染会先检查导出条件；已生成的语音和字幕不会重做，未完成的视频不会进入导出记录。${codeHint ?? ''}`,
        actions: ['render'],
      };
    }
    if (job.kind === 'tts') {
      return { title: '语音生成失败', detail: detail || '语音任务没有生成完整的音频。', hint: '重新生成语音会覆盖未完成的音频，分镜和旁白文案保持不变。', actions: ['voice'] };
    }
    const stageTitle = job.stage === 'extracting' ? '资料读取失败' : job.stage === 'storyboarding' ? '分镜生成失败' : '内容解析失败';
    const retryable = canRetryStoryboard;
    return {
      title: stageTitle,
      detail: detail || '长文生成任务在执行中停止。',
      hint: retryable
        ? '从失败步骤继续时会校验检查点，只复用与当前资料匹配且完整的章节；无有效检查点时会重新生成。从头执行会清空当前分镜。'
        : '这不是项目的最新失败任务，或项目状态已变化；请打开项目确认当前分镜状态。',
      actions: retryable ? ['step', 'restart'] : [],
    };
  }
  if (job.status === 'cancelled') {
    if (job.kind === 'render') {
      const stageLabel = renderStageLabel(job.failedStage);
      return { title: stageLabel ? `渲染已取消 · ${stageLabel}` : '渲染已取消', detail: '任务在成片完成前被取消。', hint: '可以直接重新渲染；已完成的片段会被复用，取消时未完成的文件不会作为导出记录出现。', actions: ['render'] };
    }
    if (job.kind === 'tts') {
      return { title: '语音生成已取消', detail: '任务在语音生成完成前被取消。', hint: '重新生成语音即可继续，已生成的分镜不会改变。', actions: ['voice'] };
    }
    return { title: '内容生成已取消', detail: '任务在长文生成完成前被取消。', hint: '从中断处继续会保留已完成章节；从头执行会重新解析全文。', actions: ['step', 'restart'] };
  }
  if (activeTaskStatuses.includes(job.status) && (job.ageMs ?? 0) > 15 * 60_000) {
    return { title: '任务疑似中断', detail: `已经 ${Math.round((job.ageMs ?? 0) / 60_000)} 分钟没有收到进度更新。`, hint: '先检查并释放占用，再按提示重新执行；直接重复提交可能被项目锁拒绝。', actions: ['recover'] };
  }
  return null;
}

/** The task centre reuses the existing retry routes instead of a parallel path. */
export function retryRequest(mode: RetryMode, target: { projectId: string; jobId?: string; allowIssues?: boolean; confirmRisks?: boolean; renderMode?: RenderRetryMode }): RetryRequest | null {
  // A render retry runs the export check server-side, so the retry button only
  // adds allowIssues after the user has seen and accepted the blocking issues.
  if (mode === 'render') {
    if (!target.jobId) return null;
    const body: Record<string, unknown> = {};
    if (target.allowIssues) body.allowIssues = true;
    if (target.confirmRisks) body.confirmRisks = true;
    if (target.renderMode === 'restart') body.mode = 'restart';
    return { url: `/api/jobs/${target.jobId}`, method: 'POST', ...(Object.keys(body).length > 0 ? { body } : {}) };
  }
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

/** Each stage owns a slice of the bar; the worker reports progress within its own stage. */
const stageSlices: Record<string, [number, number]> = {
  bundling: [0, 8],
  rendering: [8, 80],
  concatenating: [80, 86],
  encoding: [86, 97],
  validating: [97, 100],
};

/** Overall render progress for a stage-local percentage. */
export function renderPercent(stage?: string | null, percent?: number | null): number {
  if (stage === 'completed') return 100;
  if (!stage || stage === 'queued' || stage === 'created') return 0;
  const slice = stageSlices[stage];
  const local = Math.max(0, Math.min(100, typeof percent === 'number' ? percent : 0));
  if (!slice) return Math.round(local);
  return Math.round(slice[0] + ((slice[1] - slice[0]) * local) / 100);
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
