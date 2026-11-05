import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

export type BrandLogoExtension = 'png' | 'jpg' | 'jpeg' | 'webp';

export type ManagedBrandLogoReference = {
  brandKitId: string;
  extension: BrandLogoExtension;
  src: string;
};

const supportedExtensions = new Set<BrandLogoExtension>(['png', 'jpg', 'jpeg', 'webp']);
const repoRoot = () => resolve(process.cwd(), '..', '..');

function assertSafeId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('Brand Kit ID 无效');
}

function assertWithin(base: string, target: string): void {
  const path = relative(base, target);
  if (!path || path.startsWith('..') || path.includes(':') || path.startsWith(sep)) throw new Error('Brand Kit Logo 路径无效');
}

export function managedBrandLogoReference(src: string): ManagedBrandLogoReference | null {
  const match = /^brand-kits\/([a-zA-Z0-9_-]{1,64})\/logo\.(png|jpe?g|webp)$/i.exec(src);
  if (!match) return null;
  const extension = match[2]!.toLowerCase() as BrandLogoExtension;
  if (!supportedExtensions.has(extension)) return null;
  const brandKitId = match[1]!;
  assertSafeId(brandKitId);
  return { brandKitId, extension, src: `brand-kits/${brandKitId}/logo.${extension}` };
}

export function brandKitLogoPaths(brandKitId: string, extension: BrandLogoExtension) {
  assertSafeId(brandKitId);
  if (!supportedExtensions.has(extension)) throw new Error('Brand Kit Logo 格式无效');
  const root = repoRoot();
  const dataBase = resolve(root, 'data', 'settings', 'brand-kits');
  const publicBase = resolve(root, 'apps', 'web', 'public', 'brand-kits');
  const dataDirectory = resolve(dataBase, brandKitId);
  const publicDirectory = resolve(publicBase, brandKitId);
  assertWithin(dataBase, dataDirectory);
  assertWithin(publicBase, publicDirectory);
  return {
    dataDirectory,
    publicDirectory,
    dataFile: resolve(dataDirectory, `logo.${extension}`),
    publicFile: resolve(publicDirectory, `logo.${extension}`),
    src: `brand-kits/${brandKitId}/logo.${extension}`,
  };
}

export function brandKitLogoSourcePath(reference: ManagedBrandLogoReference): string {
  return brandKitLogoPaths(reference.brandKitId, reference.extension).dataFile;
}

async function writeProjectAsset(target: string, bytes: Uint8Array): Promise<void> {
  const existing = await readFile(target).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    if (!existing.equals(Buffer.from(bytes))) throw new Error('项目 Logo 内容哈希冲突');
    return;
  }

  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(temporary, bytes, { flag: 'wx' });
    try {
      await rename(temporary, target);
    } catch (error) {
      const raced = await readFile(target).catch(() => null);
      if (!raced?.equals(Buffer.from(bytes))) throw error;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Pins a managed or already project-local Logo to immutable project-owned storage. */
export async function copyBrandLogoToProject(projectId: string, src: string): Promise<string> {
  const reference = managedBrandLogoReference(src);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(projectId)) throw new Error('项目 ID 无效');

  let sourceFile: string;
  let extension: BrandLogoExtension;
  if (reference) {
    sourceFile = brandKitLogoSourcePath(reference);
    extension = reference.extension;
  } else {
    const match = /^projects\/([a-zA-Z0-9_-]{1,64})\/assets\/(.+\.(png|jpe?g|webp))$/i.exec(src);
    if (!match || match[1] !== projectId || match[2]!.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'))) {
      throw new Error('品牌快照 Logo 必须引用受管理或当前项目内的 PNG、JPG、JPEG 或 WebP 文件');
    }
    extension = match[3]!.toLowerCase() as BrandLogoExtension;
    sourceFile = resolve(repoRoot(), 'data', 'projects', projectId, 'assets', ...match[2]!.split('/'));
    assertWithin(resolve(repoRoot(), 'data', 'projects', projectId), sourceFile);
  }

  const bytes = await readFile(sourceFile).catch(() => {
    throw new Error('品牌快照 Logo 文件缺失，无法保存');
  });
  const digest = createHash('sha256').update(bytes).digest('hex');
  const projectSrc = `projects/${projectId}/assets/brand-logos/${digest}.${extension}`;
  const root = repoRoot();
  const dataBase = resolve(root, 'data', 'projects', projectId);
  const publicBase = resolve(root, 'apps', 'web', 'public');
  const dataFile = resolve(dataBase, 'assets', 'brand-logos', `${digest}.${extension}`);
  const publicFile = resolve(publicBase, projectSrc);
  assertWithin(resolve(root, 'data', 'projects'), dataFile);
  assertWithin(publicBase, publicFile);

  await writeProjectAsset(dataFile, bytes);
  await writeProjectAsset(publicFile, bytes);
  return projectSrc;
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** Saves the two mirrors before committing metadata, restoring the old bytes if that commit fails. */
export async function replaceBrandKitLogoFiles(options: {
  brandKitId: string;
  extension: BrandLogoExtension;
  bytes: Uint8Array;
  previousSrc?: string;
  commit: (src: string) => Promise<void>;
}): Promise<string> {
  const target = brandKitLogoPaths(options.brandKitId, options.extension);
  const previous = options.previousSrc ? managedBrandLogoReference(options.previousSrc) : null;
  const token = randomUUID();
  const dataTemp = `${target.dataFile}.${token}.tmp`;
  const publicTemp = `${target.publicFile}.${token}.tmp`;
  const dataBackup = `${target.dataFile}.${token}.bak`;
  const publicBackup = `${target.publicFile}.${token}.bak`;
  let hadData = false;
  let hadPublic = false;
  let dataTouched = false;
  let publicTouched = false;
  let committed = false;

  try {
    await mkdir(target.dataDirectory, { recursive: true });
    await mkdir(target.publicDirectory, { recursive: true });
    await writeFile(dataTemp, options.bytes, { flag: 'wx' });
    await writeFile(publicTemp, options.bytes, { flag: 'wx' });

    hadData = await fileExists(target.dataFile);
    hadPublic = await fileExists(target.publicFile);
    if (hadData) await copyFile(target.dataFile, dataBackup);
    if (hadPublic) await copyFile(target.publicFile, publicBackup);

    await rename(dataTemp, target.dataFile);
    dataTouched = true;
    await rename(publicTemp, target.publicFile);
    publicTouched = true;
    await options.commit(target.src);
    committed = true;

    if (previous && previous.brandKitId === options.brandKitId && previous.extension !== options.extension) {
      const old = brandKitLogoPaths(previous.brandKitId, previous.extension);
      await Promise.all([
        rm(old.dataFile, { force: true }).catch(() => undefined),
        rm(old.publicFile, { force: true }).catch(() => undefined),
      ]);
    }
    return target.src;
  } catch {
    if (!committed && dataTouched) {
      await rm(target.dataFile, { force: true }).catch(() => undefined);
      if (hadData) await copyFile(dataBackup, target.dataFile).catch(() => undefined);
    }
    if (!committed && publicTouched) {
      await rm(target.publicFile, { force: true }).catch(() => undefined);
      if (hadPublic) await copyFile(publicBackup, target.publicFile).catch(() => undefined);
    }
    if (committed) return target.src;
    throw new Error('保存 Brand Kit Logo 失败，原配置已保留');
  } finally {
    await Promise.all([
      rm(dataTemp, { force: true }).catch(() => undefined),
      rm(publicTemp, { force: true }).catch(() => undefined),
      rm(dataBackup, { force: true }).catch(() => undefined),
      rm(publicBackup, { force: true }).catch(() => undefined),
    ]);
  }
}

/** Copy an uploaded, managed logo to a duplicate's independent storage locations. */
export async function copyBrandKitLogo(sourceId: string, destinationId: string, src?: string): Promise<string | null> {
  const reference = src ? managedBrandLogoReference(src) : null;
  if (!reference || reference.brandKitId !== sourceId) return null;
  const source = brandKitLogoPaths(sourceId, reference.extension);
  const destination = brandKitLogoPaths(destinationId, reference.extension);
  const token = randomUUID();
  const dataTemp = `${destination.dataFile}.${token}.tmp`;
  const publicTemp = `${destination.publicFile}.${token}.tmp`;
  try {
    await mkdir(destination.dataDirectory, { recursive: true });
    await mkdir(destination.publicDirectory, { recursive: true });
    await copyFile(source.dataFile, dataTemp);
    await copyFile(source.dataFile, publicTemp);
    await rename(dataTemp, destination.dataFile);
    await rename(publicTemp, destination.publicFile);
    return destination.src;
  } catch {
    await rm(destination.dataDirectory, { recursive: true, force: true }).catch(() => undefined);
    await rm(destination.publicDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw new Error('Brand Kit Logo 文件缺失或无法复制');
  } finally {
    await Promise.all([
      rm(dataTemp, { force: true }).catch(() => undefined),
      rm(publicTemp, { force: true }).catch(() => undefined),
    ]);
  }
}

export async function removeBrandKitLogoFiles(brandKitId: string): Promise<void> {
  assertSafeId(brandKitId);
  const root = repoRoot();
  const dataBase = resolve(root, 'data', 'settings', 'brand-kits');
  const publicBase = resolve(root, 'apps', 'web', 'public', 'brand-kits');
  const dataDirectory = resolve(dataBase, brandKitId);
  const publicDirectory = resolve(publicBase, brandKitId);
  assertWithin(dataBase, dataDirectory);
  assertWithin(publicBase, publicDirectory);
  try {
    await Promise.all([
      rm(dataDirectory, { recursive: true, force: true }),
      rm(publicDirectory, { recursive: true, force: true }),
    ]);
  } catch {
    throw new Error('Brand Kit Logo 文件清理失败');
  }
}
