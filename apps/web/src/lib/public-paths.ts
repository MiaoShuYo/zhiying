import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Public assets are addressed as `projects/<id>/assets/<file>` or `audio/<file>`; never escape `public/`. */
export function resolvePublicPath(path: string): string | null {
  const relative = path.replace(/\\/g, '/');
  if (!relative || relative.includes('..') || relative.startsWith('/')) return null;
  return resolve(process.cwd(), 'public', relative);
}

export function publicFileExists(path: string) {
  const absolute = resolvePublicPath(path);
  return Boolean(absolute && existsSync(absolute));
}
