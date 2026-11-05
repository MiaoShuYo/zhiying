import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  BrandKitSchema,
  BrandLogoSchema,
  BrandPaletteSchema,
  BrandSnapshotSchema,
  BrandTypographySchema,
  StyleIdSchema,
  type BrandKit,
  type BrandSnapshot,
} from '@m2v/schema';
import { z } from 'zod';
import { copyBrandKitLogo, removeBrandKitLogoFiles } from './brand-kit-logo-files';

export const MAX_BRAND_KITS = 30;
export const BrandKitInputSchema = BrandSnapshotSchema.strict();
export const BrandKitPatchSchema = z.object({
  name: BrandSnapshotSchema.shape.name.optional(),
  baseStyleId: StyleIdSchema.optional(),
  colors: BrandPaletteSchema.deepPartial().optional(),
  typography: BrandTypographySchema.deepPartial().optional(),
  logo: BrandLogoSchema.partial().nullable().optional(),
}).strict().refine(patch => Object.keys(patch).length > 0, '至少提供一个要更新的字段');
export type BrandKitPatch = z.infer<typeof BrandKitPatchSchema>;

export class BrandKitError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const StoreSchema = z.array(BrandKitSchema).max(MAX_BRAND_KITS).superRefine((kits, ctx) => {
  const defaults = kits.filter(kit => kit.isDefault).length;
  if (defaults > 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Brand Kit 存储中不能有多个默认项' });
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  kits.forEach((kit, index) => {
    if (ids.has(kit.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'id'], message: 'Brand Kit ID 不能重复' });
    }
    ids.add(kit.id);

    const normalizedName = kit.name.toLowerCase();
    if (names.has(normalizedName)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'name'], message: 'Brand Kit 名称不能重复' });
    }
    names.add(normalizedName);
  });
});

const file = () => resolve(process.cwd(), '../..', 'data/settings/brand-kits.json');

function withDefault(kits: BrandKit[]): BrandKit[] {
  if (kits.length && !kits.some(kit => kit.isDefault)) kits[0] = { ...kits[0], isDefault: true };
  return kits;
}

function timestampAfter(...values: string[]): string {
  const previous = values.map(value => Date.parse(value)).filter(Number.isFinite);
  return new Date(Math.max(Date.now(), ...previous.map(value => value + 1))).toISOString();
}

function nameTaken(kits: BrandKit[], name: string, exceptId?: string): boolean {
  const normalized = name.toLowerCase();
  return kits.some(kit => kit.id !== exceptId && kit.name.toLowerCase() === normalized);
}

function copyName(base: string, attempt: number): string {
  const suffix = attempt === 1 ? ' 副本' : ` 副本 ${attempt}`;
  return `${base.slice(0, 40 - suffix.length).trimEnd()}${suffix}`;
}

function parseSnapshot(input: unknown): BrandSnapshot {
  const parsed = BrandKitInputSchema.safeParse(input);
  if (!parsed.success) throw new BrandKitError(parsed.error.issues[0]?.message ?? 'Brand Kit 内容无效');
  return parsed.data;
}

export async function readBrandKits(): Promise<BrandKit[]> {
  let raw: string;
  try {
    raw = await readFile(file(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new BrandKitError('读取 Brand Kit 存储失败，请检查文件访问权限', 500);
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BrandKitError('Brand Kit 存储文件不是有效 JSON，原文件已保留', 500);
  }

  const parsed = StoreSchema.safeParse(value);
  if (!parsed.success) throw new BrandKitError('Brand Kit 存储数据无效，原文件已保留', 500);
  return withDefault(parsed.data);
}

async function writeStore(kits: BrandKit[]): Promise<void> {
  const parsed = StoreSchema.safeParse(kits);
  if (!parsed.success) throw new BrandKitError('Brand Kit 数据无效，未保存');

  const target = file();
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temporary, JSON.stringify(parsed.data, null, 2), 'utf8');
    await rename(temporary, target);
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new BrandKitError('写入 Brand Kit 存储失败，原文件未被替换', 500);
  }
}

export async function saveBrandKit(input: unknown): Promise<BrandKit> {
  const value = parseSnapshot(input);
  const kits = await readBrandKits();
  if (nameTaken(kits, value.name)) throw new BrandKitError(`已存在名为「${value.name}」的 Brand Kit，请换一个名称`, 409);
  if (kits.length >= MAX_BRAND_KITS) throw new BrandKitError(`Brand Kit 最多保存 ${MAX_BRAND_KITS} 个，请先删除不用的项目`, 409);

  const now = new Date().toISOString();
  const created: BrandKit = {
    ...value,
    id: randomUUID(),
    isDefault: kits.length === 0,
    createdAt: now,
    updatedAt: now,
  };
  const next = withDefault([created, ...kits]);
  await writeStore(next);
  return next[0];
}

export async function updateBrandKit(id: string, patch: unknown): Promise<BrandKit> {
  const parsedPatch = BrandKitPatchSchema.safeParse(patch);
  if (!parsedPatch.success) throw new BrandKitError(parsedPatch.error.issues[0]?.message ?? 'Brand Kit 更新内容无效');

  const kits = await readBrandKits();
  const index = kits.findIndex(kit => kit.id === id);
  if (index < 0) throw new BrandKitError('找不到这个 Brand Kit，可能已被删除', 404);

  const current = kits[index];
  const patchValue = parsedPatch.data;
  if (patchValue.name && nameTaken(kits, patchValue.name, id)) {
    throw new BrandKitError(`已存在名为「${patchValue.name}」的 Brand Kit，请换一个名称`, 409);
  }

  const { logo: patchLogo, ...rest } = patchValue;
  const merged = {
    ...current,
    ...rest,
    colors: { ...current.colors, ...patchValue.colors },
    typography: { ...current.typography, ...patchValue.typography },
    ...(patchLogo === null ? { logo: undefined } : patchLogo ? { logo: { ...current.logo, ...patchLogo } } : {}),
    updatedAt: timestampAfter(current.updatedAt),
  };
  const parsed = BrandKitSchema.safeParse(merged);
  if (!parsed.success) throw new BrandKitError(parsed.error.issues[0]?.message ?? 'Brand Kit 更新内容无效');

  kits[index] = parsed.data;
  await writeStore(kits);
  return kits[index];
}

export async function duplicateBrandKit(id: string): Promise<BrandKit> {
  const kits = await readBrandKits();
  const source = kits.find(kit => kit.id === id);
  if (!source) throw new BrandKitError('找不到这个 Brand Kit，可能已被删除', 404);
  if (kits.length >= MAX_BRAND_KITS) throw new BrandKitError(`Brand Kit 最多保存 ${MAX_BRAND_KITS} 个，请先删除不用的项目`, 409);

  let name = copyName(source.name, 1);
  for (let attempt = 2; nameTaken(kits, name); attempt++) name = copyName(source.name, attempt);
  const now = timestampAfter(source.createdAt, source.updatedAt);
  const newId = randomUUID();
  let copiedLogoSrc: string | null = null;
  try {
    copiedLogoSrc = await copyBrandKitLogo(id, newId, source.logo?.src);
  } catch {
    throw new BrandKitError('Brand Kit Logo 文件缺失或无法复制，原 Brand Kit 未更改', 500);
  }
  const copy: BrandKit = {
    ...source,
    ...(source.logo ? { logo: { ...source.logo, ...(copiedLogoSrc ? { src: copiedLogoSrc } : {}) } } : {}),
    id: newId,
    name,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await writeStore([copy, ...kits]);
  } catch (error) {
    if (copiedLogoSrc) await removeBrandKitLogoFiles(newId).catch(() => undefined);
    throw error;
  }
  return copy;
}

export async function setDefaultBrandKit(id: string): Promise<BrandKit> {
  const kits = await readBrandKits();
  const index = kits.findIndex(kit => kit.id === id);
  if (index < 0) throw new BrandKitError('找不到这个 Brand Kit，可能已被删除', 404);

  const next = kits.map((kit, at) => ({
    ...kit,
    isDefault: at === index,
    updatedAt: at === index ? timestampAfter(kit.updatedAt) : kit.updatedAt,
  }));
  await writeStore(next);
  return next[index];
}

export async function deleteBrandKit(id: string): Promise<void> {
  const kits = await readBrandKits();
  const next = kits.filter(kit => kit.id !== id);
  if (next.length === kits.length) throw new BrandKitError('找不到这个 Brand Kit，可能已被删除', 404);

  await writeStore(withDefault(next));
  try {
    await removeBrandKitLogoFiles(id);
  } catch {
    throw new BrandKitError('Brand Kit 已删除，但 Logo 文件未能清理', 500);
  }
}
