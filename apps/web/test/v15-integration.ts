import assert from 'node:assert/strict';
import type { PreflightResult } from '@m2v/schema';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

async function exists(path: string) {
  try { await access(path); return true; } catch { return false; }
}

async function main() {
  const repo = process.cwd(), sandbox = resolve(repo, 'data', `test-v15-${randomUUID()}`);
  await mkdir(join(sandbox, 'apps/web/public/audio'), { recursive: true });
  await mkdir(join(sandbox, 'apps/web/public/projects'), { recursive: true });
  process.env.DATABASE_URL = `file:${join(sandbox, 'test.db').replaceAll('\\', '/')}`;
  const sql = execFileSync(process.execPath, [join(repo, 'apps/web/node_modules/prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', join(repo, 'apps/web/prisma/schema.prisma'), '--script'], { env: process.env, encoding: 'utf8' });
  const database = new DatabaseSync(join(sandbox, 'test.db')); database.exec(sql); database.close();
  process.chdir(join(sandbox, 'apps/web'));

  const { db } = await import('../src/lib/db');
  const { saveStoryboard } = await import('../src/lib/pipeline');
  const { outputDirFor } = await import('../src/lib/job-video');
  const { assetFilePath, assetDirs } = await import('../src/lib/asset-usage');
  const { preflightGaps, preflightDelta, subtitleCues, cueAt, cueSceneIndex, sceneStartTimes, templateFromProject, batchImpact, applyBatch } = await import('@m2v/schema');
  const { GET: readPreflight } = await import('../src/app/api/projects/[id]/preflight/route');
  const { GET: readFlow } = await import('../src/app/api/projects/[id]/export-flow/route');
  const { GET: readUsage } = await import('../src/app/api/projects/[id]/assets/usage/route');
  const { POST: uploadAsset, PATCH: patchAsset } = await import('../src/app/api/projects/[id]/assets/route');
  const { GET: readSettings, POST: saveTemplate, PATCH: patchTemplate, DELETE: deleteTemplate } = await import('../src/app/api/settings/production-templates/route');
  const { POST: applyTemplate } = await import('../src/app/api/projects/[id]/production-template/route');
  const { GET: downloadVideo, HEAD: probeVideo } = await import('../src/app/api/projects/[id]/output/route');

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const url = (path: string) => `http://localhost${path}`;
  const body = async <T = Record<string, any>>(response: Response) => (await response.json()) as T;
  const post = (data: unknown) => new Request(url('/'), { method: 'POST', body: JSON.stringify(data) });
  const patch = (data: unknown) => new Request(url('/'), { method: 'PATCH', body: JSON.stringify(data) });
  const upload = (fields: Record<string, string>, name: string, bytes: Uint8Array) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    form.set('file', new File([bytes as unknown as BlobPart], name, { type: 'image/png' }));
    return new Request(url('/'), { method: 'POST', body: form });
  };
  const freeScene = (extra: Record<string, unknown> = {}) => ({ id: randomUUID(), type: 'title', title: '场景', narration: ' ', duration: 4, ...extra });
  const board = (title: string, scenes: unknown[]) => ({ title, styleId: 'minimal-tech', aspectRatio: '16:9', scenes });

  try {
    // ── 导出前检查：同一张图被多个场景引用只列一行 ─────────────────────
    const checkId = (await db.project.create({ data: { name: '导出检查', sourceText: '正文。'.repeat(20), status: 'awaiting_review' } })).id;
    const shared = `projects/${checkId}/assets/shared.png`;
    await saveStoryboard(checkId, board('导出检查', [
      { id: randomUUID(), type: 'media', title: '配图一', narration: '第一段讲解。', duration: 4, visual: { src: shared } },
      { id: randomUUID(), type: 'media', title: '配图二', narration: '第二段讲解。', duration: 4, visual: { src: shared } },
      freeScene({ title: '收尾' }),
    ]));
    const checked = await readPreflight(new Request(url(`/api/projects/${checkId}/preflight`)), params(checkId));
    const report = await body<PreflightResult & { projectId: string }>(checked);
    assert.equal(checked.status, 200);
    assert.equal(report.projectId, checkId, '检查结果与项目一起返回');
    assert.ok(report.blocking >= 2, '缺语音和缺图片都是阻断问题');
    const files = report.issues.filter((issue: any) => issue.code === 'missing_file');
    assert.equal(files.length, 2, '两个场景各有一条记录');
    assert.equal(files[0].assetPath, shared);
    assert.equal(files[1].assetPath, shared, '同一个文件被两个场景引用');
    assert.equal(files[0].fix, 'upload_asset');
    assert.equal(files[0].assetKind, 'image');
    assert.ok(files.every((issue: any) => typeof issue.sceneTitle === 'string'), '每条问题都带场景名，才能跳过去处理');
    const audio = report.issues.filter((issue: any) => issue.code === 'missing_audio');
    assert.equal(audio.length, 2, '没有旁白的场景不报缺语音');
    assert.equal(audio[0].fix, 'generate_audio');

    const gaps = preflightGaps(report);
    const imageGaps = gaps.filter((gap: any) => gap.kind === 'image');
    assert.equal(imageGaps.length, 1, '缺失清单里这张图只出现一次');
    assert.deepEqual(imageGaps[0].scenes.map((scene: any) => scene.sceneIndex), [0, 1], '一个文件的问题合并列出全部受影响场景');
    assert.equal(imageGaps[0].fix, 'upload_asset');
    assert.equal(gaps.filter((gap: any) => gap.kind === 'audio').length, 2, '缺语音按场景分别列出，方便逐个生成');

    // 检查未通过时不会写入通过标记，导出流程停在第 1 步。
    const blockedFlow = await body(await readFlow(new Request(url(`/api/projects/${checkId}/export-flow`)), params(checkId)));
    assert.equal(blockedFlow.canExport, false);
    assert.equal(blockedFlow.resumeFrom, 'preflight');
    assert.equal(blockedFlow.checkedAt, null, '没通过的检查不会记成已检查');
    assert.equal(blockedFlow.steps[0].state, 'blocked');
    assert.match(blockedFlow.headline, /先处理 \d+ 项阻断问题/);
    assert.deepEqual(blockedFlow.steps.map((step: any) => step.label), ['检查', '渲染', '校验', '打包']);

    // ── 修好之后从失败的步骤继续 ──────────────────────────────────────
    const previous = report;
    await mkdir(join(process.cwd(), 'public', 'audio'), { recursive: true });
    await writeFile(join(process.cwd(), 'public', 'audio', 'demo.mp3'), Buffer.from('AUDIO'));
    const readyScene = (title: string) => freeScene({ title, narration: '这一段旁白已经配好音。', audioSrc: 'audio/demo.mp3', audioDuration: 3.8 });
    await saveStoryboard(checkId, board('导出检查', [readyScene('开场'), readyScene('收尾')]));
    const clean = await body<PreflightResult & { projectId: string }>(await readPreflight(new Request(url(`/api/projects/${checkId}/preflight`)), params(checkId)));
    assert.equal(clean.blocking, 0, '补齐语音与图片后不再有阻断问题');
    assert.equal(clean.issues.length, 0, '配好旁白也不再提示缺语音');
    const delta = preflightDelta(previous, clean);
    assert.equal(delta.fixed, previous.issues.length, '上次列出的问题全都标为已修好');
    assert.equal(delta.added, 0, '修的过程中没有引入新问题');
    assert.equal(delta.remaining, 0);

    const readyFlow = await body(await readFlow(new Request(url(`/api/projects/${checkId}/export-flow`)), params(checkId)));
    assert.equal(readyFlow.canExport, true);
    assert.equal(readyFlow.steps[0].state, 'passed');
    assert.equal(readyFlow.resumeFrom, 'render', '检查通过后从渲染继续');
    assert.deepEqual(readyFlow.passed, ['preflight']);
    assert.ok(readyFlow.checkedAt, '通过的检查要记录时间');
    assert.match(readyFlow.headline, /第 2 步（渲染）/);

    // 分镜再改一次，已经通过的检查要作废。
    await saveStoryboard(checkId, board('导出检查（改）', [readyScene('开场'), readyScene('收尾')]));
    const staleFlow = await body(await readFlow(new Request(url(`/api/projects/${checkId}/export-flow`)), params(checkId)));
    assert.equal(staleFlow.steps[0].state, 'pending');
    assert.equal(staleFlow.steps[0].message, '分镜已修改，需要重新检查。');
    assert.equal(staleFlow.canExport, false);
    assert.equal(staleFlow.resumeFrom, 'preflight');

    // 检查通过并渲染完成后，渲染步骤通过、校验仍未做。
    await readPreflight(new Request(url(`/api/projects/${checkId}/preflight`)), params(checkId));
    const renderId = randomUUID();
    await db.job.create({ data: { id: renderId, projectId: checkId, kind: 'render', status: 'completed', stage: 'completed', outputPath: `${renderId}.mp4`, inputJson: '{"preset":"full"}' } });
    await mkdir(outputDirFor(checkId), { recursive: true });
    await writeFile(join(outputDirFor(checkId), `${renderId}.mp4`), Buffer.alloc(2048, 7));
    const rendered = await body(await readFlow(new Request(url(`/api/projects/${checkId}/export-flow`)), params(checkId)));
    assert.equal(rendered.steps[1].state, 'passed', '成片存在时渲染步骤通过');
    assert.equal(rendered.steps[2].state, 'pending');
    assert.equal(rendered.resumeFrom, 'validate');
    assert.deepEqual(rendered.passed, ['preflight', 'render']);
    assert.match(rendered.headline, /已通过的检查、渲染不会重做/);

    // ── 成片精修：改完字幕时间就能在成片里立刻复看 ────────────────────
    const cutId = (await db.project.create({ data: { name: '成片精修', sourceText: '正文。'.repeat(20), status: 'awaiting_review' } })).id;
    const cutScenes: any[] = [
      freeScene({ title: '开场', narration: '开场白。', duration: 4 }),
      freeScene({ title: '解释', narration: '解释一下。', duration: 5, subtitleCues: [{ text: '原来的字幕', start: 1, end: 2 }] }),
    ];
    await saveStoryboard(cutId, board('成片精修', cutScenes));
    const saved = JSON.parse((await db.project.findUniqueOrThrow({ where: { id: cutId } })).storyboardJson!);
    assert.deepEqual(saved.scenes[1].subtitleCues, [{ text: '原来的字幕', start: 1, end: 2 }], '手动字幕要原样存回去');

    const before = subtitleCues(saved);
    const startOfSecond = sceneStartTimes(saved)[1];
    assert.equal(startOfSecond, 4, '第二个场景从 4 秒开始');
    assert.equal(cueAt(before, startOfSecond + 1.5)?.text, '原来的字幕', '成片里 5.5 秒显示这条字幕');
    assert.equal(cueSceneIndex(saved, startOfSecond + 1.5), 1, '同一时刻定位到第二个场景');
    assert.ok(before.every((cue: any) => cue.start >= sceneStartTimes(saved)[cue.sceneIndex]), '每条字幕都在自己场景的区间内');

    await saveStoryboard(cutId, board('成片精修', [
      { ...cutScenes[0] },
      { ...cutScenes[1], subtitleCues: [{ text: '调整后的字幕', start: 2, end: 3 }] },
    ]));
    const refined = JSON.parse((await db.project.findUniqueOrThrow({ where: { id: cutId } })).storyboardJson!);
    const after = subtitleCues(refined);
    assert.equal(cueAt(after, 5.5), null, '调整后原来的时间点不再显示字幕');
    assert.equal(cueAt(after, 6.5)?.text, '调整后的字幕', '新的时间点立刻生效');
    const moved = after.find((cue: any) => cue.text === '调整后的字幕')!;
    assert.equal(moved.sceneIndex, 1, '字幕记住自己属于哪个场景，便于跳回去继续改');
    assert.equal(moved.cueIndex, 0);
    assert.equal(cueSceneIndex(refined, 6.5), 1);

    // ── 素材管理：未使用、重复、替换后归档与恢复 ──────────────────────
    const assetId = (await db.project.create({ data: { name: '素材管理', sourceText: '正文。'.repeat(20), status: 'awaiting_review' } })).id;
    const bytesA = Buffer.from('IMAGE-A-CONTENT');
    const uploadA = await body(await uploadAsset(upload({ kind: 'image' }, 'start.png', bytesA), params(assetId)));
    const uploadB = await body(await uploadAsset(upload({ kind: 'image' }, 'unused.png', Buffer.from('IMAGE-B-CONTENT')), params(assetId)));
    const uploadDup = await body(await uploadAsset(upload({ kind: 'image' }, 'copy-of-a.png', bytesA), params(assetId)));
    const assetA = uploadA.asset as { path: string; name: string };
    const assetB = uploadB.asset as { path: string; name: string };

    await saveStoryboard(assetId, board('素材管理', [
      { id: randomUUID(), type: 'media', title: '第一处', narration: ' ', duration: 4, visual: { src: assetA.path } },
      { id: randomUUID(), type: 'media', title: '第二处', narration: ' ', duration: 4, visual: { src: assetA.path } },
      freeScene({ title: '文字页' }),
    ]));

    const usage = await body(await readUsage(new Request(url(`/api/projects/${assetId}/assets/usage`)), params(assetId)));
    assert.equal(usage.total, 3);
    const refA = usage.referenced.find((ref: any) => ref.path === assetA.path)!;
    assert.deepEqual(refA.scenes.map((scene: any) => scene.index), [0, 1], '同一素材被两个场景引用');
    assert.equal(refA.bgm, false);
    assert.deepEqual(usage.unused.map((item: any) => item.path).sort(), [assetB.path, uploadDup.asset.path].sort(), '没有引用的素材单独列出');
    assert.equal(usage.duplicates.length, 1, '内容相同的两个文件识别为重复');
    assert.equal(usage.duplicates[0].paths.length, 2);
    assert.ok(usage.bytes > 0);
    assert.equal(usage.missing.length, 0, '文件都在，不报缺失');

    // 只替换选中的场景，其余场景继续用原素材。
    const replacement = await body(await uploadAsset(upload({ kind: 'image', replace: assetA.path, scenes: JSON.stringify([0, 2]) }, 'new.png', Buffer.from('IMAGE-C-CONTENT')), params(assetId)));
    assert.equal(replacement.archived, false, '还有场景在用，不能归档');
    assert.deepEqual(replacement.stillReferenced.scenes, [1], '还有场景在用，不能归档');
    assert.deepEqual(replacement.skipped, [2], '没有图片的场景跳过，不会凭空造出引用');

    const second = await body(await uploadAsset(upload({ kind: 'image', replace: assetA.path, scenes: JSON.stringify([1]) }, 'newer.png', Buffer.from('IMAGE-D-CONTENT')), params(assetId)));
    assert.equal(second.archived, true, '没有场景再引用时归档');
    assert.deepEqual(second.stillReferenced.scenes, []);
    assert.equal(await exists(assetFilePath(assetId, { name: assetA.name, archived: true })), true, '归档保留原文件');
    assert.equal(await exists(assetFilePath(assetId, { name: assetA.name, archived: true }, 'public')), false, '归档后不进渲染目录');
    const archivedUsage = await body(await readUsage(new Request(url(`/api/projects/${assetId}/assets/usage`)), params(assetId)));
    assert.deepEqual(archivedUsage.archived.map((item: any) => item.path), [assetA.path]);
    assert.equal(archivedUsage.total, 5, '归档的素材记录还在，可以恢复');

    const restored = await body(await patchAsset(patch({ path: assetA.path, action: 'restore' }), params(assetId)));
    assert.equal(restored.restored, assetA.path);
    assert.equal(await exists(assetFilePath(assetId, { name: assetA.name })), true);
    assert.equal(await exists(assetFilePath(assetId, { name: assetA.name }, 'public')), true, '恢复后重新进入渲染目录');

    const noConfirm = await patchAsset(patch({ path: assetA.path, action: 'purge' }), params(assetId));
    assert.equal(noConfirm.status, 400, '彻底删除要二次确认');
    const stillUsed = await patchAsset(patch({ path: replacement.asset.path, action: 'purge', confirm: true }), params(assetId));
    assert.equal(stillUsed.status, 409, '仍被场景引用时拒绝删除');
    const purged = await body(await patchAsset(patch({ path: assetA.path, action: 'purge', confirm: true }), params(assetId)));
    assert.equal(purged.purged, assetA.path);
    assert.equal(await exists(assetFilePath(assetId, { name: assetA.name })), false);
    assert.equal(await exists(join(assetDirs(assetId).dataArchive, assetA.name)), false, '彻底删除连归档副本一起清掉');
    const afterPurge = await body(await readUsage(new Request(url(`/api/projects/${assetId}/assets/usage`)), params(assetId)));
    assert.equal(afterPurge.total, 4, '删除后不再出现在素材清单里');
    assert.equal(afterPurge.archived.length, 0);

    // ── 制作方案：保存、应用前预览、应用与复用 ────────────────────────
    const tplId = (await db.project.create({ data: { name: '方案复用', sourceText: '正文。'.repeat(20), status: 'awaiting_review' } })).id;
    const tplScenes = [
      freeScene({ title: '开场', narration: '开场白。', speechSpeed: 1.2, sentencePause: 0.2, sceneGap: 0.5 }),
      freeScene({ title: '解释', narration: '解释一下。', speechSpeed: 1, sentencePause: 0.1, sceneGap: 0.5 }),
    ];
    await saveStoryboard(tplId, board('方案复用', tplScenes));
    const withAudio = JSON.parse((await db.project.findUniqueOrThrow({ where: { id: tplId } })).storyboardJson!);
    withAudio.scenes[1].audioSrc = 'audio/old.mp3';
    withAudio.scenes[1].audioDuration = 4.2;
    withAudio.scenes[1].subtitleCues = [{ text: '旧字幕', start: 1, end: 2 }];
    await db.project.update({ where: { id: tplId }, data: { storyboardJson: JSON.stringify(withAudio) } });

    const template = templateFromProject({ board: withAudio, voiceId: 'voice-1' });
    const created = await body(await saveTemplate(post({ ...template, name: '快速口播', renderPreset: 'draft' })));
    assert.ok(created.template.id);
    assert.equal(created.template.renderPreset, 'draft');
    const listed = await body(await readSettings());
    assert.equal(listed.max, 30);
    assert.deepEqual(listed.templates.map((item: any) => item.name), ['快速口播']);

    const otherProjectId = (await db.project.create({ data: { name: '跨项目套用方案', sourceText: '另一份正文。'.repeat(10), status: 'awaiting_review' } })).id;
    await saveStoryboard(otherProjectId, board('跨项目套用方案', [freeScene({ title: '另一个项目的开场' })]));
    const reusedInOtherProject = await body(await applyTemplate(post({ templateId: created.template.id, renderPreset: 'draft' }), params(otherProjectId)));
    assert.equal(reusedInOtherProject.ok, true, '同一制作方案可以从其他项目复用');
    const otherProject = await db.project.findUniqueOrThrow({ where: { id: otherProjectId } });
    const otherBoard = JSON.parse(otherProject.storyboardJson!);
    assert.equal(otherProject.voiceId, 'voice-1');
    assert.equal(otherBoard.aspectRatio, template.aspectRatio);
    assert.equal(otherBoard.scenes[0].speechSpeed, 1.2);
    assert.equal(reusedInOtherProject.renderPreset, 'draft');

    const applied = await body(await applyTemplate(post({ templateId: created.template.id, renderPreset: 'draft' }), params(tplId)));
    assert.equal(applied.ok, true);
    assert.equal(applied.voice, true, '项目原来没选声音，应用后要换成方案里的声音');
    assert.equal(applied.sceneCount, 1, '只有语速不同的那一个场景会被改写');
    assert.deepEqual(applied.staleAudio, [1], '语速变了的场景要重新配音');
    assert.equal(applied.renderPreset, 'draft');
    assert.ok(applied.changedCount > 0);
    const appliedProject = await db.project.findUniqueOrThrow({ where: { id: tplId } });
    assert.equal(appliedProject.voiceId, 'voice-1');
    const appliedBoard = JSON.parse(appliedProject.storyboardJson!);
    assert.equal(appliedBoard.aspectRatio, template.aspectRatio);
    assert.equal(appliedBoard.scenes[0].speechSpeed, 1.2);
    assert.equal(appliedBoard.scenes[1].speechSpeed, 1.2, '场景语速统一成方案里的值');
    assert.equal(appliedBoard.scenes[1].audioSrc, undefined, '语速变了，旧配音不能再冒充新旁白');
    assert.equal(appliedBoard.scenes[1].subtitleCues, undefined, '旧字幕时间轴同样作废');
    assert.equal(appliedBoard.scenes[0].audioSrc, undefined);

    const again = await body(await applyTemplate(post({ templateId: created.template.id, renderPreset: 'draft' }), params(tplId)));
    assert.equal(again.changedCount, 0, '再应用一次没有变化');
    assert.equal(again.sceneCount, 0);
    assert.equal(again.voice, false, '声音已经一致');
    assert.deepEqual(again.staleAudio, []);

    const defaultsId = (await db.project.create({ data: { name: '默认语速不作废配音', sourceText: '正文。'.repeat(10), status: 'awaiting_review' } })).id;
    const defaultsScene = freeScene({ title: '默认值', narration: '使用默认语速的旁白。', audioSrc: 'audio/default.wav', wordTimings: [{ text: '旁白', start: 0.2, end: 0.8 }], subtitleCues: [{ text: '旁白', start: 0.2, end: 0.8 }] });
    await saveStoryboard(defaultsId, board('默认语速不作废配音', [defaultsScene]));
    const defaultsBoard = JSON.parse((await db.project.findUniqueOrThrow({ where: { id: defaultsId } })).storyboardJson!);
    assert.equal(defaultsBoard.scenes[0].speechSpeed, undefined, '保存时保留隐式默认语速');
    const defaults = await body(await saveTemplate(post({ ...templateFromProject({ board: defaultsBoard }), name: '默认语速方案' })));
    const defaultsApplied = await body(await applyTemplate(post({ templateId: defaults.template.id }), params(defaultsId)));
    assert.equal(defaultsApplied.changedCount, 0, '隐式默认值与方案中的显式默认值应视为相同');
    assert.equal(defaultsApplied.sceneCount, 0);
    assert.deepEqual(defaultsApplied.staleAudio, []);
    const defaultsAfter = JSON.parse((await db.project.findUniqueOrThrow({ where: { id: defaultsId } })).storyboardJson!);
    assert.equal(defaultsAfter.scenes[0].audioSrc, 'audio/default.wav', '无变化方案不清除现有语音');
    assert.deepEqual(defaultsAfter.scenes[0].wordTimings, [{ text: '旁白', start: 0.2, end: 0.8 }]);
    assert.deepEqual(defaultsAfter.scenes[0].subtitleCues, [{ text: '旁白', start: 0.2, end: 0.8 }]);
    await deleteTemplate(new Request(url(`/api/settings/production-templates?id=${defaults.template.id}`), { method: 'DELETE' }));

    const voiceOnly = await body(await applyTemplate(post({ templateId: created.template.id, applyScenes: false, applyExport: false }), params(tplId)));
    assert.equal(voiceOnly.sceneCount, 0, '不勾选场景时不报场景改动');

    const renamed = await body(await patchTemplate(patch({ id: created.template.id, action: 'rename', name: '口播模板' })));
    assert.equal(renamed.template.name, '口播模板');
    assert.equal((await patchTemplate(patch({ id: created.template.id, action: 'rename', name: '' }))).status, 400);
    const copied = await body(await patchTemplate(patch({ id: created.template.id, action: 'duplicate' })));
    assert.notEqual(copied.template.id, created.template.id);
    assert.match(copied.template.name, /口播模板/);
    const defaulted = await body(await patchTemplate(patch({ id: copied.template.id, action: 'default' })));
    assert.equal(defaulted.template.isDefault, true);
    assert.equal((await deleteTemplate(new Request(url('/api/settings/production-templates?id=missing'), { method: 'DELETE' }))).status, 404);
    assert.equal((await deleteTemplate(new Request(url(`/api/settings/production-templates?id=${created.template.id}`), { method: 'DELETE' }))).status, 200);
    assert.deepEqual((await body(await readSettings())).templates.map((item: any) => item.name), [copied.template.name]);

    // ── 缺失素材修复：补齐上传或就地替换之后，导出检查不再拦缺图 ────────
    const fixId = (await db.project.create({ data: { name: '缺失修复', sourceText: '正文。'.repeat(20), status: 'awaiting_review' } })).id;
    const kept = (await body(await uploadAsset(upload({ kind: 'image' }, 'kept.png', Buffer.from('KEPT-IMAGE')), params(fixId)))).asset as { path: string; name: string };
    const lost = (await body(await uploadAsset(upload({ kind: 'image' }, 'lost.png', Buffer.from('LOST-IMAGE')), params(fixId)))).asset as { path: string; name: string };
    const ghost = `projects/${fixId}/assets/ghost.png`;
    await saveStoryboard(fixId, board('缺失修复', [
      { id: randomUUID(), type: 'media', title: '文件丢了', narration: '第一段讲解。', duration: 4, visual: { src: lost.path } },
      { id: randomUUID(), type: 'media', title: '没登记过', narration: '第二段讲解。', duration: 4, visual: { src: ghost } },
      { id: randomUUID(), type: 'media', title: '一切正常', narration: '第三段讲解。', duration: 4, visual: { src: kept.path } },
    ]));
    // 模拟素材文件在磁盘上丢了：记录还在，文件没了。
    await rm(assetFilePath(fixId, lost), { force: true });
    await rm(assetFilePath(fixId, lost, 'public'), { force: true });

    const brokenUsage = await body(await readUsage(new Request(url(`/api/projects/${fixId}/assets/usage`)), params(fixId)));
    const lostEntry = brokenUsage.missing.find((item: any) => item.path === lost.path);
    assert.equal(lostEntry.registered, true, '登记过但文件丢了，可以就地替换');
    assert.deepEqual(lostEntry.scenes.map((scene: any) => scene.index), [0]);
    const ghostEntry = brokenUsage.missing.find((item: any) => item.path === ghost);
    assert.equal(ghostEntry.registered, false, '引用了却没登记，要走补齐上传');
    assert.deepEqual(ghostEntry.scenes.map((scene: any) => scene.index), [1]);
    assert.equal(brokenUsage.missing.some((item: any) => item.path === kept.path), false, '文件都在的素材不误报');

    const brokenPreflight = await body<PreflightResult>(await readPreflight(new Request(url(`/api/projects/${fixId}/preflight`)), params(fixId)));
    const brokenFiles = brokenPreflight.issues.filter((issue: any) => issue.code === 'missing_file');
    assert.deepEqual(brokenFiles.map((issue: any) => issue.assetPath), [lost.path], '登记过但文件丢了的素材报缺失文件');
    assert.equal(brokenFiles[0].sceneIndex, 0);
    assert.equal(brokenFiles[0].fix, 'upload_asset', '可以就地替换文件');
    const unregistered = brokenPreflight.issues.filter((issue: any) => issue.code === 'missing_image');
    assert.deepEqual(unregistered.map((issue: any) => issue.assetPath), [ghost], '没登记的引用要提示去素材管理补齐');
    assert.equal(unregistered[0].sceneIndex, 1);
    assert.equal(unregistered[0].fix, 'open_assets');

    // 补齐上传：先登记新素材，再把场景指过去。
    const filled = (await body(await uploadAsset(upload({ kind: 'image' }, 'ghost.png', Buffer.from('FILLED-IMAGE')), params(fixId)))).asset as { path: string; name: string };
    assert.notEqual(filled.path, ghost);
    assert.equal(await exists(assetFilePath(fixId, filled)), true, '补齐上传真的写了文件');
    const afterFill = JSON.parse((await db.project.findUniqueOrThrow({ where: { id: fixId } })).storyboardJson!);
    afterFill.scenes[1].visual = { src: filled.path };
    await saveStoryboard(fixId, afterFill);

    // 就地替换：登记过的素材直接换文件，场景引用一起改掉，原文件归档保留。
    const swapped = await body(await uploadAsset(upload({ kind: 'image', replace: lost.path, scenes: JSON.stringify([0]) }, 'lost-fixed.png', Buffer.from('FIXED-IMAGE')), params(fixId)));
    assert.equal(swapped.archived, true, '原文件已经没人引用，归档保留');
    assert.deepEqual(swapped.stillReferenced.scenes, []);

    const repairedUsage = await body(await readUsage(new Request(url(`/api/projects/${fixId}/assets/usage`)), params(fixId)));
    assert.deepEqual(repairedUsage.missing.filter((item: any) => item.scenes.length > 0), [], '还有场景引用的缺失素材全部补齐');
    assert.deepEqual(repairedUsage.missing.map((item: any) => [item.path, item.archived]), [[lost.path, true]], '归档里那个文件确实不在了，如实保留一条待清理记录');
    assert.ok(repairedUsage.archived.some((item: any) => item.path === lost.path), '被换下的素材记录进了归档，可以恢复');
    const repairedPreflight = await body<PreflightResult>(await readPreflight(new Request(url(`/api/projects/${fixId}/preflight`)), params(fixId)));
    assert.equal(repairedPreflight.issues.filter((issue: any) => issue.code === 'missing_file').length, 0, '导出检查不再拦缺图');
    assert.equal(repairedPreflight.issues.filter((issue: any) => issue.code === 'missing_image').length, 0, '补齐登记后不再提示去素材管理');
    assert.ok(repairedPreflight.issues.some((issue: any) => issue.code === 'missing_audio'), '只剩还没配音的问题，可继续处理');

    // ── 批量精修：预览后应用，只改选中的场景并落盘 ──────────────────────
    const batchId = (await db.project.create({ data: { name: '批量精修', sourceText: '正文。'.repeat(20), status: 'awaiting_review' } })).id;
    const batchScenes = [
      freeScene({ title: '一', narration: '第一段。', subtitleCues: [{ text: '一', start: 0, end: 1 }] }),
      freeScene({ title: '二', narration: '第二段。', subtitleCues: [{ text: '二', start: 0, end: 1 }] }),
      freeScene({ title: '三', narration: '第三段。', subtitleCues: [{ text: '三', start: 0, end: 1 }] }),
    ];
    await saveStoryboard(batchId, board('批量精修', batchScenes));
    const beforeBatch = JSON.parse((await db.project.findUniqueOrThrow({ where: { id: batchId } })).storyboardJson!);
    beforeBatch.scenes.forEach((scene: any, index: number) => {
      scene.audioSrc = `audio/${index}.mp3`; scene.audioDuration = 4; scene.wordTimings = [{ text: '台词', start: 0, end: 1 }];
    });
    await db.project.update({ where: { id: batchId }, data: { storyboardJson: JSON.stringify(beforeBatch) } });

    const changes = { layout: 'compact' as const, speechSpeed: 1.3, sceneGap: 0.4, subtitles: { preset: 'highlight' as const, fontSize: 44 } };
    const impact = batchImpact(beforeBatch, [0, 2], changes);
    assert.deepEqual(impact.scenes, [0, 2], '预览只包含选中且存在的场景');
    assert.equal(impact.rows.filter(row => row.sceneIndex === 1).length, 0, '没选中的场景不在预览里');
    assert.ok(impact.rows.some(row => row.sceneIndex === 0 && row.field === 'layout'), '预览要逐条说明改什么');
    assert.ok(impact.projectRows.some(row => row.field === 'subtitles.preset'), '字幕样式影响全部场景，单独列出');
    assert.deepEqual(impact.staleAudio, [0, 2], '语速变了的场景要重新配音');
    assert.equal(impact.empty, false);
    assert.deepEqual(batchImpact(beforeBatch, [0, 2], {}).empty, true, '没有改动时预览为空');

    const batchedBoard = applyBatch(beforeBatch, [0, 2], changes);
    await saveStoryboard(batchId, batchedBoard);
    const batchSaved = JSON.parse((await db.project.findUniqueOrThrow({ where: { id: batchId } })).storyboardJson!);
    assert.equal(batchSaved.scenes[0].layout, 'compact');
    assert.equal(batchSaved.scenes[2].layout, 'compact');
    assert.equal(batchSaved.scenes[0].speechSpeed, 1.3);
    assert.equal(batchSaved.scenes[2].sceneGap, 0.4);
    assert.equal(batchSaved.scenes[1].layout, beforeBatch.scenes[1].layout, '没选中的场景版式不动');
    assert.equal(batchSaved.scenes[1].speechSpeed, beforeBatch.scenes[1].speechSpeed, '没选中的场景语速不动');
    assert.equal(batchSaved.scenes[1].audioSrc, 'audio/1.mp3', '没选中的场景保留原配音');
    assert.equal(batchSaved.subtitles.preset, 'highlight', '字幕样式对全部场景生效');
    assert.equal(batchSaved.subtitles.fontSize, 44);
    assert.equal(batchSaved.scenes[0].audioSrc, undefined, '语速变了，旧配音不能再冒充新旁白');
    assert.equal(batchSaved.scenes[0].wordTimings, undefined);
    assert.equal(batchSaved.scenes[0].subtitleCues, undefined, '旧字幕时间是按旧配音对出来的，一并作废');
    assert.equal(batchSaved.scenes[2].subtitleCues, undefined);
    assert.equal(batchSaved.scenes[1].subtitleCues.length, 1, '没改动的场景字幕时间保留');
    assert.equal(batchSaved.scenes[0].narration, beforeBatch.scenes[0].narration, '批量精修不动旁白');
    assert.equal(batchSaved.scenes[0].duration, beforeBatch.scenes[0].duration, '批量精修不动时长');

    // ── 成片播放：Range 拖动进度条不重新下载整段 ──────────────────────
    const videoId = (await db.project.create({ data: { name: '成片播放', sourceText: '正文。'.repeat(20), status: 'awaiting_review' } })).id;
    const videoJob = randomUUID();
    await mkdir(outputDirFor(videoId), { recursive: true });
    await writeFile(join(outputDirFor(videoId), `${videoJob}.mp4`), Buffer.alloc(2048, 7));
    await db.job.create({ data: { id: videoJob, projectId: videoId, kind: 'render', status: 'completed', stage: 'completed', outputPath: `${videoJob}.mp4`, inputJson: '{"preset":"draft"}' } });

    const whole = await downloadVideo(new Request(url(`/api/projects/${videoId}/output?jobId=${videoJob}&inline=1`)), params(videoId));
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    assert.equal(whole.headers.get('content-length'), '2048');
    assert.match(whole.headers.get('content-disposition')!, /^inline;/, '预览用内联播放');
    assert.equal((await whole.arrayBuffer()).byteLength, 2048);

    const part = await downloadVideo(new Request(url(`/api/projects/${videoId}/output?jobId=${videoJob}`), { headers: { range: 'bytes=0-99' } }), params(videoId));
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 0-99/2048');
    assert.equal(part.headers.get('content-length'), '100');
    assert.match(part.headers.get('content-disposition')!, /^attachment;/, '下载仍给出附件名');
    assert.match(part.headers.get('content-disposition')!, /filename\*=UTF-8''/, '中文文件名单独编码');
    assert.equal((await part.arrayBuffer()).byteLength, 100);

    const tail = await downloadVideo(new Request(url(`/api/projects/${videoId}/output?jobId=${videoJob}`), { headers: { range: 'bytes=-64' } }), params(videoId));
    assert.equal(tail.headers.get('content-range'), 'bytes 1984-2047/2048', '拖到末尾按尾部区间返回');

    const beyond = await downloadVideo(new Request(url(`/api/projects/${videoId}/output?jobId=${videoJob}`), { headers: { range: 'bytes=99999-' } }), params(videoId));
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers.get('content-range'), 'bytes */2048');

    const head = await probeVideo(new Request(url(`/api/projects/${videoId}/output?jobId=${videoJob}`)), params(videoId));
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '2048', 'HEAD 不下载内容也能拿到大小');
    assert.equal(await head.text(), '');

    const pendingJob = randomUUID();
    await db.job.create({ data: { id: pendingJob, projectId: videoId, kind: 'render', status: 'running', stage: 'rendering', outputPath: `${pendingJob}.mp4`, inputJson: '{}' } });
    const notReady = await downloadVideo(new Request(url(`/api/projects/${videoId}/output?jobId=${pendingJob}`)), params(videoId));
    assert.equal(notReady.status, 404);
    assert.equal((await body(notReady)).error, '视频尚未渲染完成');
    assert.equal((await probeVideo(new Request(url(`/api/projects/${videoId}/output?jobId=${pendingJob}`)), params(videoId))).status, 404);

    console.log('PASS: 导出前检查把同一个缺失文件合并成一行并列出全部受影响场景、修好后检查通过并从渲染继续、分镜再改后检查作废；手动字幕改时间后成片里的显示时刻立刻跟着变且仍能定位到所属场景；素材清单分清未使用与重复、替换只改选中场景且保留原素材、仍在用的素材不会被归档、恢复与彻底删除都要确认；缺失素材分「文件丢失」与「未登记」两条路径修复后导出检查不再拦缺图；批量精修应用后只改选中场景、字幕样式对全项目生效、旧配音与旧字幕一并作废；制作方案能从项目保存、应用前后一致的项不再报改动、语速变更会清掉旧配音与旧字幕；成片支持 Range 拖动（206/416）与 HEAD 探测。');
  } finally {
    await db.$disconnect();
    process.chdir(repo);
    for (let attempt = 0; attempt < 10; attempt++) {
      try { await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); break; } catch { await new Promise(done => setTimeout(done, 300)); }
    }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
