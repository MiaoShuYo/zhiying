import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RENDER_FPS,
  SceneSchema,
  StoryboardSchema,
  estimateRender,
  estimateSummary,
  formatBytes,
  formatDuration,
  fullRenderPlan,
  hasDanger,
  planReasons,
  segmentPlan,
  type EstimateInput,
  type PlannedSegment,
  type RenderPlan,
  type RenderSample,
} from '../src/index';

/** A hand built plan keeps the duration arithmetic in the tests readable. */
const planOf = (patch: Partial<RenderPlan> = {}): RenderPlan => {
  const totalSeconds = patch.totalSeconds ?? 600;
  return {
    version: 1,
    preset: 'full',
    fps: RENDER_FPS,
    totalFrames: Math.round(totalSeconds * RENDER_FPS),
    totalSeconds,
    segments: Array.from({ length: 4 }, () => ({}) as PlannedSegment),
    reusedCount: 0,
    renderedCount: 4,
    reusedFrames: 0,
    renderedFrames: Math.round(totalSeconds * RENDER_FPS),
    reusedSeconds: 0,
    renderedSeconds: totalSeconds,
    ...patch,
  };
};

const estimateOf = (patch: Partial<EstimateInput> = {}) => estimateRender({ plan: planOf(), ...patch });

const findingsOf = (value: ReturnType<typeof estimateRender>) => value.findings.map(finding => finding.code);

const scene = (patch: Record<string, unknown> = {}) => SceneSchema.parse({
  id: 'scene-1', type: 'title', title: '开场', narration: '第一句。第二句。', duration: 6, visual: {}, ...patch,
});

const board = (count: number) => StoryboardSchema.parse({
  title: '估算示例',
  styleId: 'minimal-tech',
  scenes: Array.from({ length: count }, (_, index) => scene({ id: `s${index}`, title: `场景 ${index}`, narration: `第 ${index} 段讲解。` })),
});

test('formatDuration covers seconds, minutes and hours', () => {
  assert.equal(formatDuration(0), '0 秒');
  assert.equal(formatDuration(-5), '0 秒', '负数和 NaN 都按 0 处理');
  assert.equal(formatDuration(Number.NaN), '0 秒');
  assert.equal(formatDuration(45), '45 秒');
  assert.equal(formatDuration(59.4), '59 秒');
  assert.equal(formatDuration(60), '1 分钟');
  assert.equal(formatDuration(90), '1 分 30 秒');
  assert.equal(formatDuration(3599), '59 分 59 秒');
  assert.equal(formatDuration(3600), '1 小时');
  assert.equal(formatDuration(5400), '1 小时 30 分');
});

test('formatBytes picks KB, MB and GB without lying about tiny files', () => {
  assert.equal(formatBytes(0), '0 MB');
  assert.equal(formatBytes(-1), '0 MB');
  assert.equal(formatBytes(512), '1 KB', '不足 1KB 也至少显示 1KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(120 * 1024 * 1024), '120 MB');
  assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GB');
});

test('without history the estimate is conservative and marked low confidence', () => {
  const value = estimateOf();
  assert.equal(value.confidence, 'low');
  assert.equal(value.sampleCount, 0);
  assert.equal(value.realtimeFactor, 0.95, '没有历史时用 libx264 的保守系数');
  assert.equal(value.renderSeconds, 570, '渲染时长只统计需要重渲染的秒数');
  assert.equal(value.totalSeconds, 600);
  assert.ok(findingsOf(value).includes('history_missing'));
  assert.equal(hasDanger(value), false);
});

test('hardware encoding is estimated faster than libx264', () => {
  const qsv = estimateOf({ encoder: 'qsv' });
  const x264 = estimateOf({ encoder: 'x264' });
  assert.equal(qsv.realtimeFactor, 0.55);
  assert.ok(qsv.totalDurationSeconds < x264.totalDurationSeconds);
  assert.ok(qsv.encodeSeconds < x264.encodeSeconds);
  assert.equal(findingsOf(qsv).includes('software_encoder'), false);
  assert.equal(findingsOf(x264).includes('software_encoder'), true);
  assert.equal(findingsOf(x264).includes('worker_offline'), false, '只给了编码器信息时不该报 Worker 离线');
});

test('finished jobs replace the fallback factors and raise confidence', () => {
  const samples: RenderSample[] = Array.from({ length: 5 }, () => ({ preset: 'full', videoSeconds: 600, durationSeconds: 1800, outputBytes: 600 * 1024 * 1024 }));
  const value = estimateOf({ samples });
  assert.equal(value.confidence, 'high');
  assert.equal(value.sampleCount, 5);
  assert.equal(value.realtimeFactor, 3);
  assert.equal(value.renderSeconds, 1800, '按历史倍率估算渲染耗时');
  assert.equal(value.outputBytes, 600 * 1024 * 1024, '按历史每秒钟的成片体积估算');
  assert.equal(findingsOf(value).includes('history_missing'), false);
  const single = estimateOf({ samples: samples.slice(0, 1) });
  assert.equal(single.confidence, 'medium');
});

test('samples from the other preset are ignored', () => {
  const samples: RenderSample[] = Array.from({ length: 5 }, () => ({ preset: 'draft', videoSeconds: 600, durationSeconds: 60, outputBytes: 10 * 1024 * 1024 }));
  const value = estimateOf({ samples });
  assert.equal(value.sampleCount, 0, '草稿的历史不能用来估算交付渲染');
  assert.equal(value.realtimeFactor, 0.95);
  const draft = estimateOf({ plan: planOf({ preset: 'draft' }), samples });
  assert.equal(draft.confidence, 'high');
  assert.equal(draft.realtimeFactor, 0.1);
  assert.ok(draft.totalDurationSeconds < value.totalDurationSeconds, '草稿必须明显更快');
});

test('a nearly full disk is a danger, a tight disk is a warning', () => {
  const base = estimateOf();
  assert.ok(base.diskNeedBytes > base.outputBytes, '片段缓存与拼接中间文件都要算进去');
  const low = estimateOf({ freeDiskBytes: base.diskNeedBytes - 1 });
  assert.equal(findingsOf(low).includes('disk_low'), true);
  assert.equal(hasDanger(low), true);
  const finding = low.findings.find(item => item.code === 'disk_low')!;
  assert.equal(finding.level, 'danger');
  assert.ok(finding.hint, '磁盘不足必须给出可执行的清理建议');
  const tight = estimateOf({ freeDiskBytes: Math.round(base.diskNeedBytes * 1.2) });
  assert.equal(findingsOf(tight).includes('disk_tight'), true);
  assert.equal(findingsOf(tight).includes('disk_low'), false);
  assert.equal(hasDanger(tight), false);
  assert.equal(tight.warning, true);
  const roomy = estimateOf({ freeDiskBytes: base.diskNeedBytes * 10 });
  assert.equal(findingsOf(roomy).includes('disk_low'), false);
  assert.equal(findingsOf(roomy).includes('disk_tight'), false);
  assert.equal(roomy.findings.some(item => item.level === 'danger' || item.level === 'warning'), false, '空间充足时不要给风险提示');
});

test('long renders are flagged as warnings and dangers by expected duration', () => {
  const warning = estimateOf({ plan: planOf({ renderedSeconds: 1200, totalSeconds: 1200 }) });
  assert.equal(findingsOf(warning).includes('long_task'), true);
  assert.equal(warning.findings.find(item => item.code === 'long_task')!.level, 'warning');
  assert.equal(hasDanger(warning), false);
  assert.ok(warning.totalDurationSeconds > 20 * 60 && warning.totalDurationSeconds < 45 * 60);
  const danger = estimateOf({ plan: planOf({ renderedSeconds: 3000, totalSeconds: 3000 }) });
  assert.equal(danger.findings.find(item => item.code === 'long_task')!.level, 'danger');
  assert.equal(hasDanger(danger), true);
});

test('queue, scene count and Worker state are surfaced', () => {
  const busy = estimateOf({ workerOnline: false, workerBusy: true, queuedJobs: 2 });
  assert.equal(findingsOf(busy).includes('worker_offline'), true);
  assert.equal(findingsOf(busy).includes('worker_busy'), true);
  assert.equal(findingsOf(busy).includes('queue_busy'), true);
  assert.equal(busy.findings.find(item => item.code === 'queue_busy')!.level, 'info');
  assert.equal(hasDanger(busy), true);
  const many = estimateOf({ plan: planOf({ segments: Array.from({ length: 31 }, () => ({}) as PlannedSegment) }) });
  assert.equal(findingsOf(many).includes('many_scenes'), true);
  assert.equal(estimateOf({ plan: planOf({ segments: Array.from({ length: 30 }, () => ({}) as PlannedSegment) }) }).findings.some(item => item.code === 'many_scenes'), false);
});

test('current CPU pressure and low available memory produce actionable resource findings', () => {
  const pressured = estimateOf({ resources: { cpuPercent: 91.2, memoryAvailableBytes: 900 * 1024 * 1024 } });
  assert.equal(pressured.findings.find(item => item.code === 'cpu_busy')?.level, 'warning');
  assert.equal(pressured.findings.find(item => item.code === 'memory_low')?.level, 'danger');
  assert.ok(pressured.findings.find(item => item.code === 'memory_low')?.hint);
  assert.equal(hasDanger(pressured), true);
  const roomy = estimateOf({ resources: { cpuPercent: 35, memoryAvailableBytes: 8 * 1024 ** 3 } });
  assert.equal(findingsOf(roomy).includes('cpu_busy'), false);
  assert.equal(findingsOf(roomy).includes('memory_low'), false);
});

test('reusing segments only charges the segments that must run', () => {
  const storyboard = board(3);
  const full = fullRenderPlan(storyboard);
  const reuseAll = segmentPlan({ storyboard, cached: full.segments.map(segment => ({ key: segment.key, fingerprint: segment.fingerprint, frames: segment.frames, parts: segment.parts })) });
  const first = estimateRender({ plan: full });
  const second = estimateRender({ plan: reuseAll });
  assert.equal(reuseAll.renderedCount, 0);
  assert.equal(planReasons(reuseAll).length, 0);
  assert.equal(second.renderSeconds, 0);
  assert.ok(second.totalDurationSeconds < first.totalDurationSeconds, '全部复用后只剩编码与收尾开销');
  assert.ok(second.encodeSeconds === first.encodeSeconds, '复用不减少编码时间，因为还要拼成片');
  assert.equal(estimateSummary(second, reuseAll), `复用 3/3 个片段，只渲染 0 秒，预计 ${formatDuration(second.totalDurationSeconds)}，占用约 ${formatBytes(second.diskNeedBytes)}`);
  assert.ok(estimateSummary(first, full).startsWith('需要渲染全部 3 个片段'));
});
