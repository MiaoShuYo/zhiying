import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { outputDirFor } from '@/lib/job-video';

export const runtime = 'nodejs';

const allowedFile = (value: string) => value === 'report.json'
  || value === 'preflight-report.json'
  || value === 'contact-sheet.html'
  || value === 'motion-strip.html'
  || /^(?:preflight|after)\/frame-\d{6}\.png$/.test(value);

async function latestReport(projectId: string, jobId?: string) {
  const job = await db.job.findFirst({
    where: { projectId, kind: 'render', status: 'completed', ...(jobId ? { id: jobId } : {}) },
    orderBy: { updatedAt: 'desc' },
    select: { id: true },
  });
  if (!job || !/^[a-zA-Z0-9_-]+$/.test(job.id)) return null;
  const directory = resolve(outputDirFor(projectId), 'visual-qa', job.id);
  try {
    const report = JSON.parse(await readFile(resolve(directory, 'report.json'), 'utf8')) as unknown;
    return { jobId: job.id, directory, report };
  } catch {
    return null;
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const project = await db.project.findUnique({ where: { id }, select: { id: true } });
  if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const url = new URL(request.url);
  const result = await latestReport(id, url.searchParams.get('jobId') ?? undefined);
  if (!result) return NextResponse.json({ error: '尚无成片视觉 QA 报告' }, { status: 404 });
  const file = url.searchParams.get('file');
  if (!file) return NextResponse.json({ jobId: result.jobId, report: result.report });
  if (!allowedFile(file)) return NextResponse.json({ error: '视觉 QA 文件路径无效' }, { status: 400 });
  const target = resolve(result.directory, file);
  if (!target.startsWith(result.directory + sep)) return NextResponse.json({ error: '视觉 QA 文件路径无效' }, { status: 400 });
  try {
    const info = await stat(target);
    if (!info.isFile()) return NextResponse.json({ error: '视觉 QA 文件不存在' }, { status: 404 });
    const data = await readFile(target);
    const contentType = file.endsWith('.png') ? 'image/png' : file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8';
    if (file.endsWith('.html')) {
      const html = data.toString('utf8').replace(/src="((?:preflight|after)\/frame-\d{6}\.png)"/g, (_match, imagePath: string) => {
        const source = '/api/projects/' + encodeURIComponent(id) + '/visual-qa?jobId=' + encodeURIComponent(result.jobId) + '&file=' + encodeURIComponent(imagePath);
        return 'src="' + source + '"';
      });
      return new Response(html, { headers: { 'content-type': contentType, 'cache-control': 'private, max-age=60' } });
    }
    return new Response(data, { headers: { 'content-type': contentType, 'cache-control': 'private, max-age=60', 'content-length': String(data.length) } });
  } catch {
    return NextResponse.json({ error: '视觉 QA 文件不存在' }, { status: 404 });
  }
}
