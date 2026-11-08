import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

/**
 * V1.6.7 #48 已有项目切换/重新应用/移除品牌的集成测试（tester 独立测试）。
 *
 * 重点覆盖：切换只改视觉快照，不动 narration / audio / timings / styleId，
 * 不创建 LLM/TTS 任务；锁定项目 409；来源套件被删除后项目仍可打开。
 */

async function main() {
  const repo = process.cwd();
  const sandbox = resolve(repo, 'data', `test-v17-brand-project-${randomUUID()}`);
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
  const { saveStoryboard, parseProject } = await import('../src/lib/pipeline');
  const { saveBrandKit, updateBrandKit, deleteBrandKit } = await import('../src/lib/brand-kits');
  const { POST: applyBrandKit, DELETE: removeBrandKit } = await import('../src/app/api/projects/[id]/brand-kit/route');
  const { GET: openProject } = await import('../src/app/api/projects/[id]/route');

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const json = async <T = Record<string, any>>(response: Response) => (await response.json()) as T;
  const post = (body: unknown, headers: Record<string, string> = {}) => new Request('http://localhost/api/projects/p/brand-kit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const remove = (headers: Record<string, string> = {}) => new Request('http://localhost/api/projects/p/brand-kit', { method: 'DELETE', headers });
  const projectOf = (id: string) => db.project.findUniqueOrThrow({ where: { id } });
  const boardOf = async (id: string) => JSON.parse((await projectOf(id)).storyboardJson!);
  const jobCount = (projectId: string) => db.job.count({ where: { projectId } });

  const colorsA = { bg: '#111827', fg: '#f9fafb', muted: '#9ca3af', accent: '#ef4444', card: '#1f2937', secondary: '#374151' };
  const colorsB = { bg: '#f8fafc', fg: '#0f172a', muted: '#64748b', accent: '#2563eb', card: '#ffffff', secondary: '#e2e8f0' };

  try {
    // ── 准备两个品牌库条目；甲带 Logo ─────────────────────────────────────
    const kitA = await saveBrandKit({ name: 'ACME Corporate', baseStyleId: 'minimal-tech', colors: colorsA, typography: { headingFont: 'Georgia', bodyFont: 'Georgia' } });
    const logoBytes = Buffer.from('v17-project-brand-logo-v1');
    const libraryDataLogo = join(sandbox, 'data/settings/brand-kits', kitA.id, 'logo.png');
    const libraryPublicLogo = join(sandbox, 'apps/web/public/brand-kits', kitA.id, 'logo.png');
    await mkdir(join(libraryDataLogo, '..'), { recursive: true });
    await mkdir(join(libraryPublicLogo, '..'), { recursive: true });
    await writeFile(libraryDataLogo, logoBytes);
    await writeFile(libraryPublicLogo, logoBytes);
    await updateBrandKit(kitA.id, { logo: { src: `brand-kits/${kitA.id}/logo.png`, position: 'bottom-right', width: 180, opacity: 0.85, margin: 40, enabled: true } });
    const kitB = await saveBrandKit({ name: '品牌乙', baseStyleId: 'academic', colors: colorsB, typography: { headingFont: 'Inter', bodyFont: 'Noto Sans' } });

    // ── 准备已生成分镜的项目：音视频/旁白/时间都必须保持不变 ──────────────
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
    const initialBoard = { title: '品牌项目', styleId: 'clean-light', aspectRatio: '16:9', scenes };
    const project = await db.project.create({ data: { name: '品牌项目', sourceText: '正文内容。'.repeat(10), status: 'awaiting_review' } });
    await saveStoryboard(project.id, initialBoard);
    const original = await boardOf(project.id);
    let revision: number = (await projectOf(project.id)).revision;

    // 品牌变更不允许触发任何网络请求（LLM/TTS）；任何 fetch 都直接判失败。
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (async () => { networkCalls += 1; throw new Error('品牌切换不应发起网络请求'); }) as typeof fetch;
    try {
      // ── 1. 已有项目切换品牌（#48-4）─────────────────────────────────────
      const applyResponse = await applyBrandKit(post({ brandKitId: kitA.id }), params(project.id));
      assert.equal(applyResponse.status, 200, await applyResponse.clone().text());
      const applied = await json(applyResponse);
      assert.equal(applied.revision, revision + 1);
      revision = applied.revision;
      assert.equal(applied.storyboard.brandKitId, kitA.id, '切换后 brandKitId 指向新品牌');
      assert.equal(applied.storyboard.brand.name, 'ACME Corporate');
      assert.deepEqual(applied.storyboard.brand.colors, colorsA);
      assert.deepEqual(applied.storyboard.brand.typography, { headingFont: 'Georgia', bodyFont: 'Georgia' });
      assert.equal(applied.storyboard.brand.logo.position, 'bottom-right');
      assert.equal(applied.storyboard.brand.logo.width, 180);
      assert.equal(applied.storyboard.brand.logo.margin, 40);
      assert.equal(applied.storyboard.brand.logo.opacity, 0.85);
      const logoDigest = createHash('sha256').update(logoBytes).digest('hex');
      const projectLogo = `projects/${project.id}/assets/brand-logos/${logoDigest}.png`;
      assert.equal(applied.storyboard.brand.logo.src, projectLogo, 'Logo 复制为项目自有路径');
      assert.deepEqual(await readFile(join(sandbox, 'data', projectLogo)), logoBytes);

      // ── 2. 切换不改 narration/audio/timings/styleId（#48-8）──────────────
      assert.equal(applied.storyboard.styleId, 'clean-light', '品牌不隐式改写项目 styleId');
      assert.deepEqual(applied.storyboard.scenes, original.scenes, '品牌变更不动场景内容');
      for (const scene of applied.storyboard.scenes) {
        assert.equal(scene.speechSpeed, sceneAudio.speechSpeed);
        assert.equal(scene.sentencePause, sceneAudio.sentencePause);
        assert.equal(scene.audioSrc, sceneAudio.audioSrc);
        assert.equal(scene.audioDuration, sceneAudio.audioDuration);
        assert.equal(scene.audioKey, sceneAudio.audioKey);
        assert.deepEqual(scene.wordTimings, sceneAudio.wordTimings);
        assert.deepEqual(scene.subtitleCues, sceneAudio.subtitleCues);
      }
      assert.equal(await jobCount(project.id), 0, '切换品牌不创建 LLM/TTS/渲染任务');
      assert.equal(networkCalls, 0, '切换品牌不发起网络请求');

      // ── 3. 库修改不穿透；重新应用同一品牌才刷新快照（#48-5）─────────────
      const replacementLogo = Buffer.from('v17-project-brand-logo-v2');
      await writeFile(libraryDataLogo, replacementLogo);
      await writeFile(libraryPublicLogo, replacementLogo);
      await updateBrandKit(kitA.id, { colors: { accent: '#00ff66' }, typography: { headingFont: 'Updated Heading' } });
      const afterLibraryEdit = await boardOf(project.id);
      assert.deepEqual(afterLibraryEdit.brand.colors, colorsA, '品牌库修改不自动影响旧项目快照');
      assert.equal(afterLibraryEdit.brand.typography.headingFont, 'Georgia');
      assert.equal(afterLibraryEdit.brand.logo.src, projectLogo);

      const reapplyResponse = await applyBrandKit(post({ brandKitId: kitA.id }), params(project.id));
      assert.equal(reapplyResponse.status, 200, await reapplyResponse.clone().text());
      const reapplied = await json(reapplyResponse);
      assert.equal(reapplied.revision, revision + 1);
      revision = reapplied.revision;
      assert.equal(reapplied.storyboard.brand.colors.accent, '#00ff66', '重新应用取到品牌库最新颜色');
      assert.equal(reapplied.storyboard.brand.typography.headingFont, 'Updated Heading');
      assert.equal(reapplied.storyboard.brand.typography.bodyFont, 'Georgia');
      const refreshedDigest = createHash('sha256').update(replacementLogo).digest('hex');
      assert.equal(reapplied.storyboard.brand.logo.src, `projects/${project.id}/assets/brand-logos/${refreshedDigest}.png`, '重新应用刷新 Logo 副本');
      assert.deepEqual(reapplied.storyboard.scenes, original.scenes);
      assert.equal(reapplied.storyboard.styleId, 'clean-light');
      assert.equal(await jobCount(project.id), 0);
      assert.equal(networkCalls, 0);

      // ── 4. 移除品牌（#48-6）─────────────────────────────────────────────
      const removeResponse = await removeBrandKit(remove(), params(project.id));
      assert.equal(removeResponse.status, 200, await removeResponse.clone().text());
      const removed = await json(removeResponse);
      assert.equal(removed.revision, revision + 1);
      revision = removed.revision;
      assert.equal('brand' in removed.storyboard, false, '移除后没有 brand 快照');
      assert.equal('brandKitId' in removed.storyboard, false);
      assert.equal(removed.storyboard.styleId, 'clean-light', '移除后回到项目自身 Style');
      assert.deepEqual(removed.storyboard.scenes, original.scenes, '移除不动场景/旁白/音频/时间');
      assert.equal(await jobCount(project.id), 0);
      assert.equal(networkCalls, 0);

      // ── 5. 锁定项目：按钮对应 API 拒绝且项目不变（#48-9）────────────────
      await applyBrandKit(post({ brandKitId: kitB.id }), params(project.id));
      revision = (await projectOf(project.id)).revision;
      const boardBeforeLock = await boardOf(project.id);
      const lockJob = await db.job.create({ data: { projectId: project.id, kind: 'render', status: 'running', stage: 'rendering' } });
      const lockedPost = await applyBrandKit(post({ brandKitId: kitA.id }), params(project.id));
      assert.equal(lockedPost.status, 409, '锁定项目时切换品牌被拒绝');
      assert.match((await json(lockedPost)).error, /项目正在执行/, '返回可展示的锁定原因');
      const lockedDelete = await removeBrandKit(remove(), params(project.id));
      assert.equal(lockedDelete.status, 409, '锁定项目时移除品牌被拒绝');
      assert.deepEqual(await boardOf(project.id), boardBeforeLock, '锁定期间 storyboard 不变');
      assert.equal((await projectOf(project.id)).revision, revision, '锁定期间 revision 不变');
      await db.job.delete({ where: { id: lockJob.id } });

      // if-match 过期仍然返回可展示的保存冲突。
      const stale = await applyBrandKit(post({ brandKitId: kitA.id }, { 'if-match': String(revision - 1) }), params(project.id));
      assert.equal(stale.status, 409);
      assert.match((await json(stale)).error, /保存冲突/);
      assert.equal((await projectOf(project.id)).revision, revision);

      // ── 6. 来源套件被删除后项目仍可打开（#48-7）─────────────────────────
      await deleteBrandKit(kitB.id);
      await db.project.update({ where: { id: project.id }, data: { status: 'failed' } });
      const opened = await openProject(new Request(`http://localhost/api/projects/${project.id}`), params(project.id));
      assert.equal(opened.status, 200, '来源套件删除后项目仍可打开');
      const openedBody = await json(opened);
      assert.equal(openedBody.storyboard.brand.name, '品牌乙', '仍显示保存时的品牌快照');
      assert.equal(openedBody.storyboard.brandKitId, kitB.id, 'brandKitId 保留用于提示来源已删除');
      assert.equal(openedBody.storyboard.styleId, 'clean-light');
      assert.deepEqual(openedBody.storyboard.scenes.map((scene: any) => scene.id), original.scenes.map((scene: any) => scene.id), '分镜完好');
      const parsed = parseProject(await db.project.findUniqueOrThrow({ where: { id: project.id }, include: { scenes: true } }));
      assert.ok(parsed.storyboard, '项目数据可解析（编辑器可打开）');
      assert.equal(parsed.storyboard.brand?.name, '品牌乙');

      // 来源删除后仍可“换成其它品牌”（无需重新应用即可继续编辑）。
      const switchAfterStale = await applyBrandKit(post({ brandKitId: kitA.id }), params(project.id));
      assert.equal(switchAfterStale.status, 200, '来源删除后仍允许切换为存在的品牌');
      assert.equal((await json(switchAfterStale)).storyboard.brandKitId, kitA.id);
      assert.equal(networkCalls, 0, '所有品牌操作均未触发 LLM/TTS 网络请求');
    } finally {
      globalThis.fetch = originalFetch;
    }

    console.log('PASS: #48 已有项目切换/重新应用/移除品牌不改 narration/audio/timings/styleId、零网络请求、锁定 409、来源删除后项目仍可打开。');
  } finally {
    await db.$disconnect();
    process.chdir(repo);
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(error => {
      console.warn(`[cleanup] temporary sandbox kept: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
