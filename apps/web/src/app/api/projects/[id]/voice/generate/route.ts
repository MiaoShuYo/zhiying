import { NextResponse } from 'next/server';
import { mkdir, copyFile, access, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { db } from '@/lib/db';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';
import { StoryboardSchema } from '@m2v/schema';
export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const lock = await getProjectLock(id); if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 }); if (lock.locked) return projectLockedResponse(lock.reason); const project = await db.project.findUnique({ where: { id } });
  let speed = 1;
  let forceRegenerate = false;
  try {
    const body = await request.json() as { speed?: unknown; force?: unknown };
    if (typeof body.speed === 'number' && Number.isFinite(body.speed) && body.speed >= 0.7 && body.speed <= 1.2) speed = body.speed;
    else return NextResponse.json({ error: '语速需在 0.7× 到 1.2× 之间' }, { status: 400 });
    forceRegenerate = body.force === true;
  } catch { /* Older clients may omit the optional speed body. */ }
  if (!project?.storyboardJson) return NextResponse.json({ error: '请先生成并保存故事板' }, { status: 400 });
  let voiceId = project.voiceId;
  if (!voiceId) {
    try {
      const generalVoice = JSON.parse(await readFile(resolve(process.cwd(), '../..', 'data', 'settings', 'general-voice.json'), 'utf8')) as { voiceId?: string };
      voiceId = generalVoice.voiceId ?? null;
    } catch { /* No general voice has been configured yet. */ }
  }
  if (!voiceId) return NextResponse.json({ error: '请先在“通用设置”中配置通用声音，或为当前项目上传声音档案' }, { status: 400 });
  const storyboard = StoryboardSchema.parse(JSON.parse(project.storyboardJson)); const publicAudio = resolve(process.cwd(), 'public/audio'); await mkdir(publicAudio, { recursive: true });
  const settingsPath = resolve(process.cwd(), '../..', 'data', 'projects', id, 'voice-settings.json');
  let voiceSettings: { speed?: number; generatedSpeed?: number } = {};
  try { voiceSettings = JSON.parse(await readFile(settingsPath, 'utf8')); } catch { /* First synthesis uses the selected speed. */ }
  const generatedSpeed = voiceSettings.generatedSpeed;
  const regenerateAtNewSpeed = forceRegenerate || (storyboard.scenes.some(scene => Boolean(scene.audioSrc)) && (generatedSpeed === undefined || generatedSpeed !== speed));
  const job = await db.job.create({ data: { projectId: id, kind: 'tts', status: 'running', stage: 'generating_audio' } });
  await db.project.update({ where: { id }, data: { status: 'generating_audio' } });
  // Windows Node may resolve localhost to ::1 while FastAPI listens on IPv4.
  const service = process.env.PYTHON_SERVICE_URL ?? 'http://127.0.0.1:8000';
  try {
    for (const scene of storyboard.scenes) {
      const existing = scene.audioSrc ? resolve(process.cwd(), 'public', scene.audioSrc) : '';
      if (existing && !regenerateAtNewSpeed) { try { await access(existing); continue; } catch { /* Regenerate missing audio assets. */ } }
      await db.job.update({ where: { id: job.id }, data: { sceneId: scene.id } });
      const form = new FormData(); form.set('text', scene.narration); form.set('voice_id', voiceId); form.set('speed', String(speed));
      const response = await fetch(`${service}/synthesize`, { method: 'POST', body: form }); const result = await response.json() as { audioPath?: string; duration?: number; error?: string; detail?: string };
      if (!response.ok || !result.audioPath) throw new Error(result.detail ?? result.error ?? `场景 ${scene.id} 语音生成失败`);
      const filename = `${id}-${scene.id}.wav`; const publicPath = join(publicAudio, filename); await copyFile(result.audioPath, publicPath);
      scene.audioSrc = `audio/${filename}`; if (result.duration && result.duration > 0) scene.duration = Math.max(2, result.duration + 0.5);
      await db.scene.update({ where: { id: scene.id }, data: { audioPath: `audio/${filename}`, duration: scene.duration } });
      await db.project.update({ where: { id }, data: { storyboardJson: JSON.stringify(storyboard) } });
    }
    await writeFile(settingsPath, JSON.stringify({ ...voiceSettings, speed, generatedSpeed: speed }), 'utf8');
    await db.project.update({ where: { id }, data: { storyboardJson: JSON.stringify(storyboard), status: 'awaiting_review' } });
    await db.job.update({ where: { id: job.id }, data: { status: 'completed', stage: 'awaiting_review', sceneId: null } });
    return NextResponse.json({ storyboard, message: '逐场景语音已生成' });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : '语音生成失败';
    // FileNotFoundError contains the substring "NotFound"; don't mistake a
    // Python inference error for a network/DNS failure.
    const isConnectionError = rawMessage.trim() === 'fetch failed' || /\b(?:ECONNREFUSED|ENOTFOUND|ETIMEDOUT)\b/i.test(rawMessage);
    const message = isConnectionError
      ? `无法连接本地 Python 语音服务（${service}）：${rawMessage}。请确认 http://127.0.0.1:8000/health 可正常返回。`
      : rawMessage;
    await db.job.update({ where: { id: job.id }, data: { status: 'failed', stage: 'generating_audio', error: message } }); await db.project.update({ where: { id }, data: { status: 'failed' } }); return NextResponse.json({ error: message, completedScenes: storyboard.scenes.filter(s => s.audioSrc).length }, { status: 503 });
  }
}
