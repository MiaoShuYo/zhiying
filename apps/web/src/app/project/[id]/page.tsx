import { recoverInterruptedRenderJobs } from '@/lib/render-recovery';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { parseProject } from '@/lib/pipeline';
import { ProjectEditor } from '@/components/project-editor';
export const dynamic = 'force-dynamic';
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; await recoverInterruptedRenderJobs(id); const p = await db.project.findUnique({ where: { id }, include: { scenes: { orderBy: { orderIndex: 'asc' } }, jobs: { orderBy: { createdAt: 'desc' }, take: 10 } } }); if (!p) notFound(); return <ProjectEditor initial={parseProject(p)} />; }
