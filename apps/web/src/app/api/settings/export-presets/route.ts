import { NextResponse } from 'next/server';
import {
  ExportPresetError,
  MAX_EXPORT_PRESETS,
  deleteExportPreset,
  readExportPresets,
  saveExportPreset,
} from '@/lib/export-presets';

export const runtime = 'nodejs';

const failure = (error: unknown, fallback: string) => NextResponse.json(
  { error: error instanceof Error ? error.message : fallback },
  { status: error instanceof ExportPresetError ? error.status : 500 },
);

export async function GET() {
  try {
    return NextResponse.json({ presets: await readExportPresets(), max: MAX_EXPORT_PRESETS });
  } catch {
    return NextResponse.json({ error: '读取导出预设失败' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { id?: unknown } & Record<string, unknown>;
    const id = typeof body.id === 'string' && body.id ? body.id : undefined;
    const { id: _ignored, ...payload } = body;
    return NextResponse.json({ preset: await saveExportPreset(payload, id) });
  } catch (error) {
    return failure(error, '保存导出预设失败');
  }
}

export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: '缺少预设 ID' }, { status: 400 });
    await deleteExportPreset(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return failure(error, '删除导出预设失败');
  }
}
