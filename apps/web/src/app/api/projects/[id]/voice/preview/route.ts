import { db } from '@/lib/db';
import { StoryboardSchema } from '@m2v/schema';
import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readPronunciationRules } from '@/lib/pronunciation';
export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params, body = await request.json();
    const project = await db.project.findUniqueOrThrow({ where: { id } });
    const board = StoryboardSchema.parse(JSON.parse(project.storyboardJson ?? '{}'));
    const scene = board.scenes.find(scene => scene.id === body.sceneId);
    if (!scene || typeof body.text !== 'string' || !body.text.trim() || !scene.narration.includes(body.text) || body.text.length > 500) throw new Error('请选择当前旁白中的 1 到 500 个字符试听');
    let voiceId = project.voiceId;
    if (!voiceId) voiceId = JSON.parse(await readFile(resolve(process.cwd(), '../../data/settings/general-voice.json'), 'utf8')).voiceId;
    const form = new FormData(); form.set('text', body.text); form.set('voice_id', voiceId!); form.set('speed', String(scene.speechSpeed ?? body.speed ?? 1)); form.set('sentence_pause', String(scene.sentencePause ?? .12));
    form.set('pronunciation_scopes', JSON.stringify([await readPronunciationRules(), board.pronunciationRules ?? [], (scene.pronunciationOverrides ?? []).filter(rule => !rule.occurrence)]));
    form.set('pronunciation_base', process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'); form.set('pronunciation_model', process.env.OLLAMA_MODEL ?? 'qwen3:4b');
    const response = await fetch(`${process.env.PYTHON_SERVICE_URL ?? 'http://127.0.0.1:8000'}/synthesize`, { method: 'POST', body: form, signal: AbortSignal.timeout(1_800_000) });
    const result = await response.json(); if (!response.ok || !result.audioPath) throw new Error(result.detail ?? '试听生成失败');
    const audioRoot = resolve(process.cwd(), 'public/audio'); await mkdir(audioRoot, { recursive: true });
    const filename = `${id}-preview-${randomUUID()}.wav`; await copyFile(result.audioPath, join(audioRoot, filename));
    return Response.json({ src: `/audio/${filename}` });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : '试听失败' }, { status: 400 }); }
}
