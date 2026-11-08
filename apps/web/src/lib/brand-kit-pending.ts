import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BrandSnapshotSchema, type BrandKit, type BrandSnapshot, type Storyboard } from '@m2v/schema';
import { readBrandKits } from './brand-kits';
import { copyBrandLogoToProject } from './brand-kit-logo-files';

/**
 * 新建项目时的“待注入品牌”（V1.6.7 #48）。
 *
 * 创建项目时还没有 Storyboard，因此在 data/projects/<id>/import-settings.json 里
 * 记下 pending brandKitId；`runProject` 首次构造 storyboard 时把品牌库条目复制成
 * 项目快照（Logo 复制为项目自有文件），成功落库后再清除 pending。
 *
 * 这样可以避免 Prisma 迁移（真实库 data/m2v.db 有备份约定），也不会丢用户的选择。
 */

export type ImportSettings = {
  preferLocalAI?: boolean;
  generationMode?: 'standard' | 'html';
  /** Only present while the project has not built its first storyboard yet. */
  brandKitId?: string;
};

export function importSettingsPath(projectId: string): string {
  return resolve(process.cwd(), '../../data/projects', projectId, 'import-settings.json');
}

/** 纯函数：只接受已知字段，忽略损坏/未知的 JSON 内容。 */
export function parseImportSettings(value: unknown): ImportSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const settings: ImportSettings = {};
  if (record.preferLocalAI === true) settings.preferLocalAI = true;
  if (record.generationMode === 'html' || record.generationMode === 'standard') settings.generationMode = record.generationMode;
  const brandKitId = typeof record.brandKitId === 'string' ? record.brandKitId.trim() : '';
  if (brandKitId) settings.brandKitId = brandKitId;
  return settings;
}

export async function readImportSettings(projectId: string): Promise<ImportSettings> {
  try {
    return parseImportSettings(JSON.parse(await readFile(importSettingsPath(projectId), 'utf8')));
  } catch {
    // 首次创建或文件损坏都按“没有 pending 设置”处理，项目流程不能因此失败。
    return {};
  }
}

export async function writeImportSettings(projectId: string, settings: ImportSettings): Promise<void> {
  const target = importSettingsPath(projectId);
  await mkdir(resolve(target, '..'), { recursive: true });
  const value = {
    preferLocalAI: settings.preferLocalAI === true,
    generationMode: settings.generationMode === 'html' ? 'html' : 'standard',
    ...(settings.brandKitId ? { brandKitId: settings.brandKitId } : {}),
  };
  await writeFile(target, JSON.stringify(value), 'utf8');
}

/**
 * Creation-time guard: only persist a brand choice that still exists in the library.
 * A stale/deleted id is ignored instead of failing project creation.
 */
export async function resolveCreationBrandKitId(brandKitId: unknown): Promise<string | undefined> {
  const id = typeof brandKitId === 'string' ? brandKitId.trim() : '';
  if (!id) return undefined;
  try {
    return (await readBrandKits()).some(kit => kit.id === id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** 品牌库条目 → 项目快照，后续库修改不会穿透到旧项目。 */
export function snapshotFromBrandKit(kit: BrandKit): BrandSnapshot {
  return BrandSnapshotSchema.parse({
    name: kit.name,
    baseStyleId: kit.baseStyleId,
    colors: { ...kit.colors },
    typography: { ...kit.typography },
    ...(kit.logo ? { logo: { ...kit.logo } } : {}),
  });
}

export type PendingBrand = { brandKitId: string; brand: BrandSnapshot };

/**
 * Resolves the pending brand snapshot, copying its Logo into project-owned storage.
 *
 * Failure policy: a deleted library entry is skipped (the project must still generate);
 * a missing Logo file keeps the snapshot but drops the Logo so one bad asset cannot
 * fail the whole storyboard run — preflight still reports the missing Logo resource.
 */
export async function pendingBrandForProject(projectId: string): Promise<PendingBrand | null> {
  const settings = await readImportSettings(projectId);
  if (!settings.brandKitId) return null;

  let kit: BrandKit | undefined;
  try {
    kit = (await readBrandKits()).find(item => item.id === settings.brandKitId);
  } catch (error) {
    console.warn(`[brand-pending] 读取品牌库失败，跳过 pending 品牌注入：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (!kit) return null;

  const brand = snapshotFromBrandKit(kit);
  if (brand.logo) {
    try {
      brand.logo = { ...brand.logo, src: await copyBrandLogoToProject(projectId, brand.logo.src) };
    } catch (error) {
      console.warn(`[brand-pending] 品牌 Logo 复制失败，保留无 Logo 快照：${error instanceof Error ? error.message : String(error)}`);
      delete brand.logo;
    }
  }
  return { brandKitId: kit.id, brand };
}

/** Called by runProject right before the first storyboard is persisted. */
export async function applyPendingBrandSnapshot(projectId: string, storyboard: Storyboard): Promise<Storyboard> {
  const pending = await pendingBrandForProject(projectId);
  if (!pending) return storyboard;
  return { ...storyboard, brandKitId: pending.brandKitId, brand: pending.brand };
}

/**
 * Removes only the pending brandKitId after the first storyboard lands. Keeping
 * preferLocalAI/generationMode intact means import settings stay reusable.
 */
export async function consumePendingBrandKitId(projectId: string): Promise<boolean> {
  const settings = await readImportSettings(projectId);
  if (!settings.brandKitId) return false;
  const { brandKitId: _consumed, ...rest } = settings;
  await writeImportSettings(projectId, rest);
  return true;
}
