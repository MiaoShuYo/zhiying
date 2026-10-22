import { createSnapshot, listSnapshots, lockSnapshot, restoreErrorBody, restoreSnapshot, snapshotResponse, verifySnapshot } from '@/lib/backups';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';
export const runtime = 'nodejs';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params; const search = new URL(request.url).searchParams;
    const snapshot = search.get('download');
    if (snapshot) return await snapshotResponse(id, snapshot);
    const verify = search.get('verify');
    return Response.json(verify ? await verifySnapshot(id, verify) : await listSnapshots(id));
  }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params; const lock = await getProjectLock(id);
    if (!lock.exists) return Response.json({ error: '项目不存在' }, { status: 404 });
    if (lock.locked) return projectLockedResponse(lock.reason);
    const body = await request.json().catch(() => ({}));
    if (body.action === 'lock') { await lockSnapshot(id, String(body.snapshotId), body.locked === true); return Response.json({ ok: true }); }
    if (body.action === 'restore') return Response.json({ id: await restoreSnapshot(id, String(body.snapshotId)) });
    const snapshotId = await createSnapshot(id);
    if (body.action === 'duplicate') return Response.json({ id: await restoreSnapshot(id, snapshotId!) });
    return Response.json({ snapshotId });
  } catch (error) { return Response.json(restoreErrorBody(error), { status: 400 }); }
}
