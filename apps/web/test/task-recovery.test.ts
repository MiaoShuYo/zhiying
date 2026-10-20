import test from 'node:test';
import assert from 'node:assert/strict';
import { failureInfo, retryLabels, retryModeFor, retryRequest } from '../src/lib/task-actions';

test('interrupted tasks name what stopped and how to continue', () => {
  const failedRender = failureInfo({ kind: 'render', status: 'failed' });
  assert.equal(failedRender?.title, '视频渲染失败');
  assert.deepEqual(failedRender?.actions, ['render']);
  assert.match(failedRender!.hint, /未完成的视频不会进入导出记录/);

  const cancelledRender = failureInfo({ kind: 'render', status: 'cancelled' });
  assert.equal(cancelledRender?.title, '渲染已取消');
  const cancelledTts = failureInfo({ kind: 'tts', status: 'cancelled' });
  assert.equal(cancelledTts?.title, '语音生成已取消');
  assert.deepEqual(cancelledTts?.actions, ['voice']);
  const cancelledStoryboard = failureInfo({ kind: 'storyboard', status: 'cancelled' });
  assert.equal(cancelledStoryboard?.title, '内容生成已取消');
  assert.deepEqual(cancelledStoryboard?.actions, ['step', 'restart']);
});

test('a failed storyboard job keeps the recorded reason and needs a failed project to resume', () => {
  assert.equal(failureInfo({ kind: 'storyboard', status: 'failed', error: '第 3 章解析失败', stage: 'storyboarding' }, 'failed')?.detail, '第 3 章解析失败');
  assert.equal(failureInfo({ kind: 'storyboard', status: 'failed', stage: 'storyboarding' }, 'failed')?.title, '分镜生成失败');
  assert.equal(failureInfo({ kind: 'storyboard', status: 'failed' }, 'failed')?.detail, '长文生成任务在执行中停止。');
  // Without a failed project there is no safe action, so the card explains instead of offering a button.
  const blocked = failureInfo({ kind: 'storyboard', status: 'failed' }, 'awaiting_review');
  assert.deepEqual(blocked?.actions, []);
  assert.match(blocked!.hint, /打开项目查看状态/);
});

test('stale progress is reported as a suspected interruption', () => {
  const stale = failureInfo({ kind: 'render', status: 'running', ageMs: 20 * 60_000 });
  assert.equal(stale?.title, '任务疑似中断');
  assert.equal(stale?.detail, '已经 20 分钟没有收到进度更新。');
  assert.deepEqual(stale?.actions, ['recover']);
  assert.equal(failureInfo({ kind: 'render', status: 'running', ageMs: 60_000 }), null);
  assert.equal(failureInfo({ kind: 'render', status: 'completed' }), null);
});

test('every offered action maps to an existing route', () => {
  const target = { projectId: 'p1', jobId: 'j1' };
  const jobs = [
    { kind: 'render', status: 'failed' },
    { kind: 'tts', status: 'failed' },
    { kind: 'storyboard', status: 'failed' },
    { kind: 'storyboard', status: 'cancelled' },
    { kind: 'render', status: 'running', ageMs: 16 * 60_000 },
  ];
  for (const job of jobs) {
    const info = failureInfo(job, 'failed');
    assert.ok(info, `${job.kind}/${job.status} should explain itself`);
    assert.ok(info!.actions.length > 0, `${job.kind}/${job.status} should offer an action`);
    for (const action of info!.actions) {
      assert.ok(retryLabels[action], `${action} needs a label`);
      assert.notEqual(retryRequest(action, target), null, `${action} needs a route`);
    }
  }
});

test('retry routing stays on the existing endpoints', () => {
  const target = { projectId: 'p1', jobId: 'j1' };
  assert.equal(retryRequest('render', { projectId: 'p1' }), null);
  assert.deepEqual(retryRequest('recover', target), { url: '/api/projects/p1/recover', method: 'POST' });
  assert.deepEqual(retryRequest('restart', target), { url: '/api/projects/p1/retry', method: 'POST', body: { mode: 'restart' } });
  assert.deepEqual(retryRequest('voice', target), { url: '/api/projects/p1/voice/generate', method: 'POST', body: { speed: 1 } });
  assert.equal(retryModeFor({ kind: 'tts', status: 'cancelled' }), 'voice');
  assert.equal(retryModeFor({ kind: 'storyboard', status: 'cancelled' }), 'step');
  assert.equal(retryModeFor({ kind: 'render', status: 'completed' }), null);
});
