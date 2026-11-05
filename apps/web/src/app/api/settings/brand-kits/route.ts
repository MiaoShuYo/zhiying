import { NextResponse } from 'next/server';
import {
  BrandKitError,
  MAX_BRAND_KITS,
  deleteBrandKit,
  duplicateBrandKit,
  readBrandKits,
  saveBrandKit,
  setDefaultBrandKit,
  updateBrandKit,
} from '@/lib/brand-kits';

export const runtime = 'nodejs';

const failure = (error: unknown, fallback: string) => NextResponse.json(
  { error: error instanceof Error ? error.message : fallback },
  { status: error instanceof BrandKitError ? error.status : 500 },
);

async function readRequestJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new BrandKitError('请求 JSON 格式无效');
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrandKitError('请求内容必须是 JSON 对象');
  return value as Record<string, unknown>;
}

export async function GET() {
  try {
    return NextResponse.json({ brandKits: await readBrandKits(), max: MAX_BRAND_KITS });
  } catch (error) {
    return failure(error, '读取 Brand Kit 失败');
  }
}

export async function POST(request: Request) {
  try {
    const brandKit = await saveBrandKit(await readRequestJson(request));
    return NextResponse.json({ brandKit });
  } catch (error) {
    return failure(error, '保存 Brand Kit 失败');
  }
}

export async function PATCH(request: Request) {
  try {
    const body = recordOf(await readRequestJson(request));
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) throw new BrandKitError('缺少 Brand Kit ID');

    switch (body.action) {
      case 'update':
        return NextResponse.json({ brandKit: await updateBrandKit(id, body.patch) });
      case 'rename': {
        if (typeof body.name !== 'string') throw new BrandKitError('Brand Kit 名称无效');
        return NextResponse.json({ brandKit: await updateBrandKit(id, { name: body.name }) });
      }
      case 'duplicate':
        return NextResponse.json({ brandKit: await duplicateBrandKit(id) });
      case 'default':
        return NextResponse.json({ brandKit: await setDefaultBrandKit(id) });
      default:
        throw new BrandKitError('不支持的 Brand Kit 操作');
    }
  } catch (error) {
    return failure(error, '更新 Brand Kit 失败');
  }
}

export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get('id')?.trim();
    if (!id) throw new BrandKitError('缺少 Brand Kit ID');
    await deleteBrandKit(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return failure(error, '删除 Brand Kit 失败');
  }
}
