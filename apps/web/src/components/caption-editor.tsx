'use client';
import { useMemo, useRef, useState } from 'react';
import { sceneSeconds, type Scene, type SubtitleCue } from '@m2v/schema';
import { captionDuration, resolveCaptionCues } from '@m2v/video/captions';

const round = (value: number) => Math.round(value * 100) / 100;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type Edge = 'start' | 'end';

/**
 * Cue-level subtitle editor. Every edit is expressed in scene-relative seconds so
 * the preview, the SRT/VTT/ASS export and the delivery check all read the same
 * numbers from `resolveCaptionCues`.
 */
export function CaptionTimeline({ scene, portrait, disabled, onChange }: {
  scene: Scene;
  portrait: boolean;
  disabled: boolean;
  onChange: (cues: SubtitleCue[] | undefined) => void;
}) {
  const duration = captionDuration(scene);
  const cues = useMemo(() => resolveCaptionCues(scene, duration, portrait), [scene, duration, portrait]);
  const manual = (scene.subtitleCues?.length ?? 0) > 0;
  const [selected, setSelected] = useState(0);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ index: number; edge: Edge; start: number; end: number; width: number; x: number } | null>(null);

  const problems = cues.map((cue, index) => {
    const issues: string[] = [];
    if (cue.end - cue.start < 0.4) issues.push('时长不足 0.4 秒');
    if (index > 0 && cue.start < cues[index - 1].end - 0.02) issues.push('与上一条重叠');
    if (cue.end > duration + 0.02) issues.push('超出场景时长');
    return issues;
  });
  const apply = (next: SubtitleCue[]) => onChange(next.map(cue => ({ text: cue.text, start: round(cue.start), end: round(cue.end) })));
  const active = cues[Math.min(selected, cues.length - 1)];
  const clamped = useMemo(() => (scene.subtitleCues ?? []).some(item => {
    const cue = cues.find(candidate => candidate.text === item.text.trim());
    return !cue || Math.abs(cue.start - item.start) > 0.02 || Math.abs(cue.end - item.end) > 0.02;
  }), [scene.subtitleCues, cues]);

  function beginDrag(event: React.PointerEvent, index: number, edge: Edge) {
    if (disabled) return;
    const width = track.current?.getBoundingClientRect().width ?? 0;
    if (!width) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = { index, edge, start: cues[index].start, end: cues[index].end, width, x: event.clientX };
    setSelected(index);
  }
  function moveDrag(event: React.PointerEvent) {
    const state = drag.current;
    if (!state) return;
    const delta = (event.clientX - state.x) / state.width * duration;
    apply(cues.map((cue, index) => index !== state.index ? cue : state.edge === 'start'
      ? { ...cue, start: clamp(state.start + delta, 0, state.end - 0.2) }
      : { ...cue, end: clamp(state.end + delta, state.start + 0.2, duration) }));
  }
  function update(index: number, patch: Partial<SubtitleCue>) {
    apply(cues.map((cue, at) => at === index ? { ...cue, ...patch } : cue));
  }
  function insert() {
    const last = cues[cues.length - 1];
    const start = last ? Math.min(last.end, Math.max(0, duration - 1)) : 0;
    apply([...cues, { text: '新字幕', start, end: Math.min(duration, start + 2) }]);
    setSelected(cues.length);
  }

  return <div className="caption-timeline">
    <div className="caption-head">
      <b>时间轴精修</b>
      <span className="caption-badge">{manual ? '手动时间轴' : '自动时间轴'}</span>
      <span className="caption-meta">共 {cues.length} 条 · 画面 {round(sceneSeconds(scene)).toFixed(2)}s · 字幕可用 {duration.toFixed(2)}s</span>
      <button className="button subtle" disabled={disabled || !manual} onClick={() => { onChange(undefined); setSelected(0); }}>恢复自动生成</button>
    </div>
    <div className="caption-track" ref={track} role="group" aria-label="字幕时间轴">
      {cues.map((cue, index) => <div
        key={index}
        className={`caption-bar${index === selected ? ' selected' : ''}${problems[index].length ? ' invalid' : ''}`}
        style={{ left: `${duration > 0 ? cue.start / duration * 100 : 0}%`, width: `${duration > 0 ? Math.max(.6, (cue.end - cue.start) / duration * 100) : 0}%` }}
        title={`${index + 1}. ${cue.text}`}
        onClick={() => setSelected(index)}
      >
        <span className="caption-handle start" onPointerDown={event => beginDrag(event, index, 'start')} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null; }} />
        <em>{index + 1}</em>
        <span className="caption-handle end" onPointerDown={event => beginDrag(event, index, 'end')} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null; }} />
      </div>)}
      {!cues.length && <p className="hint">当前场景没有旁白，暂无字幕。</p>}
    </div>
    <div className="caption-rows">
      {cues.map((cue, index) => <div className={`caption-row${index === selected ? ' selected' : ''}`} key={index} onFocus={() => setSelected(index)}>
        <span className="caption-index">{index + 1}</span>
        <label>开始<input className="input" type="number" step={.05} min={0} max={duration} disabled={disabled} value={round(cue.start)} onChange={event => update(index, { start: clamp(Number(event.target.value) || 0, 0, round(cue.end) - 0.05) })} /></label>
        <label>结束<input className="input" type="number" step={.05} min={0} max={duration} disabled={disabled} value={round(cue.end)} onChange={event => update(index, { end: clamp(Number(event.target.value) || 0, round(cue.start) + 0.05, duration) })} /></label>
        <label className="caption-text">文本<input className="input" disabled={disabled} value={cue.text} onChange={event => update(index, { text: event.target.value })} /></label>
        <button className="button danger" disabled={disabled} onClick={() => { apply(cues.filter((_, at) => at !== index)); setSelected(Math.max(0, index - 1)); }}>删除</button>
        {problems[index].length > 0 && <p className="caption-problem">{problems[index].join('；')}</p>}
      </div>)}
    </div>
    <div className="v11-row">
      <button className="button subtle" disabled={disabled || !cues.length} onClick={insert}>新增一条字幕</button>
      {active && <span className="caption-hint">第 {Math.min(selected, cues.length - 1) + 1} 条：拖动条块两端调整时间，或直接修改数值。首次修改后本场景改用手动时间轴。</span>}
    </div>
    {manual && <p className="hint">手动时间轴已启用：导出 SRT / VTT / ASS 与画面字幕使用同一份时间。修改旁白、语速或重新生成语音会清空本场景的手动时间轴。</p>}
    {manual && clamped && <p className="hint" role="status">部分字幕超出画面可用时长，已按画面结尾截断；请缩短旁白或延长场景时长。</p>}
  </div>;
}
