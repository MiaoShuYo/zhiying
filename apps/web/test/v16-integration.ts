import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

/**
 * V1.6 端到端：渲染前估算 → 风险拦截 → 只重渲染改动过的场景 → 失败后按阶段重试
 * → 任务中心与日志。整个流程跑在临时目录里，不会碰到真实的 data/ 与数据库。
 */
async function main() {
  const repo = process.cwd(), sandbox = resolve(repo, 'data', `test-v16-${randomUUID()}`);
  await mkdir(join(sandbox, 'apps/web/public/audio'), { recursive: true });
  await mkdir(join(sandbox, 'apps/web/public/projects'), { recursive: true });
  process.env.DATABASE_URL = `file:${join(sandbox, 'test.db').replaceAll('\\', '/')}`;
  const sql = execFileSync(process.execPath, [join(repo, 'apps/web/node_modules/prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', join(repo, 'apps/web/prisma/schema.prisma'), '--script'], { env: process.env, encoding: 'utf8' });
  const database = new DatabaseSync(join(sandbox, 'test.db')); database.exec(sql); database.close();
  process.chdir(join(sandbox, 'apps/web'));

  const { db } = await import('../src/lib/db');
  const { saveStoryboard } = await import('../src/lib/pipeline');
  const { buildRenderEstimate, segmentCacheDir, blockingFindings } = await import('../src/lib/render-plan-server');
  const { renderPercent } = await import('../src/lib/task-actions');
  const { planCoversTimeline } = await import('@m2v/schema');
  const { POST: startRender } = await import('../src/app/api/projects/[id]/render/route');
  const { POST: retryJob } = await import('../src/app/api/jobs/[id]/route');
  const { GET: readLogs } = await import('../src/app/api/jobs/[id]/logs/route');
  const { GET: readEstimate } = await import('../src/app/api/projects/[id]/render-estimate/route');
  const { GET: readTasks } = await import('../src/app/api/tasks/route');

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const url = (path: string) => `http://localhost${path}`;
  const body = async <T = Record<string, any>>(response: Response) => (await response.json()) as T;
  const post = (data: unknown) => new Request(url('/'), { method: 'POST', body: JSON.stringify(data) });
  const scene = (title: string, narration: string) => ({
    id: randomUUID(), type: 'title', title, narration, duration: 4,
    audioSrc: 'audio/demo.mp3', audioDuration: 3.8,
  });
  const board = (scenes: unknown[], extra: Record<string, unknown> = {}) => ({ title: '长项目', styleId: 'minimal-tech', scenes, ...extra });

  try {
    await writeFile(join(process.cwd(), 'public', 'audio', 'demo.mp3'), Buffer.from('AUDIO'));
    const projectId = (await db.project.create({ data: { name: '长项目', sourceText: '正文。'.repeat(20), status: 'awaiting_review' } })).id;
    const first = [scene('开场', '第一段旁白内容。'), scene('原理', '第二段旁白内容。'), scene('收尾', '第三段旁白内容。')];
    await saveStoryboard(projectId, board(first));
    const outputDir = join(sandbox, 'data', 'projects', projectId, 'output');

    // ── 1. 第一次渲染：计划覆盖整条时间轴，全部片段都要渲染 ──────────────
    const initial = await buildRenderEstimate(projectId, 'full');
    assert.ok(initial, '有分镜的项目一定能算出计划');
    assert.equal(initial.plan.segments.length, 3, '三个场景就是三个片段');
    assert.equal(initial.plan.reusedCount, 0);
    assert.equal(initial.plan.renderedCount, 3);
    assert.ok(planCoversTimeline(initial.plan), '片段必须无缝拼满整条时间轴');
    assert.equal(initial.plan.segments[0].startFrame, 0);
    assert.deepEqual(initial.reasons.map(reason => [reason.code, reason.count]), [['new', 3]]);
    assert.equal(initial.cache.segments, 0);
    assert.equal(initial.estimate.confidence, 'low', '没有历史记录时只能按默认速度估算');
    assert.equal(initial.worker.online, false, '沙箱里没有 Worker 心跳');
    assert.deepEqual(blockingFindings(initial.estimate), [], 'Worker 没运行只提示，不拦渲染（队列是持久的）');
    assert.deepEqual(initial.estimate.findings.filter(finding => finding.level === 'danger').map(finding => finding.code), ['worker_offline'], '唯一的髙危项就是 Worker 没运行');

    const startResponse = await startRender(post({ preset: 'full' }), params(projectId));
    assert.equal(startResponse.status, 202);
    const started = await body(startResponse);
    assert.equal(started.status, 'queued');
    assert.equal(started.plan.segments, 3);
    assert.equal(started.plan.reused, 0);
    const queued = await db.job.findUnique({ where: { id: started.jobId } });
    assert.ok(queued?.renderPlanJson, '排队时就把计划存下来，重试和任务中心才说得清复用情况');
    assert.equal(JSON.parse(queued!.renderPlanJson!).reusedCount, 0);

    // 模拟 Worker 在渲染画面阶段失败。
    const progress = JSON.stringify({ percent: 42, message: '正在渲染场景 2/3' });
    await db.job.update({
      where: { id: started.jobId },
      data: { status: 'failed', stage: 'rendering', failedStage: 'rendering', failureCode: 'render_failed', error: '片段渲染失败：Remotion 超时', progress },
    });

    // ── 2. 历史渲染记录把估算从“猜”变成“算”，超长任务要二次确认 ──────────
    const slowProject = (await db.project.create({ data: { name: '历史样本', sourceText: '正文。', status: 'completed' } })).id;
    const now = Date.now();
    const sampleJob = await db.job.create({
      data: {
        id: randomUUID(), projectId: slowProject, kind: 'render', status: 'completed', stage: 'completed',
        renderPlanJson: JSON.stringify({ preset: 'full', totalSeconds: 10, segments: [] }),
        startedAt: new Date(now - 3600_000), createdAt: new Date(now - 3600_000), updatedAt: new Date(now),
      },
    });
    const learned = await buildRenderEstimate(projectId, 'full');
    assert.ok(learned);
    assert.equal(learned.samples, 1, '完成的渲染会成为下一次估算的样本');
    assert.equal(learned.estimate.confidence, 'medium');
    assert.ok(learned.estimate.totalDurationSeconds > initial.estimate.totalDurationSeconds, '历史渲染很慢时估算要跟着变保守');
    assert.ok(learned.estimate.findings.some(finding => finding.code === 'long_task' && finding.level === 'danger'), '预计超过 45 分钟要报风险');
    assert.equal(blockingFindings(learned.estimate).length, 1, '正好一项需要确认的风险');

    const blocked = await startRender(post({ preset: 'full' }), params(projectId));
    const blockedBody = await body(blocked);
    assert.equal(blocked.status, 422, '没有确认风险时不允许排队');
    assert.equal(blockedBody.code, 'render_estimate');
    assert.equal(blockedBody.findings[0].code, 'long_task');
    assert.ok(blockedBody.estimate.totalDurationSeconds > 45 * 60);
    assert.deepEqual(blockedBody.plan.reasons.map((reason: any) => reason.code), ['new'], '拦截响应里要说明这次要渲染什么');
    const stillQueued = await db.job.count({ where: { projectId, status: 'queued' } });
    assert.equal(stillQueued, 0, '被拦下的渲染不会留下排队记录');

    const confirmed = await body(await startRender(post({ preset: 'full', confirmRisks: true }), params(projectId)));
    assert.ok(confirmed.jobId, '确认风险后照常排队');
    assert.ok(confirmed.estimate.totalDurationSeconds > 45 * 60, '确认页要能看到它确认的是什么');
    await db.job.update({ where: { id: confirmed.jobId }, data: { status: 'cancelled', stage: 'rendering' } });

    // ── 3. 有片段缓存时只重渲染改动过的场景 ─────────────────────────────
    const writeCache = async (targetId: string, plan: any) => {
      const dir = segmentCacheDir(targetId, 'full');
      await mkdir(dir, { recursive: true });
      for (const segment of plan.segments) {
        const name = `${segment.key.replace(/[^A-Za-z0-9_-]/g, '_')}-${segment.fingerprint}`;
        await writeFile(join(dir, `${name}.json`), JSON.stringify({ key: segment.key, kind: segment.kind, fingerprint: segment.fingerprint, frames: segment.frames, parts: segment.parts, version: 1, preset: 'full' }));
        await writeFile(join(dir, `${name}.mp4`), Buffer.alloc(1024, 3));
      }
    };
    const storyboardOf = async (targetId: string) => JSON.parse((await db.project.findUnique({ where: { id: targetId } }))!.storyboardJson!);
    await writeCache(projectId, initial.plan);
    const cached = await buildRenderEstimate(projectId, 'full');
    assert.ok(cached);
    assert.equal(cached.cache.segments, 3, '三个片段都进了缓存');
    assert.equal(cached.cache.bytes, 3 * 1024);
    assert.equal(cached.plan.reusedCount, 3);
    assert.equal(cached.plan.renderedCount, 0);
    assert.equal(cached.plan.renderedSeconds, 0, '全部复用时不渲染任何一秒');
    assert.deepEqual(cached.reasons, [], '没有改动就没有需要解释的重新渲染');
    assert.equal(cached.estimate.totalDurationSeconds < learned.estimate.totalDurationSeconds, true, '复用片段后估算要明显变短');

    // 增量渲染用一个干净的第二个项目验证，第一个项目的缓存保持完整供重试使用。
    const incrementalId = (await db.project.create({ data: { name: '增量渲染', sourceText: '正文。'.repeat(10), status: 'awaiting_review' } })).id;
    await saveStoryboard(incrementalId, board([scene('甲', '甲段旁白内容。'), scene('乙', '乙段旁白内容。'), scene('丙', '丙段旁白内容。')]));
    const incrementalPlan = await buildRenderEstimate(incrementalId, 'full');
    assert.ok(incrementalPlan);
    await writeCache(incrementalId, incrementalPlan.plan);
    const incrementalSaved = await storyboardOf(incrementalId);
    const untouched = await buildRenderEstimate(incrementalId, 'full');
    assert.ok(untouched);
    assert.equal(untouched.plan.reusedCount, 3, '刚渲染过的项目应该全部命中缓存');

    // BGM / 字幕等全局改动会让所有片段失效，而不是只报在改过的那个上。
    await saveStoryboard(incrementalId, { ...incrementalSaved, bgmVolume: 0.5 });
    const global = await buildRenderEstimate(incrementalId, 'full');
    assert.ok(global);
    assert.equal(global.plan.reusedCount, 0);
    assert.deepEqual(global.reasons.map(reason => [reason.code, reason.count]), [['global', 3]]);

    // 改回去以后缓存重新命中，不需要重渲染。
    await saveStoryboard(incrementalId, incrementalSaved);
    const backToStart = await buildRenderEstimate(incrementalId, 'full');
    assert.ok(backToStart);
    assert.equal(backToStart.plan.reusedCount, 3, '撤销全局改动后原来的片段还能直接用');

    // 改一个场景的旁白：只有这一个片段需要重渲染，另外两个原样复用。
    await saveStoryboard(incrementalId, { ...incrementalSaved, scenes: incrementalSaved.scenes.map((item: any, position: number) => (position === 1 ? { ...item, narration: '乙段旁白做了修改。' } : item)) });
    const partial = await buildRenderEstimate(incrementalId, 'full');
    assert.ok(partial);
    assert.equal(partial.plan.reusedCount, 2);
    assert.equal(partial.plan.renderedCount, 1);
    assert.deepEqual(partial.reasons.map(reason => [reason.code, reason.count]), [['content', 1]]);
    assert.equal(partial.reasons[0].segments[0].index, 1, '改的是第二幕');
    assert.equal(partial.reasons[0].segments[0].reason, 'content');
    assert.equal(partial.cache.segments, 3, '旧片段不会被删掉，撤销修改后还能复用');
    // 旁白改动会连带作废该场景的配音与手动字幕，避免用旧音频渲染新台词。
    const afterEdit = await storyboardOf(incrementalId);
    assert.equal(afterEdit.scenes[1].audioSrc, undefined, '台词改了就要重新配音');
    assert.equal(afterEdit.scenes[0].audioSrc, 'audio/demo.mp3', '其他场景的配音不受影响');
    assert.equal(afterEdit.scenes[2].audioSrc, 'audio/demo.mp3');

    // ── 4. 失败重试：resume 复用片段，restart 全部重渲染 ─────────────────
    await db.job.delete({ where: { id: sampleJob.id } });
    const afterSample = await buildRenderEstimate(projectId, 'full');
    assert.ok(afterSample);
    assert.deepEqual(blockingFindings(afterSample.estimate), [], '删掉超慢样本后不再有需要确认的风险');

    const resume = await body(await retryJob(post({ mode: 'resume' }), params(started.jobId)));
    assert.equal(resume.mode, 'resume');
    assert.equal(resume.status, 'queued');
    assert.equal(resume.attempt, (await db.job.findUnique({ where: { id: started.jobId } }))!.attempt + 1, '重试要记录第几次尝试');
    assert.equal(JSON.parse(resume.inputJson).noCache, undefined, 'resume 不能清空缓存');
    assert.equal(JSON.parse(resume.renderPlanJson).reusedCount, 3, '存下来的计划就是实际会跑的计划');

    await db.job.delete({ where: { id: resume.id } });
    const restart = await body(await retryJob(post({ mode: 'restart' }), params(started.jobId)));
    assert.equal(restart.mode, 'restart');
    assert.equal(JSON.parse(restart.inputJson).noCache, true, 'restart 明确忽略缓存');
    assert.equal(JSON.parse(restart.renderPlanJson).reusedCount, 0, 'restart 的计划里没有可复用的片段');
    assert.equal(JSON.parse(restart.renderPlanJson).renderedCount, 3);

    // ── 5. 任务中心把阶段、复用、可恢复状态集中展示 ──────────────────────
    const tasks = await body(await readTasks(new Request(url(`/api/tasks?projectId=${projectId}`))));
    const task = tasks.tasks.find((item: any) => item.id === started.jobId);
    assert.ok(task, '失败的任务也在任务中心里');
    assert.equal(task.projectName, '长项目');
    assert.equal(task.stage, 'rendering');
    assert.equal(task.stageLabel, '渲染画面');
    assert.equal(task.failedStageLabel, '渲染画面', '任务中心要说清失败在哪一步');
    assert.equal(task.failureCode, 'render_failed');
    assert.ok(task.failureCodeHint.includes('显存'), task.failureCodeHint);
    assert.equal(task.overallPercent, renderPercent('rendering', 42), '阶段内进度要映射成整体进度');
    assert.ok(task.percent === 42 && task.overallPercent > 8, '整体进度不等于阶段内进度');
    assert.equal(task.logUrl, `/api/jobs/${started.jobId}/logs`);
    assert.equal(task.plan.segments, 3);
    assert.equal(task.plan.reused, 0);
    assert.equal(task.cachedSegments, 3);
    assert.equal(task.recovery.kind, 'resume', '有片段缓存时可以接着渲染');
    assert.equal(task.recovery.stageLabel, '渲染画面');
    assert.ok(task.recovery.hint.includes('复用'), task.recovery.hint);
    assert.equal(task.orphanOutput, null);
    assert.equal(task.failure.title, '视频渲染失败 · 渲染画面', '失败标题要带上阶段');
    const restartTask = tasks.tasks.find((item: any) => item.id === restart.id);
    assert.equal(restartTask.plan.reused, 0, 'restart 的任务卡不显示复用');
    assert.ok(tasks.tasks.every((item: any) => ['failed', 'queued', 'cancelled', 'completed', 'running'].includes(item.status)));

    // ── 6. 日志接口只回尾部，长日志也不会拖垮页面 ───────────────────────
    await mkdir(outputDir, { recursive: true });
    const logLines = Array.from({ length: 400 }, (_, index) => `[render] 第 ${index} 行日志`);
    await writeFile(join(outputDir, `${started.jobId}.log`), `${logLines.join('\n')}\n`);
    const logs = await body(await readLogs(new Request(url(`/api/jobs/${started.jobId}/logs?tail=5`)), params(started.jobId)));
    assert.equal(logs.exists, true);
    assert.equal(logs.lines.length, 5);
    assert.equal(logs.lines[4], '[render] 第 399 行日志', '默认给最后几行');
    assert.equal(logs.failedStage, 'rendering');
    assert.equal(logs.failureCode, 'render_failed');
    assert.equal(logs.windowed, false, '小日志不需要截断');
    const capped = await body(await readLogs(new Request(url(`/api/jobs/${started.jobId}/logs?tail=99999`)), params(started.jobId)));
    assert.equal(capped.lines.length, 400, '请求超过上限时按上限截断');
    const missing = await body(await readLogs(new Request(url(`/api/jobs/${randomUUID()}/logs`)), params(randomUUID())));
    assert.equal(missing.error, '作业不存在');

    // ── 7. 估算接口给渲染标签页用 ────────────────────────────────────────
    const estimateResponse = await readEstimate(new Request(url(`/api/projects/${projectId}/render-estimate?preset=full`)), params(projectId));
    assert.equal(estimateResponse.status, 200);
    const estimate = await body(estimateResponse);
    assert.equal(estimate.projectId, projectId);
    assert.equal(estimate.preset, 'full');
    assert.equal(estimate.plan.reusedCount, 3);
    assert.deepEqual(estimate.reasons, []);
    assert.equal(estimate.cache.segments, 3);
    assert.ok(typeof estimate.estimate.totalDurationSeconds === 'number');
    assert.ok(Array.isArray(estimate.estimate.findings));
    assert.equal(estimate.worker.encoder, null, '没有心跳时不能编造编码器');
    const draft = await body(await readEstimate(new Request(url(`/api/projects/${projectId}/render-estimate?preset=draft`)), params(projectId)));
    assert.equal(draft.preset, 'draft');
    assert.equal(draft.cache.segments, 0, '草稿片段单独缓存，不会复用成片片段');
    assert.equal(draft.plan.reusedCount, 0);

    // ── 8. 集中恢复：中断的渲染任务要计数，宽限期内的任务只提示不误杀 ─────
    const { POST: recoverTasks } = await import('../src/app/api/tasks/recover/route');
    const sixMinutesAgo = new Date(Date.now() - 6 * 60_000);
    const stale = await db.job.create({ data: { projectId, kind: 'render', status: 'running', stage: 'rendering', attempt: 1, updatedAt: sixMinutesAgo } });
    const fresh = await db.job.create({ data: { projectId, kind: 'render', status: 'running', stage: 'encoding', attempt: 1 } });
    const staleRow = await db.job.findUniqueOrThrow({ where: { id: stale.id } });
    assert.ok(staleRow.updatedAt.getTime() < Date.now() - 5 * 60_000, '要真的造出一个 6 分钟没有心跳的渲染任务');
    const recovery = await body(await recoverTasks());
    assert.equal(recovery.resumed, 1, '被判定中断的渲染任务要算进已恢复数量，不能报 0');
    assert.equal(recovery.pending, 1, '宽限期内的任务单独计数，用来解释结果为 0 的情况');
    const closed = await db.job.findUniqueOrThrow({ where: { id: stale.id } });
    assert.equal(closed.status, 'failed');
    assert.equal(closed.failedStage, 'rendering', '保留中断所在阶段，重试才知道从哪继续');
    assert.equal(closed.failureCode, 'worker_lost');
    assert.equal((await db.job.findUniqueOrThrow({ where: { id: fresh.id } })).status, 'running', '5 分钟宽限期内的任务不能被误杀');
    const afterRecover = await body(await readTasks(new Request(url(`/api/tasks?projectId=${projectId}`))));
    const recoveredTask = afterRecover.tasks.find((item: any) => item.id === stale.id);
    assert.equal(recoveredTask.status, 'failed', '任务中心直接看到收尾后的失败状态');
    assert.equal(recoveredTask.failedStageLabel, '渲染画面');
    assert.equal(recoveredTask.recovery.kind, 'resume', '任务中心给出可恢复的重试入口');
    const secondRecover = await body(await recoverTasks());
    assert.equal(secondRecover.resumed, 0, '同一个任务不会被重复恢复');
    await db.job.deleteMany({ where: { id: { in: [stale.id, fresh.id] } } });

    console.log('V1.6 集成测试通过');
  } finally {
    await db.$disconnect();
    // Windows refuses to delete a directory that is still the process cwd.
    process.chdir(repo);
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
