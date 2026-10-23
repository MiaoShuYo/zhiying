import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PreflightPreset } from '@m2v/schema';

/** The last time the export check passed, and the revision it passed on. */
export type PreflightPass = {
  version: 1;
  projectId: string;
  revision: number;
  preset: PreflightPreset;
  at: string;
};

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function preflightStatePath(projectId: string) {
  if (!SAFE_ID.test(projectId)) throw new Error('项目 ID 不合法');
  return resolve(process.cwd(), '..', '..', 'data', 'projects', projectId, 'preflight.json');
}

const isPass = (value: unknown): value is PreflightPass => {
  if (!value || typeof value !== 'object') return false;
  const pass = value as Partial<PreflightPass>;
  return pass.version === 1 && typeof pass.projectId === 'string' && typeof pass.revision === 'number' && typeof pass.at === 'string';
};

export async function readPreflightPass(projectId: string): Promise<PreflightPass | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(preflightStatePath(projectId), 'utf8'));
    return isPass(parsed) && parsed.projectId === projectId ? parsed : null;
  } catch {
    return null;
  }
}

export async function writePreflightPass(input: { projectId: string; revision: number; preset: PreflightPreset }): Promise<PreflightPass> {
  const pass: PreflightPass = { version: 1, projectId: input.projectId, revision: input.revision, preset: input.preset, at: new Date().toISOString() };
  const file = preflightStatePath(input.projectId);
  await mkdir(resolve(file, '..'), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(pass), 'utf8');
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return pass;
}
