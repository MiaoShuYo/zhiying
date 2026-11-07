import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

/**
 * V1.6.6 #46 项目级 Brand Kit API 集成测试。
 *
 * 全程在临时目录与临时 SQLite 数据库中运行，不会触碰真实 data/ 与数据库。
 * 覆盖：应用快照 / 库修改不影响项目 / 重新应用刷新 / 切换 / 移除 / 音频与旁白不变 /
 * 项目锁 / 错误码 / revision 与 if-match。
 */
async function main() {
  const repo = process.cwd();
  const sandbox = resolve(repo, 'data', `test-project-brand-kit-${randomUUID()}`);
  await mkdir(join(sandbox, 'apps/web/public/audio'), { recursive: true });
  await mkdir(join(sandbox, 'apps/web/public/projects'), { recursive: true });
  await mkdir(join(sandbox, 'data/settings'), { recursive: true });
  process.env.DATABASE_URL = `file:${join(sandbox, 'test.db').replaceAll('\\', '/')}`;
  const sql = execFileSync(process.execPath, [join(repo, 'apps/web/node_modules/prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', join(repo, 'apps/web/prisma/schema.prisma'), '--script'], { env: process.env, encoding: 'utf8' });
  const database = new DatabaseSync(join(sandbox, 'test.db'));
  database.exec(sql);
  database.close();
  process.chdir(join(sandbox, 'apps/web'));

  const { db } = await import('../src/lib/db');
  const { saveStoryboard } = await import('../src/lib/pipeline');
  const { saveBrandKit, updateBrandKit } = await import('../src/lib/brand-kits');
  const { POST: applyBrandKit, DELETE: removeBrandKit } = await import('../src/app/api/projects/[id]/brand-kit/route');

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const url = (path: string) => `http://localhost${path}`;
  const json = async <T = Record<string, any>>(response: Response) => (await response.json()) as T;
  const post = (data: unknown, headers: Record<string, string> = {}) =>
    new Request(url('/api'), { method: 'POST', body: JSON.stringify(data), headers: { 'content-type': 'application/json', ...headers } });
  const postRaw = (body: string) => new Request(url('/api'), { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  const remove = (headers: Record<string, string> = {}) => new Request(url('/api'), { method: 'DELETE', headers });

  const projectOf = async (id: string) => db.project.findUniqueOrThrow({ where: { id } });
  const boardOf = async (id: string) => JSON.parse((await projectOf(id)).storyboardJson!) as Record<string, any>;
  const jobCount = async (projectId: string) => db.job.count({ where: { projectId } });

  const colorsA = { bg: '#111827', fg: '#f9fafb', muted: '#9ca3af', accent: '#ef4444', card: '#1f2937', secondary: '#374151' };
  const colorsB = { bg: '#f8fafc', fg: '#0f172a', muted: '#64748b', accent: '#2563eb', card: '#ffffff', secondary: '#e2e8f0' };

  try {
    // ── 准备两个 Brand Kit：甲带 Logo（通过 updateBrandKit 追加），乙为另一套风格 ──
    const kitA = await saveBrandKit({
      name: '品牌甲',
      baseStyleId: 'minimal-tech',
      colors: colorsA,
      typography: { headingFont: 'Georgia', bodyFont: 'Georgia' },
    });
    const originalLogoBytes = Buffer.from('project-brand-kit-logo-v1');
    const libraryLogoData = join(sandbox, 'data/settings/brand-kits', kitA.id, 'logo.png');
    const libraryLogoPublic = join(sandbox, 'apps/web/public/brand-kits', kitA.id, 'logo.png');
    await mkdir(join(libraryLogoData, '..'), { recursive: true });
    await mkdir(join(libraryLogoPublic, '..'), { recursive: true });
    await writeFile(libraryLogoData, originalLogoBytes);
    await writeFile(libraryLogoPublic, originalLogoBytes);
    await updateBrandKit(kitA.id, {
      logo: { src: `brand-kits/${kitA.id}/logo.png`, position: 'bottom-right', width: 180, opacity: 0.85, margin: 40, enabled: true },
    });
    const kitB = await saveBrandKit({
      name: '品牌乙',
      baseStyleId: 'academic',
      colors: colorsB,
      typography: { headingFont: 'Inter', bodyFont: 'Noto Sans' },
    });

    // ── 准备一个已经生成分镜的项目；音视频与旁白时间都是后续必须保持不变的内容 ──
    const sceneAudio = {
      speechSpeed: 1.1,
      sentencePause: 0.3,
      audioSrc: 'audio/demo.mp3',
      audioDuration: 3.8,
      audioKey: 'audio-key-demo',
      wordTimings: [{ text: '品牌', start: 0, end: 0.4 }, { text: '快照', start: 0.4, end: 0.9 }],
      subtitleCues: [{ text: '品牌快照', start: 0, end: 1.2 }],
    };
    const scenes = [
      { ...sceneAudio, id: randomUUID(), type: 'title', title: '开场', narration: '品牌只影响视觉，不重新生成内容。', duration: 4, visual: {} },
      { ...sceneAudio, id: randomUUID(), type: 'title', title: '收尾', narration: '旁白、音频和字幕时间保持不变。', duration: 4, visual: {} },
    ];
    const initialBoard = {
      title: '品牌项目',
      styleId: 'clean-light',
      aspectRatio: '16:9',
      scenes,
    };
    const project = await db.project.create({ data: { name: '品牌项目', sourceText: '正文内容。'.repeat(10), status: 'awaiting_review' } });
    await saveStoryboard(project.id, initialBoard);
    const original = await boardOf(project.id);
    let revision: number = (await projectOf(project.id)).revision;
    assert.deepEqual(original.scenes, scenes, '初始分镜按测试数据保存');

    // ── 1. 应用品牌：快照复制、styleId 与场景/音频字段不变 ────────────────
    const applyResponse = await applyBrandKit(post({ brandKitId: kitA.id }), params(project.id));
    assert.equal(applyResponse.status, 200, await applyResponse.clone().text());
    const applied = await json(applyResponse);
    assert.equal(applied.revision, revision + 1, '应用品牌让 revision 递增 1');
    revision = applied.revision;
    assert.equal(applied.storyboard.brandKitId, kitA.id);
    assert.equal(applied.storyboard.styleId, 'clean-light', '品牌不会隐式改写项目 styleId');
    assert.equal(applied.storyboard.brand.name, '品牌甲');
    assert.equal(applied.storyboard.brand.baseStyleId, 'minimal-tech');
    assert.deepEqual(applied.storyboard.brand.colors, colorsA, '调色板被复制');
    assert.deepEqual(applied.storyboard.brand.typography, { headingFont: 'Georgia', bodyFont: 'Georgia' }, '字体被复制');
    assert.equal(applied.storyboard.brand.logo.position, 'bottom-right');
    assert.equal(applied.storyboard.brand.logo.width, 180);
    assert.equal(applied.storyboard.brand.logo.margin, 40);
    assert.equal(applied.storyboard.brand.logo.opacity, 0.85);
    assert.equal(applied.storyboard.brand.logo.enabled, true);
    assert.deepEqual(applied.storyboard.scenes, original.scenes, '应用品牌不改场景内容');
    assert.equal((await projectOf(project.id)).revision, revision, '响应里的 revision 已持久化');

    const logoDigest = createHash('sha256').update(originalLogoBytes).digest('hex');
    const copiedLogo = applied.storyboard.brand.logo.src;
    assert.equal(copiedLogo, `projects/${project.id}/assets/brand-logos/${logoDigest}.png`, '库 Logo 被复制成项目自有路径');
    assert.deepEqual(await readFile(join(sandbox, 'data', copiedLogo)), originalLogoBytes);
    assert.deepEqual(await readFile(join(sandbox, 'apps/web/public', copiedLogo)), originalLogoBytes);
    assert.deepEqual((await boardOf(project.id)).brand.logo.src, copiedLogo);
    assert.equal(await jobCount(project.id), 0, '应用品牌不创建任何 LLM/TTS/渲染任务');

    // ── 2. 修改 Brand Kit Library 后项目快照不变 ─────────────────────────
    const replacementLogoBytes = Buffer.from('project-brand-kit-logo-v2');
    await writeFile(libraryLogoData, replacementLogoBytes);
    await writeFile(libraryLogoPublic, replacementLogoBytes);
    await updateBrandKit(kitA.id, { colors: { accent: '#00ff00' }, typography: { headingFont: 'Updated Heading' } });
    const afterLibraryEdit = await boardOf(project.id);
    assert.deepEqual(afterLibraryEdit.brand.colors, colorsA, '库修改不会穿透到已保存快照');
    assert.equal(afterLibraryEdit.brand.typography.headingFont, 'Georgia');
    assert.equal(afterLibraryEdit.brand.logo.src, copiedLogo);
    assert.deepEqual(await readFile(join(sandbox, 'data', copiedLogo)), originalLogoBytes, '项目 Logo 是独立副本');
    assert.equal((await projectOf(project.id)).revision, revision, '库修改不动项目 revision');

    // ── 3. 再次 POST 同一个 kit：刷新快照（颜色/字体/Logo）─────────────────
    const reapplyResponse = await applyBrandKit(post({ brandKitId: kitA.id }), params(project.id));
    assert.equal(reapplyResponse.status, 200, await reapplyResponse.clone().text());
    const reapplied = await json(reapplyResponse);
    assert.equal(reapplied.revision, revision + 1);
    revision = reapplied.revision;
    assert.equal(reapplied.storyboard.brandKitId, kitA.id);
    assert.equal(reapplied.storyboard.brand.colors.accent, '#00ff00', '重新应用取到库里的最新颜色');
    assert.equal(reapplied.storyboard.brand.typography.headingFont, 'Updated Heading');
    assert.equal(reapplied.storyboard.brand.typography.bodyFont, 'Georgia');
    const refreshedDigest = createHash('sha256').update(replacementLogoBytes).digest('hex');
    assert.equal(reapplied.storyboard.brand.logo.src, `projects/${project.id}/assets/brand-logos/${refreshedDigest}.png`, '重新应用刷新 Logo 副本');
    assert.deepEqual(await readFile(join(sandbox, 'data', reapplied.storyboard.brand.logo.src)), replacementLogoBytes);
    assert.equal(reapplied.storyboard.styleId, 'clean-light');
    assert.deepEqual(reapplied.storyboard.scenes, original.scenes);

    // ── 4. 切换到第二个 Brand Kit ────────────────────────────────────────
    const switchedResponse = await applyBrandKit(post({ brandKitId: kitB.id }), params(project.id));
    assert.equal(switchedResponse.status, 200, await switchedResponse.clone().text());
    const switched = await json(switchedResponse);
    assert.equal(switched.revision, revision + 1);
    revision = switched.revision;
    assert.equal(switched.storyboard.brandKitId, kitB.id);
    assert.equal(switched.storyboard.brand.baseStyleId, 'academic');
    assert.deepEqual(switched.storyboard.brand.colors, colorsB);
    assert.deepEqual(switched.storyboard.brand.typography, { headingFont: 'Inter', bodyFont: 'Noto Sans' });
    assert.equal(switched.storyboard.brand.logo, undefined, '乙没有 Logo，旧快照的 Logo 一起被替换');
    assert.equal(switched.storyboard.styleId, 'clean-light');
    assert.deepEqual(switched.storyboard.scenes, original.scenes);

    // ── 5/6. DELETE 清空品牌，音频/旁白/时间完全不变 ──────────────────────
    const removeResponse = await removeBrandKit(remove(), params(project.id));
    assert.equal(removeResponse.status, 200, await removeResponse.clone().text());
    const removed = await json(removeResponse);
    assert.equal(removed.revision, revision + 1);
    revision = removed.revision;
    assert.equal(removed.storyboard.brandKitId, undefined);
    assert.equal(removed.storyboard.brand, undefined);
    assert.equal('brand' in removed.storyboard, false);
    assert.equal('brandKitId' in removed.storyboard, false);
    assert.equal(removed.storyboard.styleId, 'clean-light', '移除品牌后回到项目自身 styleId');
    assert.deepEqual(removed.storyboard.scenes, original.scenes, '音视频、旁白、字幕时间完全不变');
    for (const scene of removed.storyboard.scenes) {
      assert.equal(scene.audioSrc, sceneAudio.audioSrc);
      assert.equal(scene.audioDuration, sceneAudio.audioDuration);
      assert.equal(scene.audioKey, sceneAudio.audioKey);
      assert.deepEqual(scene.wordTimings, sceneAudio.wordTimings);
      assert.deepEqual(scene.subtitleCues, sceneAudio.subtitleCues);
      assert.equal(scene.speechSpeed, sceneAudio.speechSpeed);
      assert.equal(scene.sentencePause, sceneAudio.sentencePause);
    }
    const persistedAfterDelete = await boardOf(project.id);
    assert.equal('brand' in persistedAfterDelete, false);
    assert.equal(await jobCount(project.id), 0, '应用/重新应用/切换/移除都不创建任务');

    // 再次 DELETE：已无品牌时幂等成功且不涨 revision。
    const removeAgain = await removeBrandKit(remove(), params(project.id));
    assert.equal(removeAgain.status, 200);
    const removeAgainBody = await json(removeAgain);
    assert.equal(removeAgainBody.revision, revision, '无品牌时 DELETE 不递增 revision');
    assert.deepEqual(removeAgainBody.storyboard, removed.storyboard);
    assert.equal((await projectOf(project.id)).revision, revision);

    // ── 8. 不存在 Brand Kit / 项目返回 404 ──────────────────────────────
    const missingKit = await applyBrandKit(post({ brandKitId: randomUUID() }), params(project.id));
    assert.equal(missingKit.status, 404, await missingKit.clone().text());
    assert.ok((await json(missingKit)).error.includes('Brand Kit'));
    assert.equal((await projectOf(project.id)).revision, revision, '404 不写项目');
    const missingProject = await applyBrandKit(post({ brandKitId: kitA.id }), params(randomUUID()));
    assert.equal(missingProject.status, 404);
    assert.equal((await json(missingProject)).error, '项目不存在');

    // ── 7. 项目锁时 POST / DELETE 都被拒绝且项目不变 ────────────────────
    const lockJob = await db.job.create({ data: { projectId: project.id, kind: 'render', status: 'running', stage: 'rendering' } });
    const lockedPost = await applyBrandKit(post({ brandKitId: kitB.id }), params(project.id));
    assert.equal(lockedPost.status, 409, await lockedPost.clone().text());
    assert.ok((await json(lockedPost)).error.includes('项目正在执行'));
    const lockedDelete = await removeBrandKit(remove(), params(project.id));
    assert.equal(lockedDelete.status, 409);
    assert.deepEqual(await boardOf(project.id), persistedAfterDelete, '锁定期间 storyboard 不被修改');
    assert.equal((await projectOf(project.id)).revision, revision, '锁定期间 revision 不变');
    await db.job.delete({ where: { id: lockJob.id } });

    // ── 9. revision / if-match：不匹配 409、匹配成功（header 与 body.revision）──
    const viaBodyRevision = await applyBrandKit(post({ brandKitId: kitA.id, revision }), params(project.id));
    assert.equal(viaBodyRevision.status, 200, 'body.revision 作为 compare-and-swap');
    const viaBody = await json(viaBodyRevision);
    assert.equal(viaBody.revision, revision + 1);
    revision = viaBody.revision;
    assert.equal(viaBody.storyboard.brandKitId, kitA.id);
    assert.deepEqual(viaBody.storyboard.scenes, original.scenes);

    const staleHeader = await applyBrandKit(post({ brandKitId: kitB.id }, { 'if-match': String(revision - 1) }), params(project.id));
    assert.equal(staleHeader.status, 409, await staleHeader.clone().text());
    assert.ok((await json(staleHeader)).error.startsWith('保存冲突'));
    assert.equal((await projectOf(project.id)).revision, revision, '冲突不写入');

    const matchingHeader = await applyBrandKit(post({ brandKitId: kitB.id }, { 'if-match': String(revision) }), params(project.id));
    assert.equal(matchingHeader.status, 200, await matchingHeader.clone().text());
    const matched = await json(matchingHeader);
    assert.equal(matched.revision, revision + 1);
    revision = matched.revision;
    assert.equal(matched.storyboard.brandKitId, kitB.id);

    const staleDelete = await removeBrandKit(remove({ 'if-match': '0' }), params(project.id));
    assert.equal(staleDelete.status, 409, await staleDelete.clone().text());
    assert.equal((await projectOf(project.id)).revision, revision);
    const guardedDelete = await removeBrandKit(remove({ 'if-match': String(revision) }), params(project.id));
    assert.equal(guardedDelete.status, 200, await guardedDelete.clone().text());
    revision = (await json(guardedDelete)).revision;
    assert.equal(revision, matched.revision + 1);
    assert.equal('brand' in (await boardOf(project.id)), false);

    // ── 无效请求体 400 ──────────────────────────────────────────────────
    const invalidRequests: { name: string; response: Response }[] = [];
    invalidRequests.push({ name: 'missing brandKitId', response: await applyBrandKit(post({}), params(project.id)) });
    invalidRequests.push({ name: 'blank brandKitId', response: await applyBrandKit(post({ brandKitId: '   ' }), params(project.id)) });
    invalidRequests.push({ name: 'malformed JSON', response: await applyBrandKit(postRaw('{ not json'), params(project.id)) });
    invalidRequests.push({ name: 'array body', response: await applyBrandKit(postRaw('[]'), params(project.id)) });
    invalidRequests.push({ name: 'negative revision', response: await applyBrandKit(post({ brandKitId: kitA.id, revision: -1 }), params(project.id)) });
    invalidRequests.push({ name: 'invalid if-match', response: await applyBrandKit(post({ brandKitId: kitA.id }, { 'if-match': 'abc' }), params(project.id)) });
    for (const entry of invalidRequests) {
      assert.equal(entry.response.status, 400, `${entry.name} 返回 400：${await entry.response.clone().text()}`);
      assert.ok((await json(entry.response)).error, `${entry.name} 带错误信息`);
    }
    assert.equal((await projectOf(project.id)).revision, revision, '无效请求不写项目');

    // ── 缺失 storyboard 400 ─────────────────────────────────────────────
    const emptyProject = await db.project.create({ data: { name: '没有分镜的项目', sourceText: '正文。', status: 'awaiting_review' } });
    const noStoryboard = await applyBrandKit(post({ brandKitId: kitA.id }), params(emptyProject.id));
    assert.equal(noStoryboard.status, 400, await noStoryboard.clone().text());
    assert.ok((await json(noStoryboard)).error.includes('分镜'));
    const noStoryboardDelete = await removeBrandKit(remove(), params(emptyProject.id));
    assert.equal(noStoryboardDelete.status, 400);

    // ── 损坏的 Brand Kit 存储：500 且项目不变 ───────────────────────────
    const storePath = join(sandbox, 'data/settings/brand-kits.json');
    const projectSnapshotBeforeCorruption = (await projectOf(project.id)).storyboardJson;
    await writeFile(storePath, '{ this is not valid json');
    const corruptJson = await applyBrandKit(post({ brandKitId: kitA.id }), params(project.id));
    assert.equal(corruptJson.status, 500, await corruptJson.clone().text());
    assert.ok((await json(corruptJson)).error.includes('Brand Kit 存储'));
    assert.equal((await projectOf(project.id)).storyboardJson, projectSnapshotBeforeCorruption, '损坏存储时不写项目');
    assert.equal((await projectOf(project.id)).revision, revision);

    await writeFile(storePath, JSON.stringify([{ id: 'broken-kit' }]));
    const corruptSchema = await applyBrandKit(post({ brandKitId: kitA.id }), params(project.id));
    assert.equal(corruptSchema.status, 500, await corruptSchema.clone().text());
    assert.ok((await json(corruptSchema)).error.includes('Brand Kit 存储数据无效'));
    assert.equal((await projectOf(project.id)).storyboardJson, projectSnapshotBeforeCorruption);
    assert.equal((await projectOf(project.id)).revision, revision);

    console.log('PASS: project Brand Kit apply/reapply/switch/remove API copies snapshots without touching styleId, scenes, audio, narration, timings, jobs or revision semantics');
  } finally {
    await db.$disconnect();
    // Windows refuses to delete a directory that is still the process cwd.
    process.chdir(repo);
    // Cleanup is best-effort: a lingering Windows file handle must not turn a passing test red.
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(error => {
      console.warn(`[cleanup] temporary sandbox kept: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
