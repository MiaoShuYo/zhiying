/** Wording shared by the render estimate panel and its tests; pure so it can run on the client. */

import { formatBytes, type EstimateFinding, type PlanReasonSummary, type RenderEstimate } from '@m2v/schema';

export const confidenceLabels: Record<RenderEstimate['confidence'], string> = {
  high: '高（来自本机历史任务）',
  medium: '中（样本较少）',
  low: '低（按默认速度估算）',
};

export const levelLabels: Record<EstimateFinding['level'], string> = { danger: '风险', warning: '注意', info: '提示' };

/** A reason row names the segments it covers so a re-render is never a black box. */
export function reasonSegments(reason: PlanReasonSummary, limit = 6): string {
  if (reason.segments.length === 0) return '';
  const names = reason.segments
    .slice(0, limit)
    .map(segment => (segment.kind === 'intro' ? '片头' : segment.kind === 'outro' ? '片尾' : `场景 ${segment.index + 1}`))
    .join('、');
  return reason.segments.length > limit ? `${names} 等 ${reason.segments.length} 个` : names;
}

export const encoderLabel = (encoder?: string | null): string => (encoder === 'qsv' ? '硬件 QSV' : '软件 x264');

export const workerLabel = (worker: { online: boolean; busy: boolean }): string => (worker.online ? (worker.busy ? '忙碌' : '空闲') : '未运行');

export const freeDiskLabel = (bytes: number | null | undefined): string => (typeof bytes === 'number' ? formatBytes(bytes) : '未知');

/** True when the cache holds segments that the current storyboard cannot use. */
export const cacheHint = (cache: { segments: number }, plan: { reusedCount: number }): string | null =>
  (plan.reusedCount === 0 && cache.segments > 0 ? `缓存中有 ${cache.segments} 个片段，但没有与本项目当前分镜匹配的片段。` : null);
