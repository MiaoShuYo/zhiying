import { importBackup } from '@/lib/backups';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try { return Response.json({ id: await importBackup(request) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : '恢复失败' }, { status: 400 }); }
}
