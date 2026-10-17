import { saveStoryboard } from '@/lib/pipeline';
import { NextResponse } from 'next/server';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';

export const runtime = 'nodejs';
const root = resolve(process.cwd(), '..', '..', 'data', 'projects');
type Asset = { path: string; name: string; kind: 'image' | 'audio'; displayName?: string; attribution?: string; license?: string; licenseUrl?: string; sourceUrl?: string };

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
      if (project.storyboardJson) {
        const board = JSON.parse(project.storyboardJson);
        for (const scene of board.scenes) if (scene.visual.src === replacing) scene.visual = { ...scene.visual, src: asset.path, attribution: asset.attribution, license: asset.license, licenseUrl: asset.licenseUrl, sourceUrl: asset.sourceUrl };
        if (board.bgmSrc === replacing) board.bgmSrc = asset.path;
        await saveStoryboard(id, board);
      }
      await db.project.update({ where: { id }, data: { assetsJson: JSON.stringify(assets.filter(item => item.path !== replacing)) } });
    }
    return NextResponse.json({ asset });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : '素材保存失败' }, { status: 500 }); }
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
  await Promise.all([rm(resolve(root, id, 'assets', asset.name), { force: true }), rm(resolve(process.cwd(), 'public/projects', id, 'assets', asset.name), { force: true })]);
  return Response.json({ ok: true });
}
