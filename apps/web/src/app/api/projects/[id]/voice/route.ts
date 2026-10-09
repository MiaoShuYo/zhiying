import { NextResponse } from 'next/server';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { db } from '@/lib/db';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';
export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const lock = await getProjectLock(id); if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 }); if (lock.locked) return projectLockedResponse(lock.reason); const form = await request.formData(); const voiceId = String(form.get('voiceId') ?? ''); const transcript = String(form.get('transcript') ?? ''); const uploaded = form.get('audio'); const draftName = String(form.get('draftName') ?? '');
  if (!transcript.trim()) return NextResponse.json({ error: '请填写参考音频对应的转录文本' }, { status: 400 });
  let audio: File;
  if (uploaded instanceof File) audio = uploaded;
  else if (/^voice-reference\.(wav|mp3|flac|ogg|m4a)$/i.test(basename(draftName))) {
    try { const bytes = await readFile(resolve(process.cwd(), '../..', 'data', 'projects', id, basename(draftName))); audio = new File([new Uint8Array(bytes)], basename(draftName), { type: 'audio/*' }); }
    catch { return NextResponse.json({ error: '项目中找不到已选择的参考音频，请重新选择文件' }, { status: 400 }); }
  } else return NextResponse.json({ error: '请先选择参考音频' }, { status: 400 });
  try {
    const service = process.env.PYTHON_SERVICE_URL ?? 'http://127.0.0.1:8000'; const pyForm = new FormData(); pyForm.set('audio', audio); pyForm.set('transcript', transcript); pyForm.set('voice_id', voiceId || 'my-voice');
    const response = await fetch(`${service}/voices`, { method: 'POST', body: pyForm }); const result = await response.json();
    if (!response.ok) return NextResponse.json(result, { status: response.status });
    await db.project.update({ where: { id }, data: { voiceId: voiceId || 'my-voice' } });
    const projectDirectory = resolve(process.cwd(), '../..', 'data', 'projects', id);
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(resolve(projectDirectory, 'voice-reference.transcript.txt'), transcript, 'utf8');
    return NextResponse.json(result);
  } catch { return NextResponse.json({ error: '本地语音服务不可用，请先启动 Python 服务并安装 F5-TTS' }, { status: 503 }); }
}
