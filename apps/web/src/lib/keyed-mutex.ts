/**
 * In-process async mutex keyed by name.
 *
 * Settings stores (Brand Kits, export presets) are JSON files rewritten with an atomic rename,
 * which prevents torn files but not lost updates: two requests could read the same list and the
 * later write silently dropped the earlier one (#188, #281). Every read/validate/modify/write
 * sequence now runs under the store's key, so mutations apply one after another.
 *
 * The registry lives on globalThis because Next.js can load a module more than once (route
 * bundles, dev HMR); a module-level Map would then hand out independent locks for one store.
 * Locks are not re-entrant: never acquire the same key again inside its own critical section.
 */
type LockRegistry = Map<string, Promise<void>>;

const globalLocks = globalThis as typeof globalThis & { __m2vKeyedLocks?: LockRegistry };
const registry: LockRegistry = globalLocks.__m2vKeyedLocks ?? (globalLocks.__m2vKeyedLocks = new Map());

export async function withKeyedLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = registry.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolveRelease => { release = resolveRelease; });
  const tail = previous.then(() => current);
  registry.set(key, tail);
  try {
    await previous;
    return await operation();
  } finally {
    release();
    if (registry.get(key) === tail) registry.delete(key);
  }
}
