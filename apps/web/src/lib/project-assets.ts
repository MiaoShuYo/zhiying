import { db } from '@/lib/db';

const MAX_ATTEMPTS = 20;

/**
 * Atomically read-modify-write a project's `assetsJson` (#321).
 *
 * Upload, Commons import, archive, restore, purge and cleanup used to read the list, change it in
 * memory and write it back, so overlapping requests each reported success while only the last
 * write survived. The update now only applies when `assetsJson` still holds the value that was
 * read (compare-and-swap in SQLite); otherwise the list is read again and `mutate` re-applied.
 * This also holds across processes. `mutate` must be a pure function of the list it receives.
 */
export async function mutateProjectAssets<T extends object>(projectId: string, mutate: (assets: T[]) => T[]): Promise<T[]> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { assetsJson: true } });
    let current: T[];
    try {
      current = JSON.parse(project.assetsJson || '[]') as T[];
    } catch {
      current = [];
    }
    const next = mutate(Array.isArray(current) ? current : []);
    const changed = await db.project.updateMany({ where: { id: projectId, assetsJson: project.assetsJson }, data: { assetsJson: JSON.stringify(next) } });
    if (changed.count) return next;
    await new Promise(resolveWait => setTimeout(resolveWait, 10 + Math.random() * 40));
  }
  throw new Error('素材列表正被其他操作同时修改，请稍后重试');
}
