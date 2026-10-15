import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const service = process.env.PYTHON_SERVICE_URL ?? 'http://127.0.0.1:8000';
    const response = await fetch(`${service}/capabilities`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('检测失败');
    const result = await response.json();
    return NextResponse.json({ preservePptx: result.preservePptx === true, message: String(result.message ?? '') });
  } catch {
    return NextResponse.json({ preservePptx: false, message: '无法检测演示软件，请确认 Python 服务已启动后重新打开窗口；也可选择提取内容重建。' }, { status: 503 });
  }
}
