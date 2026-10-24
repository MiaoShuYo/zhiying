import test from 'node:test';
import assert from 'node:assert/strict';
import { RENDER_STAGE_LABELS } from '@m2v/schema';
import {
  failureCodeHint,
  failureInfo,
  renderPercent,
  renderRecovery,
  renderStageLabel,
  retryModeFor,
  retryRequest,
  shouldShowChapterProgress,
  shouldShowTaskPercent,
  storyboardRetryAllowed,
} from '../src/lib/task-actions';

test('render stages have Chinese labels and unknown stages do not crash', () => {
  assert.equal(renderStageLabel('bundling'), '准备渲染资源');
  assert.equal(renderStageLabel('rendering'), '渲染画面');
  assert.equal(renderStageLabel('concatenating'), '拼接片段');
  assert.equal(renderStageLabel('encoding'), '视频编码');
  assert.equal(renderStageLabel('validating'), '校验成片');
  assert.equal(renderStageLabel('queued'), '等待 Worker');
  assert.equal(renderStageLabel('completed'), '已完成');
  assert.equal(renderStageLabel('brand-new-stage'), 'brand-new-stage', '未知阶段原样显示，方便排查');
  assert.equal(renderStageLabel(null), null);
  assert.equal(renderStageLabel(undefined), null);
  assert.equal(renderStageLabel('rendering'), RENDER_STAGE_LABELS.rendering);
});

test('every failure code explains itself', () => {
  for (const code of ['worker_lost', 'interrupted', 'cancelled', 'asset_missing', 'render_failed', 'concat_failed', 'encode_failed', 'validate_failed', 'unknown']) {
    assert.ok(failureCodeHint(code), `${code} 必须有中文说明`);
  }
  assert.equal(failureCodeHint('asset_missing'), '有素材文件缺失或被移动，先补齐素材再重试。');
  assert.equal(failureCodeHint('worker_lost'), 'Worker 进程在渲染中途退出，已完成的片段仍然有效。');
  assert.equal(failureCodeHint('something_else'), null);
  assert.equal(failureCodeHint(null), null);
});

test('a retry after a failure resumes from the finished segments', () => {
  const value = renderRecovery({ failedStage: 'rendering', failureCode: 'worker_lost', hasCache: true });
  assert.equal(value.kind, 'resume');
  assert.equal(value.label, '从已完成片段继续');
  assert.equal(value.stageLabel, '渲染画面');
  assert.equal(value.hint, '已完成的场景片段会被复用，只重渲染未完成的片段。');
});

test('a failure late in the pipeline only redoes the remaining steps', () => {
  assert.equal(renderRecovery({ failedStage: 'concatenating', hasCache: true }).hint, '画面片段已全部生成，重新渲染只需重做拼接、编码与校验。');
  assert.equal(renderRecovery({ failedStage: 'encoding', hasCache: true }).hint, '画面片段已全部生成，重新渲染只需重做编码与校验。');
  assert.equal(renderRecovery({ failedStage: 'validating', hasCache: true }).hint, '成片已生成但未通过校验，重新渲染只需重做编码与校验。');
  assert.equal(renderRecovery({ failedStage: 'bundling', hasCache: true }).hint, '渲染资源准备阶段失败，重新渲染会先重新打包资源与素材。');
  assert.equal(renderRecovery({}).hint, '已完成且未改动的场景片段会被复用，只重渲染未完成的部分。', '没有阶段信息也要给出可理解的默认说明');
});

test('missing cache or missing assets force a full restart', () => {
  const noCache = renderRecovery({ failedStage: 'rendering', hasCache: false });
  assert.equal(noCache.kind, 'restart');
  assert.equal(noCache.label, '忽略缓存重新渲染');
  assert.equal(noCache.hint, '还没有可复用的场景片段，本次会重新渲染全部画面。');
  const missing = renderRecovery({ failedStage: 'rendering', failureCode: 'asset_missing', hasCache: true });
  assert.equal(missing.kind, 'restart', '素材缺失时复用片段没有意义');
  assert.equal(missing.hint, '缺失的素材需要先补齐，否则重渲染会在同一位置再次失败。');
  const unknownCache = renderRecovery({ failedStage: 'rendering' });
  assert.equal(unknownCache.kind, 'resume', '缓存情况未知时先按可复用处理，Worker 会自己决定');
});

test('stage-local progress maps onto one overall bar', () => {
  assert.equal(renderPercent('queued', 50), 0);
  assert.equal(renderPercent(undefined, 50), 0);
  assert.equal(renderPercent('completed', 0), 100);
  assert.equal(renderPercent('bundling', 0), 0);
  assert.equal(renderPercent('bundling', 100), 8);
  assert.equal(renderPercent('rendering', 0), 8);
  assert.equal(renderPercent('rendering', 50), 44);
  assert.equal(renderPercent('rendering', 100), 80);
  assert.equal(renderPercent('concatenating', 0), 80);
  assert.equal(renderPercent('concatenating', 100), 86);
  assert.equal(renderPercent('encoding', 0), 86);
  assert.equal(renderPercent('encoding', 100), 97);
  assert.equal(renderPercent('validating', 0), 97);
  assert.equal(renderPercent('validating', 100), 100);
  assert.equal(renderPercent('rendering', 150), 80, '越界的进度要夹到区间内');
  assert.equal(renderPercent('rendering', -20), 8);
  assert.equal(renderPercent('rendering', null), 8, '没有进度时停在阶段起点');
  assert.equal(renderPercent('unknown-stage', 42), 42, '未知阶段直接透传');
});

test('overall progress never goes backwards between stages', () => {
  const stages = ['bundling', 'rendering', 'concatenating', 'encoding', 'validating'];
  for (let index = 1; index < stages.length; index += 1) {
    const previousEnd = renderPercent(stages[index - 1], 100);
    const nextStart = renderPercent(stages[index], 0);
    assert.equal(nextStart, previousEnd, `${stages[index]} 必须接着 ${stages[index - 1]} 的进度`);
  }
  assert.equal(renderPercent(stages.at(-1)!, 100), 100);
});

test('failed and cancelled renders name the stage in the task centre', () => {
  const failed = failureInfo({ kind: 'render', status: 'failed', failedStage: 'encoding', failureCode: 'encode_failed', error: '' })!;
  assert.equal(failed.title, '视频渲染失败 · 视频编码');
  assert.equal(failed.detail, '渲染进程在完成前意外结束。');
  assert.equal(failed.actions[0], 'render');
  assert.ok(failed.hint.includes('视频编码失败'), '失败原因要写进提示里');
  const plain = failureInfo({ kind: 'render', status: 'failed' })!;
  assert.equal(plain.title, '视频渲染失败');
  const cancelled = failureInfo({ kind: 'render', status: 'cancelled', failedStage: 'concatenating' })!;
  assert.equal(cancelled.title, '渲染已取消 · 拼接片段');
  assert.equal(cancelled.detail, '任务在成片完成前被取消。');
});

test('the latest failed storyboard can resume while its previous storyboard stays available', () => {
  const failed = failureInfo({ kind: 'storyboard', status: 'failed', stage: 'storyboarding' }, 'awaiting_review', true)!;
  assert.deepEqual(failed.actions, ['step', 'restart']);
  assert.match(failed.hint, /校验检查点/);
  assert.equal(retryModeFor({ kind: 'storyboard', status: 'failed' }, 'awaiting_review', true), 'step');
  assert.equal(retryModeFor({ kind: 'storyboard', status: 'failed' }, 'awaiting_review', false), null, '旧的失败记录不能重试');
  const allowed = { jobId: 'latest', latestJobId: 'latest', jobStatus: 'failed', projectStatus: 'awaiting_review', hasStoryboard: true, failedStage: 'storyboarding' };
  assert.equal(storyboardRetryAllowed(allowed), true);
  assert.equal(storyboardRetryAllowed({ ...allowed, latestJobId: 'newer' }), false, '任务中心和接口都只允许最新失败记录');
  assert.equal(storyboardRetryAllowed({ ...allowed, failedStage: 'extracting' }), false, '保留原分镜时只能恢复分镜阶段');
  assert.equal(storyboardRetryAllowed({ ...allowed, hasStoryboard: false }), false);
});

test('failed storyboard attempts never present stale progress as a resumable checkpoint', () => {
  assert.equal(shouldShowChapterProgress('failed'), false);
  assert.equal(shouldShowChapterProgress('cancelled'), false);
  assert.equal(shouldShowChapterProgress('running'), true);
  assert.equal(shouldShowChapterProgress('completed'), true);
  assert.equal(shouldShowTaskPercent('failed'), false);
  assert.equal(shouldShowTaskPercent('running'), true);
});

test('retry requests carry the resume or restart mode', () => {
  assert.deepEqual(retryRequest('render', { projectId: 'p1', jobId: 'j1' }), { url: '/api/jobs/j1', method: 'POST' });
  assert.deepEqual(retryRequest('render', { projectId: 'p1', jobId: 'j1', renderMode: 'resume' }), { url: '/api/jobs/j1', method: 'POST' });
  assert.deepEqual(retryRequest('render', { projectId: 'p1', jobId: 'j1', renderMode: 'restart' }), { url: '/api/jobs/j1', method: 'POST', body: { mode: 'restart' } });
  assert.deepEqual(retryRequest('render', { projectId: 'p1', jobId: 'j1', allowIssues: true, confirmRisks: true }), { url: '/api/jobs/j1', method: 'POST', body: { allowIssues: true, confirmRisks: true } });
  assert.equal(retryRequest('render', { projectId: 'p1' }), null, '渲染重试必须有作业 id');
  assert.deepEqual(retryRequest('voice', { projectId: 'p1' }), { url: '/api/projects/p1/voice/generate', method: 'POST', body: { speed: 1 } });
  assert.deepEqual(retryRequest('step', { projectId: 'p1' }), { url: '/api/projects/p1/retry', method: 'POST', body: { mode: 'step' } });
  assert.deepEqual(retryRequest('restart', { projectId: 'p1' }), { url: '/api/projects/p1/retry', method: 'POST', body: { mode: 'restart' } });
  assert.deepEqual(retryRequest('recover', { projectId: 'p1' }), { url: '/api/projects/p1/recover', method: 'POST' });
});

test('an abandoned render still routes to the recover endpoint', () => {
  const stale = failureInfo({ kind: 'render', status: 'running', stage: 'rendering', ageMs: 20 * 60_000 })!;
  assert.equal(stale.title, '任务疑似中断');
  assert.deepEqual(stale.actions, ['recover']);
  assert.equal(failureInfo({ kind: 'render', status: 'running', ageMs: 60_000 }), null, '还在正常推进的任务不该提示失败');
  assert.equal(failureInfo({ kind: 'render', status: 'completed' }), null);
});
