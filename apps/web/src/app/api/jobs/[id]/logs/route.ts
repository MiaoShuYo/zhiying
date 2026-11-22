import { resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { clampTail, readJobLog, resolveJobLogPath } from '@/lib/job-logs';

export const runtime = 'nodejs';

const dataRoot = () => resolve(process.cwd(), '../../data');

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await db.job.findUnique({
    where: { id },
    select: { id: true, projectId: true, status: true, stage: true, failedStage: true, failureCode: true },
  });
  if (!job) return NextResponse.json({ error: '作业不存在' }, { status: 404 });

  const tail = clampTail(new URL(request.url).searchParams.get('tail'));
  const file = resolveJobLogPath(dataRoot(), job.projectId, job.id);
  const log = file ? await readJobLog(file, tail) : { exists: false, lines: [], bytes: 0, windowed: false };
  return NextResponse.json({
    ...log,
    tail: log.lines.join('\n'),
    failedStage: job.failedStage ?? (job.status === 'failed' ? job.stage : null),
    failureCode: job.failureCode,
  });
}
