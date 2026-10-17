import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { preflight, type PreflightPreset, type PreflightResult } from '@m2v/schema';
import { db } from '@/lib/db';
import { parseProject } from '@/lib/pipeline';

/** Public assets are addressed as `projects/<id>/assets/<file>` or `audio/<file>`; never escape `public/`. */
function publicFileExists(path: string) {
  const relative = path.replace(/\\/g, '/');
  if (!relative || relative.includes('..') || relative.startsWith('/')) return false;
  return existsSync(resolve(process.cwd(), 'public', relative));
}

export async function projectPreflight(id: string, preset: PreflightPreset = 'full'): Promise<{ name: string; status: string; result: PreflightResult } | null> {
  const project = await db.project.findUnique({ where: { id }, include: { scenes: true } });
  if (!project?.storyboardJson) return null;
  const parsed = parseProject(project);
  if (!parsed.storyboard) return null;
  return { name: parsed.name, status: parsed.status, result: preflight(parsed.storyboard, parsed.assets, { preset, exists: publicFileExists }) };
}
