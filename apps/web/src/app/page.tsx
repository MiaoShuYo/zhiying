import { db } from '@/lib/db';
import { Dashboard } from '@/components/dashboard';
export const dynamic = 'force-dynamic';
export default async function Home() { const projects = await db.project.findMany({ orderBy: { updatedAt: 'desc' }, include: { scenes: { select: { id: true } }, jobs: { where: { status: { in: ['queued', 'running'] } }, select: { stage: true }, take: 1, orderBy: { createdAt: 'desc' } } } }); return <Dashboard initialProjects={projects.map(p => ({ id: p.id, name: p.name, status: p.status, styleId: p.styleId, createdAt: p.createdAt.toISOString(), sceneCount: p.scenes.length, busy: p.jobs.length > 0 || ['created', 'extracting', 'analyzing', 'storyboarding', 'generating_audio', 'rendering', 'encoding'].includes(p.status), busyStage: p.jobs[0]?.stage ?? null }))} />; }
