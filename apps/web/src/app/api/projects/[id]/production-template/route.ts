import { NextResponse } from 'next/server';
import { StoryboardSchema, templateBoardPatch, templateChanges, templateScenePatch, type Storyboard } from '@m2v/schema';
import { db } from '@/lib/db';
import { saveStoryboard } from '@/lib/pipeline';
import { getProjectLock, projectLockedResponse } from '@/lib/project-lock';
import { readProductionTemplates } from '@/lib/production-templates';

export const runtime = 'nodejs';

/** Applies one saved production template: voice, project-level settings and the per-scene timing. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lock = await getProjectLock(id);
  if (!lock.exists) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
  if (lock.locked) return projectLockedResponse(lock.reason);
  try {
    const body = await request.json() as { templateId?: unknown; applyVoice?: unknown; applyScenes?: unknown; applyExport?: unknown; renderPreset?: unknown };
    const template = (await readProductionTemplates()).find(item => item.id === body.templateId);
    if (!template) return NextResponse.json({ error: '找不到这个制作方案，可能已被删除' }, { status: 404 });
    const project = await db.project.findUniqueOrThrow({ where: { id } });
    if (!project.storyboardJson) return NextResponse.json({ error: '项目还没有分镜，无法应用制作方案' }, { status: 409 });
    const board = StoryboardSchema.parse(JSON.parse(project.storyboardJson));
    const applyExport = body.applyExport !== false;
    const applyScenes = body.applyScenes !== false;
    const applyVoice = body.applyVoice !== false;
    const impact = templateChanges(board, project.voiceId, template, body.renderPreset === 'draft' ? 'draft' : 'full');
    const patch = templateBoardPatch(template);
    const settings = templateScenePatch(template);
    const staleAudio: number[] = [];
    const next: Storyboard = {
      ...board,
      ...(applyExport ? patch : {}),
      scenes: applyScenes ? board.scenes.map((scene, index) => {
        const timingChanged = (scene.speechSpeed ?? 1) !== settings.speechSpeed || (scene.sentencePause ?? 0.12) !== settings.sentencePause;
        if (timingChanged && scene.audioSrc) staleAudio.push(index);
        return {
          ...scene,
          ...settings,
          // Speech changed, so the cached voice track no longer matches the narration.
          ...(timingChanged ? { audioSrc: undefined, audioKey: undefined, audioDuration: undefined, wordTimings: undefined, subtitleCues: undefined } : {}),
        };
      }) : board.scenes,
    };
    await saveStoryboard(id, next);
    if (applyVoice && template.voiceId && template.voiceId !== project.voiceId) {
      await db.project.update({ where: { id }, data: { voiceId: template.voiceId } });
    }
    return NextResponse.json({
      ok: true,
      voice: applyVoice && Boolean(template.voiceId) && template.voiceId !== project.voiceId,
      changedCount: impact.changedCount,
      sceneCount: applyScenes ? impact.sceneCount : 0,
      staleAudio,
      // Export quality is chosen per render, so the client adopts this as the render-tab default.
      renderPreset: template.renderPreset,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '应用制作方案失败' }, { status: 500 });
  }
}
