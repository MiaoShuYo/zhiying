import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

/**
 * V1.6.7 #49 服务端 preflight 接线集成测试（tester 独立测试）。
 *
 * schema 的几何/规则由 preflight-v17.test.ts 覆盖；这里验证真实项目数据经过
 * `/api/projects/[id]/preflight` 与 `exists: publicFileExists` 后：
 *  - Logo 文件存在 → 无 missing finding；
 *  - Logo 文件缺失 → 恰好 1 条项目级 warning（不阻断导出）；
 *  - Logo disabled / 无 Brand 项目 → 行为与旧项目完全一致。
 */

async function main() {
  const repo = process.cwd();
  const sandbox = resolve(repo, 'data', `test-v17-preflight-${randomUUID()}`);
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
  const { GET: readPreflight } = await import('../src/app/api/projects/[id]/preflight/route');

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const json = async <T = Record<string, any>>(response: Response) => (await response.json()) as T;
  const check = async (projectId: string) => {
    const response = await readPreflight(new Request(`http://localhost/api/projects/${projectId}/preflight?preset=full`), params(projectId));
    assert.equal(response.status, 200, await response.clone().text());
    return json(response);
  };

  const colors = { bg: '#111827', fg: '#f9fafb', muted: '#9ca3af', accent: '#ef4444', card: '#1f2937', secondary: '#374151' };
  const brand = (logoSrc: string, patch: Record<string, unknown> = {}) => ({
    name: 'ACME Corporate',
    baseStyleId: 'minimal-tech',
    colors,
    typography: { headingFont: 'Georgia', bodyFont: 'Georgia' },
    logo: { src: logoSrc, enabled: true, position: 'bottom-right', width: 180, opacity: 0.85, margin: 40, ...patch },
  });
  const makeScene = (title: string) => ({
    id: randomUUID(), type: 'title', title, narration: `${title}的旁白内容。`, duration: 4,
    audioSrc: 'audio/demo.mp3', audioDuration: 3.8, visual: {},
  });
  const readRawBoard = async (projectId: string) => JSON.parse((await db.project.findUniqueOrThrow({ where: { id: projectId } })).storyboardJson!);
  const writeRawBoard = async (projectId: string, board: unknown) => {
    await db.project.update({ where: { id: projectId }, data: { storyboardJson: JSON.stringify(board) } });
  };

  try {
    await writeFile(join(process.cwd(), 'public', 'audio', 'demo.mp3'), Buffer.from('AUDIO'));
    const project = await db.project.create({ data: { name: '品牌 preflight', sourceText: '正文内容。'.repeat(10), status: 'awaiting_review' } });
    const scenes = [makeScene('开场'), makeScene('原理'), makeScene('收尾')];
    const baseBoard = { title: '品牌 preflight', styleId: 'clean-light', aspectRatio: '16:9', scenes };
    await saveStoryboard(project.id, baseBoard);

    // 无 Brand 基线：干净项目不应有 finding。
    const cleanBaseline = await check(project.id);
    assert.deepEqual(cleanBaseline.issues, [], '无 Brand 且素材齐全的项目没有 finding');
    assert.equal(cleanBaseline.blocking, 0);

    // ── 1. Logo 文件缺失：恰好 1 条项目级 warning，fix 指向品牌设置（#49-2）──
    const logoSrc = `projects/${project.id}/assets/brand-logos/acme-missing.png`;
    await writeRawBoard(project.id, { ...baseBoard, brandKitId: 'kit-acme', brand: brand(logoSrc) });
    const missing = await check(project.id);
    const missingIssues = missing.issues.filter((issue: any) => issue.assetPath === logoSrc);
    assert.equal(missingIssues.length, 1, '缺失 Logo 恰好 1 条 finding');
    assert.equal(missing.issues.length, 1, '没有其它 finding 干扰');
    assert.equal(missingIssues[0].code, 'missing_file');
    assert.equal(missingIssues[0].severity, 'warning');
    assert.equal(missingIssues[0].fix, 'open_brand_settings', 'fix 指向品牌套件设置');
    assert.equal(missingIssues[0].sceneIndex, undefined, 'Logo finding 是项目级');
    assert.match(missingIssues[0].message, /品牌 Logo 文件不存在/);
    assert.match(missingIssues[0].message, /打开品牌套件设置/);
    assert.equal(missing.blocking, 0, '缺失 Logo 不阻断正式导出');

    // ── 2. Logo 文件存在：missing finding 消失（#49-1）────────────────────
    const publicLogo = join(process.cwd(), 'public', logoSrc);
    await mkdir(join(publicLogo, '..'), { recursive: true });
    await writeFile(publicLogo, Buffer.from('LOGO'));
    const present = await check(project.id);
    assert.deepEqual(present.issues, [], 'Logo 存在且布局安全时没有 finding');
    assert.equal(present.blocking, 0);

    // 同侧（bottom-right Logo + bottom 字幕）但布局安全：不得误报冲突。
    assert.equal(present.issues.some((issue: any) => String(issue.code).startsWith('brand_')), false, '同侧但安全不误报');

    // ── 3. Logo disabled：不检查文件（#49-3）──────────────────────────────
    await unlink(publicLogo);
    await writeRawBoard(project.id, { ...baseBoard, brandKitId: 'kit-acme', brand: brand(logoSrc, { enabled: false }) });
    const disabled = await check(project.id);
    assert.deepEqual(disabled.issues, [], 'disabled Logo 即使文件缺失也不检查');
    assert.equal(disabled.issues.some((issue: any) => String(issue.code).startsWith('brand_')), false);

    // ── 4. 多 scene 不重复（#49-7）：文件缺失 + 三个场景仍只有 1 条 ───────
    await writeRawBoard(project.id, { ...baseBoard, brandKitId: 'kit-acme', brand: brand(logoSrc) });
    const deduped = await check(project.id);
    assert.equal(deduped.issues.filter((issue: any) => issue.assetPath === logoSrc).length, 1, '3 个场景只报 1 条 Logo 文件缺失');
    assert.equal(deduped.issues.length, 1);

    // ── 5. 无 Brand 项目行为完全不变：回复到基线，且既有检查照常工作 ───────
    await writeRawBoard(project.id, baseBoard);
    const backToClean = await check(project.id);
    assert.deepEqual(backToClean, cleanBaseline, '移除品牌快照后 preflight 回到原基线');

    const projectWithoutAudio = await db.project.create({ data: { name: '缺语音项目', sourceText: '正文内容。'.repeat(10), status: 'awaiting_review' } });
    const noAudioScene = { id: randomUUID(), type: 'title', title: '缺语音', narration: '还没有生成语音。', duration: 4, visual: {} };
    await saveStoryboard(projectWithoutAudio.id, { title: '缺语音项目', styleId: 'minimal-tech', scenes: [noAudioScene] });
    const legacy = await check(projectWithoutAudio.id);
    assert.ok(legacy.issues.some((issue: any) => issue.code === 'missing_audio'), '原有缺失语音检查不受影响');
    assert.equal(legacy.issues.some((issue: any) => String(issue.code).startsWith('brand_')), false, '无 Brand 项目不会出现品牌 finding');
    assert.ok(legacy.blocking > 0);

    console.log('PASS: #49 服务端 preflight 接线通过（存在/缺失/禁用 Logo、项目级去重、无 Brand 行为不变）。');
  } finally {
    await db.$disconnect();
    process.chdir(repo);
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(error => {
      console.warn(`[cleanup] temporary sandbox kept: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
