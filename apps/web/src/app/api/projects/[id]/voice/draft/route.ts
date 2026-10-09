import { NextResponse } from 'next/server';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';

export const runtime = 'nodejs';

function draftDirectory(id: string) {
  return resolve(process.cwd(), '../..', 'data', 'projects', id);
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lock = await getProjectLock(id);
  if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  const directory = draftDirectory(id);
  try {
    const filename = (await readdir(directory)).find(name => /^voice-reference\.(wav|mp3|flac|ogg|m4a)$/i.test(name));
    let displayName = filename;
    try { displayName = JSON.parse(await readFile(join(directory, 'voice-reference.meta.json'), 'utf8')).displayName ?? filename; } catch { /* Older drafts have no display name metadata. */ }
    let transcript = '';
    try { transcript = await readFile(join(directory, 'voice-reference.transcript.txt'), 'utf8'); } catch { /* Older projects have no saved transcript yet. */ }
    let speed = 1;
    try { const settings = JSON.parse(await readFile(join(directory, 'voice-settings.json'), 'utf8')); if (typeof settings.speed === 'number') speed = settings.speed; } catch { /* Older projects use the normal speaking speed. */ }
    return NextResponse.json({ filename: filename ?? null, displayName: filename ? displayName : null, transcript, speed });
  } catch { return NextResponse.json({ filename: null, transcript: '', speed: 1 }); }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lock = await getProjectLock(id);
  if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  if (lock.locked) return projectLockedResponse(lock.reason);
  const form = await request.formData();
  const audio = form.get('audio');
  if (!(audio instanceof File)) return NextResponse.json({ error: '请选择声音参考文件' }, { status: 400 });
  if (audio.size > 100 * 1024 * 1024) return NextResponse.json({ error: '参考音频不能超过 100 MB' }, { status: 413 });
  const extension = extname(audio.name).toLowerCase();
  if (!['.wav', '.mp3', '.flac', '.ogg', '.m4a'].includes(extension)) return NextResponse.json({ error: '音频格式需为 WAV、MP3、FLAC、OGG 或 M4A' }, { status: 400 });
  const directory = draftDirectory(id);
  await mkdir(directory, { recursive: true });
  const oldFiles = (await readdir(directory)).filter(name => /^voice-reference\.(wav|mp3|flac|ogg|m4a|meta\.json)$/i.test(name));
  await Promise.all(oldFiles.map(name => rm(join(directory, name), { force: true })));
  const filename = `voice-reference${extension}`;
  await writeFile(join(directory, filename), new Uint8Array(await audio.arrayBuffer()));
  await writeFile(join(directory, 'voice-reference.meta.json'), JSON.stringify({ displayName: audio.name }), 'utf8');
  return NextResponse.json({ filename, displayName: audio.name });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lock = await getProjectLock(id);
  if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  if (lock.locked) return projectLockedResponse(lock.reason);
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: '请求内容不是有效 JSON' }, { status: 400 }); }
  const fields = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  const hasTranscript = 'transcript' in fields;
  const transcript = hasTranscript && typeof fields.transcript === 'string' ? fields.transcript : null;
  const hasSpeed = 'speed' in fields;
  const speed = hasSpeed && typeof fields.speed === 'number' ? fields.speed : null;
  if ((!hasTranscript && !hasSpeed) || (hasTranscript && transcript === null) || (hasSpeed && speed === null)) return NextResponse.json({ error: '转录或语速设置格式无效' }, { status: 400 });
  if (transcript !== null && transcript.length > 20_000) return NextResponse.json({ error: '转录文本不能超过 20000 个字符' }, { status: 413 });
  if (speed !== null && (!Number.isFinite(speed) || speed < 0.5 || speed > 3)) return NextResponse.json({ error: '语速需在 0.5× 到 3× 之间' }, { status: 400 });
  const directory = draftDirectory(id);
  await mkdir(directory, { recursive: true });
  if (transcript !== null) await writeFile(join(directory, 'voice-reference.transcript.txt'), transcript, 'utf8');
  if (speed !== null) {
    const settingsPath = join(directory, 'voice-settings.json');
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(await readFile(settingsPath, 'utf8')); } catch { /* Start with defaults for a new project. */ }
    await writeFile(settingsPath, JSON.stringify({ ...settings, speed }), 'utf8');
  }
  return NextResponse.json({ saved: true });
}
