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
    return withDefault(StoreSchema.parse(JSON.parse(await readFile(file(), 'utf8'))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Exactly one preset is the default; the newest one wins when the store has none. */
function withDefault(presets: ExportPreset[]) {
  if (!presets.length) return presets;
  if (!presets.some(preset => preset.isDefault)) presets[0] = { ...presets[0], isDefault: true };
  return presets;
}

const nameTaken = (presets: ExportPreset[], name: string, exceptId?: string) =>
  presets.some(preset => preset.id !== exceptId && preset.name.toLowerCase() === name.toLowerCase());

const cleanName = (input: unknown) => {
  const name = typeof input === 'string' ? input.trim() : '';
  if (!name) throw new ExportPresetError('预设名称不能为空');
  if (name.length > 40) throw new ExportPresetError('预设名称最多 40 个字');
  return name;
};

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
  const defaultProvided = Boolean(input && typeof input === 'object' && Object.prototype.hasOwnProperty.call(input, 'isDefault'));
  const presets = await readExportPresets();
  if (nameTaken(presets, value.name, id)) {
    throw new ExportPresetError(`已存在名为「${value.name}」的预设，请换一个名称`, 409);
  }
  const index = id ? presets.findIndex(preset => preset.id === id) : -1;
  if (id && index < 0) throw new ExportPresetError('找不到这个导出预设，可能已被删除', 404);
  const now = new Date().toISOString();
  if (index >= 0) {
    const isDefault = defaultProvided ? value.isDefault : presets[index].isDefault;
    presets[index] = { ...presets[index], ...value, isDefault, updatedAt: now };
    if (isDefault) presets.forEach((preset, at) => { if (at !== index) preset.isDefault = false; });
    const next = withDefault(presets);
    await writeStore(next);
    return next[index];
  }
  if (presets.length >= MAX_EXPORT_PRESETS) {
    throw new ExportPresetError(`导出预设最多保存 ${MAX_EXPORT_PRESETS} 个，请先删除不用的预设`, 409);
  }
  const isDefault = value.isDefault || presets.length === 0;
  if (isDefault) presets.forEach(preset => { preset.isDefault = false; });
  const created: ExportPreset = { ...value, isDefault, id: randomUUID(), createdAt: now, updatedAt: now };
  const next = withDefault([created, ...presets]);
  await writeStore(next);
  return next[0];
}

export async function renameExportPreset(id: string, name: unknown): Promise<ExportPreset> {
  const presets = await readExportPresets();
  const index = presets.findIndex(preset => preset.id === id);
  if (index < 0) throw new ExportPresetError('找不到这个导出预设，可能已被删除', 404);
  const cleaned = cleanName(name);
  if (nameTaken(presets, cleaned, id)) throw new ExportPresetError(`已存在名为「${cleaned}」的预设，请换一个名称`, 409);
  presets[index] = { ...presets[index], name: cleaned, updatedAt: new Date().toISOString() };
  await writeStore(presets);
  return presets[index];
}

const copyName = (base: string, attempt: number) => {
  const suffix = attempt === 1 ? ' 副本' : ` 副本 ${attempt}`;
  return `${base.slice(0, 40 - suffix.length).trimEnd()}${suffix}`;
};

export async function duplicateExportPreset(id: string): Promise<ExportPreset> {
  const presets = await readExportPresets();
  const source = presets.find(preset => preset.id === id);
  if (!source) throw new ExportPresetError('找不到这个导出预设，可能已被删除', 404);
  if (presets.length >= MAX_EXPORT_PRESETS) {
    throw new ExportPresetError(`导出预设最多保存 ${MAX_EXPORT_PRESETS} 个，请先删除不用的预设`, 409);
  }
  let name = copyName(source.name, 1);
  for (let attempt = 2; nameTaken(presets, name); attempt++) name = copyName(source.name, attempt);
  const now = new Date().toISOString();
  const copy: ExportPreset = { ...source, id: randomUUID(), name, isDefault: false, createdAt: now, updatedAt: now };
  await writeStore([copy, ...presets]);
  return copy;
}

export async function setDefaultExportPreset(id: string): Promise<ExportPreset> {
  const presets = await readExportPresets();
  const index = presets.findIndex(preset => preset.id === id);
  if (index < 0) throw new ExportPresetError('找不到这个导出预设，可能已被删除', 404);
  const now = new Date().toISOString();
  const next = presets.map((preset, at) => ({ ...preset, isDefault: at === index, updatedAt: at === index ? now : preset.updatedAt }));
  await writeStore(next);
  return next[index];
}

export async function deleteExportPreset(id: string) {
  const presets = await readExportPresets();
  const next = withDefault(presets.filter(preset => preset.id !== id));
  if (next.length === presets.length) throw new ExportPresetError('找不到这个导出预设，可能已被删除', 404);
  await writeStore(next);
}
