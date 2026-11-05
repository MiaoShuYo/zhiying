import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import test from 'node:test';
import { DELETE, GET as getSettings, PATCH as patchBrandKit } from '../src/app/api/settings/brand-kits/route';
import { POST as uploadLogo } from '../src/app/api/settings/brand-kits/logo/route';
import { readBrandKits, saveBrandKit } from '../src/lib/brand-kits';
import { replaceBrandKitLogoFiles } from '../src/lib/brand-kit-logo-files';

const snapshot = (name: string) => ({
  name,
  baseStyleId: 'minimal-tech',
  colors: { bg: '#080d19', fg: '#f3f7ff', muted: '#9aaac2', accent: '#50e3c2', card: '#111b2c', secondary: '#182741' },
  typography: { headingFont: 'Inter', bodyFont: 'Noto Sans' },
});

const request = (method: string, body?: unknown, path = '/api/settings/brand-kits') => new Request(`http://localhost${path}`, {
  method,
  ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
});

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function colorImage(format: 'png' | 'jpeg' | 'webp', color: string) {
  return sharp({ create: { width: 3, height: 2, channels: 4, background: color } })[format]().toBuffer();
}

function oversizedPngHeader(png: Buffer) {
  const copy = Buffer.from(png);
  copy.writeUInt32BE(6500, 16);
  copy.writeUInt32BE(6500, 20);
  let crc = 0xffffffff;
  for (const byte of copy.subarray(12, 29)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  copy.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
  return copy;
}

function uploadRequest(brandKitId: string, bytes: Uint8Array, filename: string, mime: string) {
  const form = new FormData();
  form.set('brandKitId', brandKitId);
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  form.set('file', new File([body], filename, { type: mime }));
  return new Request('http://localhost/api/settings/brand-kits/logo', { method: 'POST', body: form });
}

const body = async (response: Response) => response.json() as Promise<Record<string, any>>;

test('Brand Kit Logo upload validation, mirrors, replacement, duplicate and delete', async t => {
  const originalCwd = process.cwd();
  const sandbox = await mkdtemp(join(tmpdir(), 'm2v-brand-kit-logo-'));
  const webCwd = join(sandbox, 'apps', 'web');
  await mkdir(webCwd, { recursive: true });
  process.chdir(webCwd);

  try {
    const kit = await saveBrandKit(snapshot('Logo 上传测试'));
    const dataDir = join(sandbox, 'data', 'settings', 'brand-kits', kit.id);
    const publicDir = join(webCwd, 'public', 'brand-kits', kit.id);
    const pngRed = await colorImage('png', '#ff0000');
    const pngBlue = await colorImage('png', '#0000ff');
    const jpg = await colorImage('jpeg', '#00ff00');
    const webp = await colorImage('webp', '#ffff00');

    await t.test('accepts PNG, JPG/JPEG and WebP and writes both paths and a relative src', async () => {
      for (const [filename, mime, bytes, extension] of [
        ['brand.png', 'image/png', pngRed, 'png'],
        ['brand.jpg', 'image/jpeg', jpg, 'jpg'],
        ['brand.jpeg', 'image/jpeg', jpg, 'jpeg'],
        ['brand.webp', 'image/webp', webp, 'webp'],
      ] as const) {
        const response = await uploadLogo(uploadRequest(kit.id, bytes, filename, mime));
        const result = await body(response);
        assert.equal(response.status, 200);
        const src = `brand-kits/${kit.id}/logo.${extension}`;
        assert.equal(result.brandKit.logo.src, src);
        assert.ok(await exists(join(dataDir, `logo.${extension}`)));
        assert.ok(await exists(join(publicDir, `logo.${extension}`)));
        assert.deepEqual(await readFile(join(dataDir, `logo.${extension}`)), await readFile(join(publicDir, `logo.${extension}`)));
      }
      assert.deepEqual(await readdir(dataDir), ['logo.webp'], 'each format replacement cleans the previously managed extension');
    });

    await t.test('same-format replacement updates both mirrors and changed-format replacement removes the prior extension', async () => {
      let response = await uploadLogo(uploadRequest(kit.id, pngRed, 'logo.png', 'image/png'));
      assert.equal(response.status, 200);
      response = await uploadLogo(uploadRequest(kit.id, pngBlue, '../../outside.png', 'image/png'));
      const result = await body(response);
      assert.equal(response.status, 200, 'the original filename is never used as a destination path');
      assert.equal(result.brandKit.logo.src, `brand-kits/${kit.id}/logo.png`);
      assert.deepEqual(await readFile(join(dataDir, 'logo.png')), await readFile(join(publicDir, 'logo.png')));
      assert.notDeepEqual(await readFile(join(dataDir, 'logo.png')), pngRed);
      assert.equal(await exists(join(sandbox, 'outside.png')), false);

      response = await uploadLogo(uploadRequest(kit.id, webp, 'logo.webp', 'image/webp'));
      assert.equal(response.status, 200);
      assert.equal(await exists(join(dataDir, 'logo.png')), false);
      assert.equal(await exists(join(publicDir, 'logo.png')), false);
      assert.equal((await readBrandKits())[0]!.logo!.src, `brand-kits/${kit.id}/logo.webp`);
    });

    await t.test('metadata commit failure restores the previous authoritative file and public mirror', async () => {
      const priorData = await readFile(join(dataDir, 'logo.webp'));
      const priorPublic = await readFile(join(publicDir, 'logo.webp'));
      await assert.rejects(() => replaceBrandKitLogoFiles({
        brandKitId: kit.id,
        extension: 'webp',
        bytes: pngRed,
        previousSrc: `brand-kits/${kit.id}/logo.webp`,
        commit: async () => { throw new Error('metadata write failure'); },
      }), /原配置已保留/);
      assert.deepEqual(await readFile(join(dataDir, 'logo.webp')), priorData);
      assert.deepEqual(await readFile(join(publicDir, 'logo.webp')), priorPublic);
    });

    await t.test('rejects unknown kits, mismatched MIME or extension, non-images, corrupt and empty files', async () => {
      const missingKit = await uploadLogo(uploadRequest('missing-kit', pngRed, 'logo.png', 'image/png'));
      assert.equal(missingKit.status, 404);
      assert.equal((await body(missingKit)).error.includes(sandbox), false, 'API errors never expose filesystem paths');
      assert.equal((await uploadLogo(uploadRequest(kit.id, pngRed, 'logo.png', 'image/jpeg'))).status, 400);
      assert.equal((await uploadLogo(uploadRequest(kit.id, pngRed, 'logo.jpg', 'image/jpeg'))).status, 400, 'actual image format must also match');
      assert.equal((await uploadLogo(uploadRequest(kit.id, Buffer.from('<svg/>'), 'logo.svg', 'image/svg+xml'))).status, 400);
      assert.equal((await uploadLogo(uploadRequest(kit.id, Buffer.from('not image'), 'logo.png', 'image/png'))).status, 400);
      assert.equal((await uploadLogo(uploadRequest(kit.id, Buffer.alloc(0), 'logo.png', 'image/png'))).status, 400);
      assert.equal((await uploadLogo(uploadRequest(kit.id, Buffer.alloc(5 * 1024 * 1024 + 1), 'logo.png', 'image/png'))).status, 413);
      assert.equal((await uploadLogo(uploadRequest(kit.id, oversizedPngHeader(pngRed), 'logo.png', 'image/png'))).status, 400);
      assert.equal(await exists(join(dataDir, 'logo.svg')), false);
      assert.equal(await exists(join(sandbox, 'outside.png')), false);
    });

    await t.test('duplicate has an independent Logo and kit deletion cleans persistent and public files', async () => {
      const duplicateResponse = await patchBrandKit(request('PATCH', { action: 'duplicate', id: kit.id }));
      const duplicate = (await body(duplicateResponse)).brandKit;
      assert.equal(duplicateResponse.status, 200);
      assert.equal(duplicate.logo.src, `brand-kits/${duplicate.id}/logo.webp`);
      const duplicateData = join(sandbox, 'data', 'settings', 'brand-kits', duplicate.id, 'logo.webp');
      const duplicatePublic = join(webCwd, 'public', 'brand-kits', duplicate.id, 'logo.webp');
      assert.deepEqual(await readFile(duplicateData), await readFile(join(dataDir, 'logo.webp')));
      assert.deepEqual(await readFile(duplicatePublic), await readFile(duplicateData));

      await rm(join(webCwd, 'public', 'brand-kits', duplicate.id), { recursive: true, force: true });
      const settings = await getSettings();
      assert.equal(settings.status, 200, 'a missing static mirror does not break settings reads');

      const deleted = await DELETE(request('DELETE', undefined, `/api/settings/brand-kits?id=${kit.id}`));
      assert.equal(deleted.status, 200);
      assert.equal(await exists(dataDir), false);
      assert.equal(await exists(publicDir), false);
      assert.equal(await exists(join(sandbox, 'data', 'settings', 'brand-kits', duplicate.id)), true, 'source deletion leaves the duplicate copy intact');
      const deleteDuplicate = await DELETE(request('DELETE', undefined, `/api/settings/brand-kits?id=${duplicate.id}`));
      assert.equal(deleteDuplicate.status, 200);
      assert.equal(await exists(join(sandbox, 'data', 'settings', 'brand-kits', duplicate.id)), false);
      assert.equal(await exists(join(webCwd, 'public', 'brand-kits', duplicate.id)), false);
    });
  } finally {
    process.chdir(originalCwd);
    await rm(sandbox, { recursive: true, force: true });
  }
});
