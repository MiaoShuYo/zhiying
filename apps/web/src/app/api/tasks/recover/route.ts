import { NextResponse } from 'next/server';
import { recoverInterruptedJobs } from '@/lib/project-recovery';

export const runtime = 'nodejs';

/** Central recovery entry: releases stale locks and restarts abandoned jobs. */
export async function POST() {
  const { restarted, released } = await recoverInterruptedJobs();
  const projects = new Set([...restarted.map(item => item.projectId), ...released]);
  return NextResponse.json({ resumed: restarted.length, released: released.length, projects: projects.size });
}
