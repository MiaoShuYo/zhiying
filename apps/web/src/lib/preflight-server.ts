import { preflight, type PreflightPreset, type PreflightResult } from '@m2v/schema';
import { db } from '@/lib/db';
import { parseProject } from '@/lib/pipeline';
import { publicFileExists } from '@/lib/public-paths';

export async function projectPreflight(id: string, preset: PreflightPreset = 'full'): Promise<{ name: string; status: string; result: PreflightResult } | null> {
  const project = await db.project.findUnique({ where: { id }, include: { scenes: true } });
  if (!project?.storyboardJson) return null;
  const parsed = parseProject(project);
  if (!parsed.storyboard) return null;
  return { name: parsed.name, status: parsed.status, result: preflight(parsed.storyboard, parsed.assets, { preset, exists: publicFileExists }) };
}
