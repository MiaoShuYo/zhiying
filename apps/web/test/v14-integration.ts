import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

/** Reads the manifest and payloads of an M2VBK001 archive so tests can tamper with them. */
function unpack(archive: Buffer) {
  const manifestLength = archive.readUInt32BE(8);
  const manifest = JSON.parse(archive.subarray(12, 12 + manifestLength).toString()) as {
    files: { path: string; size: number; sha256: string }[];
    [key: string]: unknown;
  };
  let offset = 12 + manifestLength;
  const bodies = new Map<string, Buffer>();
  for (const file of manifest.files) {
    bodies.set(file.path, archive.subarray(offset, offset + file.size));
    offset += file.size;
  }
  assert.equal(offset, archive.length, '清单长度必须与文件总长一致');
  return { manifest, bodies };
}

function pack(manifest: { files: { path: string; size: number; sha256: string }[]; [key: string]: unknown }, bodies: Map<string, Buffer>) {
  const raw = Buffer.from(JSON.stringify(manifest));
  const prefix = Buffer.alloc(12);
  prefix.write('M2VBK001', 0, 'utf8');
  prefix.writeUInt32BE(raw.length, 8);
  return Buffer.concat([prefix, raw, ...manifest.files.map(file => bodies.get(file.path) ?? Buffer.alloc(0))]);
}

async function exists(path: string) {
  try { await access(path); return true; } catch { return false; }
}

async function main() {
  const repo = process.cwd(), sandbox = resolve(repo, 'data', `test-v14-${randomUUID()}`);
  await mkdir(join(sandbox, 'apps/web/public/audio'), { recursive: true });
  await mkdir(join(sandbox, 'apps/web/public/projects'), { recursive: true });
  process.env.DATABASE_URL = `file:${join(sandbox, 'test.db').replaceAll('\\', '/')}`;
  const sql = execFileSync(process.execPath, [join(repo, 'apps/web/node_modules/prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', join(repo, 'apps/web/prisma/schema.prisma'), '--script'], { env: process.env, encoding: 'utf8' });
  const database = new DatabaseSync(join(sandbox, 'test.db')); database.exec(sql); database.close();
  process.chdir(join(sandbox, 'apps/web'));
  const { db } = await import('../src/lib/db');
  const { saveStoryboard } = await import('../src/lib/pipeline');
  const { outputDirFor } = await import('../src/lib/job-video');
  const { presetChanges, changedPresetCount } = await import('@m2v/schema');
  const { failureInfo, retryModeFor, retryRequest } = await import('../src/lib/task-actions');
  const { GET: qcCheck } = await import('../src/app/api/projects/[id]/qc/route');
  const { GET: readExports } = await import('../src/app/api/projects/[id]/exports/route');
  const { GET: readTasks } = await import('../src/app/api/tasks/route');
  const { POST: validateExportRoute } = await import('../src/app/api/projects/[id]/exports/[jobId]/validate/route');
  const { POST: buildDeliveryRoute } = await import('../src/app/api/projects/[id]/delivery/route');
  const { GET: readDelivery } = await import('../src/app/api/projects/[id]/delivery/[jobId]/route');
  const { GET: readPresets, POST: writePreset, PATCH: patchPreset } = await import('../src/app/api/settings/export-presets/route');
  const { createSnapshot, restoreSnapshot, importBackup, writeProjectArchive, RestoreError } = await import('../src/lib/backups');

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const jobParams = (id: string, jobId: string) => ({ params: Promise.resolve({ id, jobId }) });
  const url = (path: string) => `http://localhost${path}`;
  const body = async (response: Response) => (await response.json()) as Record<string, any>;
  const post = (data: unknown) => new Request(url('/'), { method: 'POST', body: JSON.stringify(data) });

  try {
    // ── 四态质检：待检查 → 阻断 → 修改后回到待检查 ────────────────────
    const project = await db.project.create({ data: { name: '启航质检', sourceText: '正文。'.repeat(20), status: 'awaiting_review' } });
    const board = {
      title: '启航', styleId: 'minimal-tech', aspectRatio: '16:9',
      scenes: [
        { id: randomUUID(), type: 'title', title: '开场', narration: '这一句有旁白但没有音频。', duration: 6 },
        { id: randomUUID(), type: 'title', title: '收尾', narration: '第二段旁白同样没有音频。', duration: 5 },
      ],
    };
    await saveStoryboard(project.id, board, 0);

    const never = await body(await qcCheck(new Request(url(`/api/projects/${project.id}/qc?cached=1`)), params(project.id)));
    assert.equal(never.status, 'pending', '从未检查过的项目是待检查');
    assert.equal(never.stale, true);
    assert.equal(never.reason, 'never');
    assert.equal(never.report, undefined, '没有报告时不返回结论');

    const first = await body(await qcCheck(new Request(url(`/api/projects/${project.id}/qc`)), params(project.id)));
    assert.equal(first.status, 'blocking', '有阻断级语音问题时状态为阻断');
    assert.ok(first.summary.errors >= 2, '两个场景都缺旁白音频');
    assert.equal(first.persisted, true, '检查结果要写入磁盘');
    assert.equal(first.report, undefined, '实时结果不套用缓存结构');

    const cached = await body(await qcCheck(new Request(url(`/api/projects/${project.id}/qc?cached=1`)), params(project.id)));
    assert.equal(cached.status, 'blocking', '缓存读取保留结论');
    assert.equal(cached.stale, false);
    assert.equal(cached.checkedAt, first.checkedAt);
    assert.equal(cached.report.summary.errors, first.summary.errors);

    await saveStoryboard(project.id, { ...board, scenes: [{ ...board.scenes[0], narration: '改过的旁白。' }, board.scenes[1]] }, 1);
    const stale = await body(await qcCheck(new Request(url(`/api/projects/${project.id}/qc?cached=1`)), params(project.id)));
    assert.equal(stale.status, 'pending', '分镜修改后旧结论必须回到待检查');
    assert.equal(stale.stale, true);
    assert.equal(stale.reason, 'revision');
    assert.equal(stale.previousSummary.errors, first.summary.errors, '仍能查看上次结论');
    assert.equal(stale.report, undefined, '待检查时不返回旧明细');

    // 渲染失败要作为质检问题定位到渲染页。
    await db.job.create({ data: { projectId: project.id, kind: 'render', status: 'failed', stage: 'encoding', error: '编码器退出码 1' } });
    const withRender = await body(await qcCheck(new Request(url(`/api/projects/${project.id}/qc?refresh=1`)), params(project.id)));
    assert.equal(withRender.render.status, 'failed');
    assert.equal(withRender.render.issue.code, 'render_failed');
    assert.equal(withRender.render.issue.kind, 'render');
    assert.equal(withRender.render.issue.fix, 'open_render');
    assert.equal(withRender.render.issue.severity, 'error');
    assert.match(withRender.render.issue.message, /编码器退出码 1/);
    assert.equal(withRender.status, 'blocking');

    // 重新渲染成功后同一个项目不再报渲染问题。
    const completed = await db.job.create({
      data: { projectId: project.id, kind: 'render', status: 'completed', stage: 'done', inputJson: JSON.stringify({ storyboard: board, preset: 'full' }) },
    });
    const ok = await body(await qcCheck(new Request(url(`/api/projects/${project.id}/qc?refresh=1`)), params(project.id)));
    assert.equal(ok.render.issue, null, '最新一次渲染成功就不报渲染问题');
    assert.equal(ok.render.status, 'completed');
    assert.equal(ok.status, 'blocking', '语音缺失仍然是阻断项');

    // 没写台词的场景按“有意静音”处理：不报缺失音频，因此不阻断交付。
    const quiet = await db.project.create({ data: { name: '静音质检', sourceText: '图注页。'.repeat(20), status: 'awaiting_review' } });
    await saveStoryboard(quiet.id, {
      title: '图注', styleId: 'minimal-tech', aspectRatio: '16:9',
      scenes: [
        { id: randomUUID(), type: 'title', title: '图注一', narration: '   ', duration: 4 },
        { id: randomUUID(), type: 'title', title: '图注二', narration: ' \n ', duration: 4 },
      ],
    }, 0);
    const silentRun = await body(await qcCheck(new Request(url(`/api/projects/${quiet.id}/qc`)), params(quiet.id)));
    assert.equal(silentRun.audio.silent, 2, '没有台词的场景要单独计数');
    assert.equal(silentRun.audio.issues.length, 0, '有意静音不是缺失音频');
    assert.equal(silentRun.summary.errors, 0, '有意静音不产生阻断项');
    assert.equal(silentRun.status, 'passed', '整个项目都是有意静音时质检通过');

    // ── 任务中断后的可操作原因 ──────────────────────────────────────────
    const interrupted = await db.job.create({ data: { projectId: project.id, kind: 'storyboard', status: 'cancelled', stage: 'analyzing' } });
    const tasks = await body(await readTasks(new Request(url('/api/tasks'))));
    const task = tasks.tasks.find((item: any) => item.id === interrupted.id);
    assert.ok(task, '任务中心要列出中断的任务');
    assert.equal(task.failure.title, '内容生成已取消');
    assert.deepEqual(task.failure.actions, ['step', 'restart']);
    assert.match(task.failure.hint, /保留已完成章节/);
    assert.equal(retryModeFor({ kind: 'storyboard', status: 'cancelled' }), 'step', '取消的任务可以继续');
    assert.equal(retryModeFor({ kind: 'storyboard', status: 'failed' }, 'awaiting_review'), null, '项目状态不允许时不给重试入口');
    assert.equal(retryModeFor({ kind: 'storyboard', status: 'failed' }, 'failed'), 'step');
    assert.equal(retryModeFor({ kind: 'render', status: 'cancelled' }), 'render');
    assert.equal(retryModeFor({ kind: 'render', status: 'running', ageMs: 16 * 60_000 }), 'recover', '长时间无进度的任务是疑似中断');
    assert.equal(retryModeFor({ kind: 'render', status: 'running', ageMs: 60_000 }), null);
    assert.deepEqual(retryRequest('step', { projectId: project.id }), { url: `/api/projects/${project.id}/retry`, method: 'POST', body: { mode: 'step' } });
    assert.deepEqual(retryRequest('render', { projectId: project.id, jobId: 'job-9' }), { url: '/api/jobs/job-9', method: 'POST' });
    assert.equal(failureInfo({ kind: 'render', status: 'failed' })?.title, '视频渲染失败');
    assert.equal(failureInfo({ kind: 'tts', status: 'cancelled' })?.title, '语音生成已取消');
    assert.equal(failureInfo({ kind: 'storyboard', status: 'completed' }), null, '正常完成的任务不显示失败块');

    // ── 导出记录：最新的失败不能被旧的成功掩盖 ──────────────────────────
    await db.job.create({ data: { projectId: project.id, kind: 'render', status: 'failed', stage: 'encoding', error: '磁盘写入失败' } });
    const rows = (await body(await readExports(new Request(url('/')), params(project.id)))) as any[];
    assert.equal(rows[0].status, 'failed', '导出记录按时间倒序，最新一条是失败');
    assert.equal(rows[0].error, '磁盘写入失败');
    const success = rows.find(item => item.id === completed.id);
    assert.ok(success, '旧的成功记录仍然可见');
    assert.equal(success.videoState, 'missing', '没有 outputPath 的成功记录标为视频不存在');
    assert.equal(success.delivery, null, '没有打包时交付状态为空');

    // ── 交付包：失败要写明缺失环节，并且可以重试 ────────────────────────
    const failedDelivery = await buildDeliveryRoute(post({ jobId: completed.id }), params(project.id));
    assert.equal(failedDelivery.status, 409);
    const failedBody = await body(failedDelivery);
    assert.match(failedBody.error, /成片文件校验未通过|成片文件不存在/);
    assert.ok(Array.isArray(failedBody.missing) && failedBody.missing.length > 0, '失败必须给出缺失环节');
    assert.ok(['validation', 'video'].includes(failedBody.missing[0].step));
    assert.equal(failedBody.record.status, 'failed');
    assert.equal(failedBody.record.attempts, 1);
    assert.equal(failedBody.record.file, undefined, '失败记录不指向文件');

    const again = await body(await buildDeliveryRoute(post({ jobId: completed.id }), params(project.id)));
    assert.equal(again.record.attempts, 2, '重试要累加尝试次数');
    assert.equal(again.record.createdAt, failedBody.record.createdAt, '重试保留首次尝试时间');
    assert.ok(Date.parse(again.record.updatedAt) >= Date.parse(failedBody.record.updatedAt));

    const failedRow = ((await body(await readExports(new Request(url('/')), params(project.id)))) as any[]).find(item => item.id === completed.id);
    assert.equal(failedRow.delivery.status, 'failed', '导出记录要显示交付包生成状态');
    assert.equal(failedRow.delivery.attempts, 2);
    assert.ok(failedRow.delivery.missing.length > 0, '导出记录要带上缺失环节');
    assert.equal(failedRow.delivery.fileExists, false);

    const failedDownload = await readDelivery(new Request(url('/')), jobParams(project.id, completed.id));
    assert.equal(failedDownload.status, 409, '失败的交付包不能下载');
    assert.match((await body(failedDownload)).error, /上次交付包生成失败|成片/);
    assert.equal((await readDelivery(new Request(url('/')), jobParams(project.id, randomUUID()))).status, 404);
    assert.equal((await buildDeliveryRoute(post({ jobId: randomUUID() }), params(project.id))).status, 404);

    // ── 真实成片：校验 → 打包 → 再次下载 → 重新生成 ────────────────────
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const filmProject = await db.project.create({ data: { name: '启航交付', sourceText: '交付正文。'.repeat(4), status: 'awaiting_review' } });
    const filmBoard = {
      title: '交付样片', styleId: 'minimal-tech', aspectRatio: '16:9',
      scenes: [{ id: randomUUID(), type: 'title', title: '开场', narration: '这一句会有音频。', duration: 6 }],
    };
    await saveStoryboard(filmProject.id, filmBoard, 0);
    const filmJob = await db.job.create({
      data: {
        projectId: filmProject.id, kind: 'render', status: 'completed', stage: 'done',
        outputPath: `${randomUUID()}.mp4`, inputJson: JSON.stringify({ storyboard: filmBoard, preset: 'full' }),
      },
    });
    const video = resolve(outputDirFor(filmProject.id), filmJob.outputPath!);
    await mkdir(dirname(video), { recursive: true });
    let media = true;
    try {
      execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=1920x1080:d=6:r=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', video], { stdio: 'ignore', timeout: 180_000 });
    } catch {
      media = false;
      console.log('SKIP: 本机没有可用的 FFmpeg，跳过真实成片的交付包下载与重新生成检查。');
    }

    if (media) {
      const verdict = await body(await validateExportRoute(post({}), jobParams(filmProject.id, filmJob.id)));
      if (!verdict.validation?.ok) {
        console.log(`SKIP: FFprobe 不可用（${verdict.validation?.issues?.[0]?.message ?? '未知原因'}），跳过打包检查。`);
      } else {
        const packed = await buildDeliveryRoute(post({ jobId: filmJob.id }), params(filmProject.id));
        assert.equal(packed.status, 200);
        const packedBody = await body(packed);
        assert.equal(packedBody.ok, true, '打包成功后返回记录，ZIP 由下载接口单独提供');
        assert.match(packedBody.name, /启航交付-交付包-\d{8}-\d{4}\.zip/);
        assert.ok(packedBody.bytes > 1000);
        const currentRevision = (await db.project.findUniqueOrThrow({ where: { id: filmProject.id } })).revision;
        const readyRow = ((await body(await readExports(new Request(url('/')), params(filmProject.id)))) as any[]).find(item => item.id === filmJob.id);
        assert.equal(readyRow.delivery.status, 'ready');
        assert.equal(readyRow.delivery.fileExists, true);
        assert.equal(readyRow.delivery.attempts, 1);
        assert.equal(readyRow.delivery.revision, currentRevision, '记录要写明包对应的项目版本');
        assert.equal(readyRow.delivery.qc.status, 'pending', '没有质检结论时如实记为待检查');
        assert.equal(readyRow.delivery.stale, null, '最新版本同一结论下不算过期');

        const download = await readDelivery(new Request(url('/')), jobParams(filmProject.id, filmJob.id));
        assert.equal(download.status, 200);
        assert.equal(download.headers.get('content-type'), 'application/zip');
        const downloaded = Buffer.from(await download.arrayBuffer());
        assert.equal(downloaded.length, readyRow.delivery.bytes, '再次下载的文件与记录一致');

        // 下载前的预检只回答“这个包能不能下”，不搬运 ZIP。
        const probe = await readDelivery(new Request(url('/?probe=1')), jobParams(filmProject.id, filmJob.id));
        assert.equal(probe.status, 200, '预检成功');
        assert.match(String(probe.headers.get('content-type')), /application\/json/);
        const probed = await body(probe);
        assert.equal(probed.ok, true);
        assert.equal(probed.name, readyRow.delivery.name, '预检返回的文件名与记录一致');
        assert.equal(probed.bytes, readyRow.delivery.bytes, '预检返回的大小与记录一致');

        // 包被清理后记录仍可查看，但下载要明确提示重新生成。
        const deliveryFile = join(sandbox, 'data/projects', filmProject.id, 'delivery', readyRow.delivery.file);
        await rm(deliveryFile, { force: true });
        const expiredRecord = await readDelivery(new Request(url('/')), jobParams(filmProject.id, filmJob.id));
        assert.equal(expiredRecord.status, 410, '文件被清理后不能再下载');
        assert.match((await body(expiredRecord)).error, /重新生成/);
        const expiredProbe = await readDelivery(new Request(url('/?probe=1')), jobParams(filmProject.id, filmJob.id));
        assert.equal(expiredProbe.status, 410, '预检同样要拦下缺文件的包');
        assert.match((await body(expiredProbe)).error, /重新生成/);
        const expiredRow = ((await body(await readExports(new Request(url('/')), params(filmProject.id)))) as any[]).find(item => item.id === filmJob.id);
        assert.equal(expiredRow.delivery.status, 'ready', '记录仍然保留');
        assert.equal(expiredRow.delivery.fileExists, false, '文件不存在要标出来');

        const regenerated = await buildDeliveryRoute(post({ jobId: filmJob.id }), params(filmProject.id));
        assert.equal(regenerated.status, 200, '可以重新生成');
        assert.equal((await body(regenerated)).ok, true);
        const regenRow = ((await body(await readExports(new Request(url('/')), params(filmProject.id)))) as any[]).find(item => item.id === filmJob.id);
        assert.equal(regenRow.delivery.status, 'ready');
        assert.equal(regenRow.delivery.attempts, 2);
        assert.equal(regenRow.delivery.fileExists, true);

        // ── 质检阻断时不能打包：失败环节要指向质检，记录不能显示成功 ────
        const filmQc = await body(await qcCheck(new Request(url(`/api/projects/${filmProject.id}/qc?refresh=1`)), params(filmProject.id)));
        assert.equal(filmQc.status, 'blocking', '没有语音的项目质检为阻断');
        const qcRefused = await buildDeliveryRoute(post({ jobId: filmJob.id }), params(filmProject.id));
        assert.equal(qcRefused.status, 409, '质检阻断时不允许打包交付');
        const qcRefusedBody = await body(qcRefused);
        assert.match(qcRefusedBody.error, /质检还有 \d+ 项阻断问题/);
        assert.equal(qcRefusedBody.missing[0].step, 'qc', '失败环节要指向质检');
        assert.equal(qcRefusedBody.record.status, 'failed');
        assert.equal(qcRefusedBody.record.attempts, 3);
        const qcRow = ((await body(await readExports(new Request(url('/')), params(filmProject.id)))) as any[]).find(item => item.id === filmJob.id);
        assert.equal(qcRow.delivery.status, 'failed', '质检阻断时导出记录不能留下成功状态');
        assert.equal(qcRow.delivery.fileExists, false);

        // 过期的质检结论不算数：报告版本与项目不一致时照常打包。
        const { qcReportPath } = await import('../src/lib/qc-report');
        const storedReport = JSON.parse(await readFile(qcReportPath(filmProject.id), 'utf8')) as { revision: number };
        await writeFile(qcReportPath(filmProject.id), JSON.stringify({ ...storedReport, revision: storedReport.revision + 1 }));
        const stalePacked = await buildDeliveryRoute(post({ jobId: filmJob.id }), params(filmProject.id));
        assert.equal(stalePacked.status, 200, '过期质检结论不拦打包');
        assert.equal((await body(stalePacked)).ok, true);
        const staleRow = ((await body(await readExports(new Request(url('/')), params(filmProject.id)))) as any[]).find(item => item.id === filmJob.id);
        assert.equal(staleRow.delivery.status, 'ready');
        assert.equal(staleRow.delivery.attempts, 4);
        await rm(qcReportPath(filmProject.id), { force: true });

        // ── 旧包：质检结论变阻断、或项目又有修改后，记录不能继续显示为可交付 ──
        const blockingAgain = await body(await qcCheck(new Request(url(`/api/projects/${filmProject.id}/qc?refresh=1`)), params(filmProject.id)));
        assert.equal(blockingAgain.status, 'blocking');
        const staleByQc = ((await body(await readExports(new Request(url('/')), params(filmProject.id)))) as any[]).find(item => item.id === filmJob.id);
        assert.equal(staleByQc.delivery.status, 'ready', '包本身仍是生成成功的记录');
        assert.equal(staleByQc.delivery.stale, 'qc-blocking', '阻断结论出来后旧包要标为过期');
        const refusedStaleQc = await readDelivery(new Request(url('/')), jobParams(filmProject.id, filmJob.id));
        assert.equal(refusedStaleQc.status, 409, '阻断后过期包不能再下载');
        assert.match((await body(refusedStaleQc)).error, /质检出现阻断问题之前生成|已过期/);
        const refusedStaleQcProbe = await readDelivery(new Request(url('/?probe=1')), jobParams(filmProject.id, filmJob.id));
        assert.equal(refusedStaleQcProbe.status, 409, '预检同样要拦下质检过期的包');

        await rm(qcReportPath(filmProject.id), { force: true });
        await saveStoryboard(filmProject.id, { ...filmBoard, title: '交付样片（改）' }, currentRevision);
        const staleByRevision = ((await body(await readExports(new Request(url('/')), params(filmProject.id)))) as any[]).find(item => item.id === filmJob.id);
        assert.equal(staleByRevision.delivery.stale, 'project-changed', '项目改过之后旧包要标为过期');
        const refusedStaleRevision = await readDelivery(new Request(url('/')), jobParams(filmProject.id, filmJob.id));
        assert.equal(refusedStaleRevision.status, 409, '落后于项目的包不能再下载');
        assert.match((await body(refusedStaleRevision)).error, /项目在这个交付包生成之后又有修改|已过期/);

        // 校验通过后视频消失：交付包要指出缺的是成片文件，而不是笼统失败。
        await rm(video, { force: true });
        const goneDelivery = await buildDeliveryRoute(post({ jobId: filmJob.id }), params(filmProject.id));
        assert.equal(goneDelivery.status, 409);
        const goneBody = await body(goneDelivery);
        assert.equal(goneBody.missing[0].step, 'video', '要指出缺少成片文件');
        assert.match(goneBody.error, /成片文件不存在或为空/);
        assert.equal(goneBody.record.status, 'failed');
        assert.equal(goneBody.record.attempts, 5);
        const brokenRow = ((await body(await readExports(new Request(url('/')), params(filmProject.id)))) as any[]).find(item => item.id === filmJob.id);
        assert.equal(brokenRow.delivery.status, 'failed', '导出记录不能留下误导性的成功状态');
        assert.equal(brokenRow.delivery.fileExists, false);
      }
    }

    // ── 备份恢复：重名自动加后缀，原项目保持不变 ────────────────────────
    const source = await db.project.create({ data: { name: '启航备份', sourceText: '备份正文。'.repeat(6), status: 'awaiting_review' } });
    const sourceBoard = {
      title: '备份样片', styleId: 'minimal-tech', aspectRatio: '16:9',
      scenes: [{ id: randomUUID(), type: 'title', title: '开场', narration: '会恢复的旁白。', duration: 6 }],
    };
    await saveStoryboard(source.id, sourceBoard, 0);
    const assetDir = join(sandbox, 'data/projects', source.id, 'assets');
    await mkdir(assetDir, { recursive: true });
    await writeFile(join(assetDir, 'logo.png'), Buffer.from('fake-png-bytes'));
    await mkdir(join(sandbox, 'apps/web/public/projects', source.id, 'assets'), { recursive: true });
    await writeFile(join(sandbox, 'apps/web/public/projects', source.id, 'assets/logo.png'), Buffer.from('fake-png-bytes'));
    await db.project.update({ where: { id: source.id }, data: { assetsJson: JSON.stringify([{ path: `projects/${source.id}/assets/logo.png`, name: 'logo.png' }]) } });
    const before = await db.project.findUniqueOrThrow({ where: { id: source.id } });

    const snapshotId = await createSnapshot(source.id);
    assert.ok(snapshotId, '要能生成备份');
    const firstRestoreId = await restoreSnapshot(source.id, snapshotId!);
    const firstRestore = await db.project.findUniqueOrThrow({ where: { id: firstRestoreId } });
    assert.equal(firstRestore.name, '启航备份（恢复）', '恢复项目使用独立名称');
    assert.notEqual(firstRestore.id, source.id);
    assert.equal((await db.project.findUniqueOrThrow({ where: { id: source.id } })).name, before.name, '原项目名称不能变');
    assert.equal((await db.project.findUniqueOrThrow({ where: { id: source.id } })).revision, before.revision);
    assert.equal((await db.project.findUniqueOrThrow({ where: { id: source.id } })).storyboardJson, before.storyboardJson, '原项目分镜不能变');
    const restoredScenes = await db.scene.findMany({ where: { projectId: firstRestore.id } });
    assert.equal(restoredScenes.length, 1, '场景要一起恢复');

    const secondRestoreId = await restoreSnapshot(source.id, snapshotId!);
    assert.equal((await db.project.findUniqueOrThrow({ where: { id: secondRestoreId } })).name, '启航备份（恢复 2）', '重复恢复不能覆盖已有项目');

    const archivePath = join(sandbox, `archive-${randomUUID()}.m2v`);
    await writeProjectArchive(source.id, archivePath);
    const valid = await readFile(archivePath);
    const { manifest, bodies } = unpack(valid);
    assert.ok(manifest.files.some(file => file.path === 'project/assets/logo.png'), '项目包要包含素材');

    const importedId = await importBackup(new Request(url('/'), { method: 'POST', body: valid }));
    assert.equal((await db.project.findUniqueOrThrow({ where: { id: importedId } })).name, '启航备份（恢复 3）', '导入同样自动加后缀');
    const count = await db.project.count();

    // 损坏的项目包：明确报损坏、不留下半个项目
    const corrupt = Buffer.from(valid);
    const logoEntry = manifest.files.find(file => file.path === 'project/assets/logo.png')!;
    const logoOffset = 12 + valid.readUInt32BE(8) + manifest.files.slice(0, manifest.files.indexOf(logoEntry)).reduce((sum, file) => sum + file.size, 0);
    corrupt[logoOffset + 2] ^= 0xff;
    await assert.rejects(() => importBackup(new Request(url('/'), { method: 'POST', body: corrupt })), (error: unknown) => {
      assert.ok(error instanceof RestoreError);
      assert.equal(error.step, 'files');
      assert.match(error.message, /备份损坏/);
      return true;
    });
    assert.equal(await db.project.count(), count, '恢复失败不能多出项目');

    const garbage = Buffer.from('not-a-backup-at-all');
    await assert.rejects(() => importBackup(new Request(url('/'), { method: 'POST', body: garbage })), (error: unknown) => {
      assert.ok(error instanceof RestoreError);
      assert.equal(error.step, 'validate');
      assert.match(error.message, /不是知影 V1.1 项目包/);
      return true;
    });

    // 缺少媒体文件：指出缺了哪个素材，并且不改动原项目。
    const stripped = pack({ ...manifest, files: manifest.files.filter(file => file.path !== 'project/assets/logo.png') }, bodies);
    await assert.rejects(() => importBackup(new Request(url('/'), { method: 'POST', body: stripped })), (error: unknown) => {
      assert.ok(error instanceof RestoreError);
      assert.equal(error.step, 'files');
      assert.match(error.message, /备份缺少媒体文件：素材 logo\.png/);
      assert.deepEqual(error.missing, ['素材 logo.png']);
      return true;
    });
    assert.equal(await db.project.count(), count, '缺少媒体时不能留下项目');
    assert.equal((await db.project.findUniqueOrThrow({ where: { id: source.id } })).revision, before.revision, '失败后原项目仍可用');

    // 中断的恢复：重启清理能识别文件写入阶段被杀死的旧进程，并清除
    // 文件系统与数据库中的半成品；后续恢复重试仍可成功。
    const staleId = randomUUID();
    await mkdir(join(sandbox, 'data/projects', staleId), { recursive: true });
    await writeFile(join(sandbox, 'data/projects', staleId, 'leftover.json'), '{}');
    await writeFile(join(sandbox, 'apps/web/public/audio', `${staleId}-orphan.mp3`), 'x');
    const marker = join(sandbox, 'data/projects', `.restore-${staleId}.json`);
    await writeFile(marker, JSON.stringify({ projectId: staleId, startedAt: Date.now(), ownerPid: 2_147_483_647, step: 'files', fileIndex: 2, fileCount: 5 }));

    const postCommitId = randomUUID();
    await db.project.create({ data: { id: postCommitId, name: '被中断的半成品恢复', sourceText: '不应残留' } });
    await db.scene.create({ data: { id: randomUUID(), projectId: postCommitId, orderIndex: 0, type: 'title', title: '半成品', narration: '', visualJson: '{}' } });
    await db.job.create({ data: { projectId: postCommitId, kind: 'render', status: 'failed' } });
    const postCommitMarker = join(sandbox, 'data/projects', `.restore-${postCommitId}.json`);
    await mkdir(join(sandbox, 'data/projects', postCommitId), { recursive: true });
    await writeFile(join(sandbox, 'data/projects', postCommitId, 'leftover.json'), '{}');
    await writeFile(postCommitMarker, JSON.stringify({ projectId: postCommitId, startedAt: Date.now(), ownerPid: 2_147_483_647, step: 'database' }));

    const previousRuntime = process.env.NEXT_RUNTIME;
    process.env.NEXT_RUNTIME = 'nodejs';
    try {
      const { register } = await import('../src/instrumentation');
      await register();
    } finally {
      if (previousRuntime === undefined) delete process.env.NEXT_RUNTIME;
      else process.env.NEXT_RUNTIME = previousRuntime;
    }
    assert.equal((await db.project.findUniqueOrThrow({ where: { id: source.id } })).revision, before.revision, '清理中断恢复不能修改原项目');
    assert.equal(await exists(marker), false, '写文件阶段的中断标记应被清理');
    assert.equal(await exists(join(sandbox, 'data/projects', staleId)), false, '写文件阶段留下的项目目录应被清理');
    assert.equal(await exists(join(sandbox, 'apps/web/public/audio', `${staleId}-orphan.mp3`)), false, '写文件阶段留下的音频应被清理');
    assert.equal(await exists(postCommitMarker), false, '数据库提交阶段的中断标记应被清理');
    assert.equal(await exists(join(sandbox, 'data/projects', postCommitId)), false, '数据库提交阶段留下的文件应被清理');
    assert.equal(await db.project.findUnique({ where: { id: postCommitId } }), null, '数据库中的半成品项目应被级联删除');

    const afterCleanupId = await importBackup(new Request(url('/'), { method: 'POST', body: valid }));
    assert.equal((await db.project.findUniqueOrThrow({ where: { id: afterCleanupId } })).name, '启航备份（恢复 4）');
    assert.equal((await db.project.findUniqueOrThrow({ where: { id: source.id } })).revision, before.revision, '重新恢复不能修改源项目');
    assert.ok((await readdir(join(sandbox, 'data/projects'))).every(name => !name.startsWith('.restore-')), '不能留下任何恢复标记');

    // 恢复后的项目可以继续修改并重新导出，不影响原项目。
    const restoredProject = await db.project.findUniqueOrThrow({ where: { id: afterCleanupId } });
    const restoredBoard = JSON.parse(restoredProject.storyboardJson!);
    assert.notEqual(restoredBoard.scenes[0].id, sourceBoard.scenes[0].id, '恢复时场景要重新分配 ID');
    assert.deepEqual((await db.scene.findMany({ where: { projectId: source.id } })).map(scene => scene.id), [sourceBoard.scenes[0].id]);
    await assert.doesNotReject(() => saveStoryboard(afterCleanupId, restoredBoard, restoredProject.revision), '恢复后的项目要能继续编辑');

    // ── 预设生命周期：重命名 / 复制 / 默认 / 应用前预览 ──────────────────
    const created = (await body(await writePreset(post({ name: '竖屏交付', aspectRatio: '9:16', transition: 'fade', intro: { enabled: true, title: '片头' }, subtitles: { preset: 'highlight' } })))).preset;
    assert.equal(created.isDefault, true, '第一个预设自动成为默认');
    const renamed = (await body(await patchPreset(new Request(url('/'), { method: 'PATCH', body: JSON.stringify({ id: created.id, action: 'rename', name: '竖屏交付 A' }) })))).preset;
    assert.equal(renamed.name, '竖屏交付 A');
    assert.equal(renamed.id, created.id, '重命名不换 ID');

    const second = (await body(await writePreset(post({ name: '横屏交付', aspectRatio: '16:9', subtitles: {} })))).preset;
    assert.equal(second.isDefault, false, '已有默认预设时新预设不是默认');
    const copy = (await body(await patchPreset(new Request(url('/'), { method: 'PATCH', body: JSON.stringify({ id: created.id, action: 'duplicate' }) })))).preset;
    assert.equal(copy.name, '竖屏交付 A 副本', '复制要取一个可读的名字');
    assert.notEqual(copy.id, created.id);
    assert.equal(copy.aspectRatio, '9:16', '复制保留设置');
    assert.equal(copy.isDefault, false, '复制品不是默认');

    const defaulted = (await body(await patchPreset(new Request(url('/'), { method: 'PATCH', body: JSON.stringify({ id: copy.id, action: 'default' }) })))).preset;
    assert.equal(defaulted.isDefault, true);
    const presets = (await body(await readPresets())).presets as any[];
    assert.equal(presets.filter(item => item.isDefault).length, 1, '同时只能有一个默认预设');
    assert.equal(presets.find(item => item.id === created.id).isDefault, false);

    const duplicateName = await patchPreset(new Request(url('/'), { method: 'PATCH', body: JSON.stringify({ id: second.id, action: 'rename', name: '竖屏交付 A' }) }));
    assert.equal(duplicateName.status, 409, '重命名不能撞名');
    assert.equal((await patchPreset(new Request(url('/'), { method: 'PATCH', body: JSON.stringify({ id: 'gone', action: 'rename', name: 'x' }) }))).status, 404);
    assert.equal((await patchPreset(new Request(url('/'), { method: 'PATCH', body: JSON.stringify({ id: created.id, action: 'explode' }) }))).status, 400);

    // 应用前预览：只列出会被改动的导出设置，且前后值都是可读文案。
    const settings = { aspectRatio: '16:9' as const, transition: 'none' as const };
    const changes = presetChanges(settings, created);
    assert.deepEqual(changes.map(change => change.label), ['画面比例', '字幕样式', '片头', '片尾', '转场', '渲染质量']);
    assert.deepEqual(changes.filter(change => change.changed).map(change => change.key), ['aspectRatio', 'subtitles', 'intro', 'transition']);
    assert.equal(changedPresetCount(changes), 4);
    assert.deepEqual(changes.slice(0, 5).map(change => change.next), ['竖屏 9:16', '高亮 · 底部 · 字号 30', '片头 · 3 秒', '关闭', '淡入淡出']);
    assert.deepEqual(changes.map(change => change.current), ['横屏 16:9', '描边 · 底部 · 字号 30', '关闭', '关闭', '无', '正式']);
    assert.ok(changes.every(change => change.current && change.next), '每项都要有可读的前后值');
    const identical = presetChanges({
      aspectRatio: created.aspectRatio, subtitles: created.subtitles,
      intro: created.intro, outro: created.outro, transition: created.transition,
    }, created, created.renderPreset);
    assert.equal(changedPresetCount(identical), 0, '设置一致时预览不报修改');

    console.log('PASS: 质检四态在未检查、已检查、修改后回退之间切换，渲染失败定位到渲染页，没写台词的场景按有意静音计为通过；最新的导出失败不会被旧成功掩盖，交付包失败列出缺失环节且重试累加次数，真实的包可以再次下载、清理后提示重新生成、视频丢失时指出缺少成片，质检阻断或项目改过之后旧包标为过期且拒绝下载；备份恢复重名自动加后缀、损坏/缺媒体/中断都明确报错且不动原项目；预设支持重命名、复制、默认与应用前预览。');
  } finally {
    await db.$disconnect();
    process.chdir(repo);
    for (let attempt = 0; attempt < 10; attempt++) {
      try { await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); break; } catch { await new Promise(done => setTimeout(done, 300)); }
    }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
