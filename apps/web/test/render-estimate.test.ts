import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SceneSchema,
  StoryboardSchema,
  blockingFindings,
  estimateRender,
  estimateSummary,
  fullRenderPlan,
  planReasons,
  segmentPlan,
  type PlannedSegment,
  type PlanReasonSummary,
  type RenderPlan,
  type SegmentKind,
  type Storyboard,
} from '@m2v/schema';
import { cacheHint, encoderLabel, freeDiskLabel, reasonSegments, workerLabel } from '../src/lib/render-estimate-view';

const planOf = (patch: Partial<RenderPlan> = {}): RenderPlan => {
  const totalSeconds = patch.totalSeconds ?? 600;
  return {
    version: 1,
    preset: 'full',
    fps: 30,
    totalFrames: Math.round(totalSeconds * 30),
    totalSeconds,
    segments: Array.from({ length: 3 }, (_, index) => ({ key: `scene:${index}`, kind: 'scene', index }) as PlannedSegment),
    reusedCount: 0,
    renderedCount: 3,
    reusedFrames: 0,
    renderedFrames: Math.round(totalSeconds * 30),
    reusedSeconds: 0,
    renderedSeconds: totalSeconds,
    ...patch,
  };
};

const reasonOf = (items: { kind: SegmentKind; index: number }[]): PlanReasonSummary => ({
  code: 'content',
  label: '内容有改动',
  count: items.length,
  segments: items.map(item => ({ key: `${item.kind}:${item.index}`, kind: item.kind, index: item.index } as PlannedSegment)),
});

const board = (count: number): Storyboard => StoryboardSchema.parse({
  title: '复用示例',
  styleId: 'minimal-tech',
  scenes: Array.from({ length: count }, (_, index) => SceneSchema.parse({
    id: `s${index}`, type: 'title', title: `场景 ${index}`, narration: `第 ${index} 段讲解。`, duration: 6, visual: {},
  })),
});

test('a stopped worker never blocks a render on its own', () => {
  const offline = estimateRender({ plan: planOf(), workerOnline: false });
  assert.equal(offline.danger, true);
  assert.equal(offline.findings.some(finding => finding.code === 'worker_offline'), true);
  assert.deepEqual(blockingFindings(offline), [], '队列是持久的，Worker 没起来时应该允许先排队');
});

test('disk and duration dangers have to be confirmed before queuing', () => {
  const base = estimateRender({ plan: planOf() });
  const lowDisk = estimateRender({ plan: planOf(), freeDiskBytes: base.diskNeedBytes - 1 });
  const blockers = blockingFindings(lowDisk);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].code, 'disk_low');
  assert.equal(blockers[0].level, 'danger');
  const longTask = estimateRender({ plan: planOf({ renderedSeconds: 4000, totalSeconds: 4000 }) });
  assert.deepEqual(blockingFindings(longTask).map(finding => finding.code), ['long_task']);
  const tight = estimateRender({ plan: planOf(), freeDiskBytes: Math.round(base.diskNeedBytes * 1.2) });
  assert.deepEqual(blockingFindings(tight), [], '警告级别只需要提示，不需要确认');
});

test('reason rows name the segments they cover', () => {
  assert.equal(reasonSegments(reasonOf([{ kind: 'scene', index: 0 }, { kind: 'scene', index: 1 }, { kind: 'scene', index: 2 }])), '场景 1、场景 2、场景 3');
  assert.equal(reasonSegments(reasonOf([{ kind: 'intro', index: 0 }, { kind: 'outro', index: 0 }])), '片头、片尾');
  assert.equal(reasonSegments(reasonOf([])), '');
  const many = Array.from({ length: 9 }, (_, index) => ({ kind: 'scene' as const, index }));
  assert.equal(reasonSegments(reasonOf(many)), '场景 1、场景 2、场景 3、场景 4、场景 5、场景 6 等 9 个');
  assert.equal(reasonSegments(reasonOf(many.slice(0, 2))), '场景 1、场景 2', '没有截断时不要追加计数');
});

test('the panel only warns about a cache that cannot be reused', () => {
  assert.equal(cacheHint({ segments: 5 }, { reusedCount: 0 }), '缓存中有 5 个片段，但没有与本项目当前分镜匹配的片段。');
  assert.equal(cacheHint({ segments: 5 }, { reusedCount: 5 }), null);
  assert.equal(cacheHint({ segments: 0 }, { reusedCount: 0 }), null);
});

test('worker, encoder and disk labels never show a raw value', () => {
  assert.equal(workerLabel({ online: true, busy: false }), '空闲');
  assert.equal(workerLabel({ online: true, busy: true }), '忙碌');
  assert.equal(workerLabel({ online: false, busy: false }), '未运行');
  assert.equal(encoderLabel('qsv'), '硬件 QSV');
  assert.equal(encoderLabel('x264'), '软件 x264');
  assert.equal(encoderLabel(null), '软件 x264', '没检测到编码器时按软件编码提示');
  assert.equal(freeDiskLabel(null), '未知');
  assert.equal(freeDiskLabel(undefined), '未知');
  assert.equal(freeDiskLabel(1024 * 1024 * 1024), '1.0 GB');
});

test('the summary the panel shows matches the planned reuse', () => {
  const storyboard = board(2);
  const first = fullRenderPlan(storyboard);
  const cached = first.segments.map(segment => ({ key: segment.key, fingerprint: segment.fingerprint, frames: segment.frames, parts: segment.parts }));
  const reuse = segmentPlan({ storyboard, cached });
  const estimate = estimateRender({ plan: reuse });
  assert.equal(planReasons(reuse).length, 0);
  assert.equal(estimate.renderedSeconds, 0);
  assert.ok(estimateSummary(estimate, reuse).startsWith('复用 2/2 个片段，只渲染 0 秒'));
});
