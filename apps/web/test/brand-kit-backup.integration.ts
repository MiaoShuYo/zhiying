import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

type Entry = { path: string; size: number; sha256: string };
type ArchiveManifest = {
  files: Entry[];
  project: { storyboardJson: string | null; [key: string]: any };
  [key: string]: any;
};

function unpack(archive: Buffer) {
  assert.equal(archive.toString('utf8', 0, 8), 'M2VBK001');
  const manifestLength = archive.readUInt32BE(8);
  const manifest = JSON.parse(archive.subarray(12, 12 + manifestLength).toString()) as ArchiveManifest;
  let offset = 12 + manifestLength;
  const bodies = new Map<string, Buffer>();
  for (const file of manifest.files) {
    bodies.set(file.path, archive.subarray(offset, offset + file.size));
    offset += file.size;
  }
  assert.equal(offset, archive.length);
  return { manifest, bodies };
}

function pack(manifest: ArchiveManifest, bodies: Map<string, Buffer>) {
  const raw = Buffer.from(JSON.stringify(manifest));
  const prefix = Buffer.alloc(12);
  prefix.write('M2VBK001', 0, 'utf8');
  prefix.writeUInt32BE(raw.length, 8);
  return Buffer.concat([prefix, raw, ...manifest.files.map(file => bodies.get(file.path) ?? Buffer.alloc(0))]);
}

async function main() {
  const repo = process.cwd();
  const sandbox = resolve(repo, 'data', `test-brand-kit-backup-${randomUUID()}`);
  await mkdir(join(sandbox, 'apps/web/public/audio'), { recursive: true });
  await mkdir(join(sandbox, 'apps/web/public/projects'), { recursive: true });
  process.env.DATABASE_URL = `file:${join(sandbox, 'test.db').replaceAll('\\', '/')}`;
  const sql = execFileSync(process.execPath, [join(repo, 'apps/web/node_modules/prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', join(repo, 'apps/web/prisma/schema.prisma'), '--script'], { env: process.env, encoding: 'utf8' });
  const database = new DatabaseSync(join(sandbox, 'test.db'));
  database.exec(sql);
  database.close();
  process.chdir(join(sandbox, 'apps/web'));

  const { db } = await import('../src/lib/db');
  const { createSnapshot, restoreSnapshot, importBackup, writeProjectArchive } = await import('../src/lib/backups');
  const { saveStoryboard } = await import('../src/lib/pipeline');
  const { saveBrandKit, updateBrandKit, deleteBrandKit } = await import('../src/lib/brand-kits');

  try {
    const brandBase = {
      name: '随项目恢复的品牌',
      baseStyleId: 'minimal-tech' as const,
      colors: { bg: '#080d19', fg: '#f3f7ff', muted: '#9aaac2', accent: '#50e3c2', card: '#111b2c', secondary: '#182741' },
      typography: { headingFont: 'Inter', bodyFont: 'Noto Sans' },
    };
    const kit = await saveBrandKit(brandBase);
    const kitId = kit.id;
    const logoSrc = `brand-kits/${kitId}/logo.png`;
    const logoBytes = Buffer.from('validated-global-brand-logo');
    const globalData = join(sandbox, 'data/settings', logoSrc);
    const globalPublic = join(sandbox, 'apps/web/public', logoSrc);
    await mkdir(join(globalData, '..'), { recursive: true });
    await mkdir(join(globalPublic, '..'), { recursive: true });
    await writeFile(globalData, logoBytes);
    await writeFile(globalPublic, logoBytes);
    await updateBrandKit(kitId, { logo: { src: logoSrc } });
    const unusedKitId = randomUUID();
    const unusedLogo = join(sandbox, 'data/settings/brand-kits', unusedKitId, 'logo.png');
    await mkdir(join(unusedLogo, '..'), { recursive: true });
    await writeFile(unusedLogo, 'unreferenced-logo');

    const brand = {
      ...brandBase,
      logo: { src: logoSrc, position: 'top-right', width: 160, opacity: 1, margin: 40, enabled: true },
    };
    const storyboard = {
      title: '品牌备份项目',
      styleId: 'minimal-tech',
      aspectRatio: '16:9',
      brandKitId: kitId,
      scenes: [{ id: randomUUID(), type: 'title', title: '开场', narration: '用于测试品牌快照恢复。', duration: 4 }],
      brand,
    };
    const project = await db.project.create({ data: {
      name: '品牌备份项目',
      sourceText: 'This project contains a brand snapshot for backup testing.',
      status: 'awaiting_review',
      storyboardJson: JSON.stringify(storyboard),
    } });

    const savedStoryboard = await saveStoryboard(project.id, storyboard);
    const projectLogoSrc = savedStoryboard.brand!.logo!.src;
    const logoHash = createHash('sha256').update(logoBytes).digest('hex');
    assert.equal(projectLogoSrc, `projects/${project.id}/assets/brand-logos/${logoHash}.png`);
    assert.deepEqual(await readFile(join(sandbox, 'data', projectLogoSrc)), logoBytes, 'save copies the Logo into project-owned storage');
    assert.deepEqual(await readFile(join(sandbox, 'apps/web/public', projectLogoSrc)), logoBytes, 'save writes a static public mirror');
    const storedBoard = JSON.parse((await db.project.findUniqueOrThrow({ where: { id: project.id } })).storyboardJson!) as typeof storyboard;
    const resavedStoryboard = await saveStoryboard(project.id, storedBoard);
    assert.equal(resavedStoryboard.brand!.logo!.src, projectLogoSrc, 'saving an existing snapshot keeps its content-addressed Logo path stable');
    await updateBrandKit(kitId, { colors: { accent: '#123456' } });
    assert.equal(storedBoard.brand.colors.accent, '#50e3c2', 'editing the Brand Kit does not mutate the persisted snapshot');
    await writeFile(globalData, 'replacement-logo-from-brand-library');
    await writeFile(globalPublic, 'replacement-logo-from-brand-library');
    assert.deepEqual(await readFile(join(sandbox, 'data', projectLogoSrc)), logoBytes, 'replacing the library Logo does not alter the project copy');
    await deleteBrandKit(kitId);
    await assert.rejects(() => readFile(globalData), 'deleting the Brand Kit deletes its global Logo');

    const snapshotId = await createSnapshot(project.id);
    assert.ok(snapshotId);
    const snapshotDir = join(sandbox, 'data/backups', project.id, snapshotId!);
    const snapshotManifest = JSON.parse(await readFile(join(snapshotDir, 'manifest.json'), 'utf8')) as ArchiveManifest;
    const projectLogoArchivePath = `project/assets/brand-logos/${logoHash}.png`;
    assert.ok(snapshotManifest.files.some(file => file.path === projectLogoArchivePath), 'snapshot includes its project-owned Logo');
    assert.equal(snapshotManifest.files.some(file => file.path === logoSrc), false, 'snapshot no longer depends on the Brand Kit library file');
    assert.equal(snapshotManifest.files.some(file => file.path === `brand-kits/${unusedKitId}/logo.png`), false, 'snapshot excludes unreferenced Brand Kit Logos');
    assert.deepEqual(await readFile(join(snapshotDir, 'files', projectLogoArchivePath)), logoBytes);

    const restoredSnapshotId = await restoreSnapshot(project.id, snapshotId!);
    const restoredSnapshot = await db.project.findUniqueOrThrow({ where: { id: restoredSnapshotId } });
    const restoredSnapshotBoard = JSON.parse(restoredSnapshot.storyboardJson!) as typeof storyboard;
    const restoredLogoSrc = `projects/${restoredSnapshotId}/assets/brand-logos/${logoHash}.png`;
    assert.equal(restoredSnapshotBoard.brandKitId, kitId, 'restore preserves provenance even when its source kit no longer exists');
    assert.equal(restoredSnapshotBoard.brand.logo.src, restoredLogoSrc);
    assert.equal(restoredSnapshotBoard.brand.colors.accent, '#50e3c2');
    assert.deepEqual(await readFile(join(sandbox, 'data', restoredLogoSrc)), logoBytes);
    assert.deepEqual(await readFile(join(sandbox, 'apps/web/public', restoredLogoSrc)), logoBytes);
    await assert.rejects(() => readFile(globalData), 'restore does not recreate a deleted global Brand Kit Logo');

    const archivePath = join(sandbox, 'brand-kit-project.m2v');
    await writeProjectArchive(project.id, archivePath);
    const archive = await readFile(archivePath);
    const { manifest, bodies } = unpack(archive);
    assert.ok(manifest.files.some(file => file.path === projectLogoArchivePath), '.m2v package includes its project-owned Logo');
    assert.equal(manifest.files.some(file => file.path === logoSrc), false, '.m2v does not depend on the Brand Kit library file');
    assert.equal(manifest.files.some(file => file.path === `brand-kits/${unusedKitId}/logo.png`), false, '.m2v excludes unreferenced Logos');

    const restoredArchiveId = await importBackup(new Request('http://localhost/import', { method: 'POST', body: archive }));
    const restoredArchive = await db.project.findUniqueOrThrow({ where: { id: restoredArchiveId } });
    const restoredArchiveBoard = JSON.parse(restoredArchive.storyboardJson!) as typeof storyboard;
    assert.equal(restoredArchiveBoard.brandKitId, kitId);
    assert.equal(restoredArchiveBoard.brand.logo.src, `projects/${restoredArchiveId}/assets/brand-logos/${logoHash}.png`);
    assert.deepEqual(await readFile(join(sandbox, 'apps/web/public', 'projects', restoredArchiveId, 'assets/brand-logos', `${logoHash}.png`)), logoBytes);
    await assert.rejects(() => readFile(globalData), 'archive restore does not recreate a deleted global Logo');

    const legacyManifest = structuredClone(manifest) as ArchiveManifest;
    const legacyStoryboard = JSON.parse(legacyManifest.project.storyboardJson!) as Record<string, unknown>;
    delete legacyStoryboard.brand;
    legacyManifest.project.storyboardJson = JSON.stringify(legacyStoryboard);
    legacyManifest.files = legacyManifest.files.filter(file => file.path !== projectLogoArchivePath);
    const legacyBodies = new Map([...bodies].filter(([path]) => path !== projectLogoArchivePath));
    const legacyArchive = pack(legacyManifest, legacyBodies);
    const restoredLegacyId = await importBackup(new Request('http://localhost/import', { method: 'POST', body: legacyArchive }));
    assert.equal((await db.project.findUniqueOrThrow({ where: { id: restoredLegacyId } })).name, '品牌备份项目（恢复 3）', 'old V1 package without a brand asset still restores');

    const missingLogoProject = await db.project.create({ data: {
      name: '引用缺失全局 Logo 的旧项目',
      sourceText: 'This legacy project still points at the deleted global Logo.',
      status: 'awaiting_review',
      storyboardJson: JSON.stringify({ ...storedBoard, brand: { ...storedBoard.brand, logo: { ...storedBoard.brand.logo!, src: logoSrc } } }),
    } });
    const missingLogoBoardJson = missingLogoProject.storyboardJson;
    await assert.rejects(() => saveStoryboard(missingLogoProject.id, JSON.parse(missingLogoBoardJson!)), /品牌快照 Logo 文件缺失/);
    assert.equal((await db.project.findUniqueOrThrow({ where: { id: missingLogoProject.id } })).storyboardJson, missingLogoBoardJson, 'a missing source Logo cannot overwrite the saved storyboard');
    await assert.rejects(() => writeProjectArchive(missingLogoProject.id, join(sandbox, 'missing-logo.m2v')), /Brand Kit Logo 文件缺失/);
    await assert.rejects(() => createSnapshot(missingLogoProject.id), /Brand Kit Logo 文件缺失/);

    console.log('PASS: snapshots and .m2v packages preserve project-owned Brand Snapshots and Logos after Brand Kit deletion, and legacy packages remain restorable');
  } finally {
    await db.$disconnect();
    process.chdir(repo);
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
