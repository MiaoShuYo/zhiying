import { NextResponse } from 'next/server';
import {
  MAX_PRODUCTION_TEMPLATES,
  ProductionTemplateError,
  deleteProductionTemplate,
  duplicateProductionTemplate,
  readProductionTemplates,
  renameProductionTemplate,
  saveProductionTemplate,
  setDefaultProductionTemplate,
} from '@/lib/production-templates';

export const runtime = 'nodejs';

const failure = (error: unknown, fallback: string) => NextResponse.json(
  { error: error instanceof Error ? error.message : fallback },
  { status: error instanceof ProductionTemplateError ? error.status : 500 },
);

export async function GET() {
  try {
    return NextResponse.json({ templates: await readProductionTemplates(), max: MAX_PRODUCTION_TEMPLATES });
  } catch {
    return NextResponse.json({ error: '读取制作方案失败' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { id?: unknown } & Record<string, unknown>;
    const id = typeof body.id === 'string' && body.id ? body.id : undefined;
    const { id: _ignored, ...payload } = body;
    return NextResponse.json({ template: await saveProductionTemplate(payload, id) });
  } catch (error) {
    return failure(error, '保存制作方案失败');
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as { id?: unknown; action?: unknown; name?: unknown };
    const id = typeof body.id === 'string' ? body.id : '';
    if (!id) return NextResponse.json({ error: '缺少方案 ID' }, { status: 400 });
    if (body.action === 'rename') return NextResponse.json({ template: await renameProductionTemplate(id, body.name) });
    if (body.action === 'duplicate') return NextResponse.json({ template: await duplicateProductionTemplate(id) });
    if (body.action === 'default') return NextResponse.json({ template: await setDefaultProductionTemplate(id) });
    return NextResponse.json({ error: '不支持的方案操作' }, { status: 400 });
  } catch (error) {
    return failure(error, '更新制作方案失败');
  }
}

export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: '缺少方案 ID' }, { status: 400 });
    await deleteProductionTemplate(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return failure(error, '删除制作方案失败');
  }
}
