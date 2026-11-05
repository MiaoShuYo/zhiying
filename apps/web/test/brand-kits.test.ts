import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GET, PATCH, POST, DELETE } from '../src/app/api/settings/brand-kits/route';
import {
  BrandKitError,
  MAX_BRAND_KITS,
  readBrandKits,
  saveBrandKit,
} from '../src/lib/brand-kits';

const snapshot = (name: string) => ({
  name,
  baseStyleId: 'minimal-tech',
  colors: { bg: '#080d19', fg: '#f3f7ff', muted: '#9aaac2', accent: '#50e3c2', card: '#111b2c', secondary: '#182741' },
  typography: { headingFont: 'Inter', bodyFont: 'Noto Sans' },
  logo: { src: 'https://example.com/logo.png' },
});

const request = (method: string, body?: unknown, path = '/api/settings/brand-kits') => new Request(`http://localhost${path}`, {
  method,
  ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
});

const responseBody = async (response: Response) => response.json() as Promise<Record<string, any>>;

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

test('Brand Kit storage and API CRUD', async t => {
  const originalCwd = process.cwd();
  const sandbox = await mkdtemp(join(tmpdir(), 'm2v-brand-kits-'));
  const webCwd = join(sandbox, 'apps', 'web');
  const storePath = join(sandbox, 'data', 'settings', 'brand-kits.json');
  await mkdir(webCwd, { recursive: true });
  process.chdir(webCwd);

  try {
    await t.test('missing file reads as an empty list without creating storage', async () => {
      const response = await GET();
      const body = await responseBody(response);
      assert.equal(response.status, 200);
      assert.deepEqual(body.brandKits, []);
      assert.equal(body.max, MAX_BRAND_KITS);
      assert.equal(await pathExists(storePath), false);
    });

    await t.test('an empty JSON store also reads as an empty list', async () => {
      await mkdir(join(sandbox, 'data', 'settings'), { recursive: true });
      await writeFile(storePath, '[]', 'utf8');
      assert.deepEqual(await readBrandKits(), []);
    });

    let first: Record<string, any>;
    let second: Record<string, any>;
    await t.test('first create becomes default; subsequent creates do not steal it', async () => {
      const created = await POST(request('POST', snapshot('品牌一')));
      first = (await responseBody(created)).brandKit;
      assert.equal(created.status, 200);
      assert.equal(first.isDefault, true);
      assert.ok(first.id);
      assert.ok(first.createdAt);
      assert.equal(first.createdAt, first.updatedAt);
      assert.equal(await pathExists(storePath), true);
      assert.deepEqual(JSON.parse(await readFile(storePath, 'utf8')).map((kit: any) => kit.id), [first.id]);

      const createdSecond = await POST(request('POST', snapshot('品牌二')));
      second = (await responseBody(createdSecond)).brandKit;
      assert.equal(createdSecond.status, 200);
      assert.equal(second.isDefault, false);
      assert.equal((await readBrandKits()).filter(kit => kit.isDefault).length, 1);
    });

    await t.test('partial nested update merges fields, clears Logo, and rename validates names', async () => {
      const updated = await PATCH(request('PATCH', {
        action: 'update', id: first.id,
        patch: { colors: { accent: '#abcdef' }, typography: { headingFont: 'Aptos' }, logo: null },
      }));
      const value = (await responseBody(updated)).brandKit;
      assert.equal(updated.status, 200);
      assert.equal(value.colors.accent, '#abcdef');
      assert.equal(value.colors.bg, snapshot('x').colors.bg);
      assert.equal(value.typography.headingFont, 'Aptos');
      assert.equal(value.typography.bodyFont, 'Noto Sans');
      assert.equal(value.logo, undefined);
      assert.notEqual(value.updatedAt, first.updatedAt);

      const renamed = await PATCH(request('PATCH', { action: 'rename', id: first.id, name: '  新品牌  ' }));
      assert.equal(renamed.status, 200);
      assert.equal((await responseBody(renamed)).brandKit.name, '新品牌');
      assert.equal((await PATCH(request('PATCH', { action: 'rename', id: first.id, name: ' ' }))).status, 400);
      assert.equal((await PATCH(request('PATCH', { action: 'rename', id: first.id }))).status, 400);
      assert.equal((await PATCH(request('PATCH', { action: 'rename', id: first.id, name: '品牌二' }))).status, 409);
    });

    let copy: Record<string, any>;
    let secondCopy: Record<string, any>;
    await t.test('duplicate gets a new ID and timestamps and is not default', async () => {
      const response = await PATCH(request('PATCH', { action: 'duplicate', id: second.id }));
      copy = (await responseBody(response)).brandKit;
      assert.equal(response.status, 200);
      assert.notEqual(copy.id, second.id);
      assert.match(copy.name, /副本/);
      assert.notEqual(copy.createdAt, second.createdAt);
      assert.notEqual(copy.updatedAt, second.updatedAt);
      assert.equal(copy.isDefault, false);
      assert.deepEqual(copy.logo, second.logo, 'duplicate retains logo configuration and source path');

      const collision = await PATCH(request('PATCH', { action: 'duplicate', id: second.id }));
      secondCopy = (await responseBody(collision)).brandKit;
      assert.equal(collision.status, 200);
      assert.equal(secondCopy.name, `${copy.name} 2`);
      assert.notEqual(secondCopy.id, copy.id);
    });

    await t.test('setting default keeps exactly one; deleting it selects first remaining and deleting all leaves none', async () => {
      const response = await PATCH(request('PATCH', { action: 'default', id: second.id }));
      assert.equal(response.status, 200);
      assert.equal((await responseBody(response)).brandKit.isDefault, true);
      assert.equal((await readBrandKits()).filter(kit => kit.isDefault).length, 1);

      const deletedDefault = await DELETE(request('DELETE', undefined, `/api/settings/brand-kits?id=${second.id}`));
      assert.equal(deletedDefault.status, 200);
      const afterDelete = await readBrandKits();
      assert.equal(afterDelete[0].id, secondCopy.id);
      assert.equal(afterDelete[0].isDefault, true);
      assert.equal(afterDelete.filter(kit => kit.isDefault).length, 1);

      await DELETE(request('DELETE', undefined, `/api/settings/brand-kits?id=${secondCopy.id}`));
      await DELETE(request('DELETE', undefined, `/api/settings/brand-kits?id=${copy.id}`));
      await DELETE(request('DELETE', undefined, `/api/settings/brand-kits?id=${first.id}`));
      assert.deepEqual(await readBrandKits(), []);
      assert.equal((await GET()).status, 200);
    });

    await t.test('schema, malformed requests, and missing IDs map to 400 or 404', async () => {
      assert.equal((await POST(request('POST', { ...snapshot('非法颜色'), colors: { ...snapshot('x').colors, accent: '#123' } }))).status, 400);
      assert.equal((await PATCH(request('PATCH', { action: 'update', id: 'missing', patch: { colors: { accent: '#1234567' } } }))).status, 400);
      assert.equal((await PATCH(request('PATCH', { action: 'update', id: 'missing', patch: { name: '不存在' } }))).status, 404);
      assert.equal((await PATCH(request('PATCH', { action: 'unknown', id: 'some-id' }))).status, 400);
      assert.equal((await DELETE(request('DELETE', undefined, '/api/settings/brand-kits'))).status, 400);
      assert.equal((await DELETE(request('DELETE', undefined, '/api/settings/brand-kits?id=missing'))).status, 404);
      assert.equal((await POST(new Request('http://localhost/api/settings/brand-kits', { method: 'POST', body: '{bad json' }))).status, 400);
    });

    await t.test('30-item limit returns 409', async () => {
      for (let index = 0; index < MAX_BRAND_KITS; index++) {
        await saveBrandKit(snapshot(`上限测试 ${index}`));
      }
      assert.equal((await readBrandKits()).length, MAX_BRAND_KITS);
      const response = await POST(request('POST', snapshot('超出上限')));
      assert.equal(response.status, 409);
    });

    await t.test('invalid update does not alter the existing file', async () => {
      const before = await readFile(storePath, 'utf8');
      const target = (await readBrandKits())[0];
      const response = await PATCH(request('PATCH', { action: 'update', id: target.id, patch: { colors: { accent: 'invalid' } } }));
      assert.equal(response.status, 400);
      assert.equal(await readFile(storePath, 'utf8'), before);
    });

    await t.test('invalid JSON store returns an explicit 500 and preserves original bytes', async () => {
      const invalidJson = '{not json';
      await writeFile(storePath, invalidJson, 'utf8');
      const response = await GET();
      const body = await responseBody(response);
      assert.equal(response.status, 500);
      assert.match(body.error, /JSON/);
      assert.equal(body.error.includes(sandbox), false);
      assert.equal(await readFile(storePath, 'utf8'), invalidJson);
      const writeAttempt = await POST(request('POST', snapshot('不能覆盖 JSON 错误')));
      assert.equal(writeAttempt.status, 500);
      assert.equal(await readFile(storePath, 'utf8'), invalidJson);
      await assert.rejects(readBrandKits(), BrandKitError);
    });

    await t.test('invalid-schema store returns an explicit 500 and cannot be overwritten', async () => {
      const invalidSchema = JSON.stringify([{ id: 'broken', name: '坏数据' }]);
      await writeFile(storePath, invalidSchema, 'utf8');
      const response = await POST(request('POST', snapshot('不能覆盖')));
      const body = await responseBody(response);
      assert.equal(response.status, 500);
      assert.match(body.error, /存储数据无效/);
      assert.equal(body.error.includes(sandbox), false);
      assert.equal(await readFile(storePath, 'utf8'), invalidSchema);
    });
  } finally {
    process.chdir(originalCwd);
    await rm(sandbox, { recursive: true, force: true });
  }
});
