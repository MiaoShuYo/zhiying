import { NextResponse } from 'next/server';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { db } from '@/lib/db';
import { deliveryDirFor, deliveryRecordExists, deliveryStaleReason, readDeliveryRecord } from '@/lib/delivery-records';
import { cachedQcView, readQcReport } from '@/lib/qc-report';

export const runtime = 'nodejs';

const staleMessages = {
  'qc-blocking': '这个交付包是在质检出现阻断问题之前生成的，当前质检未通过，已过期。请修复后重新检查并重新生成。',
  'project-changed': '项目在这个交付包生成之后又有修改，包内内容已不是最新版本，已过期。请重新生成。',
} as const;

/** Re-downloads a previously generated package, or explains exactly what is missing. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; jobId: string }> }) {
  const { id, jobId } = await params;
  const record = await readDeliveryRecord(id, jobId).catch(() => null);
  if (!record) return NextResponse.json({ error: '还没有为这次导出生成交付包' }, { status: 404 });
  if (record.status !== 'ready') {
    return NextResponse.json(
      { error: record.error ?? '上次交付包生成失败，请重新生成', missing: record.missing, record },
      { status: 409 },
    );
  }
  if (!record.file || basename(record.file) !== record.file || !(await deliveryRecordExists(record))) {
    return NextResponse.json(
      { error: '交付包文件已不存在（可能被清理或移动），请重新生成', missing: record.missing, record },
      { status: 410 },
    );
  }
  // A stale archive must not be handed out as if it still described the project.
  const project = await db.project.findUnique({ where: { id }, select: { revision: true } });
  const qc = project ? cachedQcView(id, project.revision, await readQcReport(id).catch(() => null)) : null;
  const stale = deliveryStaleReason(record, project && qc ? { revision: project.revision, qcStatus: qc.status } : undefined);
  if (stale) {
    return NextResponse.json({ error: staleMessages[stale], stale, record }, { status: 409 });
  }
  const name = record.name ?? `${record.stamp}-交付包.zip`;
  // The browser transfers the ZIP itself, so a cheap probe decides what to say before that.
  if (new URL(request.url).searchParams.get('probe') === '1') {
    return NextResponse.json(
      { ok: true, name, bytes: record.bytes ?? 0, file: record.file },
      { headers: { 'cache-control': 'no-store' } },
    );
  }
  const file = resolve(deliveryDirFor(id), record.file);
  const info = await stat(file);
  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(stream, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="delivery-${record.stamp}.zip"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'content-length': String(info.size),
      'cache-control': 'no-store',
    },
  });
}
