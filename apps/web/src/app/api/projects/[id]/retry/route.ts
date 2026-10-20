import { after, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { processProject, type ProjectStage } from '@/lib/pipeline';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lock = await getProjectLock(id);
  if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  if (lock.locked) return projectLockedResponse(lock.reason);
  const project = await db.project.findUnique({ where: { id } });
  if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });

  let mode: 'step' | 'restart' = 'step';
  try {
    const body = await request.json() as { mode?: unknown };
    if (body.mode === 'restart') mode = 'restart';
    else if (body.mode !== 'step') return NextResponse.json({ error: '无效的重试方式' }, { status: 400 });
  } catch { return NextResponse.json({ error: '请求内容不是有效 JSON' }, { status: 400 }); }

  // Cancelled runs are resumable too: the job stores the stage it stopped at, so
  // resuming does not re-read or re-analyse text that already succeeded. Only the
  // newest run counts, otherwise an old cancelled job would let a finished project
  // be restarted and lose its current scenes.
  const latestRun = await db.job.findFirst({ where: { projectId: id, kind: 'storyboard' }, orderBy: { createdAt: 'desc' } });
  const failedJob = latestRun && (latestRun.status === 'failed' || latestRun.status === 'cancelled') ? latestRun : null;
  if (!failedJob) {
    const error = project.status === 'failed' ? '找不到可重试的失败任务' : '项目当前不在可重试状态';
    return NextResponse.json({ error }, { status: 409 });
  }
  const stages: ProjectStage[] = ['extracting', 'analyzing', 'storyboarding'];
  const stage: ProjectStage = mode === 'restart' ? 'extracting' : stages.includes(failedJob.stage as ProjectStage) ? failedJob.stage as ProjectStage : 'analyzing';
  if (stage !== 'extracting' && project.sourceText.trim().length < 30) {
    return NextResponse.json({ error: '项目还没有提取出可用文本，请选择“从头重新执行”' }, { status: 409 });
  }

  const operations = [];
  if (mode === 'restart') operations.push(db.scene.deleteMany({ where: { projectId: id } }));
  operations.push(
    db.project.update({ where: { id }, data: { status: stage, ...(mode === 'restart' ? { storyboardJson: null } : {}) } }),
    db.job.create({ data: { projectId: id, kind: 'storyboard', status: 'queued', stage, attempt: failedJob.attempt + 1 } }),
  );
  await db.$transaction(operations);
  after(async () => processProject(id, stage));
  return NextResponse.json({ status: stage, stage, mode }, { status: 202 });
}
