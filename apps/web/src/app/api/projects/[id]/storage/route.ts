import { NextResponse } from 'next/server';
import { readdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { db } from '@/lib/db';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';
import { listSnapshots } from '@/lib/backups';

export const runtime = 'nodejs';
const root = resolve(process.cwd(), '..', '..', 'data', 'projects');
const publicRoot = resolve(process.cwd(), 'public');
const assetDirectory = (id: string) => resolve(root, id, 'assets');
const publicAssetDirectory = (id: string) => resolve(publicRoot, 'projects', id, 'assets');
type Asset = { path: string; name: string; kind?: 'image' | 'audio'; displayName?: string };

const bytesOf = async (path: string) => { try { return (await stat(path)).size; } catch { return 0; } };
async function directoryBytes(directory: string, filter?: (name: string) => boolean) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) if (entry.isFile() && (!filter || filter(entry.name))) total += await bytesOf(resolve(directory, entry.name));
  return total;
}

/** A scene references an asset through its picture, its narration audio or the background music. */
function referencedPaths(storyboardJson: string | null) {
  const referenced = new Set<string>();
  if (!storyboardJson) return referenced;
  try {
    const board = JSON.parse(storyboardJson) as { scenes?: { visual?: { src?: unknown }; audioSrc?: unknown }[]; bgmSrc?: unknown };
    for (const scene of board.scenes ?? []) {
      if (typeof scene.visual?.src === 'string') referenced.add(scene.visual.src);
      if (typeof scene.audioSrc === 'string') referenced.add(scene.audioSrc);
    }
    if (typeof board.bgmSrc === 'string') referenced.add(board.bgmSrc);
  } catch { /* A corrupt storyboard must not block the storage report. */ }
  return referenced;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await db.project.findUnique({ where: { id }, select: { storyboardJson: true, assetsJson: true, sourcePath: true } });
  if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const referenced = referencedPaths(project.storyboardJson);
  const registered = (() => { try { return JSON.parse(project.assetsJson) as Asset[]; } catch { return [] as Asset[]; } })();
  const registeredByName = new Map(registered.map(asset => [asset.name, asset]));

  const entries = await readdir(assetDirectory(id), { withFileTypes: true }).catch(() => []);
  const assets = await Promise.all(entries.filter(entry => entry.isFile() && !entry.name.startsWith('.')).map(async entry => {
    const path = `projects/${id}/assets/${entry.name}`;
    return { path, name: entry.name, displayName: registeredByName.get(entry.name)?.displayName, bytes: await bytesOf(resolve(assetDirectory(id), entry.name)), referenced: referenced.has(path) };
  }));
  assets.sort((a, b) => Number(a.referenced) - Number(b.referenced) || a.name.localeCompare(b.name));

  const [audio, output, pages, snapshots] = await Promise.all([
    directoryBytes(resolve(publicRoot, 'audio'), name => name.startsWith(`${id}-`)),
    directoryBytes(resolve(root, id, 'output')),
    directoryBytes(resolve(root, id, 'pages')),
    listSnapshots(id),
  ]);
  const source = project.sourcePath ? await bytesOf(resolve(process.cwd(), '..', '..', project.sourcePath)) : 0;
  const backups = snapshots.reduce((sum, snapshot) => sum + snapshot.bytes, 0);
  const assetBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  return NextResponse.json({
    assets,
    unreferenced: assets.filter(asset => !asset.referenced).map(asset => asset.path),
    totals: { assets: assetBytes, audio, output, pages, source, backups, total: assetBytes + audio + output + pages + source + backups },
  });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lock = await getProjectLock(id);
  if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  if (lock.locked) return projectLockedResponse(lock.reason);
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: '请求内容不是有效 JSON' }, { status: 400 }); }
  const requested = (body as { paths?: unknown })?.paths;
  const paths = Array.isArray(requested) ? requested.filter((path): path is string => typeof path === 'string') : [];
  if (!paths.length) return NextResponse.json({ error: '请选择要清理的素材' }, { status: 400 });

  const project = await db.project.findUniqueOrThrow({ where: { id }, select: { storyboardJson: true, assetsJson: true } });
  const referenced = referencedPaths(project.storyboardJson);
  const assets = (() => { try { return JSON.parse(project.assetsJson) as Asset[]; } catch { return [] as Asset[]; } })();
  // Sources, exports and snapshots live outside the asset folder, so only
  // `projects/<id>/assets/<file>` can ever be deleted here.
  const allowed = new RegExp(`^projects/${id}/assets/[^/\\\\]+$`);
  const deleted: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    if (!allowed.test(path) || referenced.has(path)) continue;
    const name = path.split('/').at(-1)!;
    if (!name || name === '.' || name === '..') continue;
    bytes += await bytesOf(resolve(assetDirectory(id), name));
    await Promise.all([
      rm(resolve(assetDirectory(id), name), { force: true }),
      rm(resolve(publicAssetDirectory(id), name), { force: true }),
    ]);
    deleted.push(path);
  }
  if (!deleted.length) return NextResponse.json({ error: '所选素材仍被场景引用或路径无效，未删除任何文件' }, { status: 409 });
  await db.project.update({ where: { id }, data: { assetsJson: JSON.stringify(assets.filter(asset => !deleted.includes(`projects/${id}/assets/${asset.name}`))) } });
  return NextResponse.json({ deleted, bytes });
}
