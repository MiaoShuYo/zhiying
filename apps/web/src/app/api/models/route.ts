import { readDesktopModelStatus } from '@/lib/desktop-models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/models：只读安装版模型清单/下载状态（缺失时返回 available:false，不抛错）。 */
export async function GET() {
  const status = await readDesktopModelStatus();
  return Response.json(status, { headers: { 'cache-control': 'no-store' } });
}
