import { z } from 'zod';

/** Shape the worker and the web server derive from `ffprobe -show_streams -show_format`. */
export type ProbeSummary = {
  width?: number;
  height?: number;
  duration?: number;
  videoCodec?: string;
  audioCodec?: string;
  hasVideo: boolean;
  hasAudio: boolean;
};

export type ExpectedRender = { width: number; height: number; duration: number; requireAudio: boolean };

export const RenderValidationCodeSchema = z.enum(['unreadable', 'empty_file', 'no_video', 'no_audio', 'resolution_mismatch', 'duration_mismatch']);
export type RenderValidationCode = z.infer<typeof RenderValidationCodeSchema>;

export type RenderValidationIssue = {
  code: RenderValidationCode;
  message: string;
  /** A blocking issue makes the file unusable; the rest are risks the user may accept. */
  blocking: boolean;
};

export type RenderValidation = {
  ok: boolean;
  checkedAt: string;
  fileBytes: number;
  width?: number;
  height?: number;
  duration?: number;
  videoCodec?: string;
  audioCodec?: string;
  hasAudio: boolean;
  expected: ExpectedRender;
  issues: RenderValidationIssue[];
};

export const renderValidationLabels: Record<RenderValidationCode, string> = {
  unreadable: '文件无法读取',
  empty_file: '文件为空',
  no_video: '缺少视频轨道',
  no_audio: '缺少音频轨道',
  resolution_mismatch: '分辨率不符',
  duration_mismatch: '时长不符',
};

const RESOLUTION_TOLERANCE = 2;
const DURATION_FLOOR_SECONDS = 1.5;

/**
 * Pure verdict shared by the worker (right after encoding) and the web server
 * (re-checking an old export). A missing audio track is reported but does not
 * block delivery: silent videos can still be intentional.
 */
export function evaluateRender(probe: ProbeSummary | null, expected: ExpectedRender, fileBytes: number): RenderValidation {
  const issues: RenderValidationIssue[] = [];
  const base = {
    checkedAt: new Date().toISOString(),
    fileBytes,
    width: probe?.width,
    height: probe?.height,
    duration: probe?.duration,
    videoCodec: probe?.videoCodec,
    audioCodec: probe?.audioCodec,
    hasAudio: Boolean(probe?.hasAudio),
    expected,
    issues,
  };
  if (!probe) {
    issues.push({ code: 'unreadable', message: '无法解析视频文件，文件可能已损坏或不是有效的 MP4。', blocking: true });
    return { ...base, ok: false };
  }
  if (fileBytes <= 0) issues.push({ code: 'empty_file', message: '视频文件大小为 0，渲染可能被中断。', blocking: true });
  if (!probe.hasVideo) issues.push({ code: 'no_video', message: '文件里没有视频轨道，无法作为成片交付。', blocking: true });
  else if (expected.width > 0 && expected.height > 0 && (Math.abs((probe.width ?? 0) - expected.width) > RESOLUTION_TOLERANCE || Math.abs((probe.height ?? 0) - expected.height) > RESOLUTION_TOLERANCE)) {
    issues.push({ code: 'resolution_mismatch', message: `实际分辨率 ${probe.width ?? '?'} × ${probe.height ?? '?'}，预期 ${expected.width} × ${expected.height}。`, blocking: false });
  }
  if (expected.requireAudio && !probe.hasAudio) issues.push({ code: 'no_audio', message: '分镜包含旁白或背景音乐，但成片没有音频轨道。', blocking: false });
  if (expected.duration > 0 && Number.isFinite(probe.duration)) {
    const drift = Math.abs((probe.duration ?? 0) - expected.duration);
    const tolerance = Math.max(DURATION_FLOOR_SECONDS, expected.duration * 0.02);
    if (drift > tolerance) {
      issues.push({ code: 'duration_mismatch', message: `实际时长 ${(probe.duration ?? 0).toFixed(1)} 秒，预期 ${expected.duration.toFixed(1)} 秒，相差 ${drift.toFixed(1)} 秒。`, blocking: false });
    }
  }
  return { ...base, ok: issues.length === 0 };
}

export const RenderValidationSchema = z.object({
  ok: z.boolean(),
  checkedAt: z.string(),
  fileBytes: z.number().nonnegative(),
  width: z.number().optional(),
  height: z.number().optional(),
  duration: z.number().optional(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  hasAudio: z.boolean(),
  expected: z.object({ width: z.number(), height: z.number(), duration: z.number(), requireAudio: z.boolean() }),
  issues: z.array(z.object({ code: RenderValidationCodeSchema, message: z.string(), blocking: z.boolean() })),
});
