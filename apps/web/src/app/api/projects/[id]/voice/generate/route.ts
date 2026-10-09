import { NextResponse } from 'next/server';
import { mkdir, copyFile, access, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join, resolve } from 'node:path';
import { db } from '@/lib/db';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';
import { StoryboardSchema } from '@m2v/schema';
export const runtime = 'nodejs';

type SynthesisResult = { ok: boolean; audioPath?: string; duration?: number; error?: string; detail?: string };

function requestSynthesis(service: string, text: string, voiceId: string, speed: number): Promise<SynthesisResult> {
  const endpoint = new URL(`${service.replace(/\/$/, '')}/synthesize`);
  const payload = new URLSearchParams({ text, voice_id: voiceId, speed: String(speed) }).toString();
  const transport = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolveRequest, rejectRequest) => {
    const request = transport(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', 'content-length': Buffer.byteLength(payload) },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', rejectRequest);
      response.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Omit<SynthesisResult, 'ok'>;
          resolveRequest({ ...result, ok: (response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300 });
        } catch { rejectRequest(new Error('Python 语音服务返回了无效响应')); }
      });
    });
    request.on('error', rejectRequest);
    request.setTimeout(30 * 60 * 1000, () => request.destroy(new Error('Python 语音服务在 30 分钟内没有响应')));
    request.end(payload);
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const lock = await getProjectLock(id); if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 }); if (lock.locked) return projectLockedResponse(lock.reason); const project = await db.project.findUnique({ where: { id } });
  let speed = 1;
  let forceRegenerate = false;
  let sceneId: string | undefined;
  try {
    const body = await request.json() as { speed?: unknown; force?: unknown; sceneId?: unknown };
    if (typeof body.speed === 'number' && Number.isFinite(body.speed) && body.speed >= 0.5 && body.speed <= 3) speed = body.speed;
    else return NextResponse.json({ error: '语速需在 0.5× 到 3× 之间' }, { status: 400 });
    forceRegenerate = body.force === true;
    if (typeof body.sceneId === 'string' && body.sceneId.trim()) sceneId = body.sceneId.trim();
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
  const targetScenes = sceneId ? storyboard.scenes.filter(scene => scene.id === sceneId) : storyboard.scenes;
  if (sceneId && targetScenes.length === 0) return NextResponse.json({ error: '场景不存在' }, { status: 404 });
  const settingsPath = resolve(process.cwd(), '../..', 'data', 'projects', id, 'voice-settings.json');
  let voiceSettings: { speed?: number; generatedSpeed?: number } = {};
  try { voiceSettings = JSON.parse(await readFile(settingsPath, 'utf8')); } catch { /* First synthesis uses the selected speed. */ }
  const generatedSpeed = voiceSettings.generatedSpeed;
  const regenerateAtNewSpeed = !sceneId && (forceRegenerate || (storyboard.scenes.some(scene => Boolean(scene.audioSrc)) && (generatedSpeed === undefined || generatedSpeed !== speed)));
  const job = await db.job.create({ data: { projectId: id, kind: 'tts', status: 'running', stage: 'generating_audio' } });
  await db.project.update({ where: { id }, data: { status: 'generating_audio' } });
  // Windows Node may resolve localhost to ::1 while FastAPI listens on IPv4.
  const service = process.env.PYTHON_SERVICE_URL ?? 'http://127.0.0.1:8000';
  try {
    for (const scene of targetScenes) {
      const existing = scene.audioSrc ? resolve(process.cwd(), 'public', scene.audioSrc) : '';
      if (!sceneId && existing && !regenerateAtNewSpeed) { try { await access(existing); continue; } catch { /* Regenerate missing audio assets. */ } }
      await db.job.update({ where: { id: job.id }, data: { sceneId: scene.id } });
      const result = await requestSynthesis(service, scene.narration, voiceId, speed);
      if (!result.ok || !result.audioPath) throw new Error(result.detail ?? result.error ?? `场景 ${scene.id} 语音生成失败`);
      const filename = `${id}-${scene.id}.wav`; const publicPath = join(publicAudio, filename); await copyFile(result.audioPath, publicPath);
      scene.audioSrc = `audio/${filename}`; if (result.duration && result.duration > 0) scene.duration = Math.max(2, result.duration + 0.5);
      await db.scene.update({ where: { id: scene.id }, data: { audioPath: `audio/${filename}`, duration: scene.duration } });
      await db.project.update({ where: { id }, data: { storyboardJson: JSON.stringify(storyboard) } });
    }
    await writeFile(settingsPath, JSON.stringify(sceneId ? { ...voiceSettings, speed } : { ...voiceSettings, speed, generatedSpeed: speed }), 'utf8');
    await db.project.update({ where: { id }, data: { storyboardJson: JSON.stringify(storyboard), status: 'awaiting_review' } });
    await db.job.update({ where: { id: job.id }, data: { status: 'completed', stage: 'awaiting_review', sceneId: null } });
    const generatedScene = sceneId ? targetScenes[0] : null;
    return NextResponse.json({ storyboard, message: generatedScene ? `场景「${generatedScene.title ?? '未命名'}」语音已生成` : '逐场景语音已生成' });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : '语音生成失败';
    // FileNotFoundError contains the substring "NotFound"; don't mistake a
    // Python inference error for a network/DNS failure.
    const isConnectionError = rawMessage.trim() === 'fetch failed' || /\b(?:ECONNREFUSED|ENOTFOUND|ETIMEDOUT)\b/i.test(rawMessage);
    const message = isConnectionError
      ? `无法连接本地 Python 语音服务（${service}）：${rawMessage}。请确认 http://127.0.0.1:8000/health 可正常返回。`
      : rawMessage;
    await db.job.update({ where: { id: job.id }, data: { status: 'failed', stage: 'generating_audio', error: message } }); await db.project.update({ where: { id }, data: { status: sceneId ? 'awaiting_review' : 'failed' } }); return NextResponse.json({ error: message, completedScenes: storyboard.scenes.filter(s => s.audioSrc).length }, { status: 503 });
  }
}
