import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ProductionTemplateSchema, type ProductionTemplate } from '@m2v/schema';

export const MAX_PRODUCTION_TEMPLATES = 30;
export const ProductionTemplateInputSchema = ProductionTemplateSchema.omit({ id: true, createdAt: true, updatedAt: true });

export class ProductionTemplateError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const StoreSchema = z.array(ProductionTemplateSchema).max(MAX_PRODUCTION_TEMPLATES);
const file = () => resolve(process.cwd(), '../..', 'data/settings/production-templates.json');

export async function readProductionTemplates(): Promise<ProductionTemplate[]> {
  try {
    return withDefault(StoreSchema.parse(JSON.parse(await readFile(file(), 'utf8'))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Exactly one template is the default; the newest one wins when the store has none. */
function withDefault(templates: ProductionTemplate[]) {
  if (!templates.length) return templates;
  if (!templates.some(template => template.isDefault)) templates[0] = { ...templates[0], isDefault: true };
  return templates;
}

const nameTaken = (templates: ProductionTemplate[], name: string, exceptId?: string) =>
  templates.some(template => template.id !== exceptId && template.name.toLowerCase() === name.toLowerCase());

const cleanName = (input: unknown) => {
  const name = typeof input === 'string' ? input.trim() : '';
  if (!name) throw new ProductionTemplateError('方案名称不能为空');
  if (name.length > 40) throw new ProductionTemplateError('方案名称最多 40 个字');
  return name;
};

async function writeStore(templates: ProductionTemplate[]) {
  const target = file();
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(templates, null, 2), 'utf8');
  await rename(temporary, target);
}

/** Creates or updates one template. Names are compared case-insensitively to avoid twin templates. */
export async function saveProductionTemplate(input: unknown, id?: string): Promise<ProductionTemplate> {
  const parsed = ProductionTemplateInputSchema.safeParse(input);
  if (!parsed.success) throw new ProductionTemplateError(parsed.error.issues[0]?.message ?? '制作方案内容无效');
  const value = parsed.data;
  const defaultProvided = Boolean(input && typeof input === 'object' && Object.prototype.hasOwnProperty.call(input, 'isDefault'));
  const templates = await readProductionTemplates();
  if (nameTaken(templates, value.name, id)) throw new ProductionTemplateError(`已存在名为「${value.name}」的方案，请换一个名称`, 409);
  const index = id ? templates.findIndex(template => template.id === id) : -1;
  if (id && index < 0) throw new ProductionTemplateError('找不到这个制作方案，可能已被删除', 404);
  const now = new Date().toISOString();
  if (index >= 0) {
    const isDefault = defaultProvided ? value.isDefault : templates[index].isDefault;
    templates[index] = { ...templates[index], ...value, isDefault, updatedAt: now };
    if (isDefault) templates.forEach((template, at) => { if (at !== index) template.isDefault = false; });
    const next = withDefault(templates);
    await writeStore(next);
    return next[index];
  }
  if (templates.length >= MAX_PRODUCTION_TEMPLATES) throw new ProductionTemplateError(`制作方案最多保存 ${MAX_PRODUCTION_TEMPLATES} 个，请先删除不用的方案`, 409);
  const isDefault = value.isDefault || templates.length === 0;
  if (isDefault) templates.forEach(template => { template.isDefault = false; });
  const created: ProductionTemplate = { ...value, isDefault, id: randomUUID(), createdAt: now, updatedAt: now };
  const next = withDefault([created, ...templates]);
  await writeStore(next);
  return next[0];
}

export async function renameProductionTemplate(id: string, name: unknown): Promise<ProductionTemplate> {
  const templates = await readProductionTemplates();
  const index = templates.findIndex(template => template.id === id);
  if (index < 0) throw new ProductionTemplateError('找不到这个制作方案，可能已被删除', 404);
  const cleaned = cleanName(name);
  if (nameTaken(templates, cleaned, id)) throw new ProductionTemplateError(`已存在名为「${cleaned}」的方案，请换一个名称`, 409);
  templates[index] = { ...templates[index], name: cleaned, updatedAt: new Date().toISOString() };
  await writeStore(templates);
  return templates[index];
}

const copyName = (base: string, attempt: number) => {
  const suffix = attempt === 1 ? ' 副本' : ` 副本 ${attempt}`;
  return `${base.slice(0, 40 - suffix.length).trimEnd()}${suffix}`;
};

export async function duplicateProductionTemplate(id: string): Promise<ProductionTemplate> {
  const templates = await readProductionTemplates();
  const source = templates.find(template => template.id === id);
  if (!source) throw new ProductionTemplateError('找不到这个制作方案，可能已被删除', 404);
  if (templates.length >= MAX_PRODUCTION_TEMPLATES) throw new ProductionTemplateError(`制作方案最多保存 ${MAX_PRODUCTION_TEMPLATES} 个，请先删除不用的方案`, 409);
  let name = copyName(source.name, 1);
  for (let attempt = 2; nameTaken(templates, name); attempt++) name = copyName(source.name, attempt);
  const now = new Date().toISOString();
  const copy: ProductionTemplate = { ...source, id: randomUUID(), name, isDefault: false, createdAt: now, updatedAt: now };
  await writeStore([copy, ...templates]);
  return copy;
}

export async function setDefaultProductionTemplate(id: string): Promise<ProductionTemplate> {
  const templates = await readProductionTemplates();
  const index = templates.findIndex(template => template.id === id);
  if (index < 0) throw new ProductionTemplateError('找不到这个制作方案，可能已被删除', 404);
  const now = new Date().toISOString();
  const next = templates.map((template, at) => ({ ...template, isDefault: at === index, updatedAt: at === index ? now : template.updatedAt }));
  await writeStore(next);
  return next[index];
}

export async function deleteProductionTemplate(id: string) {
  const templates = await readProductionTemplates();
  const next = withDefault(templates.filter(template => template.id !== id));
  if (next.length === templates.length) throw new ProductionTemplateError('找不到这个制作方案，可能已被删除', 404);
  await writeStore(next);
}
