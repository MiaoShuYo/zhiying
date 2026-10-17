import { SubtitleSchema, timelineFor, type Storyboard } from '@m2v/schema';
import { captionDuration, resolveCaptionCues } from './captions';

const clock = (seconds: number, ass = false) => {
  const ticks = Math.round(seconds * (ass ? 100 : 1000));
  const unit = ass ? 100 : 1000;
  return `${String(Math.floor(ticks / (3600 * unit))).padStart(ass ? 1 : 2, '0')}:${String(Math.floor(ticks / (60 * unit)) % 60).padStart(2, '0')}:${String(Math.floor(ticks / unit) % 60).padStart(2, '0')}.${String(ticks % unit).padStart(ass ? 2 : 3, '0')}`;
};
export function exportSubtitles(storyboard: Storyboard, format: 'srt' | 'vtt' | 'ass') {
  const timeline = timelineFor(storyboard);
  const cues = storyboard.scenes.flatMap((scene, index) => {
    const offset = timeline.scenes[index].start;
    return resolveCaptionCues(scene, captionDuration(scene), storyboard.aspectRatio === '9:16').map(cue => ({ ...cue, start: cue.start + offset, end: cue.end + offset }));
  });
  if (format !== 'ass') return (format === 'vtt' ? 'WEBVTT\n\n' : '') + cues.map((cue, index) => `${index + 1}\n${clock(cue.start).replace('.', format === 'srt' ? ',' : '.')} --> ${clock(cue.end).replace('.', format === 'srt' ? ',' : '.')}\n${cue.text.replace(/-->/g, '→')}\n`).join('\n');
  const style = SubtitleSchema.parse(storyboard.subtitles ?? {});
  const color = (hex: string, opacity = 1) => `&H${Math.round((1 - opacity) * 255).toString(16).padStart(2, '0')}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
  const width = storyboard.aspectRatio === '9:16' ? 1080 : 1920;
  const height = storyboard.aspectRatio === '9:16' ? 1920 : 1080;
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Microsoft YaHei,${style.fontSize},${color(style.color)},${color(style.color)},${color(style.background, style.backgroundOpacity)},${color(style.background, style.backgroundOpacity)},-1,0,0,0,100,100,0,0,${style.preset === 'minimal' ? 1 : 3},2,0,${{ bottom: 2, center: 5, top: 8 }[style.position]},${Math.round(width * .05)},${Math.round(width * .05)},${Math.round(height * .05)},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  return header + cues.map(cue => `Dialogue: 0,${clock(cue.start, true)},${clock(cue.end, true)},Default,,0,0,0,,${cue.text.replace(/\\/g, '＼').replace(/[{}]/g, '').replace(/\n/g, '\\N')}`).join('\n');
}
