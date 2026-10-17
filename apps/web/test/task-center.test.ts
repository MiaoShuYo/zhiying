import test from 'node:test';
import assert from 'node:assert/strict';
import { chapterProgress, formatElapsed, isActiveTask, readTaskProgress, retryModeFor, retryRequest } from '../src/lib/task-actions';

test('failed jobs retry through the endpoint that owns their kind', () => {
  assert.equal(retryModeFor({ kind: 'render', status: 'failed' }), 'render');
  assert.equal(retryModeFor({ kind: 'tts', status: 'failed' }), 'voice');
  assert.equal(retryModeFor({ kind: 'storyboard', status: 'failed' }, 'failed'), 'step');
  // A storyboard job can only be resumed while the project itself is failed.
  assert.equal(retryModeFor({ kind: 'storyboard', status: 'failed' }, 'awaiting_review'), null);
});

test('only abandoned or cancelled tasks offer recovery', () => {
  assert.equal(retryModeFor({ kind: 'storyboard', status: 'running', ageMs: 60_000 }), null);
  assert.equal(retryModeFor({ kind: 'storyboard', status: 'running', ageMs: 16 * 60_000 }), 'recover');
  assert.equal(retryModeFor({ kind: 'render', status: 'cancelled' }), 'render');
  assert.equal(retryModeFor({ kind: 'tts', status: 'cancelled' }), null);
  assert.equal(retryModeFor({ kind: 'render', status: 'completed' }), null);
  assert.equal(isActiveTask('queued') && isActiveTask('running'), true);
  assert.equal(isActiveTask('failed'), false);
});

test('retry requests reuse the existing project and job routes', () => {
  const target = { projectId: 'p1', jobId: 'j1' };
  assert.deepEqual(retryRequest('render', target), { url: '/api/jobs/j1', method: 'POST' });
  // 导出前检查确认风险后，重试请求带上 allowIssues 由服务端放行。
  assert.deepEqual(retryRequest('render', { ...target, allowIssues: true }), { url: '/api/jobs/j1', method: 'POST', body: { allowIssues: true } });
  assert.equal(retryRequest('render', { projectId: 'p1' }), null);
  assert.deepEqual(retryRequest('voice', target), { url: '/api/projects/p1/voice/generate', method: 'POST', body: { speed: 1 } });
  assert.deepEqual(retryRequest('step', target), { url: '/api/projects/p1/retry', method: 'POST', body: { mode: 'step' } });
  assert.deepEqual(retryRequest('restart', target), { url: '/api/projects/p1/retry', method: 'POST', body: { mode: 'restart' } });
  assert.deepEqual(retryRequest('recover', target), { url: '/api/projects/p1/recover', method: 'POST' });
});

test('chapters.json drives the checklist and page provenance', () => {
  const entries = [{ index: 1, title: '引言', page: 1 }, { index: 2, title: '方法' }, { index: 3, title: '结论' }];
  assert.deepEqual(chapterProgress(entries, { completedChapters: 2, chapterCount: 3 }), [
    { index: 1, title: '引言', done: true, page: 1 },
    { index: 2, title: '方法', done: true },
    { index: 3, title: '结论', done: false },
  ]);
});

test('a missing chapters.json still separates done from pending', () => {
  assert.deepEqual(chapterProgress(null, { completedChapters: 1, chapterCount: 3 }), [
    { index: 1, title: '第 1 章', done: true },
    { index: 2, title: '第 2 章', done: false },
    { index: 3, title: '第 3 章', done: false },
  ]);
  assert.equal(chapterProgress([], { completedChapters: 0 }), undefined);
  assert.equal(chapterProgress(undefined, null), undefined);
});

test('progress parsing tolerates missing and malformed payloads', () => {
  assert.deepEqual(readTaskProgress(null), {});
  assert.deepEqual(readTaskProgress('not json'), {});
  assert.deepEqual(readTaskProgress(JSON.stringify({ percent: 42, message: '已完成 2 / 5 章', completedChapters: 2, chapterCount: 5, currentChapter: '第 3 章：方法' })), { percent: 42, message: '已完成 2 / 5 章', completedChapters: 2, chapterCount: 5, currentChapter: '第 3 章：方法' });
  assert.deepEqual(readTaskProgress(JSON.stringify({ percent: '42' })), { percent: undefined, message: undefined, completedChapters: undefined, chapterCount: undefined, currentChapter: undefined });
});

test('elapsed time reads naturally in Chinese', () => {
  assert.equal(formatElapsed(4_000), '4 秒');
  assert.equal(formatElapsed(192_000), '3 分 12 秒');
  assert.equal(formatElapsed(3_840_000), '1 小时 4 分');
  assert.equal(formatElapsed(-5), '0 秒');
});
