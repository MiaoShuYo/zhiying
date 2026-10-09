import { NextResponse } from 'next/server';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

export const runtime = 'nodejs';
const voiceId = 'global-default';
const settingsPath = () => resolve(process.cwd(), '..', '..', 'data', 'settings', 'general-voice.json');

export async function GET() {
  try {
    const settings = JSON.parse(await readFile(settingsPath(), 'utf8')) as { voiceId?: string; displayName?: string; transcript?: string; audioFilename?: string };
    let audioFilename = settings.audioFilename ?? '';
    if (!audioFilename && settings.voiceId === voiceId) {
      try { audioFilename = (await readdir(resolve(process.cwd(), '..', '..', 'data', 'voices', voiceId))).find(name => /^reference\.(wav|mp3|flac|ogg|m4a)$/i.test(name)) ?? ''; } catch { /* Older settings may have no local voice file. */ }
    }
    return NextResponse.json({ configured: settings.voiceId === voiceId, displayName: settings.displayName ?? '', transcript: settings.transcript ?? '', audioFilename });
  } catch {
    return NextResponse.json({ configured: false, displayName: '', transcript: '' });
  }
}

export async function POST(request: Request) {
  const form = await request.formData();
  const audio = form.get('audio');
  const transcript = String(form.get('transcript') ?? '').trim();
  const displayName = String(form.get('displayName') ?? '通用声音').trim() || '通用声音';
  const uploadedAudio = audio instanceof File ? audio : null;
  let existing: { voiceId?: string; displayName?: string; transcript?: string; audioFilename?: string } | null = null;
  try { existing = JSON.parse(await readFile(settingsPath(), 'utf8')); } catch { /* First setup has no saved voice. */ }
  if (!uploadedAudio && existing?.voiceId !== voiceId) return NextResponse.json({ error: '首次配置通用声音时，请先选择参考音频' }, { status: 400 });
  if (uploadedAudio && uploadedAudio.size > 100 * 1024 * 1024) return NextResponse.json({ error: '参考音频不能超过 100 MB' }, { status: 413 });
  if (uploadedAudio && !['.wav', '.mp3', '.flac', '.ogg', '.m4a'].includes(extname(uploadedAudio.name).toLowerCase())) return NextResponse.json({ error: '参考音频格式需为 WAV、MP3、FLAC、OGG 或 M4A' }, { status: 400 });
  if (!transcript) return NextResponse.json({ error: '请填写参考音频对应的转录文本' }, { status: 400 });
  if (transcript.length > 20_000) return NextResponse.json({ error: '转录文本不能超过 20000 个字符' }, { status: 413 });

  try {
    const service = process.env.PYTHON_SERVICE_URL ?? 'http://127.0.0.1:8000';
    const pythonForm = new FormData();
    if (uploadedAudio) pythonForm.set('audio', uploadedAudio);
    pythonForm.set('transcript', transcript);
    pythonForm.set('voice_id', voiceId);
    const response = await fetch(`${service}/voices`, { method: 'POST', body: pythonForm });
    const result = await response.json();
    if (!response.ok) return NextResponse.json(result, { status: response.status });

    const path = settingsPath();
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify({ voiceId, displayName, transcript, audioFilename: uploadedAudio?.name ?? existing?.audioFilename ?? '', updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    return NextResponse.json({ ok: true, voiceId, displayName });
  } catch {
    return NextResponse.json({ error: '本地语音服务不可用，请先启动 Python 服务' }, { status: 503 });
  }
}
