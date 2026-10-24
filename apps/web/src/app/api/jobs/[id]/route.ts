import { recoverInterruptedRenderJobs } from '@/lib/render-recovery';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';
import { projectPreflight } from '@/lib/preflight-server';
import { blockingFindings, buildRenderEstimate } from '@/lib/render-plan-server';
import type { PreflightPreset } from '@m2v/schema';
export const runtime = 'nodejs';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) { const { id } = await params; await recoverInterruptedRenderJobs(); const job = await db.job.findUnique({ where: { id } }); return job ? NextResponse.json(job) : NextResponse.json({ error: '作业不存在' }, { status: 404 }); }
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const job = await db.job.findUnique({ where: { id } });
  if (!job || job.kind !== 'render' || !['failed', 'cancelled'].includes(job.status)) return NextResponse.json({ error: '只能重试失败或取消的渲染任务' }, { status: 409 });
  const lock = await getProjectLock(job.projectId); if (lock.locked) return projectLockedResponse(lock.reason);
  // `resume` reuses the segment cache, `restart` ignores it; both render the current storyboard.
  const body = await request.json().catch(() => ({})) as { allowIssues?: boolean; confirmRisks?: boolean; mode?: string };
  const restart = body.mode === 'restart';
  // Retries keep the preset of the failed attempt but render the current storyboard,
  // so the check below and the queued snapshot always describe the same content.
  let preset: PreflightPreset = 'full';
  try { if ((JSON.parse(job.inputJson ?? '{}') as { preset?: string }).preset === 'draft') preset = 'draft'; } catch {}
  const project = await db.project.findUnique({ where: { id: job.projectId } });
  if (!project?.storyboardJson) return NextResponse.json({ error: '请先生成并保存分镜' }, { status: 400 });
  const check = await projectPreflight(job.projectId, preset);
  if (!check) return NextResponse.json({ error: '请先生成并保存分镜' }, { status: 400 });
  const accepted = body.allowIssues === true && check.result.blocking > 0;
  // Same gate as POST /render: a known asset or environment error needs confirmation.
  if (check.result.blocking > 0 && !accepted) return NextResponse.json({ error: `导出前检查发现 ${check.result.blocking} 个错误，请先处理或确认风险`, issues: check.result.issues, blocking: check.result.blocking }, { status: 422 });
  const assessment = await buildRenderEstimate(job.projectId, preset);
  const restartPlan = restart ? await buildRenderEstimate(job.projectId, preset, { ignoreCache: true }) : null;
  const blockers = assessment ? blockingFindings(assessment.estimate) : [];
  if (assessment && blockers.length > 0 && body.confirmRisks !== true) {
    return NextResponse.json({
      error: `渲染前评估发现 ${blockers.length} 项风险，请确认后再重试`,
      code: 'render_estimate',
      findings: blockers,
      estimate: assessment.estimate,
      plan: { segments: assessment.plan.segments.length, reused: assessment.plan.reusedCount, rendered: assessment.plan.renderedCount, renderedSeconds: assessment.plan.renderedSeconds, totalSeconds: assessment.plan.totalSeconds, reasons: assessment.reasons.map(reason => ({ code: reason.code, label: reason.label, count: reason.count })) },
    }, { status: 422 });
  }
  const retried = await db.job.create({
    data: {
      projectId: job.projectId,
      kind: 'render',
      status: 'queued',
      stage: 'queued',
      attempt: job.attempt + 1,
      inputJson: JSON.stringify({ storyboard: JSON.parse(project.storyboardJson), preset, allowIssues: accepted, ...(restart ? { noCache: true } : {}) }),
      // The stored plan describes what will actually run: a restart plans with an empty cache.
      renderPlanJson: restartPlan ? JSON.stringify(restartPlan.plan) : assessment ? JSON.stringify(assessment.plan) : null,
    },
  });
  return NextResponse.json({ ...retried, mode: restart ? 'restart' : 'resume' }, { status: 202 });
}
