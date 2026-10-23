import { saveStoryboard } from '@/lib/pipeline';
import { NextResponse } from 'next/server';
import { mkdir, writeFile, rm, rename, copyFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Storyboard } from '@m2v/schema';
import { assetFilePath } from '@/lib/asset-usage';
import { db } from '@/lib/db';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';

export const runtime = 'nodejs';
const root = resolve(process.cwd(), '..', '..', 'data', 'projects');
type Asset = { path: string; name: string; kind: 'image' | 'audio'; displayName?: string; attribution?: string; license?: string; licenseUrl?: string; sourceUrl?: string; archived?: boolean; archivedAt?: string };

async function saveAsset(id: string, name: string, bytes: Uint8Array, metadata: Omit<Asset, 'path' | 'name'>): Promise<Asset> {
  const safeName = `${randomUUID()}${extname(name).toLowerCase()}`;
  const directory = resolve(root, id, 'assets'); await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, safeName), bytes);
  await mkdir(resolve(process.cwd(), 'public', 'projects', id, 'assets'), { recursive: true });
  await writeFile(resolve(process.cwd(), 'public', 'projects', id, 'assets', safeName), bytes);
  const asset = { ...metadata, displayName: name, name: safeName, path: `projects/${id}/assets/${safeName}` };
  const project = await db.project.findUniqueOrThrow({ where: { id }, select: { assetsJson: true } });
  const assets = JSON.parse(project.assetsJson || '[]') as Asset[];
  await db.project.update({ where: { id }, data: { assetsJson: JSON.stringify([...assets, asset]) } });
  return asset;
}

/** Replaced assets keep their record and bytes, only moved out of the active folder so the next render ignores them. */
async function archiveAsset(id: string, asset: Asset) {
  await mkdir(resolve(root, id, 'assets', 'archive'), { recursive: true });
  await rename(assetFilePath(id, { name: asset.name, archived: false }), assetFilePath(id, { name: asset.name, archived: true })).catch(() => {});
  await rm(assetFilePath(id, { name: asset.name, archived: false }, 'public'), { force: true });
  const project = await db.project.findUniqueOrThrow({ where: { id }, select: { assetsJson: true } });
  const assets = JSON.parse(project.assetsJson || '[]') as Asset[];
  await db.project.update({ where: { id }, data: { assetsJson: JSON.stringify(assets.map(item => item.path === asset.path ? { ...item, archived: true, archivedAt: new Date().toISOString() } : item)) } });
}

async function dropRecord(id: string, path: string) {
  const project = await db.project.findUniqueOrThrow({ where: { id }, select: { assetsJson: true } });
  const assets = JSON.parse(project.assetsJson || '[]') as Asset[];
  await db.project.update({ where: { id }, data: { assetsJson: JSON.stringify(assets.filter(item => item.path !== path)) } });
}

function remainingReferences(board: Storyboard | null, path: string) {
  const scenes: number[] = [];
  if (!board) return { scenes, bgm: false };
  const needle = JSON.stringify(path);
  board.scenes.forEach((scene, index) => {
    if (scene.audioSrc === path) { scenes.push(index); return; }
    if (JSON.stringify(scene.visual ?? {}).includes(needle)) scenes.push(index);
  });
  return { scenes, bgm: board.bgmSrc === path };
}

/** `scenes` is an optional JSON array of scene indexes; without it the old "wherever this path appears" rule applies. */
function parseScenes(value: FormDataEntryValue | null): number[] | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return [...new Set(parsed.filter((item): item is number => typeof item === 'number' && Number.isInteger(item) && item >= 0))];
  } catch { return null; }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const lock = await getProjectLock(id);
  if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  if (lock.locked) return projectLockedResponse(lock.reason);
  try {
    const form = await request.formData(); const file = form.get('file'); const kind = form.get('kind') === 'audio' ? 'audio' : 'image';
    if (!(file instanceof File)) return NextResponse.json({ error: '请选择素材文件' }, { status: 400 });
    const extension = extname(file.name).toLowerCase();
    const allowed = kind === 'audio' ? ['.mp3', '.wav', '.m4a', '.ogg', '.flac'] : ['.png', '.jpg', '.jpeg', '.webp'];
    if (!allowed.includes(extension)) return NextResponse.json({ error: '不支持的素材格式' }, { status: 400 });
    if (file.size > 40 * 1024 * 1024) return NextResponse.json({ error: '素材不能超过 40 MB' }, { status: 413 });
    const asset = await saveAsset(id, file.name, new Uint8Array(await file.arrayBuffer()), { kind });
    const replacing = form.get('replace');
    if (typeof replacing === 'string' && replacing) {
      const project = await db.project.findUniqueOrThrow({ where: { id } });
      const assets = JSON.parse(project.assetsJson) as Asset[];
      const old = assets.find(item => item.path === replacing);
      if (!old || (old.kind ?? 'image') !== kind) throw new Error('替换素材不存在或类型不匹配');
      const requested = parseScenes(form.get('scenes'));
      const skipped: number[] = [];
      let board: Storyboard | null = project.storyboardJson ? JSON.parse(project.storyboardJson) as Storyboard : null;
      if (board) {
        if (requested) {
          for (const index of requested) {
            const scene = board.scenes[index];
            if (!scene) continue;
            // Assigning `visual.src` on a scene that draws no image would create an invisible reference.
            if (scene.visual.src === undefined && scene.type !== 'media') { skipped.push(index); continue; }
            scene.visual = { ...scene.visual, src: asset.path, attribution: asset.attribution, license: asset.license, licenseUrl: asset.licenseUrl, sourceUrl: asset.sourceUrl };
          }
        } else {
          for (const scene of board.scenes) if (scene.visual.src === replacing) scene.visual = { ...scene.visual, src: asset.path, attribution: asset.attribution, license: asset.license, licenseUrl: asset.licenseUrl, sourceUrl: asset.sourceUrl };
          if (board.bgmSrc === replacing) board.bgmSrc = asset.path;
        }
        await saveStoryboard(id, board);
      }
      const remaining = remainingReferences(board, replacing);
      const keep = remaining.scenes.length > 0 || remaining.bgm;
      if (keep) {
        // Still used elsewhere: keep it active so those scenes keep rendering.
        return NextResponse.json({ asset, archived: false, stillReferenced: remaining, skipped });
      }
      await archiveAsset(id, old);
      if (!requested) await dropRecord(id, replacing);
      return NextResponse.json({ asset, archived: true, stillReferenced: remaining, skipped });
    }
    return NextResponse.json({ asset });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : '素材保存失败' }, { status: 500 }); }
}

/** Restore an archived asset, or purge it for good. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const lock = await getProjectLock(id);
  if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  if (lock.locked) return projectLockedResponse(lock.reason);
  try {
    const body = await request.json() as { path?: string; action?: string; confirm?: boolean };
    const action = body.action === 'restore' ? 'restore' : body.action === 'purge' ? 'purge' : null;
    if (!action || typeof body.path !== 'string') return NextResponse.json({ error: '操作无效' }, { status: 400 });
    const project = await db.project.findUniqueOrThrow({ where: { id } });
    const assets = JSON.parse(project.assetsJson || '[]') as Asset[];
    const asset = assets.find(item => item.path === body.path);
    if (!asset) return NextResponse.json({ error: '素材不存在' }, { status: 404 });
    if (!asset.name || /[\\/]/.test(asset.name) || asset.name === '.' || asset.name === '..') return NextResponse.json({ error: '素材路径无效' }, { status: 400 });
    if (action === 'restore') {
      await mkdir(resolve(root, id, 'assets'), { recursive: true });
      await rename(assetFilePath(id, { name: asset.name, archived: true }), assetFilePath(id, { name: asset.name, archived: false })).catch(error => { throw new Error(`归档文件无法恢复：${error instanceof Error ? error.message : '文件缺失'}`); });
      await mkdir(resolve(process.cwd(), 'public', 'projects', id, 'assets'), { recursive: true });
      await copyFile(assetFilePath(id, { name: asset.name, archived: false }), assetFilePath(id, { name: asset.name, archived: false }, 'public'));
      await db.project.update({ where: { id }, data: { assetsJson: JSON.stringify(assets.map(item => item.path === asset.path ? { ...item, archived: undefined, archivedAt: undefined } : item)) } });
      return NextResponse.json({ ok: true, restored: asset.path });
    }
    if (body.confirm !== true) return NextResponse.json({ error: '彻底删除需要再次确认' }, { status: 400 });
    const board = project.storyboardJson ? JSON.parse(project.storyboardJson) as Storyboard : null;
    const remaining = remainingReferences(board, asset.path);
    if (remaining.scenes.length || remaining.bgm) return NextResponse.json({ error: '素材仍被场景或背景音乐引用，请先替换或移除引用' }, { status: 409 });
    await Promise.all([
      rm(assetFilePath(id, asset), { force: true }),
      rm(assetFilePath(id, asset, 'public'), { force: true }),
      rm(assetFilePath(id, { name: asset.name, archived: true }), { force: true }),
    ]);
    await db.project.update({ where: { id }, data: { assetsJson: JSON.stringify(assets.filter(item => item.path !== asset.path)) } });
    return NextResponse.json({ ok: true, purged: asset.path });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : '素材操作失败' }, { status: 500 }); }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const lock = await getProjectLock(id);
  if (!lock.exists) return Response.json({ error: '项目不存在' }, { status: 404 });
  if (lock.locked) return projectLockedResponse(lock.reason);
  const { path } = await request.json();
  const project = await db.project.findUniqueOrThrow({ where: { id } });
  const assets = JSON.parse(project.assetsJson) as Asset[]; const asset = assets.find(item => item.path === path);
  if (!asset) return Response.json({ error: '素材不存在' }, { status: 404 });
  if (project.storyboardJson?.includes(JSON.stringify(path))) return Response.json({ error: '素材正在被场景或背景音乐引用，请先替换或移除引用' }, { status: 409 });
  if (!asset.name || /[\\/]/.test(asset.name) || asset.name === '.' || asset.name === '..') return Response.json({ error: '素材路径无效' }, { status: 400 });
  await db.project.update({ where: { id }, data: { assetsJson: JSON.stringify(assets.filter(item => item.path !== path)) } });
  await Promise.all([
    rm(assetFilePath(id, asset), { force: true }),
    rm(assetFilePath(id, asset, 'public'), { force: true }),
    rm(assetFilePath(id, { name: asset.name, archived: true }), { force: true }),
  ]);
  return Response.json({ ok: true });
}
