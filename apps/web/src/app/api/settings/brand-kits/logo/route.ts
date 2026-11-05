import { extname } from 'node:path';
import sharp from 'sharp';
import { NextResponse } from 'next/server';
import {
  BrandKitError,
  readBrandKits,
  updateBrandKit,
} from '@/lib/brand-kits';
import {
  replaceBrandKitLogoFiles,
  type BrandLogoExtension,
} from '@/lib/brand-kit-logo-files';

export const runtime = 'nodejs';

const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const MAX_LOGO_PIXELS = 40_000_000;
const accepted = {
  '.png': { mime: 'image/png', format: 'png' },
  '.jpg': { mime: 'image/jpeg', format: 'jpeg' },
  '.jpeg': { mime: 'image/jpeg', format: 'jpeg' },
  '.webp': { mime: 'image/webp', format: 'webp' },
} as const;

function failure(error: unknown, fallback: string) {
  return NextResponse.json(
    { error: error instanceof BrandKitError ? error.message : fallback },
    { status: error instanceof BrandKitError ? error.status : 500 },
  );
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: '请求必须是有效的 multipart 表单' }, { status: 400 });
  }

  const idValue = form.get('brandKitId');
  const file = form.get('file');
  if (typeof idValue !== 'string' || !idValue.trim()) {
    return NextResponse.json({ error: '缺少 Brand Kit ID' }, { status: 400 });
  }
  const brandKitId = idValue.trim();
  if (!(file instanceof File)) return NextResponse.json({ error: '请选择 Logo 文件' }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: 'Logo 文件不能为空' }, { status: 400 });
  if (file.size > MAX_LOGO_BYTES) return NextResponse.json({ error: 'Logo 文件不能超过 5 MiB' }, { status: 413 });

  try {
    const kits = await readBrandKits();
    const brandKit = kits.find(kit => kit.id === brandKitId);
    if (!brandKit) throw new BrandKitError('找不到这个 Brand Kit', 404);

    const extension = extname(file.name).toLowerCase() as keyof typeof accepted;
    const expected = accepted[extension];
    if (!expected || file.type.toLowerCase() !== expected.mime) {
      throw new BrandKitError('Logo 扩展名与 MIME 类型不匹配，仅支持 PNG、JPG 和 WebP');
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length === 0) throw new BrandKitError('Logo 文件不能为空');
    if (bytes.length > MAX_LOGO_BYTES) throw new BrandKitError('Logo 文件不能超过 5 MiB', 413);

    let normalized: Buffer;
    try {
      const input = sharp(bytes, { failOn: 'error', limitInputPixels: MAX_LOGO_PIXELS, sequentialRead: true });
      const metadata = await input.metadata();
      if (metadata.format !== expected.format) throw new BrandKitError('Logo 实际图片格式与扩展名不匹配');
      if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_LOGO_PIXELS) {
        throw new BrandKitError('Logo 图片尺寸不能超过 40 MP');
      }
      if (metadata.pages && metadata.pages > 1) throw new BrandKitError('Logo 只支持单帧图片');

      const decoder = sharp(bytes, { failOn: 'error', limitInputPixels: MAX_LOGO_PIXELS, sequentialRead: true }).rotate();
      normalized = expected.format === 'png'
        ? await decoder.png().toBuffer()
        : expected.format === 'jpeg'
          ? await decoder.jpeg().toBuffer()
          : await decoder.webp().toBuffer();
      if (!normalized.length) throw new BrandKitError('Logo 图片内容无效');
    } catch (error) {
      if (error instanceof BrandKitError) throw error;
      throw new BrandKitError('Logo 图片无法解码或内容已损坏');
    }

    const logoExtension: BrandLogoExtension = extension.slice(1) as BrandLogoExtension;
    let updatedBrandKit;
    await replaceBrandKitLogoFiles({
      brandKitId,
      extension: logoExtension,
      bytes: normalized,
      previousSrc: brandKit.logo?.src,
      commit: async src => { updatedBrandKit = await updateBrandKit(brandKitId, { logo: { src } }); },
    });
    return NextResponse.json({ brandKit: updatedBrandKit });
  } catch (error) {
    return failure(error, '上传 Brand Kit Logo 失败');
  }
}
