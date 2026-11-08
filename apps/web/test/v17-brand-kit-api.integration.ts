import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';

/**
 * V1.6.7 #47 品牌套件设置页 API 集成测试（tester 独立测试）。
 *
 * 全程临时目录 + 临时 SQLite：创建/编辑颜色字体 Logo/上传 Logo/复制/设为默认/删除，
 * 并验证删除品牌库条目不破坏已应用该品牌的项目快照。
 */

async function main() {
  const repo = process.cwd();
  const sandbox = resolve(repo, 'data', `test-v17-brand-kit-api-${randomUUID()}`);
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
  const { readBrandKits } = await import('../src/lib/brand-kits');
  const { GET, POST, PATCH, DELETE } = await import('../src/app/api/settings/brand-kits/route');
  const { POST: uploadLogo } = await import('../src/app/api/settings/brand-kits/logo/route');

  const json = async <T = Record<string, any>>(response: Response) => (await response.json()) as T;
  const request = (method: string, body?: unknown, path = '/api/settings/brand-kits') => new Request(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const snapshot = (name: string, accent = '#ef4444') => ({
    name,
    baseStyleId: 'minimal-tech',
    colors: { bg: '#111827', fg: '#f9fafb', muted: '#9ca3af', accent, card: '#1f2937', secondary: '#374151' },
    typography: { headingFont: 'Georgia', bodyFont: 'Georgia' },
  });
  const uploadRequest = (brandKitId: string, bytes: Buffer, filename = 'logo.png', mime = 'image/png') => {
    const form = new FormData();
    form.set('brandKitId', brandKitId);
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    form.set('file', new File([body], filename, { type: mime }));
    return new Request('http://localhost/api/settings/brand-kits/logo', { method: 'POST', body: form });
  };
  const exists = async (path: string) => {
    try { await access(path); return true; } catch { return false; }
  };

  try {
    // ── 1. 空列表 → 新建：第一个自动成为默认 ─────────────────────────────
    const empty = await json(await GET());
    assert.deepEqual(empty.brandKits, [], '空列表返回空数组');
    assert.equal(empty.max, 30, '返回品牌库上限');

    const createdA = await POST(request('POST', snapshot('ACME Corporate')));
    assert.equal(createdA.status, 200, await createdA.clone().text());
    const kitA = (await json(createdA)).brandKit;
    assert.ok(kitA.id);
    assert.equal(kitA.isDefault, true, '第一个品牌自动设为默认');

    const createdB = await POST(request('POST', snapshot('品牌乙', '#2563eb')));
    const kitB = (await json(createdB)).brandKit;
    assert.equal(kitB.isDefault, false, '后续创建不抢默认');

    // 重名 409
    const duplicateName = await POST(request('POST', snapshot('ACME Corporate')));
    assert.equal(duplicateName.status, 409, '重名创建被拒绝');
    assert.match((await json(duplicateName)).error, /已存在名为/);

    // ── 2. 编辑颜色/字体/logo config（部分嵌套更新）──────────────────────
    const updated = await PATCH(request('PATCH', {
      id: kitA.id,
      action: 'update',
      patch: {
        colors: { accent: '#00ff66', card: '#05070c' },
        typography: { headingFont: 'Georgia', bodyFont: 'Noto Sans' },
        logo: { enabled: false, position: 'bottom-left', width: 200, opacity: 0.8, margin: 32, src: `brand-kits/${kitA.id}/logo.png` },
      },
    }));
    assert.equal(updated.status, 200, await updated.clone().text());
    const edited = (await json(updated)).brandKit;
    assert.equal(edited.colors.accent, '#00ff66', '强调色被更新');
    assert.equal(edited.colors.card, '#05070c', '卡片色被更新');
    assert.equal(edited.colors.bg, '#111827', '未提供的颜色保持不变');
    assert.deepEqual(edited.typography, { headingFont: 'Georgia', bodyFont: 'Noto Sans' }, '字体可编辑');
    assert.equal(edited.logo.position, 'bottom-left');
    assert.equal(edited.logo.width, 200);
    assert.equal(edited.logo.margin, 32);
    assert.equal(edited.logo.opacity, 0.8);
    assert.equal(edited.logo.enabled, false);

    // ── 3. 上传 Logo：双镜像写入 + 品牌库引用 ────────────────────────────
    const png = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#ef4444' } }).png().toBuffer();
    const uploadResponse = await uploadLogo(uploadRequest(kitA.id, png));
    assert.equal(uploadResponse.status, 200, await uploadResponse.clone().text());
    const uploaded = (await json(uploadResponse)).brandKit;
    assert.equal(uploaded.logo.src, `brand-kits/${kitA.id}/logo.png`);
    assert.equal(uploaded.logo.enabled, false, '上传 Logo 不擅自改变 enabled/其它字段');
    assert.ok(await exists(join(sandbox, 'data/settings/brand-kits', kitA.id, 'logo.png')), 'data 目录写入 Logo');
    assert.ok(await exists(join(sandbox, 'apps/web/public/brand-kits', kitA.id, 'logo.png')), 'public 目录写入 Logo');
    assert.deepEqual(await readFile(join(sandbox, 'data/settings/brand-kits', kitA.id, 'logo.png')), await readFile(join(sandbox, 'apps/web/public/brand-kits', kitA.id, 'logo.png')));

    // 上传后重新启用 Logo，供项目快照使用。
    await PATCH(request('PATCH', { id: kitA.id, action: 'update', patch: { logo: { enabled: true } } }));

    // ── 4. 复制（duplicate）：副本名、非默认、Logo 独立副本 ───────────────
    const duplicated = await PATCH(request('PATCH', { id: kitA.id, action: 'duplicate' }));
    assert.equal(duplicated.status, 200, await duplicated.clone().text());
    const copy = (await json(duplicated)).brandKit;
    assert.notEqual(copy.id, kitA.id);
    assert.match(copy.name, / 副本/);
    assert.equal(copy.isDefault, false, '副本不会自动成为默认');
    assert.equal(copy.logo.src, `brand-kits/${copy.id}/logo.png`, '副本 Logo 指向独立存储');
    assert.ok(await exists(join(sandbox, 'data/settings/brand-kits', copy.id, 'logo.png')));
    assert.equal((await json(await GET())).brandKits.length, 3, '复制后品牌库有 3 个条目');

    // ── 5. 设为默认：唯一默认项 ──────────────────────────────────────────
    const defaulted = await PATCH(request('PATCH', { id: kitB.id, action: 'default' }));
    assert.equal(defaulted.status, 200);
    const kitsAfterDefault = (await json(await GET())).brandKits as any[];
    assert.equal(kitsAfterDefault.filter(item => item.isDefault).length, 1, '始终只有一个默认品牌');
    assert.equal(kitsAfterDefault.find(item => item.isDefault).id, kitB.id, '默认标记转移到目标品牌');

    // ── 6. 非法 hex 不提交（API 层兜底）──────────────────────────────────
    const beforeInvalid = JSON.stringify((await readBrandKits()).map(item => item.colors));
    const invalidHex = await PATCH(request('PATCH', { id: kitA.id, action: 'update', patch: { colors: { accent: 'red' } } }));
    assert.equal(invalidHex.status, 400, '非法 hex 被 API 拒绝');
    assert.ok((await json(invalidHex)).error, '错误信息可展示');
    assert.equal(JSON.stringify((await readBrandKits()).map(item => item.colors)), beforeInvalid, '被拒绝的请求不写品牌库');
    const invalidCreate = await POST(request('POST', { ...snapshot('Bad Hex'), colors: { ...snapshot('Bad Hex').colors, bg: '#12' } }));
    assert.equal(invalidCreate.status, 400, '创建时非法 hex 也被拒绝');

    // ── 7. 删除：已应用项目的快照不受影响（不扫描项目引用）────────────────
    const project = await db.project.create({ data: { name: '已用品牌项目', sourceText: '正文内容。'.repeat(10), status: 'awaiting_review' } });
    const board = {
      title: '已用品牌项目',
      styleId: 'clean-light',
      aspectRatio: '16:9',
      scenes: [{ id: randomUUID(), type: 'title', title: '开场', narration: '品牌只影响视觉。', duration: 4, audioSrc: 'audio/demo.mp3', audioDuration: 3.8, visual: {} }],
      brandKitId: kitA.id,
      brand: {
        name: 'ACME Corporate',
        baseStyleId: 'minimal-tech',
        colors: { bg: '#111827', fg: '#f9fafb', muted: '#9ca3af', accent: '#00ff66', card: '#05070c', secondary: '#374151' },
        typography: { headingFont: 'Georgia', bodyFont: 'Noto Sans' },
        logo: { src: `brand-kits/${kitA.id}/logo.png`, enabled: true, position: 'bottom-left', width: 200, opacity: 0.8, margin: 32 },
      },
    };
    await saveStoryboard(project.id, board);
    const appliedBoard = JSON.parse((await db.project.findUniqueOrThrow({ where: { id: project.id } })).storyboardJson!);
    const copiedLogo = appliedBoard.brand.logo.src as string;
    assert.match(copiedLogo, new RegExp(`^projects/${project.id}/assets/brand-logos/[a-f0-9]{64}\\.png$`), '项目 Logo 是独立副本');

    const removed = await DELETE(request('DELETE', undefined, `/api/settings/brand-kits?id=${encodeURIComponent(kitA.id)}`));
    assert.equal(removed.status, 200, await removed.clone().text());
    assert.ok((await json(removed)).ok);
    assert.equal((await json(await GET())).brandKits.some((item: any) => item.id === kitA.id), false, '品牌库条目被删除');
    const projectAfterDelete = JSON.parse((await db.project.findUniqueOrThrow({ where: { id: project.id } })).storyboardJson!);
    assert.deepEqual(projectAfterDelete.brand, appliedBoard.brand, '已应用到项目的品牌快照继续保留');
    assert.equal(projectAfterDelete.brandKitId, kitA.id, '项目 brandKitId 不被清除（用于提示来源已删除）');
    assert.deepEqual(await readFile(join(sandbox, 'data', copiedLogo)), png, '项目 Logo 副本未被删除');
    assert.equal(projectAfterDelete.styleId, 'clean-light');
    assert.deepEqual(projectAfterDelete.scenes, appliedBoard.scenes, '删除品牌库不动项目分镜');

    // 删除不存在的条目 404；重复删除也 404。
    const missing = await DELETE(request('DELETE', undefined, `/api/settings/brand-kits?id=${encodeURIComponent(kitA.id)}`));
    assert.equal(missing.status, 404);

    // ── 8. 删除默认品牌后默认标记转移到剩余条目 ──────────────────────────
    const remainingBefore = (await json(await GET())).brandKits as any[];
    const currentDefault = remainingBefore.find(item => item.isDefault);
    assert.ok(currentDefault, '剩余品牌中仍有默认项');
    const deleteDefault = await DELETE(request('DELETE', undefined, `/api/settings/brand-kits?id=${encodeURIComponent(currentDefault.id)}`));
    assert.equal(deleteDefault.status, 200);
    const remainingAfter = (await json(await GET())).brandKits as any[];
    assert.equal(remainingAfter.filter(item => item.isDefault).length, 1, '删除默认后仍有一个默认');

    console.log('PASS: #47 品牌库 API 集成（创建/编辑颜色字体 Logo/上传双镜像/复制/设为默认/删除/非法 hex 拒绝/删除不破坏项目快照）全部通过。');
  } finally {
    await db.$disconnect();
    process.chdir(repo);
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(error => {
      console.warn(`[cleanup] temporary sandbox kept: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
