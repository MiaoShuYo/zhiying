import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CachedSegment, PlannedSegment } from '@m2v/schema';

/** Segments are kept for the last few renders; older ones are dropped by LRU. */
export const MAX_SEGMENT_CACHE_BYTES = 2 * 1024 * 1024 * 1024;

export const segmentDir = (outputDir: string, preset: string) => join(outputDir, 'segments', preset === 'draft' ? 'draft' : 'full');

const safeKey = (key: string) => key.replace(/[^A-Za-z0-9_-]+/g, '-');

export const segmentVideoPath = (dir: string, segment: Pick<PlannedSegment, 'key' | 'fingerprint'>) => join(dir, `${safeKey(segment.key)}-${segment.fingerprint}.mp4`);

export const segmentMetaPath = (dir: string, segment: Pick<PlannedSegment, 'key' | 'fingerprint'>) => join(dir, `${safeKey(segment.key)}-${segment.fingerprint}.json`);

/** Reads every sidecar in the cache directory; broken sidecars are ignored. */
export async function readSegmentIndex(dir: string): Promise<CachedSegment[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const index: CachedSegment[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, entry), 'utf8')) as CachedSegment;
      if (!parsed || typeof parsed.fingerprint !== 'string' || !Number.isFinite(parsed.frames) || parsed.frames <= 0) continue;
      if (!(await stat(join(dir, entry.replace(/\.json$/, '.mp4'))).catch(() => null))) continue;
      index.push(parsed);
    } catch {
      // A cache entry written by a crashed worker is simply rebuilt.
    }
  }
  return index;
}

export async function writeSegmentMeta(dir: string, segment: PlannedSegment, bytes: number, preset: string) {
  await writeFile(segmentMetaPath(dir, segment), JSON.stringify({
    key: segment.key,
    kind: segment.kind,
    fingerprint: segment.fingerprint,
    frames: segment.frames,
    bytes,
    parts: segment.parts,
    version: 1,
    preset,
    createdAt: new Date().toISOString(),
  } satisfies CachedSegment), 'utf8');
  return bytes;
}

export const segmentBytes = async (file: string) => (await stat(file).catch(() => null))?.size ?? 0;

/**
 * Drops cache files that no longer belong to a render, then trims the oldest
 * remaining files until the directory fits into the budget.
 */
export async function pruneSegmentCache(dir: string, keep: Set<string>, maxBytes = MAX_SEGMENT_CACHE_BYTES): Promise<{ removed: number; bytes: number }> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const files: { path: string; size: number; mtimeMs: number; fingerprint: string }[] = [];
  let removed = 0;
  for (const entry of entries) {
    const path = join(dir, entry);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    const fingerprint = entry.replace(/\.(mp4|json)$/, '').split('-').pop() ?? '';
    if (entry.endsWith('.mp4') && !keep.has(fingerprint)) {
      await rm(path, { force: true }).catch(() => {});
      await rm(path.replace(/\.mp4$/, '.json'), { force: true }).catch(() => {});
      removed += 1;
      continue;
    }
    if (entry.endsWith('.json') && !(await stat(path.replace(/\.json$/, '.mp4')).catch(() => null))) {
      await rm(path, { force: true }).catch(() => {});
      removed += 1;
      continue;
    }
    files.push({ path, size: info.size, mtimeMs: info.mtimeMs, fingerprint });
  }
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
    if (total <= maxBytes) break;
    if (keep.has(file.fingerprint)) continue;
    await rm(file.path, { force: true }).catch(() => {});
    total -= file.size;
    removed += 1;
  }
  return { removed, bytes: total };
}

export async function ensureSegmentDir(dir: string) {
  await mkdir(dir, { recursive: true });
}
