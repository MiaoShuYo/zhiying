import { SubtitleSchema, subtitleCues as storyboardCues, timelineFor, type Storyboard } from '@m2v/schema';
import { captionDuration, resolveCaptionCues } from './captions';

const clock = (seconds: number, ass = false) => {
  const ticks = Math.round(seconds * (ass ? 100 : 1000));
  const unit = ass ? 100 : 1000;
  return `${String(Math.floor(ticks / (3600 * unit))).padStart(ass ? 1 : 2, '0')}:${String(Math.floor(ticks / (60 * unit)) % 60).padStart(2, '0')}:${String(Math.floor(ticks / unit) % 60).padStart(2, '0')}.${String(ticks % unit).padStart(ass ? 2 : 3, '0')}`;
};
export function subtitleCues(storyboard: Storyboard) {
  return storyboardCues(storyboard).map(cue => ({ text: cue.text, start: cue.start, end: cue.end }));
}

export type SubtitleTimelineIssue = {
  code: 'invalid_range' | 'empty_text' | 'overlap' | 'past_end';
  message: string;
  cueIndex: number;
};

/** Checks the exact cue list that the subtitle exporters write, so a package can never ship a broken timeline silently. */
export function validateSubtitleTimeline(storyboard: Storyboard, duration?: number) {
  const timeline = timelineFor(storyboard);
  const cues = subtitleCues(storyboard);
  const total = Math.max(0, duration ?? timeline.totalSeconds);
  const issues: SubtitleTimelineIssue[] = [];
  cues.forEach((cue, cueIndex) => {
    const at = cueIndex + 1;
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start || cue.start < 0) {
      issues.push({ code: 'invalid_range', cueIndex, message: `第 ${at} 条字幕时间轴无效（${cue.start.toFixed(2)}s → ${cue.end.toFixed(2)}s）` });
    }
    if (!cue.text.trim()) issues.push({ code: 'empty_text', cueIndex, message: `第 ${at} 条字幕内容为空` });
    const previous = cues[cueIndex - 1];
    if (previous && cue.start < previous.end - 0.02) {
      issues.push({ code: 'overlap', cueIndex, message: `第 ${at} 条字幕与上一条重叠（${cue.start.toFixed(2)}s < ${previous.end.toFixed(2)}s）` });
    }
    if (total > 0 && cue.end > total + 0.05) {
      issues.push({ code: 'past_end', cueIndex, message: `第 ${at} 条字幕超出成片时长（${cue.end.toFixed(2)}s > ${total.toFixed(2)}s）` });
    }
  });
  return { ok: issues.length === 0, cues: cues.length, total, issues };
}


export function exportSubtitles(storyboard: Storyboard, format: 'srt' | 'vtt' | 'ass') {
  const cues = subtitleCues(storyboard);
  if (format !== 'ass') return (format === 'vtt' ? 'WEBVTT\n\n' : '') + cues.map((cue, index) => `${index + 1}\n${clock(cue.start).replace('.', format === 'srt' ? ',' : '.')} --> ${clock(cue.end).replace('.', format === 'srt' ? ',' : '.')}\n${cue.text.replace(/-->/g, '→')}\n`).join('\n');
  const style = SubtitleSchema.parse(storyboard.subtitles ?? {});
  const color = (hex: string, opacity = 1) => `&H${Math.round((1 - opacity) * 255).toString(16).padStart(2, '0')}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
  const width = storyboard.aspectRatio === '9:16' ? 1080 : 1920;
  const height = storyboard.aspectRatio === '9:16' ? 1920 : 1080;
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Microsoft YaHei,${style.fontSize},${color(style.color)},${color(style.color)},${color(style.background, style.backgroundOpacity)},${color(style.background, style.backgroundOpacity)},-1,0,0,0,100,100,0,0,${style.preset === 'minimal' ? 1 : 3},2,0,${{ bottom: 2, center: 5, top: 8 }[style.position]},${Math.round(width * .05)},${Math.round(width * .05)},${Math.round(height * .05)},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  return header + cues.map(cue => `Dialogue: 0,${clock(cue.start, true)},${clock(cue.end, true)},Default,,0,0,0,,${cue.text.replace(/\\/g, '＼').replace(/[{}]/g, '').replace(/\n/g, '\\N')}`).join('\n');
}
