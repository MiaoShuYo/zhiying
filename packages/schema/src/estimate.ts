import type { RenderPlan } from './render-plan';

export type RenderSample = {
  preset?: string;
  /** Length of the video that was rendered, in seconds. */
  videoSeconds: number;
  /** Wall clock duration of the job, in seconds. */
  durationSeconds: number;
  outputBytes?: number | null;
};

export type EstimateCode =
  | 'disk_low'
  | 'disk_tight'
  | 'worker_offline'
  | 'worker_busy'
  | 'queue_busy'
  | 'long_task'
  | 'many_scenes'
  | 'history_missing'
  | 'software_encoder'
  | 'cpu_busy'
  | 'memory_low';

export type EstimateLevel = 'danger' | 'warning' | 'info';

export type EstimateFinding = {
  code: EstimateCode;
  level: EstimateLevel;
  message: string;
  hint?: string;
};

export type EstimateInput = {
  plan: RenderPlan;
  samples?: RenderSample[];
  freeDiskBytes?: number | null;
  workerOnline?: boolean;
  workerBusy?: boolean;
  queuedJobs?: number;
  /** `qsv` uses the hardware encoder, anything else falls back to libx264. */
  encoder?: string | null;
  /** Current host snapshot; used as a risk signal, not a peak-load prediction. */
  resources?: { cpuPercent?: number | null; memoryAvailableBytes?: number; memoryTotalBytes?: number; workerRssBytes?: number };
};

export type RenderEstimate = {
  preset: 'full' | 'draft';
  fps: number;
  totalSeconds: number;
  renderedSeconds: number;
  reusedSeconds: number;
  /** Seconds the worker spends producing frames. */
  renderSeconds: number;
  encodeSeconds: number;
  overheadSeconds: number;
  totalDurationSeconds: number;
  segmentBytes: number;
  outputBytes: number;
  diskNeedBytes: number;
  freeDiskBytes: number | null;
  realtimeFactor: number;
  confidence: 'high' | 'medium' | 'low';
  sampleCount: number;
  findings: EstimateFinding[];
  danger: boolean;
  warning: boolean;
};

const BYTES_PER_MB = 1024 * 1024;

/** Wall clock seconds per video second when no job history exists yet. */
const FALLBACK_REALTIME_FACTOR: Record<'qsv' | 'x264', number> = { qsv: 0.55, x264: 0.95 };
/** Encode seconds per video second. */
const ENCODE_FACTOR: Record<'qsv' | 'x264', number> = { qsv: 0.22, x264: 0.65 };
/** Output megabytes per video second when no job history exists yet. */
const FALLBACK_MB_PER_SECOND: Record<'full' | 'draft', number> = { full: 0.42, draft: 0.14 };
/** Intermediate segments are encoded at high quality, so they are larger than the final file. */
const SEGMENT_OVERHEAD = 1.35;
/** Raw concat output plus the renamed final file must both fit on disk. */
const DISK_OUTPUT_FACTOR = 1.9;

const isPositive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

const usableSamples = (samples: RenderSample[] | undefined, preset: 'full' | 'draft'): RenderSample[] => {
  if (!samples) return [];
  const matching = samples.filter(sample => (sample.preset === 'draft' ? 'draft' : 'full') === preset);
  const pool = matching.length > 0 ? matching : samples.filter(sample => !sample.preset);
  return pool.filter(sample => isPositive(sample.videoSeconds) && isPositive(sample.durationSeconds));
};

export const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 秒';
  const total = Math.round(seconds);
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${restMinutes} 分`;
};

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes < BYTES_PER_MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const megabytes = bytes / BYTES_PER_MB;
  if (megabytes < 1024) return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
  return `${(megabytes / 1024).toFixed(1)} GB`;
};

/**
 * Projects the cost of a render from the plan and the history of finished jobs.
 * The estimate is advisory: it never blocks a render on its own, the caller
 * decides what to do with `danger` / `findings`.
 */
export function estimateRender(input: EstimateInput): RenderEstimate {
  const { plan } = input;
  const preset: 'full' | 'draft' = plan.preset === 'draft' ? 'draft' : 'full';
  const encoder = input.encoder === 'qsv' ? 'qsv' : 'x264';
  const samples = usableSamples(input.samples, preset);
  const ratios = samples.map(sample => sample.durationSeconds / sample.videoSeconds);
  const byteRates = samples
    .filter(sample => isPositive(sample.outputBytes))
    .map(sample => (sample.outputBytes as number) / sample.videoSeconds);
  const realtimeFactor = median(ratios) ?? FALLBACK_REALTIME_FACTOR[encoder];
  const bytesPerSecond = median(byteRates) ?? FALLBACK_MB_PER_SECOND[preset] * BYTES_PER_MB;
  const encodeFactor = ENCODE_FACTOR[encoder] * (preset === 'draft' ? 0.45 : 1);
  const renderSeconds = plan.renderedSeconds * realtimeFactor;
  const encodeSeconds = plan.totalSeconds * encodeFactor;
  const overheadSeconds = 20 + plan.segments.length * 1.5;
  const totalDurationSeconds = renderSeconds + encodeSeconds + overheadSeconds;
  const outputBytes = Math.round(bytesPerSecond * plan.totalSeconds);
  const segmentBytes = Math.round(outputBytes * SEGMENT_OVERHEAD);
  const diskNeedBytes = Math.round(segmentBytes + outputBytes * DISK_OUTPUT_FACTOR);
  const rawFreeDisk = input.freeDiskBytes;
  const freeDiskBytes = typeof rawFreeDisk === 'number' && isPositive(rawFreeDisk) ? rawFreeDisk : null;
  const queuedJobs = typeof input.queuedJobs === 'number' && isPositive(input.queuedJobs) ? input.queuedJobs : 0;
  const sampleCount = samples.length || byteRates.length;
  const confidence: RenderEstimate['confidence'] = sampleCount >= 5 ? 'high' : sampleCount >= 1 ? 'medium' : 'low';
  const findings: EstimateFinding[] = [];

  if (input.workerOnline === false) {
    findings.push({
      code: 'worker_offline',
      level: 'danger',
      message: '渲染 Worker 未在运行，任务会一直停留在队列中。',
      hint: '运行 pnpm dev:worker 或在任务中心重新检测 Worker。',
    });
  }
  const cpuPercent = input.resources?.cpuPercent;
  if (typeof cpuPercent === 'number' && Number.isFinite(cpuPercent) && cpuPercent >= 85) {
    findings.push({ code: 'cpu_busy', level: 'warning', message: `当前系统 CPU 占用 ${Math.round(cpuPercent)}%，渲染期间可能出现排队或耗时增加。`, hint: '关闭其他高负载任务，或先使用草稿预设。' });
  }
  const memoryAvailableBytes = input.resources?.memoryAvailableBytes;
  if (isPositive(memoryAvailableBytes) && memoryAvailableBytes < 1024 * BYTES_PER_MB) {
    findings.push({ code: 'memory_low', level: 'danger', message: `当前可用内存仅 ${formatBytes(memoryAvailableBytes)}，长时间渲染可能因内存不足中断。`, hint: '先释放内存或重启 Worker，再开始渲染。' });
  } else if (isPositive(memoryAvailableBytes) && memoryAvailableBytes < 2 * 1024 * BYTES_PER_MB) {
    findings.push({ code: 'memory_low', level: 'warning', message: `当前可用内存仅 ${formatBytes(memoryAvailableBytes)}，大型项目渲染有内存压力。`, hint: '关闭其他高内存应用，或先使用草稿预设。' });
  }
  if (freeDiskBytes !== null && freeDiskBytes < diskNeedBytes) {
    findings.push({
      code: 'disk_low',
      level: 'danger',
      message: `磁盘剩余 ${formatBytes(freeDiskBytes)}，预计需要 ${formatBytes(diskNeedBytes)}，可能中途写盘失败。`,
      hint: '先清理 data/projects 下的旧成片或片段缓存，再开始渲染。',
    });
  } else if (freeDiskBytes !== null && freeDiskBytes < diskNeedBytes * 1.4) {
    findings.push({
      code: 'disk_tight',
      level: 'warning',
      message: `磁盘剩余 ${formatBytes(freeDiskBytes)}，接近预计占用 ${formatBytes(diskNeedBytes)}。`,
    });
  }
  if (totalDurationSeconds > 45 * 60) {
    findings.push({
      code: 'long_task',
      level: 'danger',
      message: `预计渲染 ${formatDuration(totalDurationSeconds)}，属于超长任务，建议先出草稿预设确认画面。`,
    });
  } else if (totalDurationSeconds > 20 * 60) {
    findings.push({
      code: 'long_task',
      level: 'warning',
      message: `预计渲染 ${formatDuration(totalDurationSeconds)}，请保持 Worker 运行，中断后可按阶段重试。`,
    });
  }
  if (plan.segments.length > 30) {
    findings.push({
      code: 'many_scenes',
      level: 'warning',
      message: `共 ${plan.segments.length} 个片段，失败时只会重渲染未完成的片段。`,
    });
  }
  if (input.workerBusy) {
    findings.push({
      code: 'worker_busy',
      level: 'warning',
      message: 'Worker 正在处理其他任务，本次渲染需要排队等待。',
    });
  }
  if (queuedJobs > 0) {
    findings.push({
      code: 'queue_busy',
      level: 'info',
      message: `队列中还有 ${queuedJobs} 个任务在前面。`,
    });
  }
  if (input.encoder && encoder === 'x264') {
    findings.push({
      code: 'software_encoder',
      level: 'info',
      message: '未检测到硬件编码器，将使用 libx264 软件编码，耗时更长。',
    });
  }
  if (sampleCount === 0 && plan.renderedCount > 0) {
    findings.push({
      code: 'history_missing',
      level: 'info',
      message: '还没有历史渲染记录，本次耗时为保守估计。',
    });
  }

  return {
    preset,
    fps: plan.fps,
    totalSeconds: plan.totalSeconds,
    renderedSeconds: plan.renderedSeconds,
    reusedSeconds: plan.reusedSeconds,
    renderSeconds: Math.round(renderSeconds * 10) / 10,
    encodeSeconds: Math.round(encodeSeconds * 10) / 10,
    overheadSeconds,
    totalDurationSeconds: Math.round(totalDurationSeconds),
    segmentBytes,
    outputBytes,
    diskNeedBytes,
    freeDiskBytes,
    realtimeFactor: Math.round(realtimeFactor * 100) / 100,
    confidence,
    sampleCount,
    findings,
    danger: findings.some(finding => finding.level === 'danger'),
    warning: findings.some(finding => finding.level === 'warning'),
  };
}

export const hasDanger = (estimate: RenderEstimate): boolean => estimate.danger;

/**
 * Risk findings that must be confirmed before a render may start. A stopped
 * worker is excluded on purpose: the queue is durable, so the job just waits.
 */
export const blockingFindings = (estimate: RenderEstimate): EstimateFinding[] =>
  estimate.findings.filter(finding => finding.level === 'danger' && finding.code !== 'worker_offline');

/** One line summary for the render tab; mirrors the plan's reuse counts. */
export function estimateSummary(estimate: RenderEstimate, plan: RenderPlan): string {
  const reuse = plan.reusedCount > 0
    ? `复用 ${plan.reusedCount}/${plan.segments.length} 个片段，只渲染 ${formatDuration(estimate.renderedSeconds)}`
    : `需要渲染全部 ${plan.segments.length} 个片段`;
  return `${reuse}，预计 ${formatDuration(estimate.totalDurationSeconds)}，占用约 ${formatBytes(estimate.diskNeedBytes)}`;
}
