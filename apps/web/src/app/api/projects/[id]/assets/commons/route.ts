import { NextResponse } from 'next/server';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { readCredit } from '@/lib/commons-license';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';

export const runtime = 'nodejs';
const root = resolve(process.cwd(), '..', '..', 'data', 'projects');
type CommonsResult = { url?: string; descriptionurl?: string; extmetadata?: Record<string, { value?: string }> };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const lock = await getProjectLock(id);
  if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  if (lock.locked) return projectLockedResponse(lock.reason);
  try {
    const body = await request.json() as { title?: string; attribution?: string; confirmed?: boolean };
    const title = body.title?.trim();
    if (!title || !title.startsWith('File:') || title.length > 300) return NextResponse.json({ error: 'Commons 文件标题无效' }, { status: 400 });
    const attributionOverride = typeof body.attribution === 'string' ? body.attribution.trim().slice(0, 200) : '';
    const api = new URL('https://commons.wikimedia.org/w/api.php');
    for (const [key, value] of Object.entries({ action: 'query', format: 'json', titles: title, prop: 'imageinfo', iiprop: 'url|extmetadata' })) api.searchParams.set(key, value);
    const response = await fetch(api, { headers: { 'user-agent': 'ZhiyingLocalStudio/1.0 (local visual asset picker)' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error('无法获取 Commons 图片信息');
    const json = await response.json() as { query?: { pages?: Record<string, { title: string; imageinfo?: CommonsResult[] }> } };
    const page = Object.values(json.query?.pages ?? {})[0]; const info = page?.imageinfo?.[0];
    if (!page || !info?.url?.startsWith('https://upload.wikimedia.org/')) throw new Error('Commons 图片不可用或下载地址无效');
    const sourceUrl = info.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title.replaceAll(' ', '_'))}`;
    const credit = readCredit(info.extmetadata ?? {}, sourceUrl);
    // 许可与署名提示只做确认，不阻断使用；补写署名后对应提示不再出现。
    const warnings = credit.warnings.filter(warning => !(attributionOverride && warning.includes('署名')));
    if (warnings.length && body.confirmed !== true) return NextResponse.json({ error: '导入前请确认许可与署名提示', warnings, credit }, { status: 400 });
    const download = await fetch(info.url, { signal: AbortSignal.timeout(30_000) });
    if (!download.ok) throw new Error(`图片下载失败 (${download.status})`);
    if (!download.headers.get('content-type')?.startsWith('image/')) throw new Error('Commons 返回的素材不是图片');
    const contentLength = Number(download.headers.get('content-length') ?? 0);
    if (contentLength > 20 * 1024 * 1024) throw new Error('图片大于 20 MB，无法导入');
    const reader = download.body?.getReader();
    if (!reader) throw new Error('图片响应内容为空');
    const chunks: Uint8Array[] = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 20 * 1024 * 1024) { await reader.cancel(); throw new Error('图片大于 20 MB，无法导入'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const filename = `${randomUUID()}${new URL(info.url).pathname.match(/\.[a-z0-9]+$/i)?.[0] ?? '.img'}`;
    const directory = resolve(root, id, 'assets'); await mkdir(directory, { recursive: true }); await writeFile(resolve(directory, filename), bytes);
    const publicDirectory = resolve(process.cwd(), 'public', 'projects', id, 'assets'); await mkdir(publicDirectory, { recursive: true }); await writeFile(resolve(publicDirectory, filename), bytes);
    const asset = { name: filename, path: `projects/${id}/assets/${filename}`, kind: 'image', ...credit, attribution: attributionOverride || credit.attribution, warnings };
    const project = await db.project.findUniqueOrThrow({ where: { id }, select: { assetsJson: true } }); const assets = JSON.parse(project.assetsJson || '[]') as object[];
    await db.project.update({ where: { id }, data: { assetsJson: JSON.stringify([...assets, asset]) } });
    return NextResponse.json({ asset, warnings: credit.warnings });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Commons 图片导入失败' }, { status: 502 }); }
}
