import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Storyboard } from '@m2v/schema';

export type AssetRecord = {
  path: string;
  name: string;
  kind?: string;
  displayName?: string;
  archived?: boolean;
  archivedAt?: string;
};

export type AssetSceneRef = { index: number; title?: string };
export type AssetRef = { path: string; scenes: AssetSceneRef[]; bgm: boolean };
export type AssetFileRef = { path: string; name: string; displayName?: string; bytes: number; archived?: boolean };
export type AssetMissing = { path: string; kind: 'image' | 'audio' | 'bgm'; scenes: AssetSceneRef[]; registered: boolean; archived?: boolean };
export type AssetDuplicate = { hash: string; paths: string[]; bytes: number };

export type AssetUsage = {
  total: number;
  bytes: number;
  referenced: AssetRef[];
  unused: AssetFileRef[];
  archived: AssetFileRef[];
  missing: AssetMissing[];
  duplicates: AssetDuplicate[];
  scannedAt: string;
};

const audioExtensions = /\.(?:mp3|wav|m4a|ogg|flac)$/i;

/** Physical folders for one project, matching where `saveAsset` writes and where the worker syncs from. */
export function assetDirs(id: string) {
  const data = resolve(process.cwd(), '..', '..', 'data', 'projects', id, 'assets');
  return { data, dataArchive: resolve(data, 'archive'), public: resolve(process.cwd(), 'public', 'projects', id, 'assets') };
}

export function assetFilePath(id: string, asset: Pick<AssetRecord, 'name' | 'archived'>, side: 'data' | 'public' = 'data') {
  const dirs = assetDirs(id);
  const base = side === 'data' ? dirs.data : dirs.public;
  return asset.archived ? resolve(base, 'archive', asset.name) : resolve(base, asset.name);
}

export const assetIndexPath = (id: string) => resolve(process.cwd(), '..', '..', 'data', 'projects', id, 'asset-index.json');

function validName(name: unknown): name is string {
  return typeof name === 'string' && Boolean(name) && !/[\\/]/.test(name) && name !== '.' && name !== '..';
}

/** Mirrors the worker's reference scan: every string under `visual` plus the scene voice track. */
function visualPaths(value: unknown, into: string[]) {
  if (typeof value === 'string') { if (/^projects\/[A-Za-z0-9_-]+\/assets\/[^/]+$/.test(value)) into.push(value); return; }
  if (Array.isArray(value)) { value.forEach(item => visualPaths(item, into)); return; }
  if (value && typeof value === 'object') Object.values(value).forEach(item => visualPaths(item, into));
}

export function storyboardReferences(board: Storyboard): AssetRef[] {
  const refs = new Map<string, AssetRef>();
  const touch = (path: string, scene?: AssetSceneRef, bgm = false) => {
    const ref = refs.get(path) ?? { path, scenes: [], bgm: false };
    if (bgm) ref.bgm = true;
    if (scene && !ref.scenes.some(item => item.index === scene.index)) ref.scenes.push(scene);
    refs.set(path, ref);
  };
  board.scenes.forEach((scene, index) => {
    const sceneRef = { index, title: scene.title ?? scene.type };
    if (scene.audioSrc) touch(scene.audioSrc, sceneRef);
    const paths: string[] = []; visualPaths(scene.visual, paths); paths.forEach(path => touch(path, sceneRef));
  });
  if (board.bgmSrc) touch(board.bgmSrc, undefined, true);
  return [...refs.values()].sort((a, b) => a.path.localeCompare(b.path));
}

type HashCache = Record<string, { size: number; mtimeMs: number; hash: string }>;

async function readHashCache(id: string): Promise<HashCache> {
  try {
    const parsed: unknown = JSON.parse(await readFile(assetIndexPath(id), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    const cache: HashCache = {};
    for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const item = entry as Partial<HashCache[string]> | null;
      if (item && typeof item.hash === 'string' && typeof item.size === 'number' && typeof item.mtimeMs === 'number') cache[name] = { size: item.size, mtimeMs: item.mtimeMs, hash: item.hash };
    }
    return cache;
  } catch { return {}; }
}

async function writeHashCache(id: string, cache: HashCache) {
  const target = assetIndexPath(id);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(cache));
  await rename(temporary, target);
}

/** sha256 per file, recomputed only when `size + mtimeMs` changed. */
async function fileHashes(id: string, files: { name: string; absolute: string }[]): Promise<HashCache> {
  const cache = await readHashCache(id);
  const next: HashCache = {};
  for (const file of files) {
    try {
      const info = await stat(file.absolute);
      const cached = cache[file.name];
      const hash = cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs ? cached.hash : createHash('sha256').update(await readFile(file.absolute)).digest('hex');
      next[file.name] = { size: info.size, mtimeMs: info.mtimeMs, hash };
    } catch { /* A missing file is reported by the missing list, not by duplicates. */ }
  }
  await writeHashCache(id, next).catch(() => {});
  return next;
}

export async function scanAssetUsage(project: { id: string; storyboard: Storyboard; assets: AssetRecord[] }): Promise<AssetUsage> {
  const { id, storyboard } = project;
  const registered = project.assets.filter(asset => asset && typeof asset.path === 'string' && validName(asset.name));
  const refs = storyboardReferences(storyboard);
  const refByPath = new Map(refs.map(ref => [ref.path, ref]));
  const sizes = new Map<string, number>();
  for (const asset of registered) {
    try { sizes.set(asset.path, (await stat(assetFilePath(id, asset))).size); } catch { /* Missing, reported below. */ }
  }
  const missing: AssetMissing[] = [];
  for (const asset of registered) {
    if (sizes.has(asset.path)) continue;
    const kind = asset.kind === 'audio' ? 'audio' : 'image';
    missing.push({ path: asset.path, kind, scenes: refByPath.get(asset.path)?.scenes ?? [], registered: true, archived: asset.archived });
  }
  const publicFile = (path: string) => {
    const relative = path.replace(/\\/g, '/');
    if (!relative || relative.includes('..') || relative.startsWith('/')) return false;
    return existsSync(resolve(process.cwd(), 'public', relative));
  };
  for (const ref of refs) {
    if (sizes.has(ref.path) || missing.some(item => item.path === ref.path)) continue;
    if (publicFile(ref.path)) continue;
    missing.push({ path: ref.path, kind: ref.bgm ? 'bgm' : audioExtensions.test(ref.path) ? 'audio' : 'image', scenes: ref.scenes, registered: false });
  }
  const unused: AssetFileRef[] = [], archived: AssetFileRef[] = [];
  for (const asset of registered) {
    const entry = { path: asset.path, name: asset.name, displayName: asset.displayName, bytes: sizes.get(asset.path) ?? 0, archived: asset.archived };
    if (asset.archived) archived.push(entry);
    else if (!refByPath.has(asset.path)) unused.push(entry);
  }
  const hashes = await fileHashes(id, registered.filter(asset => !asset.archived && sizes.has(asset.path)).map(asset => ({ name: asset.name, absolute: assetFilePath(id, asset) })));
  const groups = new Map<string, { name: string; abs: string; size: number }[]>();
  for (const asset of registered) {
    const entry = hashes[asset.name];
    if (!entry || asset.archived) continue;
    const list = groups.get(entry.hash) ?? [];
    list.push({ name: asset.name, abs: assetFilePath(id, asset), size: entry.size });
    groups.set(entry.hash, list);
  }
  const duplicates: AssetDuplicate[] = [...groups.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([hash, files]) => ({ hash, paths: files.map(file => `projects/${id}/assets/${file.name}`), bytes: files[0].size }))
    .sort((a, b) => b.paths.length - a.paths.length || a.paths[0].localeCompare(b.paths[0]));
  return {
    total: registered.length,
    bytes: [...sizes.values()].reduce((sum, value) => sum + value, 0),
    referenced: refs,
    unused: unused.sort((a, b) => b.bytes - a.bytes),
    archived: archived.sort((a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name)),
    missing,
    duplicates,
    scannedAt: new Date().toISOString(),
  };
}
