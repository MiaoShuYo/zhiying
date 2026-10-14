import { NextResponse } from 'next/server';
import { readPronunciationRules, writePronunciationRules } from '@/lib/pronunciation';
export const runtime = 'nodejs';
export async function GET() {
  try { return NextResponse.json({ rules: await readPronunciationRules() }); }
  catch { return NextResponse.json({ error: '读取通用纠音规则失败' }, { status: 500 }); }
}
export async function PUT(request: Request) {
  try { return NextResponse.json({ rules: await writePronunciationRules(await request.json()) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : '保存纠音规则失败' }, { status: 400 }); }
}
