import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

/**
 * V1.6.7 #48 新建项目品牌选择的端到端测试（tester 独立测试）。
 *
 * 不用真实 LLM：mock `globalThis.fetch` 只响应 Ollama /api/chat，验证
 * `createProject(brandKitId)` → `processProject(storyboarding)` 全链路里
 * storyboard 首次落库就带上正确品牌快照，且 pending 只消费一次。
 */

async function main() {
  const repo = process.cwd();
  const sandbox = resolve(repo, 'data', `test-v17-brand-pending-${randomUUID()}`);
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
  const { createProject, processProject } = await import('../src/lib/pipeline');
  const { saveBrandKit, updateBrandKit } = await import('../src/lib/brand-kits');
  const { readImportSettings } = await import('../src/lib/brand-kit-pending');

  const colors = { bg: '#111827', fg: '#f9fafb', muted: '#9ca3af', accent: '#ef4444', card: '#1f2937', secondary: '#374151' };
  const sourceText = '这是一段用于品牌注入端到端测试的正文内容。'.repeat(8);
  const projectOf = (id: string) => db.project.findUniqueOrThrow({ where: { id } });
  const boardOf = async (id: string) => JSON.parse((await projectOf(id)).storyboardJson!);

  /** Only the storyboard LLM endpoint may be fetched; any other network call fails the test. */
  function mockOllama(register: (chapter: { title: string; content: string }) => void) {
    const original = globalThis.fetch;
    const chatCalls: { chapters: number }[] = [];
    globalThis.fetch = (async (input: any, init: any) => {
      const url = String(input);
      if (!url.includes('/api/chat')) throw new Error(`品牌相关流程不应发起额外网络请求：${url}`);
      const payload = JSON.parse(String(init.body));
      const prompt = String(payload.messages[0].content);
      const chapters = JSON.parse(prompt.split('章节资料：')[1].split('\n/no_think')[0]) as { title: string; content: string }[];
      chatCalls.push({ chapters: chapters.length });
      const scenes = chapters.map(chapter => {
        register(chapter);
        return { id: 'model-repeated-id', type: 'title', title: chapter.title, narration: chapter.content };
      });
      return Response.json({ message: { content: JSON.stringify({ scenes }) } });
    }) as typeof fetch;
    return { chatCalls, restore: () => { globalThis.fetch = original; } };
  }

  try {
    // ── 准备一个带 Logo 的品牌库条目（Logo 同时写入 data 与 public 镜像）──
    const kit = await saveBrandKit({
      name: 'ACME Corporate',
      baseStyleId: 'minimal-tech',
      colors,
      typography: { headingFont: 'Georgia', bodyFont: 'Georgia' },
    });
    const logoBytes = Buffer.from('v17-pending-brand-logo-bytes');
    const libraryDataLogo = join(sandbox, 'data/settings/brand-kits', kit.id, 'logo.png');
    const libraryPublicLogo = join(sandbox, 'apps/web/public/brand-kits', kit.id, 'logo.png');
    await mkdir(join(libraryDataLogo, '..'), { recursive: true });
    await mkdir(join(libraryPublicLogo, '..'), { recursive: true });
    await writeFile(libraryDataLogo, logoBytes);
    await writeFile(libraryPublicLogo, logoBytes);
    await updateBrandKit(kit.id, {
      logo: { src: `brand-kits/${kit.id}/logo.png`, position: 'bottom-right', width: 180, opacity: 0.9, margin: 32, enabled: true },
    });

    // ── 1. 创建：brandKitId 持久化为 pending，项目本体暂时没有品牌 ────────
    const project = await createProject({ name: '品牌新项目', text: sourceText, styleId: 'clean-light', file: null, brandKitId: kit.id });
    const created = await projectOf(project.id);
    assert.equal(created.status, 'extracting');
    assert.equal(created.storyboardJson, null, '创建阶段还没有 storyboard');
    assert.equal(created.styleId, 'clean-light', '品牌选择不替换项目 Style');
    const pendingSettings = await readImportSettings(project.id);
    assert.equal(pendingSettings.brandKitId, kit.id, 'brandKitId 写入 import-settings.json');
    assert.equal(await db.job.count({ where: { projectId: project.id } }), 1, '创建阶段只有 storyboard 任务');

    // ── 2. 首次生成 storyboard：快照注入（no LLM/TTS beyond the mocked chat）──
    const narrationByChapter = new Map<string, string>();
    const mock = mockOllama(chapter => narrationByChapter.set(chapter.title, chapter.content));
    let savedBoard: any;
    try {
      await processProject(project.id, 'storyboarding');
      savedBoard = await boardOf(project.id);
    } finally {
      mock.restore();
    }
    assert.ok(mock.chatCalls.length >= 1, '生成本身走的是被 mock 的 Ollama chat');
    assert.equal((await projectOf(project.id)).status, 'awaiting_review', 'storyboard 生成完成');

    assert.equal(savedBoard.brandKitId, kit.id, '首个 storyboard 直接带 brandKitId');
    assert.equal(savedBoard.brand?.name, 'ACME Corporate', '品牌快照被注入');
    assert.equal(savedBoard.brand?.baseStyleId, 'minimal-tech');
    assert.deepEqual(savedBoard.brand?.colors, colors, '六色调色板被复制');
    assert.deepEqual(savedBoard.brand?.typography, { headingFont: 'Georgia', bodyFont: 'Georgia' }, '字体被复制');
    assert.equal(savedBoard.brand?.logo?.position, 'bottom-right');
    assert.equal(savedBoard.brand?.logo?.width, 180);
    assert.equal(savedBoard.brand?.logo?.margin, 32);
    assert.equal(savedBoard.brand?.logo?.opacity, 0.9);
    assert.equal(savedBoard.styleId, 'clean-light', '品牌不改项目 styleId');
    assert.equal(savedBoard.aspectRatio, '16:9');
    assert.ok(savedBoard.scenes.length >= 1, 'storyboard 有场景');
    for (const scene of savedBoard.scenes) {
      assert.ok(narrationByChapter.has(scene.title ?? ''), '场景来自 mock 的 LLM 输出');
      assert.equal(scene.narration, narrationByChapter.get(scene.title!), '品牌注入不改旁白');
      assert.equal(scene.id.length > 0, true);
    }

    const digest = createHash('sha256').update(logoBytes).digest('hex');
    const expectedLogoSrc = `projects/${project.id}/assets/brand-logos/${digest}.png`;
    assert.equal(savedBoard.brand.logo.src, expectedLogoSrc, 'Logo 复制为项目自有路径');
    assert.deepEqual(await readFile(join(sandbox, 'data', expectedLogoSrc)), logoBytes, 'data 目录保存项目 Logo 副本');
    assert.deepEqual(await readFile(join(sandbox, 'apps/web/public', expectedLogoSrc)), logoBytes, 'public 目录保存项目 Logo 副本');
    assert.deepEqual(await readFile(join(sandbox, 'apps/web/public/brand-kits', kit.id, 'logo.png')), logoBytes, '品牌库 Logo 仍独立保留');

    // ── 3. pending 只在首次落库后消费；重试不会用旧选择覆盖新品牌 ──────────
    assert.equal((await readImportSettings(project.id)).brandKitId, undefined, '首次落库后 pending brandKitId 被清除');
    const jobs = await db.job.findMany({ where: { projectId: project.id } });
    assert.equal(jobs.length, 1, '品牌注入不创建额外任务');
    assert.equal(jobs[0]!.kind, 'storyboard');
    assert.equal(jobs[0]!.status, 'completed');

    // ── 4. 无品牌项目：首次 storyboard 完全没有品牌字段（旧项目兼容）───────
    const plainProject = await createProject({ name: '无品牌项目', text: sourceText, styleId: 'academic', file: null });
    assert.equal((await readImportSettings(plainProject.id)).brandKitId, undefined, '未选品牌不写 pending');
    const plainMock = mockOllama(() => undefined);
    let plainBoard: any;
    try {
      await processProject(plainProject.id, 'storyboarding');
      plainBoard = await boardOf(plainProject.id);
    } finally {
      plainMock.restore();
    }
    assert.equal('brand' in plainBoard, false, '无品牌项目 storyboard 没有 brand 字段');
    assert.equal('brandKitId' in plainBoard, false);
    assert.equal(plainBoard.styleId, 'academic');
    assert.ok(plainBoard.scenes.length >= 1);

    // ── 5. 创建时选择已不存在的品牌：忽略选择但项目照常创建/生成 ───────────
    const staleProject = await createProject({ name: '品牌已删除项目', text: sourceText, styleId: 'minimal-tech', file: null, brandKitId: 'no-such-kit' });
    assert.equal((await readImportSettings(staleProject.id)).brandKitId, undefined, '不存在的品牌 ID 不写 pending');
    const staleMock = mockOllama(() => undefined);
    let staleBoard: any;
    try {
      await processProject(staleProject.id, 'storyboarding');
      staleBoard = await boardOf(staleProject.id);
    } finally {
      staleMock.restore();
    }
    assert.equal('brand' in staleBoard, false, '过期品牌选择不会让项目失败');
    assert.equal('brandKitId' in staleBoard, false);

    console.log('PASS: #48 新建项目 pending 品牌端到端通过（快照注入、Logo 项目副本、pending 一次消费、无品牌/过期品牌兼容、无额外 LLM/TTS 任务）。');
  } finally {
    await db.$disconnect();
    process.chdir(repo);
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(error => {
      console.warn(`[cleanup] temporary sandbox kept: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
