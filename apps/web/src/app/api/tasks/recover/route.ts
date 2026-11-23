import { after, NextResponse } from 'next/server';
import { processProject } from '@/lib/pipeline';
import { recoverInterruptedJobs } from '@/lib/project-recovery';

export const runtime = 'nodejs';

/**
 * Central recovery entry: releases stale locks and restarts abandoned jobs.
 * Render jobs closed out as failed count as resumed work, otherwise the button
 * reports 0 even though a dead render was handled. `pending` explains a zero
 * result: those renders are still inside the heartbeat grace window.
 */
export async function POST() {
  const { restarted, released, render } = await recoverInterruptedJobs();
  // #288: recovery only claims the stale storyboard jobs; without scheduling them they stayed
  // "running" with no processor. Start them the same way GET /api/projects does.
  if (restarted.length) after(async () => { await Promise.all(restarted.map(job => processProject(job.projectId, job.stage))); });
  const projects = new Set([...restarted.map(item => item.projectId), ...released, ...render.projectIds]);
  return NextResponse.json({ resumed: restarted.length + render.failed, released: released.length, projects: projects.size, pending: render.pending });
}
