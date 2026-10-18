import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ExportPresetSchema, type ExportPreset } from '@m2v/schema';

export const MAX_EXPORT_PRESETS = 30;
export const ExportPresetInputSchema = ExportPresetSchema.omit({ id: true, createdAt: true, updatedAt: true });

export class ExportPresetError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const StoreSchema = z.array(ExportPresetSchema).max(MAX_EXPORT_PRESETS);
const file = () => resolve(process.cwd(), '../..', 'data/settings/export-presets.json');

export async function readExportPresets(): Promise<ExportPreset[]> {
  try {
    return StoreSchema.parse(JSON.parse(await readFile(file(), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function writeStore(presets: ExportPreset[]) {
  const target = file();
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(presets, null, 2), 'utf8');
  await rename(temporary, target);
}

/** Creates or updates one preset. Names are compared case-insensitively to avoid twin presets. */
export async function saveExportPreset(input: unknown, id?: string): Promise<ExportPreset> {
  const parsed = ExportPresetInputSchema.safeParse(input);
  if (!parsed.success) throw new ExportPresetError(parsed.error.issues[0]?.message ?? '导出预设内容无效');
  const value = parsed.data;
  const presets = await readExportPresets();
  if (presets.some(preset => preset.id !== id && preset.name.toLowerCase() === value.name.toLowerCase())) {
    throw new ExportPresetError(`已存在名为「${value.name}」的预设，请换一个名称`, 409);
  }
  const index = id ? presets.findIndex(preset => preset.id === id) : -1;
  if (id && index < 0) throw new ExportPresetError('找不到这个导出预设，可能已被删除', 404);
  const now = new Date().toISOString();
  if (index >= 0) {
    const updated: ExportPreset = { ...presets[index], ...value, updatedAt: now };
    presets[index] = updated;
    await writeStore(presets);
    return updated;
  }
  if (presets.length >= MAX_EXPORT_PRESETS) {
    throw new ExportPresetError(`导出预设最多保存 ${MAX_EXPORT_PRESETS} 个，请先删除不用的预设`, 409);
  }
  const created: ExportPreset = { ...value, id: randomUUID(), createdAt: now, updatedAt: now };
  presets.unshift(created);
  await writeStore(presets);
  return created;
}

export async function deleteExportPreset(id: string) {
  const presets = await readExportPresets();
  const next = presets.filter(preset => preset.id !== id);
  if (next.length === presets.length) throw new ExportPresetError('找不到这个导出预设，可能已被删除', 404);
  await writeStore(next);
}
