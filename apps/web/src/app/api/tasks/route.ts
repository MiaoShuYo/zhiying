import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { activeTaskStatuses, chapterProgress, failureInfo, isActiveTask, readTaskProgress, retryModeFor, type ChapterEntry } from '@/lib/task-actions';

export const runtime = 'nodejs';

const staleAfterMs = 15 * 60_000;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const status = params.get('status') ?? '';
  const kind = params.get('kind') ?? '';
  const projectId = params.get('projectId') ?? '';
  const requested = Number(params.get('limit'));
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(100, requested) : 30;
  const jobs = await db.job.findMany({
    where: {
      ...(projectId ? { projectId } : {}),
      ...(kind ? { kind } : {}),
      ...(status === 'active' ? { status: { in: activeTaskStatuses } } : status === 'failed' ? { status: 'failed' } : status === 'completed' ? { status: 'completed' } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, projectId: true, kind: true, status: true, stage: true, attempt: true, error: true, progress: true, inputJson: true, createdAt: true, updatedAt: true, project: { select: { name: true, status: true } } },
  });
  const active = await db.job.count({ where: { status: { in: activeTaskStatuses } } });
  const chapterCache = new Map<string, ChapterEntry[] | null>();
  const chaptersOf = async (id: string) => {
    if (!chapterCache.has(id)) {
      try {
        const parsed = JSON.parse(await readFile(resolve(process.cwd(), '../../data/projects', id, 'chapters.json'), 'utf8')) as unknown;
        chapterCache.set(id, Array.isArray(parsed) ? parsed as ChapterEntry[] : null);
      } catch { chapterCache.set(id, null); }
    }
    return chapterCache.get(id) ?? null;
  };
  const now = Date.now();
  const tasks = await Promise.all(jobs.map(async job => {
    const progress = readTaskProgress(job.progress);
    const since = new Date(isActiveTask(job.status) ? job.updatedAt : job.createdAt).getTime();
    const ageMs = now - since;
    return {
      id: job.id,
      projectId: job.projectId,
      projectName: job.project.name,
      projectStatus: job.project.status,
      kind: job.kind,
      status: job.status,
      stage: job.stage,
      attempt: job.attempt,
      percent: progress.percent,
      message: progress.message ?? null,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      retryMode: retryModeFor({ kind: job.kind, status: job.status, ageMs }, job.project.status),
      failure: failureInfo({ kind: job.kind, status: job.status, stage: job.stage, error: job.error, ageMs }, job.project.status),
      // A render job carries the whole storyboard in inputJson; a substring test avoids parsing it.
      confirmed: job.kind === 'render' && Boolean(job.inputJson?.includes('"allowIssues":true')),
      chapters: job.kind === 'storyboard' ? chapterProgress(await chaptersOf(job.projectId), progress) : undefined,
    };
  }));
  return NextResponse.json({ tasks, active, staleAfterMs });
}
