import { NextResponse } from 'next/server';
import { buildRenderEstimate } from '@/lib/render-plan-server';

export const runtime = 'nodejs';

/** Preview of the next render: reusable segments, expected duration and disk usage. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const preset = new URL(request.url).searchParams.get('preset') === 'draft' ? 'draft' : 'full';
  const payload = await buildRenderEstimate(id, preset);
  if (!payload) return NextResponse.json({ error: '请先生成并保存分镜' }, { status: 400 });
  return NextResponse.json(payload);
}
