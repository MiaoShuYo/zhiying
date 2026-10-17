import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

async function main() {
  const repo = process.cwd(), sandbox = resolve(repo, 'data', `test-v11-${randomUUID()}`);
  await mkdir(join(sandbox, 'apps/web/public/audio'), { recursive: true });
  process.env.DATABASE_URL = `file:${join(sandbox, 'test.db').replaceAll('\\', '/')}`;
  const sql = execFileSync(process.execPath, [join(repo, 'apps/web/node_modules/prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', join(repo, 'apps/web/prisma/schema.prisma'), '--script'], { env: process.env, encoding: 'utf8' });
  const database = new DatabaseSync(join(sandbox, 'test.db')); database.exec(sql); database.close();
  process.chdir(join(sandbox, 'apps/web'));
  const { db } = await import('../src/lib/db');
  const { saveStoryboard, processProject, parseProject } = await import('../src/lib/pipeline');
  const { exportSubtitles } = await import('@m2v/video/subtitles');
  const { readCredit, classifyLicense } = await import('../src/lib/commons-license');
  const { createSnapshot, listSnapshots, snapshotResponse, importBackup, restoreSnapshot, lockSnapshot } = await import('../src/lib/backups');
  const { POST: cancel } = await import('../src/app/api/jobs/[id]/cancel/route');
  try {
    const project = await db.project.create({ data: { name: '完整备份', sourceText: '测试正文。'.repeat(20), status: 'awaiting_review' } });
    const id = project.id;
    await mkdir(join(sandbox, 'data/projects', id, 'output'), { recursive: true });
    await writeFile(join(sandbox, 'data/projects', id, 'output/export.mp4'), 'video bytes');
    await writeFile(join(sandbox, 'apps/web/public/audio', `${id}-scene.wav`), 'audio bytes');
    const board = { title: '测试', styleId: 'minimal-tech', scenes: [{ id: randomUUID(), type: 'title', narration: '测试字幕。', audioSrc: `audio/${id}-scene.wav`, audioDuration: 2, wordTimings: [{ text: '测试', start: 0, end: 1 }] }] };
    await saveStoryboard(id, board, 0);
    await assert.rejects(saveStoryboard(id, { ...board, title: '过期修改' }, 0), /保存冲突/);
    const captions = { ...board, subtitles: { preset: 'boxed', color: '#ffcc00', background: '#112233', backgroundOpacity: .65 } };
    await saveStoryboard(id, captions, 1);
    const reloaded = parseProject(await db.project.findUniqueOrThrow({ where: { id }, include: { scenes: true } })).storyboard!;
    assert.equal(reloaded.subtitles?.preset, 'boxed');
    assert.equal(reloaded.subtitles?.color, '#ffcc00'); assert.equal(reloaded.subtitles?.background, '#112233'); assert.equal(reloaded.subtitles?.backgroundOpacity, .65);
    const ass = exportSubtitles(reloaded, 'ass');
    assert.ok(ass.includes('&H0000CCFF') && ass.includes('&H59332211'), ass.split('\n').find(line => line.startsWith('Style:')));
    assert.match(ass, /PlayResX: 1920/);
    const meta = (license: string, attribution = 'Created by Someone') => ({ LicenseShortName: { value: license }, Attribution: { value: attribution } });
    assert.equal(classifyLicense('CC0'), 'public-domain'); assert.equal(classifyLicense('CC BY 4.0'), 'cc-by');
    assert.equal(classifyLicense('CC BY-SA 3.0'), 'cc-by-sa'); assert.equal(classifyLicense('Custom terms'), 'other'); assert.equal(classifyLicense(''), 'unknown');
    assert.equal(readCredit(meta('CC BY-SA 4.0'), 'https://commons/1').requiresAttribution, true);
    assert.ok(readCredit({ LicenseShortName: { value: 'Custom terms' }, Attribution: { value: '' } }, 'https://commons/2').warnings.some(item => item.includes('人工确认')));
    assert.ok(readCredit({ LicenseShortName: { value: 'CC BY 4.0' }, Attribution: { value: '' } }, 'https://commons/3').warnings.some(item => item.includes('未取得作者署名信息')));
    assert.ok(readCredit({}, 'https://commons/4').warnings.some(item => item.includes('未取得许可信息')));
    assert.equal(readCredit({}, 'https://commons/4').license, '许可信息未提供');
    const exportJob = await db.job.create({ data: { projectId: id, kind: 'render', status: 'completed', stage: 'completed', outputPath: 'export.mp4', inputJson: JSON.stringify({ storyboard: board, preset: 'full' }) } });
    const snapshot = (await createSnapshot(id))!;
    await lockSnapshot(id, snapshot, true);
    for (let i = 0; i < 11; i++) await createSnapshot(id);
    const snapshots = await listSnapshots(id);
    assert.equal(snapshots.length, 11); assert.equal(snapshots.filter(item => item.locked).length, 1);
    assert.equal(await createSnapshot(id, true), null, 'automatic snapshot must be throttled');
    const response = await snapshotResponse(id, snapshot), bytes = new Uint8Array(await response.arrayBuffer());
    const restoredId = await importBackup(new Request('http://localhost/restore', { method: 'POST', body: bytes }));
    const restored = await db.project.findUniqueOrThrow({ where: { id: restoredId }, include: { jobs: true, scenes: true } });
    assert.notEqual(restored.scenes[0].id, board.scenes[0].id);
    assert.equal(restored.jobs[0].outputPath, 'export.mp4');
    assert.equal(await readFile(join(sandbox, 'data/projects', restoredId, 'output/export.mp4'), 'utf8'), 'video bytes');
    assert.equal(await readFile(resolve(process.cwd(), 'public', restored.scenes[0].audioPath!), 'utf8'), 'audio bytes');
    assert.equal(JSON.parse(restored.storyboardJson!).scenes[0].wordTimings[0].text, '测试');
    const duplicate = await restoreSnapshot(id, snapshot); assert.notEqual(duplicate, restoredId);
    // 每代恢复都重新命名音频：旧实现把上一代文件名再拼上 37 字符，第 5 代就撑破 Windows 的 255 字符文件名上限。
    let chainProject = restoredId, chainSnapshot = (await createSnapshot(restoredId))!;
    for (let generation = 2; generation <= 6; generation++) {
      chainProject = await restoreSnapshot(chainProject, chainSnapshot);
      const scene = (await db.scene.findMany({ where: { projectId: chainProject } }))[0];
      assert.ok(basename(scene.audioPath!).length <= 64, `第 ${generation} 代音频文件名过长：${scene.audioPath}`);
      assert.equal(await readFile(resolve(process.cwd(), 'public', scene.audioPath!), 'utf8'), 'audio bytes');
      chainSnapshot = (await createSnapshot(chainProject))!;
    }
    const corrupt = bytes.slice(); corrupt[corrupt.length - 1] ^= 1;
    await assert.rejects(importBackup(new Request('http://localhost/restore', { method: 'POST', body: corrupt })), /备份损坏/);
    const header = Buffer.from(bytes.subarray(0, 12)), length = header.readUInt32BE(8), manifest = JSON.parse(Buffer.from(bytes.subarray(12, 12 + length)).toString());
    manifest.files[0].path = 'project/../../escape.txt'; const raw = Buffer.from(JSON.stringify(manifest)); header.writeUInt32BE(raw.length, 8);
    await assert.rejects(importBackup(new Request('http://localhost/restore', { method: 'POST', body: Buffer.concat([header, raw, bytes.subarray(12 + length)]) })), /备份路径无效/);
    // V1.0 每次导出都覆盖同一个 final.mp4 且不写 outputPath：备份只能把这个文件记给最近一条记录，其余记录不得冒充可下载。
    const { sharedVideoOwner } = await import('../src/lib/job-video');
    const { GET: readVideo } = await import('../src/app/api/projects/[id]/output/route');
    const downloadVideo = (projectId: string, jobId: string) => readVideo(new Request(`http://localhost/api/projects/${projectId}/output?jobId=${jobId}`), { params: Promise.resolve({ id: projectId }) });
    const manifestOf = (blob: Uint8Array) => {
      const head = Buffer.from(blob.subarray(0, 12)), size = head.readUInt32BE(8);
      return JSON.parse(Buffer.from(blob.subarray(12, 12 + size)).toString());
    };
    const multi = await db.project.create({ data: { name: '多次导出', sourceText: '正文。'.repeat(10), status: 'awaiting_review' } });
    await mkdir(join(sandbox, 'data/projects', multi.id, 'output'), { recursive: true });
    const videos = ['first video', 'second video', 'third video'];
    for (const [index, content] of videos.entries()) {
      await db.job.create({ data: { projectId: multi.id, kind: 'render', status: 'completed', stage: 'completed', outputPath: `render-${index}.mp4`, createdAt: new Date(Date.now() + index * 1000) } });
      await writeFile(join(sandbox, 'data/projects', multi.id, 'output', `render-${index}.mp4`), content);
    }
    const multiSnapshot = (await createSnapshot(multi.id))!;
    const multiBytes = new Uint8Array(await (await snapshotResponse(multi.id, multiSnapshot)).arrayBuffer());
    assert.equal(manifestOf(multiBytes).files.filter((file: { path: string }) => /^project\/output\/.+\.mp4$/.test(file.path)).length, 3, '项目包必须包含全部历史视频');
    const multiRestored = await importBackup(new Request('http://localhost/restore', { method: 'POST', body: multiBytes }));
    const restoredRenders = await db.job.findMany({ where: { projectId: multiRestored, kind: 'render' } });
    assert.equal(restoredRenders.length, 3);
    for (const job of restoredRenders) {
      const index = Number(/render-(\d+)\.mp4/.exec(job.outputPath!)![1]);
      const response = await downloadVideo(multiRestored, job.id);
      assert.equal(response.status, 200, `恢复后第 ${index + 1} 条记录应可下载`);
      assert.equal(await response.text(), videos[index], '不同记录必须下载各自的视频');
    }
    const legacy = await db.project.create({ data: { name: '旧版导出', sourceText: '正文。'.repeat(10), status: 'awaiting_review' } });
    await mkdir(join(sandbox, 'data/projects', legacy.id, 'output'), { recursive: true });
    await writeFile(join(sandbox, 'data/projects', legacy.id, 'output/final.mp4'), 'shared video');
    const olderJob = await db.job.create({ data: { projectId: legacy.id, kind: 'render', status: 'completed', stage: 'completed', createdAt: new Date(Date.now() - 60000) } });
    const newestJob = await db.job.create({ data: { projectId: legacy.id, kind: 'render', status: 'completed', stage: 'completed' } });
    assert.equal(sharedVideoOwner(await db.job.findMany({ where: { projectId: legacy.id } })), newestJob.id, '共享视频属于最近一次完成的导出');
    assert.notEqual(olderJob.id, newestJob.id);
    const legacySnapshot = (await createSnapshot(legacy.id))!;
    const legacyBytes = new Uint8Array(await (await snapshotResponse(legacy.id, legacySnapshot)).arrayBuffer());
    assert.equal(manifestOf(legacyBytes).jobs.filter((job: { outputPath: string | null }) => job.outputPath === 'final.mp4').length, 1, '共享视频只能标记给一条记录');
    const legacyRestored = await importBackup(new Request('http://localhost/restore', { method: 'POST', body: legacyBytes }));
    const legacyJobs = await db.job.findMany({ where: { projectId: legacyRestored, kind: 'render' } });
    const owner = legacyJobs.find(job => job.outputPath === 'final.mp4'), stale = legacyJobs.find(job => !job.outputPath);
    assert.ok(owner && stale && owner.id !== stale.id);
    assert.equal((await downloadVideo(legacyRestored, owner.id)).status, 200);
    assert.equal((await downloadVideo(legacyRestored, stale.id)).status, 409, '旧记录不能下载同一份共享视频');
    assert.equal(sharedVideoOwner(legacyJobs), null);
    const queued = await db.job.create({ data: { projectId: id, kind: 'render', status: 'queued' } });
    await cancel(new Request('http://localhost', { method: 'POST' }), { params: Promise.resolve({ id: queued.id }) });
    assert.equal((await db.job.findUniqueOrThrow({ where: { id: queued.id } })).status, 'cancelled');
    const running = await db.job.create({ data: { projectId: id, kind: 'render', status: 'running' } });
    await cancel(new Request('http://localhost', { method: 'POST' }), { params: Promise.resolve({ id: running.id }) });
    assert.equal((await db.job.findUniqueOrThrow({ where: { id: running.id } })).status, 'cancelling');
    await cancel(new Request('http://localhost', { method: 'POST' }), { params: Promise.resolve({ id: exportJob.id }) });
    assert.equal((await db.job.findUniqueOrThrow({ where: { id: exportJob.id } })).status, 'completed');
    const imported = await db.project.create({ data: { name: '导入预览', sourceText: '完整正文。'.repeat(20), status: 'extracting' } });
    await db.job.create({ data: { projectId: imported.id, kind: 'storyboard', status: 'queued', stage: 'extracting' } });
    await processProject(imported.id, 'extracting');
    assert.equal((await db.project.findUniqueOrThrow({ where: { id: imported.id } })).status, 'awaiting_source_review');
    assert.equal(await db.scene.count({ where: { projectId: imported.id } }), 0);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('offline'); };
    try { await processProject(imported.id, 'analyzing'); } finally { globalThis.fetch = originalFetch; }
    assert.equal((await db.project.findUniqueOrThrow({ where: { id: imported.id } })).status, 'awaiting_review');
    console.log('PASS: caption colour/background persistence and ASS colours, version conflicts, full archive round trip, video/audio preservation, clone IDs, snapshot retention/lock, corrupt/path traversal rejection, cancel transitions, extraction review and continuation.');
  } finally { await db.$disconnect(); process.chdir(repo); for (let attempt = 0; attempt < 10; attempt++) { try { await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); break; } catch { await new Promise(done => setTimeout(done, 300)); } } }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
