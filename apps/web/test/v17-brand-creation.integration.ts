import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { StoryboardSchema } from '@m2v/schema';

/**
 * V1.6.7 #48 新建项目 pending 品牌注入集成测试。
 *
 * 创建项目时还没有 Storyboard：brandKitId 写入 data/projects/<id>/import-settings.json，
 * runProject 首次构造 storyboard 时复制品牌快照与 Logo，成功落库后清除 pending。
 * 全程在临时目录 + 临时 SQLite 中运行，不接触真实 data/ 或数据库。
 */
async function main() {
  const repo = process.cwd();
  const sandbox = resolve(repo, 'data', `test-v17-brand-${randomUUID()}`);
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
  const { createProject } = await import('../src/lib/pipeline');
  const { saveBrandKit, updateBrandKit } = await import('../src/lib/brand-kits');
  const {
    applyPendingBrandSnapshot,
    consumePendingBrandKitId,
    parseImportSettings,
    pendingBrandForProject,
    readImportSettings,
    snapshotFromBrandKit,
    writeImportSettings,
  } = await import('../src/lib/brand-kit-pending');

  const colors = { bg: '#111827', fg: '#f9fafb', muted: '#9ca3af', accent: '#ef4444', card: '#1f2937', secondary: '#374151' };
  const text = '这是一段用于品牌注入集成测试的正文内容。'.repeat(20);
  const projectRow = (id: string) => db.project.findUniqueOrThrow({ where: { id } });

  function boardOf(title: string): ReturnType<typeof StoryboardSchema.parse> {
    return StoryboardSchema.parse({
      title,
      styleId: 'clean-light',
      aspectRatio: '16:9',
      scenes: [{ id: randomUUID(), type: 'title', title: '开场', narration: '品牌快照只影响视觉，不重新生成内容。', duration: 4, visual: {} }],
    });
  }

  try {
    // ── 准备带 Logo 的品牌套件（Logo 文件同时写在 data 与 public 镜像目录）──
    const kit = await saveBrandKit({
      name: 'ACME Corporate',
      baseStyleId: 'minimal-tech',
      colors,
      typography: { headingFont: 'Georgia', bodyFont: 'Georgia' },
    });
    const logoBytes = Buffer.from('v17-brand-logo-bytes');
    const libraryDataLogo = join(sandbox, 'data/settings/brand-kits', kit.id, 'logo.png');
    const libraryPublicLogo = join(sandbox, 'apps/web/public/brand-kits', kit.id, 'logo.png');
    await mkdir(join(libraryDataLogo, '..'), { recursive: true });
    await mkdir(join(libraryPublicLogo, '..'), { recursive: true });
    await writeFile(libraryDataLogo, logoBytes);
    await writeFile(libraryPublicLogo, logoBytes);
    await updateBrandKit(kit.id, {
      logo: { src: `brand-kits/${kit.id}/logo.png`, position: 'bottom-right', width: 180, opacity: 0.9, margin: 32, enabled: true },
    });

    // ── 1. 创建项目时持久化 pending brandKitId，且不改变项目 styleId ──────
    const project = await createProject({ name: '品牌新项目', text, styleId: 'clean-light', file: null, brandKitId: kit.id });
    const created = await projectRow(project.id);
    assert.equal(created.styleId, 'clean-light', '品牌选择不会替换项目 Style');
    const settings = await readImportSettings(project.id);
    assert.equal(settings.brandKitId, kit.id, '品牌选择持久化到 import-settings.json');
    assert.equal(settings.generationMode, 'standard');
    assert.equal(settings.preferLocalAI, undefined);

    // ── 2. 首次构造 storyboard 时复制快照与 Logo，且不动场景/音频 ─────────
    const baseBoard = boardOf('品牌新项目');
    const injected = await applyPendingBrandSnapshot(project.id, baseBoard);
    assert.equal(injected.brandKitId, kit.id);
    assert.equal(injected.brand?.name, 'ACME Corporate');
    assert.equal(injected.brand?.baseStyleId, 'minimal-tech');
    assert.deepEqual(injected.brand?.colors, colors, '六色调色板被复制');
    assert.deepEqual(injected.brand?.typography, { headingFont: 'Georgia', bodyFont: 'Georgia' }, '字体被复制');
    assert.equal(injected.brand?.logo?.position, 'bottom-right');
    assert.equal(injected.brand?.logo?.width, 180);
    assert.equal(injected.brand?.logo?.margin, 32);
    assert.equal(injected.brand?.logo?.opacity, 0.9);
    assert.equal(injected.styleId, 'clean-light', '品牌不改项目 styleId');
    assert.deepEqual(injected.scenes, baseBoard.scenes, '品牌不改场景内容/旁白/时长');

    const digest = createHash('sha256').update(logoBytes).digest('hex');
    const expectedLogo = `projects/${project.id}/assets/brand-logos/${digest}.png`;
    assert.equal(injected.brand?.logo?.src, expectedLogo, 'Logo 复制为项目自有路径');
    assert.deepEqual(await readFile(join(sandbox, 'data', expectedLogo)), logoBytes, 'data 目录保存 Logo 副本');
    assert.deepEqual(await readFile(join(sandbox, 'apps/web/public', expectedLogo)), logoBytes, 'public 目录保存 Logo 副本');
    assert.equal(await db.job.count({ where: { projectId: project.id } }), 1, '只创建创建流程原有的 storyboard 任务，没有额外 LLM/TTS 任务');

    // ── 3. pending 在落库前保留；消费后只移除 brandKitId ──────────────────
    assert.equal((await pendingBrandForProject(project.id))?.brandKitId, kit.id, '未消费前 pending 仍然存在');
    assert.equal(await consumePendingBrandKitId(project.id), true, '首次落库后消费 pending');
    const afterConsume = await readImportSettings(project.id);
    assert.equal(afterConsume.brandKitId, undefined);
    assert.equal(afterConsume.generationMode, 'standard', '消费 pending 不丢 import 设置');
    assert.equal(await consumePendingBrandKitId(project.id), false, '重复消费是幂等的');
    assert.equal((await projectRow(project.id)).revision, 0, 'pending 品牌注入本身不写项目 revision');

    // ── 4. 品牌库来源被删除：选择被忽略，项目仍能生成 ────────────────────
    const staleProject = await createProject({ name: '过期品牌项目', text, styleId: 'minimal-tech', file: null, brandKitId: kit.id });
    await writeImportSettings(staleProject.id, { preferLocalAI: true, generationMode: 'html', brandKitId: 'deleted-kit-id' });
    const staleBoard = boardOf('过期品牌项目');
    const staleInjected = await applyPendingBrandSnapshot(staleProject.id, staleBoard);
    assert.equal(staleInjected.brandKitId, undefined, '已删除的品牌库条目不写入快照');
    assert.equal(staleInjected.brand, undefined);
    assert.deepEqual(staleInjected.scenes, staleBoard.scenes);

    // 创建时传入已不存在的品牌 ID 也不会失败或残留 pending。
    const deletedCreation = await createProject({ name: '品牌已删除项目', text, styleId: 'minimal-tech', file: null, brandKitId: 'no-such-kit' });
    assert.equal((await readImportSettings(deletedCreation.id)).brandKitId, undefined, '创建时不接受不存在的品牌 ID');

    // ── 5. Logo 文件缺失：保留品牌快照但移除不可用 Logo，不让分镜失败 ─────
    await rm(libraryDataLogo, { force: true });
    await rm(libraryPublicLogo, { force: true });
    const missingLogoProject = await createProject({ name: '缺 Logo 项目', text, styleId: 'minimal-tech', file: null, brandKitId: kit.id });
    const missingLogoBoard = await applyPendingBrandSnapshot(missingLogoProject.id, boardOf('缺 Logo 项目'));
    assert.equal(missingLogoBoard.brandKitId, kit.id, 'Logo 缺失不丢整个品牌选择');
    assert.equal(missingLogoBoard.brand?.name, 'ACME Corporate');
    assert.equal(missingLogoBoard.brand?.logo, undefined, '无法复制的 Logo 不进入快照');

    // ── 6. 无品牌项目：pending 注入是 no-op ───────────────────────────────
    const plainProject = await createProject({ name: '无品牌项目', text, styleId: 'academic', file: null });
    assert.equal((await readImportSettings(plainProject.id)).brandKitId, undefined);
    const plainBoard = boardOf('无品牌项目');
    const plainInjected = await applyPendingBrandSnapshot(plainProject.id, plainBoard);
    assert.deepEqual(plainInjected, plainBoard, '无品牌项目完全不受影响');

    // ── 7. parseImportSettings：只接受已知字段、容忍损坏内容 ───────────────
    assert.deepEqual(parseImportSettings(null), {});
    assert.deepEqual(parseImportSettings('not-an-object'), {});
    assert.deepEqual(parseImportSettings({ brandKitId: '  kit-x  ', generationMode: 'html', preferLocalAI: true, extra: 1 }), { preferLocalAI: true, generationMode: 'html', brandKitId: 'kit-x' });
    assert.deepEqual(parseImportSettings({ brandKitId: 42, generationMode: 'bogus' }), {});
    const snapshot = snapshotFromBrandKit({ ...kit, name: '快照品牌', logo: undefined, isDefault: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(snapshot.name, '快照品牌');
    assert.equal('id' in snapshot, false, '快照不包含品牌库 ID 字段');
    assert.equal('isDefault' in snapshot, false, '快照不包含默认标记');

    console.log('PASS: 新建项目 pending 品牌持久化、首次 storyboard 快照/Logo 注入、消费、来源删除与缺 Logo 兜底均通过。');
  } finally {
    await db.$disconnect();
    process.chdir(repo);
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(error => {
      console.warn(`[cleanup] temporary sandbox kept: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
