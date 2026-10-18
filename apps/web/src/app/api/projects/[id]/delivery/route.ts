import { NextResponse } from 'next/server';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { db } from '@/lib/db';
import { buildDelivery } from '@/lib/delivery';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await db.project.count({ where: { id } }))) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  let jobId = '';
  try {
    jobId = String(((await request.json()) as { jobId?: unknown }).jobId ?? '');
  } catch { /* The newest finished render is the default. */ }
  if (!jobId) {
    const latest = await db.job.findFirst({
      where: { projectId: id, kind: 'render', status: 'completed' },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
    jobId = latest?.id ?? '';
  }
  if (!jobId) return NextResponse.json({ error: '还没有渲染完成的成片，无法生成交付包' }, { status: 409 });
  const result = await buildDelivery(id, jobId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const stream = Readable.toWeb(createReadStream(result.file)) as ReadableStream;
  return new Response(stream, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="delivery-${result.stamp}.zip"; filename*=UTF-8''${encodeURIComponent(result.name)}`,
      'content-length': String(result.bytes),
      'cache-control': 'no-store',
    },
  });
}
