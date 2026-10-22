import { importBackup, restoreErrorBody } from '@/lib/backups';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try { return Response.json({ id: await importBackup(request) }); }
  catch (error) { return Response.json(restoreErrorBody(error), { status: 400 }); }
}
