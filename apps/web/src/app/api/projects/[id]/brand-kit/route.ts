import { NextResponse } from 'next/server';
import { BrandSnapshotSchema, StoryboardSchema, type BrandKit, type BrandSnapshot, type Storyboard } from '@m2v/schema';
import { BrandKitError, readBrandKits } from '@/lib/brand-kits';
import { db } from '@/lib/db';
import { saveStoryboard } from '@/lib/pipeline';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';

export const runtime = 'nodejs';

/** Request-level failures that already know their HTTP status. */
class RequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function failure(error: unknown, fallback: string) {
  if (error instanceof RequestError || error instanceof BrandKitError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : fallback;
  // saveStoryboard reports compare-and-swap conflicts with this shared prefix.
  const status = message.startsWith('保存冲突') ? 409 : 500;
  return NextResponse.json({ error: message }, { status });
}

async function readRequestBody(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new RequestError('请求 JSON 格式无效', 400);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError('请求内容必须是 JSON 对象', 400);
  return value as Record<string, unknown>;
}

/** Mirrors the storyboard endpoint: an optional `if-match` header (or body `revision`) is the CAS guard. */
function expectedRevision(request: Request, body?: Record<string, unknown>): number | undefined {
  const header = request.headers.get('if-match')?.trim();
  const raw: unknown = header ? header : body && typeof body.revision === 'number' ? body.revision : undefined;
  if (raw === undefined) return undefined;
  const revision = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) throw new RequestError('修订版本无效', 400);
  return revision;
}

/** Copies the library entry into an independent snapshot so later library edits cannot leak into the project. */
function brandSnapshotFromKit(kit: BrandKit): BrandSnapshot {
  return BrandSnapshotSchema.parse({
    name: kit.name,
    baseStyleId: kit.baseStyleId,
    colors: { ...kit.colors },
    typography: { ...kit.typography },
    ...(kit.logo ? { logo: { ...kit.logo } } : {}),
  });
}

async function readProjectBoard(projectId: string): Promise<Storyboard | null> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { storyboardJson: true } });
  if (!project) return null;
  if (!project.storyboardJson) throw new RequestError('项目还没有分镜，无法应用 Brand Kit', 400);
  return StoryboardSchema.parse(JSON.parse(project.storyboardJson));
}

async function saveAndReadRevision(projectId: string, board: Storyboard, revision: number | undefined) {
  const storyboard = await saveStoryboard(projectId, board, revision);
  const saved = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { revision: true } });
  return NextResponse.json({ storyboard, revision: saved.revision });
}

/** Applies (or re-applies) a saved Brand Kit by copying its current values into the project snapshot. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const lock = await getProjectLock(id);
    if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
    if (lock.locked) return projectLockedResponse(lock.reason);

    const body = await readRequestBody(request);
    const brandKitId = typeof body.brandKitId === 'string' ? body.brandKitId.trim() : '';
    if (!brandKitId) throw new RequestError('缺少 Brand Kit ID', 400);
    const revision = expectedRevision(request, body);

    // A corrupted Brand Kit store raises BrandKitError(500) here, before the project is touched.
    const kit = (await readBrandKits()).find(item => item.id === brandKitId);
    if (!kit) return NextResponse.json({ error: '找不到这个 Brand Kit，可能已被删除' }, { status: 404 });

    const board = await readProjectBoard(id);
    if (!board) return NextResponse.json({ error: '项目不存在' }, { status: 404 });

    // Brand is a pure visual snapshot: styleId, scenes, narration and audio timing stay untouched.
    const next: Storyboard = { ...board, brandKitId: kit.id, brand: brandSnapshotFromKit(kit) };
    return await saveAndReadRevision(id, next, revision);
  } catch (error) {
    return failure(error, '应用 Brand Kit 失败');
  }
}

/** Removes the project brand and falls back to the project's own styleId. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const lock = await getProjectLock(id);
    if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
    if (lock.locked) return projectLockedResponse(lock.reason);

    const revision = expectedRevision(request);
    const project = await db.project.findUnique({ where: { id }, select: { storyboardJson: true, revision: true } });
    if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
    if (!project.storyboardJson) throw new RequestError('项目还没有分镜，无法移除 Brand Kit', 400);

    const board = StoryboardSchema.parse(JSON.parse(project.storyboardJson));
    if (!board.brandKitId && !board.brand) {
      // Already brand-free: idempotent success that must not bump the revision.
      return NextResponse.json({ storyboard: board, revision: project.revision });
    }

    const next: Storyboard = { ...board };
    delete next.brandKitId;
    delete next.brand;
    return await saveAndReadRevision(id, next, revision);
  } catch (error) {
    return failure(error, '移除 Brand Kit 失败');
  }
}
