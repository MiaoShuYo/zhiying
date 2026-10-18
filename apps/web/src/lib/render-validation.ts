import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  RenderValidationSchema,
  StoryboardSchema,
  evaluateRender,
  timelineFor,
  type ExpectedRender,
  type RenderValidation,
  type Storyboard,
} from '@m2v/schema';
import { probeVideoFile } from '@m2v/video/probe';
import { db } from '@/lib/db';
import { outputDirFor, ownedVideoPath, videoFileIsCurrent } from '@/lib/job-video';

const STALE_MESSAGE = '找不到这条记录的视频文件（可能已被清理或被后续导出覆盖），请重新渲染后再校验。';
const UNREADABLE_MESSAGE = '无法解析视频文件：文件可能已损坏，或本机缺少 FFmpeg/FFprobe。请重新渲染后再校验。';

/** What the record asked for: dimensions follow aspect ratio and the draft half-scale. */
export function expectedRender(inputJson: string | null): ExpectedRender {
  let board: Storyboard;
  let preset = 'full';
  try {
    const input = JSON.parse(inputJson ?? '{}') as { storyboard?: unknown; preset?: unknown };
    board = StoryboardSchema.parse(input.storyboard);
    preset = input.preset === 'draft' ? 'draft' : 'full';
  } catch {
    // An unreadable snapshot only weakens the checks; the file itself is still read.
    return { width: 0, height: 0, duration: 0, requireAudio: false };
  }
  const scale = preset === 'draft' ? 0.5 : 1;
  const portrait = board.aspectRatio === '9:16';
  return {
    width: Math.round((portrait ? 1080 : 1920) * scale),
    height: Math.round((portrait ? 1920 : 1080) * scale),
    duration: timelineFor(board).totalSeconds,
    requireAudio: board.scenes.some(scene => scene.narration.trim().length > 0 || Boolean(scene.audioSrc)) || Boolean(board.bgmSrc),
  };
}

export function parseValidation(json: string | null): RenderValidation | null {
  if (!json) return null;
  try {
    const parsed = RenderValidationSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type ExportValidationOutcome =
  | { ok: true; validation: RenderValidation }
  | { ok: false; status: number; error: string };

/** Re-reads the exported file and stores the verdict on the job; `null` means the job is unknown. */
export async function validateExport(projectId: string, jobId: string): Promise<ExportValidationOutcome | null> {
  const job = await db.job.findFirst({ where: { id: jobId, projectId, kind: 'render' } });
  if (!job) return null;
  if (job.status !== 'completed') return { ok: false, status: 409, error: '这次导出还没有渲染完成，暂时无法校验。' };
  const renders = await db.job.findMany({
    where: { projectId, kind: 'render' },
    select: { id: true, kind: true, status: true, outputPath: true, createdAt: true },
  });
  const owned = ownedVideoPath(job, renders);
  if (!owned) {
    return { ok: false, status: 409, error: '这条导出记录的视频已被后续导出覆盖，只有最近一次导出可以校验，请重新导出后再试。' };
  }
  const expected = expectedRender(job.inputJson);
  const file = resolve(outputDirFor(projectId), owned);
  let size = 0;
  let usable = false;
  try {
    const info = await stat(file);
    size = info.size;
    usable = info.isFile() && videoFileIsCurrent(owned, job, info.mtimeMs);
  } catch {
    // Reported as unreadable below; the row keeps the reason for the export history.
  }
  let validation: RenderValidation;
  if (!usable) {
    validation = evaluateRender(null, expected, 0);
    validation.issues = [{ code: 'unreadable', message: STALE_MESSAGE, blocking: true }];
  } else {
    const probed = await probeVideoFile(file);
    validation = evaluateRender(probed?.probe ?? null, expected, probed?.bytes ?? size);
    if (!probed) validation.issues = [{ code: 'unreadable', message: UNREADABLE_MESSAGE, blocking: true }];
  }
  await db.job.update({ where: { id: jobId }, data: { validationJson: JSON.stringify(validation) } });
  return { ok: true, validation };
}
