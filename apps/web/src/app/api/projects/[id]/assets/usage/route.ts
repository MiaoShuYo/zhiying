import { NextResponse } from 'next/server';
import type { Storyboard } from '@m2v/schema';
import { scanAssetUsage, type AssetRecord } from '@/lib/asset-usage';
import { db } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return NextResponse.json({ error: '项目 ID 无效' }, { status: 400 });
  try {
    const project = await db.project.findUnique({ where: { id }, select: { storyboardJson: true, assetsJson: true } });
    if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
    if (!project.storyboardJson) return NextResponse.json({ error: '项目还没有分镜，素材使用情况需要先有分镜' }, { status: 409 });
    const storyboard = JSON.parse(project.storyboardJson) as Storyboard;
    const assets = JSON.parse(project.assetsJson || '[]') as AssetRecord[];
    return NextResponse.json(await scanAssetUsage({ id, storyboard, assets }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '素材检查失败' }, { status: 500 });
  }
}
