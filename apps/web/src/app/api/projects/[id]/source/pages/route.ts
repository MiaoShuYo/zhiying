import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { db } from '@/lib/db';
import { mergePageText, normalizePageInfo, pageRecord, pageSections, type ExtractedPage, type ExtractionMeta } from '@/lib/extraction';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';

/** Re-runs selected PDF pages and splices the result back into the source text. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lock = await getProjectLock(id);
  if (!lock.exists) return Response.json({ error: '项目不存在' }, { status: 404 });
  if (lock.locked) return projectLockedResponse(lock.reason);
  const project = await db.project.findUnique({ where: { id }, select: { sourcePath: true, sourceText: true, storyboardJson: true } });
  if (!project) return Response.json({ error: '项目不存在' }, { status: 404 });
  if (!project.sourcePath?.toLowerCase().endsWith('.pdf')) return Response.json({ error: '只有 PDF 资料支持按页重跑' }, { status: 400 });
  const body = await request.json().catch(() => null) as { pages?: unknown; forceOcr?: unknown } | null;
  const pages = Array.isArray(body?.pages) ? [...new Set(body!.pages)].filter((page): page is number => Number.isInteger(page) && Number(page) >= 1 && Number(page) <= 500) : [];
  if (!pages.length || pages.length > 50) return Response.json({ error: '每次可重跑 1 到 50 页' }, { status: 400 });
  const forceOcr = body?.forceOcr === true;

  const root = resolve(process.cwd(), '../../data/projects', id);
  const metaPath = resolve(root, 'extraction.json');
  let meta: ExtractionMeta | null = null;
  try { meta = JSON.parse(await readFile(metaPath, 'utf8')) as ExtractionMeta; } catch { meta = null; }
  const source = await readFile(resolve(process.cwd(), '../..', project.sourcePath));
  const form = new FormData();
  form.set('file', new File([new Uint8Array(source)], basename(project.sourcePath), { type: 'application/pdf' }));
  form.set('pages', JSON.stringify(pages));
  form.set('forceOcr', forceOcr ? 'true' : 'false');
  const service = process.env.PYTHON_SERVICE_URL ?? 'http://127.0.0.1:8000';
  let response: Response;
  try {
    response = await fetch(`${service}/extract/pdf/pages`, { method: 'POST', body: form, signal: AbortSignal.timeout(600_000) });
  } catch {
    return Response.json({ error: 'PDF 解析服务不可用。请先启动 services/python 后重试。' }, { status: 502 });
  }
  const result = await response.json().catch(() => ({})) as { pages?: ExtractedPage[]; detail?: string };
  if (!response.ok) return Response.json({ error: result.detail ?? '重跑失败' }, { status: 422 });
  const updated = (result.pages ?? []).filter(page => Number.isInteger(page.page));
  if (!updated.length) return Response.json({ error: '重跑没有返回任何页面' }, { status: 422 });

  // A page that failed again must not wipe the text that already worked.
  const replacements = updated.filter(page => !page.error && page.text?.trim()).map(page => ({ page: page.page, body: page.text!.trim() }));
  const sourceText = mergePageText(project.sourceText, replacements);
  if (sourceText === null) return Response.json({ error: '这份资料不是按页抽取的，无法单独重跑页面' }, { status: 409 });
  if (sourceText.length > 2_000_000) return Response.json({ error: '重跑后正文超过 2000000 个字符上限' }, { status: 413 });

  // Legacy records have no per-page rows (and some projects have no extraction.json at all),
  // so rebuild the list from the page markers instead of starting from an empty map.
  const previous: ExtractionMeta = meta ?? { kind: 'pdf', extractedAt: new Date().toISOString() };
  const pageCount = previous.pages ?? pageSections(project.sourceText).sections.length;
  const merged = new Map(normalizePageInfo({ ...previous, pages: pageCount }).map(page => [page.page, page]));
  for (const page of updated) merged.set(page.page, pageRecord(page));
  const pageInfo = [...merged.values()].sort((a, b) => a.page - b.page);
  const nextMeta: ExtractionMeta = {
    ...previous,
    kind: 'pdf',
    pages: pageInfo[pageInfo.length - 1]?.page ?? pageInfo.length,
    pageInfo,
    ocrPages: pageInfo.filter(page => page.method === 'ocr').map(page => page.page),
    failedPages: pageInfo.filter(page => page.error).map(page => ({ page: page.page, error: page.error! })),
  };
  await writeFile(metaPath, JSON.stringify(nextMeta)).catch(() => {});
  await db.project.update({ where: { id }, data: { sourceText } });

  const board = project.storyboardJson ? JSON.parse(project.storyboardJson) as { scenes?: { id: string; title?: string; sourcePage?: number }[] } : null;
  const reran = new Set(updated.map(page => page.page));
  const staleScenes = (board?.scenes ?? []).filter(scene => scene.sourcePage && reran.has(scene.sourcePage)).map(scene => ({ id: scene.id, title: scene.title ?? '', sourcePage: scene.sourcePage! }));
  return Response.json({ pages: updated, sourceText, ocrPages: nextMeta.ocrPages, failedPages: nextMeta.failedPages, staleScenes });
}
