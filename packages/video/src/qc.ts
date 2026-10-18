import { captionCharLimit, captionDisplayWidth, type Storyboard } from '@m2v/schema';
import { captionDuration, resolveCaptionCues } from './captions';

export type QcSeverity = 'error' | 'warning';

export type QcFix = 'open_captions' | 'audition_audio' | 'regenerate_audio' | 'open_render';

export type SubtitleQcCode = 'subtitle_too_long' | 'subtitle_too_short' | 'subtitle_overlap' | 'subtitle_out_of_scene' | 'subtitle_empty';

export type AudioQcCode = 'audio_missing' | 'audio_silent' | 'audio_too_short' | 'audio_duration_mismatch';

export type QcCode = SubtitleQcCode | AudioQcCode;

export type QcIssue = {
  id: string;
  kind: 'subtitle' | 'audio';
  code: QcCode;
  severity: QcSeverity;
  message: string;
  fix: QcFix;
  sceneId: string;
  sceneIndex: number;
  sceneTitle: string;
  cueIndex?: number;
  cueText?: string;
};

export type SubtitleQc = { enabled: boolean; cueCount: number; issues: QcIssue[] };

/** `missing` means the referenced file is gone, `unreadable` means FFmpeg could not measure it. */
export type AudioProbe = { duration: number; meanVolume: number; peakVolume: number; hasAudio: boolean };
export type AudioProbeEntry = AudioProbe | 'missing' | 'unreadable';

export type AudioQc = { measurable: number; issues: QcIssue[] };

export const qcCodeLabels: Record<QcCode, string> = {
  subtitle_too_long: '字幕过长',
  subtitle_too_short: '停留时间不足',
  subtitle_overlap: '字幕时间重叠',
  subtitle_out_of_scene: '超出场景时长',
  subtitle_empty: '字幕内容为空',
  audio_missing: '旁白缺失',
  audio_silent: '音频静音',
  audio_too_short: '音频异常偏短',
  audio_duration_mismatch: '音频与场景时长不符',
};

export const qcFixLabels: Record<QcFix, string> = {
  open_captions: '定位到字幕',
  audition_audio: '试听音频',
  regenerate_audio: '重新生成',
  open_render: '前往渲染',
};

const MIN_DWELL_SECONDS = 0.8;
const MAX_READING_UNITS_PER_SECOND = 20;
const OVERLAP_TOLERANCE = 0.02;
const SCENE_TOLERANCE = 0.05;
const MIN_AUDIO_SECONDS = 0.6;

const sceneLabel = (scene: { title?: string }, index: number) => scene.title?.trim() || `场景 ${index + 1}`;

const issue = (input: Pick<QcIssue, 'code' | 'message'> & Partial<Pick<QcIssue, 'severity' | 'fix' | 'kind' | 'cueIndex' | 'cueText'>> & { scene: { id: string; title?: string }; index: number }): QcIssue => {
  const { scene, index, ...rest } = input;
  return {
    kind: 'subtitle',
    severity: 'warning',
    fix: 'open_captions',
    ...rest,
    sceneId: scene.id,
    sceneIndex: index,
    sceneTitle: sceneLabel(scene, index),
    id: `${scene.id}:${rest.code}:${rest.cueIndex ?? 'scene'}`,
  };
};

/**
 * Subtitle QC works on the cues the renderer would actually draw, but the
 * out-of-scene and empty checks read the raw manual cues because
 * `resolveCaptionCues` clamps their timing and drops blank entries.
 * Cue counting still happens when subtitles are switched off, so the report
 * can show how many cues would be drawn once they are turned back on.
 */
export function checkSubtitles(board: Storyboard): SubtitleQc {
  const enabled = board.subtitles?.enabled !== false;
  const portrait = board.aspectRatio === '9:16';
  const limit = captionCharLimit(portrait);
  const issues: QcIssue[] = [];
  let cueCount = 0;

  board.scenes.forEach((scene, index) => {
    const window = captionDuration(scene);
    const manual = scene.subtitleCues ?? [];
    const cues = resolveCaptionCues(scene, window, portrait);
    cueCount += cues.length;
    if (!enabled) return;
    manual.forEach((cue, cueIndex) => {
      if (!cue.text.trim()) {
        issues.push(issue({ scene, index, code: 'subtitle_empty', cueIndex, cueText: '', message: `第 ${cueIndex + 1} 条手写字幕内容为空，渲染时会被丢弃。` }));
      }
      if (cue.start < 0 || cue.start > window - SCENE_TOLERANCE || cue.end > window + SCENE_TOLERANCE) {
        issues.push(issue({
          scene, index, code: 'subtitle_out_of_scene', cueIndex, cueText: cue.text,
          message: `字幕时间 ${cue.start.toFixed(1)}–${cue.end.toFixed(1)} 秒超出场景时长 ${window.toFixed(1)} 秒，导出时会被截断。`,
        }));
      }
    });

    cues.forEach((cue, cueIndex) => {
      const width = captionDisplayWidth(cue.text);
      const dwell = cue.end - cue.start;
      if (width > limit || cue.text.split('\n').length > 2) {
        issues.push(issue({
          scene, index, code: 'subtitle_too_long', cueIndex, cueText: cue.text,
          message: `字幕「${cue.text.slice(0, 12)}${cue.text.length > 12 ? '…' : ''}」约 ${width.toFixed(0)} 个字符宽度，超过 ${portrait ? '竖屏' : '横屏'}上限 ${limit}。`,
        }));
      }
      if (dwell < MIN_DWELL_SECONDS - 0.001 || width / Math.max(dwell, 0.01) > MAX_READING_UNITS_PER_SECOND) {
        issues.push(issue({
          scene, index, code: 'subtitle_too_short', cueIndex, cueText: cue.text,
          message: `字幕「${cue.text.slice(0, 12)}${cue.text.length > 12 ? '…' : ''}」只停留 ${dwell.toFixed(2)} 秒，来不及读完。`,
        }));
      }
      const previous = cues[cueIndex - 1];
      if (previous && cue.start < previous.end - OVERLAP_TOLERANCE) {
        issues.push(issue({
          scene, index, code: 'subtitle_overlap', cueIndex, cueText: cue.text,
          message: `第 ${cueIndex} 条与第 ${cueIndex + 1} 条字幕在 ${cue.start.toFixed(2)} 秒处重叠 ${(previous.end - cue.start).toFixed(2)} 秒。`,
        }));
      }
      if (cue.start > window + SCENE_TOLERANCE || cue.end > window + SCENE_TOLERANCE) {
        issues.push(issue({
          scene, index, code: 'subtitle_out_of_scene', cueIndex, cueText: cue.text,
          message: `字幕结束于 ${cue.end.toFixed(1)} 秒，超出场景时长 ${window.toFixed(1)} 秒。`,
        }));
      }
    });
  });

  return { enabled, cueCount, issues };
}

/** Audio QC relies on FFmpeg measurements; scenes without a probe entry are not judged. */
export function checkAudio(board: Storyboard, probes: Map<string, AudioProbeEntry>): AudioQc {
  const issues: QcIssue[] = [];
  let measurable = 0;

  board.scenes.forEach((scene, index) => {
    if (!(scene.narration ?? '').trim()) return;
    if (!scene.audioSrc) {
      issues.push(issue({
        scene, index, code: 'audio_missing', kind: 'audio', severity: 'error', fix: 'regenerate_audio',
        message: `${sceneLabel(scene, index)}缺少旁白音频，成片会静默。`,
      }));
      return;
    }
    const probe = probes.get(scene.id);
    if (!probe) return;
    if (probe === 'missing' || probe === 'unreadable') {
      issues.push(issue({
        scene, index, code: 'audio_missing', kind: 'audio', severity: 'error', fix: 'regenerate_audio',
        message: probe === 'missing' ? `${sceneLabel(scene, index)}的音频文件不存在，需要重新生成。` : `${sceneLabel(scene, index)}的音频无法读取，文件可能已损坏。`,
      }));
      return;
    }
    measurable += 1;
    if (!probe.hasAudio) {
      issues.push(issue({
        scene, index, code: 'audio_missing', kind: 'audio', severity: 'error', fix: 'regenerate_audio',
        message: `${sceneLabel(scene, index)}的音频文件没有音轨。`,
      }));
      return;
    }
    if (probe.peakVolume < -45 && probe.meanVolume < -50) {
      issues.push(issue({
        scene, index, code: 'audio_silent', kind: 'audio', severity: 'error', fix: 'regenerate_audio',
        message: `${sceneLabel(scene, index)}的音频峰值 ${probe.peakVolume.toFixed(1)} dB，几乎是静音。`,
      }));
    }
    if (probe.duration < MIN_AUDIO_SECONDS) {
      issues.push(issue({
        scene, index, code: 'audio_too_short', kind: 'audio', severity: 'error', fix: 'regenerate_audio',
        message: `${sceneLabel(scene, index)}的音频只有 ${probe.duration.toFixed(2)} 秒，明显短于台词。`,
      }));
    }
    const expected = scene.duration ?? 6;
    const drift = Math.abs(probe.duration - expected);
    const severe = drift > Math.max(5, expected * 0.6);
    if (drift > Math.max(2, expected * 0.3)) {
      issues.push(issue({
        scene, index, code: 'audio_duration_mismatch', kind: 'audio', severity: severe ? 'error' : 'warning', fix: 'audition_audio',
        message: `${sceneLabel(scene, index)}的音频 ${probe.duration.toFixed(1)} 秒，场景 ${expected.toFixed(1)} 秒，相差 ${drift.toFixed(1)} 秒。`,
      }));
    }
  });

  return { measurable, issues };
}
