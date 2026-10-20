import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

async function main() {
  const repo = process.cwd(), sandbox = resolve(repo, 'data', `test-v13-${randomUUID()}`);
  await mkdir(join(sandbox, 'apps/web/public/audio'), { recursive: true });
  process.env.DATABASE_URL = `file:${join(sandbox, 'test.db').replaceAll('\\', '/')}`;
  const sql = execFileSync(process.execPath, [join(repo, 'apps/web/node_modules/prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', join(repo, 'apps/web/prisma/schema.prisma'), '--script'], { env: process.env, encoding: 'utf8' });
  const database = new DatabaseSync(join(sandbox, 'test.db')); database.exec(sql); database.close();
  process.chdir(join(sandbox, 'apps/web'));
  const { db } = await import('../src/lib/db');
  const { saveStoryboard } = await import('../src/lib/pipeline');
  const { outputDirFor } = await import('../src/lib/job-video');
  const { presetBoardPatch } = await import('@m2v/schema');
  const { GET: qcCheck } = await import('../src/app/api/projects/[id]/qc/route');
  const { GET: readExports } = await import('../src/app/api/projects/[id]/exports/route');
  const { POST: validateExportRoute } = await import('../src/app/api/projects/[id]/exports/[jobId]/validate/route');
  const { POST: buildDeliveryRoute } = await import('../src/app/api/projects/[id]/delivery/route');
  const { GET: readDelivery } = await import('../src/app/api/projects/[id]/delivery/[jobId]/route');
  const { GET: readPresets, POST: writePreset, DELETE: removePreset } = await import('../src/app/api/settings/export-presets/route');

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const jobParams = (id: string, jobId: string) => ({ params: Promise.resolve({ id, jobId }) });
  const url = (path: string) => `http://localhost${path}`;
  const body = async (response: Response) => (await response.json()) as Record<string, any>;

  try {
    // ── 字幕质检与语音质检 ───────────────────────────────────────────────
    const project = await db.project.create({ data: { name: '启航纪录片', sourceText: '正文。'.repeat(20), status: 'awaiting_review' } });
    const first = randomUUID(), second = randomUUID();
    const broken = {
      title: '质检样片', styleId: 'minimal-tech', aspectRatio: '16:9',
      scenes: [
        {
          id: first, type: 'title', title: '开场', narration: '这一句有旁白但没有音频。', duration: 6,
          subtitleCues: [
            { text: '这是一条被故意写得很长很长的手动字幕用来触发字幕过长检查的示例内容需要超过三十八个字符宽度才能被检查出来', start: 0, end: 0.4 },
            { text: '第三条', start: 0.2, end: 1.2 },
            { text: '越界字幕', start: 40, end: 42 },
          ],
        },
        { id: second, type: 'title', title: '收尾', narration: '第二段旁白同样没有音频。', duration: 5 },
      ],
    };
    await saveStoryboard(project.id, broken, 0);

    const checked = await body(await qcCheck(new Request(url(`/api/projects/${project.id}/qc`)), params(project.id)));
    assert.equal(checked.projectId, project.id);
    assert.equal(checked.summary.scenes, 2, '质检覆盖每个场景');
    assert.ok(!Number.isNaN(Date.parse(checked.checkedAt)), '检查时间要可解析');
    assert.equal(checked.summary.total, checked.subtitles.issues.length + checked.audio.issues.length, '汇总数量必须等于问题明细');
    assert.equal(checked.summary.errors + checked.summary.warnings, checked.summary.total);
    assert.equal(checked.subtitles.enabled, true);
    assert.ok(checked.subtitles.cueCount >= 3, '手动字幕要计入条数');

    const sceneIssues = checked.subtitles.issues.filter((issue: any) => issue.sceneIndex === 0);
    const codes = new Set(sceneIssues.map((issue: any) => issue.code));
    for (const code of ['subtitle_too_long', 'subtitle_too_short', 'subtitle_overlap', 'subtitle_out_of_scene']) {
      assert.ok(codes.has(code), `字幕质检要能发现 ${code}`);
    }
    assert.ok(sceneIssues.every((issue: any) => issue.kind === 'subtitle' && issue.fix === 'open_captions' && issue.sceneId === first && issue.sceneTitle === '开场'), '字幕问题必须定位到字幕与场景');
    assert.ok(sceneIssues.every((issue: any) => typeof issue.message === 'string' && issue.message.length > 0));
    assert.ok(sceneIssues.some((issue: any) => issue.cueIndex === 0 && issue.cueText?.length > 0), '问题要带上是哪一条字幕');
    assert.ok(sceneIssues.every((issue: any) => issue.severity === 'warning'), '字幕问题是提醒级');

    // 空白字幕在保存时就被拒绝，只有历史数据会走到这里，引擎要能兜住。
    const { checkSubtitles } = await import('@m2v/video/qc');
    const { StoryboardSchema } = await import('@m2v/schema');
    const parsedBroken = StoryboardSchema.parse(broken);
    const blankCue = checkSubtitles({
      ...parsedBroken,
      scenes: [{ ...parsedBroken.scenes[0], subtitleCues: [{ text: '   ', start: 0, end: 1 }] }, ...parsedBroken.scenes.slice(1)],
    });
    assert.deepEqual(blankCue.issues.filter(issue => issue.code === 'subtitle_empty').map(issue => [issue.cueIndex, issue.severity]), [[0, 'warning']]);

    assert.equal(typeof checked.audio.available, 'boolean');
    const missing = checked.audio.issues.filter((issue: any) => issue.code === 'audio_missing');
    assert.deepEqual(missing.map((issue: any) => issue.sceneIndex).sort(), [0, 1], '每个有旁白但没有音频的场景都要报缺失');
    assert.ok(missing.every((issue: any) => issue.kind === 'audio' && issue.severity === 'error' && issue.fix === 'regenerate_audio'));
    assert.equal(checked.audio.measurable, 0, '没有音频文件时可测量的场景为 0');

    // 修正字幕后再检查：字幕问题清零，语音缺失仍然保留。
    const fixed = { ...broken, scenes: [{ ...broken.scenes[0], subtitleCues: undefined }, broken.scenes[1]] };
    await saveStoryboard(project.id, fixed, 1);
    const rechecked = await body(await qcCheck(new Request(url(`/api/projects/${project.id}/qc?refresh=1`)), params(project.id)));
    assert.deepEqual(rechecked.subtitles.issues, [], '改好之后重新检查必须通过');
    assert.ok(rechecked.subtitles.cueCount > 0, '自动字幕仍然参与检查');
    assert.deepEqual(rechecked.audio.issues.map((issue: any) => issue.code), ['audio_missing', 'audio_missing'], '字幕修正不影响语音结论');

    // 关闭字幕后仍要统计实际字幕条目，只是不再产生字幕问题。
    const muted = { ...broken, subtitles: { enabled: false } };
    await saveStoryboard(project.id, muted, 2);
    const mutedCheck = await body(await qcCheck(new Request(url(`/api/projects/${project.id}/qc`)), params(project.id)));
    assert.equal(mutedCheck.subtitles.enabled, false, '要标出字幕已关闭');
    assert.equal(mutedCheck.subtitles.cueCount, checked.subtitles.cueCount, '关闭字幕后条数仍按实际字幕统计');
    assert.ok(mutedCheck.subtitles.cueCount >= 3, '关闭字幕后条数不能归零');
    assert.deepEqual(mutedCheck.subtitles.issues, [], '关闭字幕后不报字幕问题');
    await saveStoryboard(project.id, fixed, 3);

    assert.equal((await qcCheck(new Request(url('/api/projects/nope/qc')), params('nope'))).status, 404);
    const blank = await db.project.create({ data: { name: '没有分镜', sourceText: '正文。', status: 'draft' } });
    const noBoard = await qcCheck(new Request(url(`/api/projects/${blank.id}/qc`)), params(blank.id));
    assert.equal(noBoard.status, 400);
    assert.match((await body(noBoard)).error, /分镜/);

    // ── 成片文件校验 ────────────────────────────────────────────────────
    const missingJob = await db.job.create({
      data: {
        projectId: project.id, kind: 'render', status: 'completed', stage: 'done',
        outputPath: `${randomUUID()}.mp4`, inputJson: JSON.stringify({ storyboard: fixed, preset: 'full' }),
      },
    });
    const missingVerdict = await validateExportRoute(new Request(url('/'), { method: 'POST' }), jobParams(project.id, missingJob.id));
    assert.equal(missingVerdict.status, 200);
    const missingValidation = (await body(missingVerdict)).validation;
    assert.equal(missingValidation.ok, false);
    assert.deepEqual(missingValidation.issues.map((issue: any) => [issue.code, issue.blocking]), [['unreadable', true]]);
    assert.match(missingValidation.issues[0].message, /找不到这条记录的视频文件/);
    assert.equal(missingValidation.expected.width, 1920, '预期分辨率来自渲染快照');
    assert.equal(missingValidation.expected.height, 1080);
    assert.equal(missingValidation.expected.requireAudio, true, '有旁白就必须要求音频轨道');

    const history = await body(await readExports(new Request(url('/')), params(project.id)));
    assert.ok(Array.isArray(history));
    const row = history.find((item: any) => item.id === missingJob.id);
    assert.ok(row, '导出记录要带上校验结果');
    assert.equal(row.validation.ok, false, '校验结论要落库');
    assert.equal(row.validationJson, undefined, '原始字段不外泄');

    const gated = await body(await buildDeliveryRoute(new Request(url('/'), { method: 'POST', body: JSON.stringify({ jobId: missingJob.id }) }), params(project.id)));
    assert.match(gated.error, /成片文件校验未通过（文件无法读取）/, '有阻断问题时必须拒绝打包');
    const blocked = await buildDeliveryRoute(new Request(url('/'), { method: 'POST', body: JSON.stringify({ jobId: missingJob.id }) }), params(project.id));
    assert.equal(blocked.status, 409);

    const runningJob = await db.job.create({ data: { projectId: project.id, kind: 'render', status: 'running', stage: 'encoding' } });
    assert.equal((await validateExportRoute(new Request(url('/'), { method: 'POST' }), jobParams(project.id, runningJob.id))).status, 409);
    assert.equal((await validateExportRoute(new Request(url('/'), { method: 'POST' }), jobParams(project.id, 'missing-job'))).status, 404);
    assert.equal((await buildDeliveryRoute(new Request(url('/'), { method: 'POST', body: JSON.stringify({ jobId: 'missing-job' }) }), params(project.id))).status, 404);
    assert.equal((await buildDeliveryRoute(new Request(url('/'), { method: 'POST' }), params('missing-project'))).status, 404);

    // 共享 final.mp4 之后的旧记录不能再拿别人的视频做校验。
    await db.job.create({ data: { projectId: project.id, kind: 'render', status: 'completed', stage: 'done', outputPath: 'final.mp4' } });
    const legacy = await db.job.create({ data: { projectId: project.id, kind: 'render', status: 'completed', stage: 'done' } });
    const covered = await validateExportRoute(new Request(url('/'), { method: 'POST' }), jobParams(project.id, legacy.id));
    assert.equal(covered.status, 409);
    assert.match((await body(covered)).error, /已被后续导出覆盖/);

    // ── 真实成片的校验与交付包 ──────────────────────────────────────────
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const filmProject = await db.project.create({ data: { name: '启航交付', sourceText: '交付正文。', status: 'awaiting_review' } });
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
    await mkdir(resolve(outputDirFor(filmProject.id)), { recursive: true });
    let media = true;
    try {
      execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=1920x1080:d=6:r=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', video], { stdio: 'ignore', timeout: 180_000 });
    } catch {
      media = false;
      console.log('SKIP: 本机没有可用的 FFmpeg，跳过真实成片的校验与交付包检查。');
    }

    if (media) {
      const filmVerdict = await validateExportRoute(new Request(url('/'), { method: 'POST' }), jobParams(filmProject.id, filmJob.id));
      assert.equal(filmVerdict.status, 200);
      const validation = (await body(filmVerdict)).validation;
      if (!validation.ok) {
        console.log(`SKIP: FFprobe 不可用（${validation.issues[0]?.message ?? '未知原因'}），跳过交付包检查。`);
      } else {
        assert.equal(validation.width, 1920);
        assert.equal(validation.height, 1080);
        assert.equal(validation.hasAudio, true);
        assert.ok(Math.abs(validation.duration - 6) < 1.5, '成片时长要与场景时间轴一致');
        assert.deepEqual(validation.issues, []);

        const packed = await buildDeliveryRoute(new Request(url('/'), { method: 'POST', body: JSON.stringify({ jobId: filmJob.id }) }), params(filmProject.id));
        assert.equal(packed.status, 200);
        const packedBody = await body(packed);
        assert.equal(packedBody.ok, true, '打包成功时返回记录，ZIP 由下载接口单独提供');
        assert.match(packedBody.name, /启航交付-交付包-\d{8}-\d{4}\.zip/, '交付包文件名要带项目名与时间戳');
        const download = await readDelivery(new Request(url('/')), jobParams(filmProject.id, filmJob.id));
        assert.equal(download.status, 200);
        assert.equal(download.headers.get('content-type'), 'application/zip');
        const archive = Buffer.from(await download.arrayBuffer());
        assert.equal(archive.length, packedBody.bytes, '下载到的字节数与记录一致');
        assert.ok(archive.readUInt32LE(0) === 0x04034b50, '交付包必须是 ZIP');
        assert.ok(archive.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), '交付包必须以中央目录收尾');
        for (const entry of ['启航交付-成片-', '-字幕-', '.srt', '.vtt', '.ass', '启航交付-封面-', '启航交付-项目备份-', '.m2v', '启航交付-交付说明.txt']) {
          assert.ok(archive.includes(Buffer.from(entry, 'utf8')), `交付包缺少 ${entry}`);
        }
        assert.ok(archive.includes(Buffer.from('字幕与成片使用同一时间轴', 'utf8')), '交付说明要写明字幕时间轴');
        assert.ok(archive.includes(Buffer.from('五、质检结果', 'utf8')), '交付说明要附上质检结论');

        const fallback = await buildDeliveryRoute(new Request(url('/'), { method: 'POST' }), params(filmProject.id));
        assert.equal(fallback.status, 200, '不带 jobId 时默认打包最近一次完成的渲染');
        assert.equal((await body(fallback)).ok, true);
        const stored = await db.job.findUniqueOrThrow({ where: { id: filmJob.id } });
        assert.ok(stored.validationJson, '校验结果要留在导出记录里');
      }
    }

    // ── 导出预设 ────────────────────────────────────────────────────────
    const empty = await body(await readPresets());
    assert.deepEqual(empty.presets, [], '沙箱里没有历史预设');
    assert.equal(empty.max, 30);

    const created = await writePreset(new Request(url('/'), {
      method: 'POST',
      body: JSON.stringify({ name: ' 竖屏交付 ', aspectRatio: '9:16', transition: 'fade', intro: { enabled: true, title: '片头' }, subtitles: { preset: 'highlight' } }),
    }));
    assert.equal(created.status, 200);
    const preset = (await body(created)).preset;
    assert.equal(preset.name, '竖屏交付');
    assert.equal(preset.aspectRatio, '9:16');
    assert.equal(preset.renderPreset, 'full');
    assert.equal(preset.transition, 'fade');
    assert.equal(preset.subtitles.preset, 'highlight');
    assert.equal(preset.intro.title, '片头');
    assert.ok(preset.id && preset.createdAt && preset.updatedAt);

    const listed = await body(await readPresets());
    assert.deepEqual(listed.presets.map((item: any) => item.name), ['竖屏交付'], '保存后能读到');

    const duplicate = await writePreset(new Request(url('/'), { method: 'POST', body: JSON.stringify({ name: '竖屏交付', aspectRatio: '16:9', subtitles: {} }) }));
    assert.equal(duplicate.status, 409, '同名预设不能重复保存');
    assert.match((await body(duplicate)).error, /已存在/);
    const invalid = await writePreset(new Request(url('/'), { method: 'POST', body: JSON.stringify({ name: '坏预设', aspectRatio: '1:1', subtitles: {} }) }));
    assert.equal(invalid.status, 400);
    const incomplete = await writePreset(new Request(url('/'), { method: 'POST', body: JSON.stringify({ name: '缺字幕设置', aspectRatio: '16:9' }) }));
    assert.equal(incomplete.status, 400, '缺少字幕设置要拒绝');

    // 复用预设：只改交付设置，分镜、旁白与素材原样保留。
    const patch = presetBoardPatch(preset);
    assert.deepEqual(Object.keys(patch).sort(), ['aspectRatio', 'intro', 'outro', 'subtitles', 'transition']);
    const applied = { ...fixed, ...patch };
    assert.deepEqual(applied.scenes, fixed.scenes, '应用预设不能改动分镜');
    assert.equal(applied.aspectRatio, '9:16');

    assert.equal((await removePreset(new Request(url(`/api/settings/export-presets?id=${preset.id}`), { method: 'DELETE' }))).status, 200);
    assert.deepEqual((await body(await readPresets())).presets, [], '删除后列表为空');
    assert.equal((await removePreset(new Request(url('/api/settings/export-presets?id=gone'), { method: 'DELETE' }))).status, 404);
    assert.equal((await removePreset(new Request(url('/api/settings/export-presets'), { method: 'DELETE' }))).status, 400);

    console.log('PASS: GET /qc 把字幕过长、停留不足、重叠、超场景与空字幕逐条定位到场景与字幕，语音缺失同样定位到场景；修正后 refresh=1 重新检查字幕清零。校验接口把不可读的成片标为阻断并写进导出记录，交付包接口据此拒绝打包；真实 MP4 通过校验后可打出含成片、三份字幕、封面、项目备份与交付说明的 ZIP。导出预设支持保存、同名拒绝、列表、应用（只改画幅/字幕/片头片尾）与删除。');
  } finally {
    await db.$disconnect();
    process.chdir(repo);
    for (let attempt = 0; attempt < 10; attempt++) {
      try { await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); break; } catch { await new Promise(done => setTimeout(done, 300)); }
    }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
