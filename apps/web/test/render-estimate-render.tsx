import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SceneSchema,
  StoryboardSchema,
  estimateRender,
  fullRenderPlan,
  planReasons,
  segmentPlan,
  type Storyboard,
} from '@m2v/schema';
import { RenderEstimateBody, type RenderEstimatePayload } from '../src/components/render-estimate-panel';

const board = (count: number): Storyboard => StoryboardSchema.parse({
  title: '渲染面板示例',
  styleId: 'minimal-tech',
  scenes: Array.from({ length: count }, (_, index) => SceneSchema.parse({
    id: `s${index}`, type: 'title', title: `场景 ${index}`, narration: `第 ${index} 段讲解。`, duration: 6, visual: {},
  })),
});

const payloadOf = (storyboard: Storyboard, patch: Partial<RenderEstimatePayload> = {}): RenderEstimatePayload => {
  const plan = fullRenderPlan(storyboard);
  const estimate = estimateRender({ plan, freeDiskBytes: 50 * 1024 * 1024 * 1024 });
  return {
    projectId: 'p1',
    preset: 'full',
    plan,
    estimate,
    reasons: planReasons(plan),
    worker: { online: true, busy: false, encoder: 'qsv', ageMs: 1200 },
    cache: { segments: 0, bytes: 0 },
    samples: 0,
    ...patch,
  };
};

const html = (payload: RenderEstimatePayload, preset: 'full' | 'draft' = 'full') =>
  renderToStaticMarkup(createElement(RenderEstimateBody, { payload, preset }));

test('the panel renders the summary, the cost grid and the plan reasons', () => {
  const payload = payloadOf(board(3));
  const markup = html(payload);
  assert.ok(markup.includes('render-estimate-body'));
  assert.ok(markup.includes('渲染前估算'));
  assert.ok(markup.includes('成片'));
  assert.ok(markup.includes('需要渲染全部 3 个片段'), markup);
  assert.ok(markup.includes('预计耗时'));
  assert.ok(markup.includes('片段复用'));
  assert.ok(markup.includes('0 / 3'));
  assert.ok(markup.includes('硬件 QSV'));
  assert.ok(markup.includes('空闲'));
  assert.ok(markup.includes('新增片段 · 3 个'), '第一次渲染要说明全部片段都是新增');
  assert.ok(markup.includes('场景 1、场景 2、场景 3'));
  assert.equal(markup.includes('render-estimate-danger'), false, '没有风险时不要整块标红');
});

test('the draft preset is labelled and reuse is shown', () => {
  const storyboard = board(2);
  const first = fullRenderPlan(storyboard);
  const reuse = segmentPlan({
    storyboard,
    cached: first.segments.map(segment => ({ key: segment.key, fingerprint: segment.fingerprint, frames: segment.frames, parts: segment.parts })),
  });
  const estimate = estimateRender({ plan: reuse });
  const markup = html({
    ...payloadOf(storyboard),
    preset: 'draft',
    plan: reuse,
    estimate,
    reasons: planReasons(reuse),
    cache: { segments: reuse.segments.length, bytes: 10 },
  }, 'draft');
  assert.ok(markup.includes('540p 草稿'));
  assert.ok(markup.includes('复用 2/2 个片段'), '复用信息要写在摘要里');
  assert.equal(markup.includes('render-estimate-reasons'), false, '全部复用时不该有原因列表');
});

test('risks are listed with their fix, and danger marks the whole panel', () => {
  const storyboard = board(2);
  const plan = fullRenderPlan(storyboard);
  const estimate = estimateRender({ plan, freeDiskBytes: 1024 * 1024, workerOnline: false });
  const markup = html(payloadOf(storyboard, {
    plan,
    estimate,
    reasons: planReasons(plan),
    worker: { online: false, busy: false, encoder: 'x264', ageMs: null },
  }));
  assert.ok(markup.includes('render-estimate-danger'));
  assert.ok(markup.includes('风险'), '风险等级要显示出来');
  assert.ok(markup.includes('磁盘剩余'), markup);
  assert.ok(markup.includes('先清理 data/projects 下的旧成片或片段缓存'), '每条风险都要带处理建议');
  assert.ok(markup.includes('软件 x264'));
  assert.ok(markup.includes('未运行'));
  assert.ok(markup.includes('未知') === false, '可用空间有数值时不该显示未知');
});

test('resource pressure is shown as a current snapshot with remediation', () => {
  const storyboard = board(2);
  const plan = fullRenderPlan(storyboard);
  const estimate = estimateRender({ plan, resources: { cpuPercent: 92, memoryAvailableBytes: 768 * 1024 * 1024 } });
  const markup = html(payloadOf(storyboard, {
    plan, estimate, reasons: planReasons(plan),
    worker: { online: true, busy: false, encoder: 'qsv', ageMs: 1200, resources: { cpuPercent: 92, memoryAvailableBytes: 768 * 1024 * 1024, memoryTotalBytes: 16 * 1024 ** 3, workerRssBytes: 200 * 1024 * 1024 } },
  }));
  assert.ok(markup.includes('当前系统 CPU 占用 92%'));
  assert.ok(markup.includes('当前可用内存仅'));
  assert.ok(markup.includes('释放内存或重启 Worker'));
});

test('a cache full of stale segments is explained instead of silently ignored', () => {
  const storyboard = board(2);
  const markup = html(payloadOf(storyboard, { cache: { segments: 7, bytes: 2048 } }));
  assert.ok(markup.includes('缓存中有 7 个片段，但没有与本项目当前分镜匹配的片段。'));
});
