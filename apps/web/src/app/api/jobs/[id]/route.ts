import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) { const { id } = await params; const job = await db.job.findUnique({ where: { id } }); return job ? NextResponse.json(job) : NextResponse.json({ error: '作业不存在' }, { status: 404 }); }
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) { const { id } = await params; const job = await db.job.findUniqueOrThrow({ where: { id } }); const lock = await getProjectLock(job.projectId); if (lock.locked) return projectLockedResponse(lock.reason); const retried = await db.job.update({ where: { id }, data: { status: 'queued', stage: job.stage, attempt: { increment: 1 }, error: null } }); return NextResponse.json(retried, { status: 202 }); }
