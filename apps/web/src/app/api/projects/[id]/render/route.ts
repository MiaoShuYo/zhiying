import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';
import { projectPreflight } from '@/lib/preflight-server';
import { publicFileExists } from '@/lib/public-paths';
import { blockingFindings, buildRenderEstimate, planSummary } from '@/lib/render-plan-server';
export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const lock = await getProjectLock(id); if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 }); if (lock.locked) return projectLockedResponse(lock.reason); const project = await db.project.findUnique({ where: { id }, include: { scenes: true } });
  if (!project?.storyboardJson) return NextResponse.json({ error: '请先生成并保存分镜' }, { status: 400 });
  const body = await request.json().catch(() => ({}));
  const preset = body.preset === 'draft' ? 'draft' : 'full';
  // Severe issues need a second confirmation instead of silently producing a broken export.
  const check = await projectPreflight(id, preset);
  const issues = check?.result.issues ?? [];
  const accepted = body.allowIssues === true && (check?.result.blocking ?? 0) > 0;
  if (check && check.result.blocking > 0 && !accepted) return NextResponse.json({ error: `导出前检查发现 ${check.result.blocking} 个错误，请先处理或确认风险`, issues, blocking: check.result.blocking }, { status: 422 });
  // V1.6: the plan decides which segments are reused, the estimate warns about time and disk before the queue grows.
  const assessment = await buildRenderEstimate(id, preset);
  const blockers = assessment ? blockingFindings(assessment.estimate) : [];
  if (assessment && blockers.length > 0 && body.confirmRisks !== true) {
    return NextResponse.json({
      error: `渲染前评估发现 ${blockers.length} 项风险，请确认后再开始`,
      code: 'render_estimate',
      findings: blockers,
      estimate: assessment.estimate,
      plan: { ...planSummary(assessment.plan), reasons: assessment.reasons.map(reason => ({ code: reason.code, label: reason.label, count: reason.count })) },
    }, { status: 422 });
  }
  const stage = 'queued';
  // #182: a missing brand Logo is only a preflight warning, but the renderer would still try to
  // load it and abort. Render without the decorative Logo; the saved storyboard keeps it.
  const renderBoard = JSON.parse(project.storyboardJson!) as { brand?: { logo?: { enabled?: boolean; src?: unknown } } };
  const logo = renderBoard.brand?.logo;
  if (logo?.enabled && (typeof logo.src !== 'string' || !logo.src.trim() || !publicFileExists(logo.src.trim()))) delete renderBoard.brand!.logo;
  const job = await db.$transaction(async tx => {
    if (await tx.job.count({ where: { projectId: id, status: { in: ['queued', 'running', 'cancelling'] } } })) throw new Error('项目已有运行中的任务');
    return tx.job.create({ data: { projectId: id, kind: 'render', status: 'queued', stage, attempt: 1, inputJson: JSON.stringify({ storyboard: renderBoard, preset, allowIssues: accepted }), ...(assessment ? { renderPlanJson: JSON.stringify(assessment.plan) } : {}) } });
  });
  // Rendering is executed by the local worker; queue record is durable for retry/status polling.
  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    projectId: id,
    output: `data/projects/${id}/output/${job.id}.mp4`,
    requestId: randomUUID(),
    ...(assessment ? { plan: planSummary(assessment.plan), estimate: assessment.estimate } : {}),
  }, { status: 202 });
}
