'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SubtitleSchema, captionDuration, sceneSeconds, subtitleCues, timelineFor, type Storyboard, type SubtitleCue } from '@m2v/schema';

const round = (value: number) => Math.round(value * 100) / 100;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}.${String(Math.round(seconds * 10) % 10)}`;

type CueRef = { sceneIndex: number; cueIndex: number };

type Props = {
  id: string;
  jobId: string;
  board: Storyboard | null;
  disabled: boolean;
  /** Persists one scene's cues in scene-relative seconds; `undefined` restores automatic timing. */
  onSaveCues: (sceneIndex: number, cues: SubtitleCue[] | undefined) => Promise<boolean>;
  onJumpScene: (sceneIndex: number) => void;
  onOpenRender: () => void;
  onMessage: (text: string) => void;
};

/**
 * Subtitle refinement on the real MP4: the overlay and the cue track are computed from
 * the same `subtitleCues` the exporters write, so what is seen here is what ships.
 */
export function FinalCutPreview({ id, jobId, board, disabled, onSaveCues, onJumpScene, onOpenRender, onMessage }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [stageWidth, setStageWidth] = useState(0);
  const [selected, setSelected] = useState<CueRef | null>(null);
  const [overrides, setOverrides] = useState<Record<number, SubtitleCue[]>>({});
  const [saving, setSaving] = useState(false);

  const portrait = board?.aspectRatio === '9:16';
  const subtitle = useMemo(() => {
    try { return SubtitleSchema.parse(board?.subtitles ?? {}); } catch { return SubtitleSchema.parse({}); }
  }, [board?.subtitles]);
  const baseCues = useMemo(() => (board ? subtitleCues(board) : []), [board]);
  const cues = useMemo(() => {
    if (!board) return [];
    const overridden = new Set(Object.keys(overrides).map(Number));
    const merged = baseCues.filter(cue => !overridden.has(cue.sceneIndex));
    for (const [key, list] of Object.entries(overrides)) {
      const sceneIndex = Number(key);
      list.forEach((cue, cueIndex) => merged.push({ ...cue, sceneIndex, cueIndex }));
    }
    return merged.sort((a, b) => a.start - b.start);
  }, [baseCues, board, overrides]);
  const boardTotal = useMemo(() => (board ? timelineFor(board).totalSeconds : 0), [board]);
  const total = duration > 0 ? duration : boardTotal;
  const drift = duration > 0 && Math.abs(duration - boardTotal) > 0.05 ? duration - boardTotal : 0;
  const dirty = Object.keys(overrides).length > 0;
  const caption = cues.find(cue => time >= cue.start && time < cue.end)?.text ?? '';
  const current = selected ? cues.find(cue => cue.sceneIndex === selected.sceneIndex && cue.cueIndex === selected.cueIndex) ?? null : null;
  const currentScene = current ? board?.scenes[current.sceneIndex] ?? null : null;

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => setStageWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const overlayScale = Math.min(stageWidth / (portrait ? 1080 : 1920), 1.25);
  const captionStyle: React.CSSProperties = {
    left: '5%',
    right: '5%',
    ...(subtitle.position === 'top' ? { top: '5%' } : subtitle.position === 'center' ? { top: '50%', transform: 'translateY(-50%)' } : { bottom: '5%' }),
    padding: `${10 * overlayScale}px ${18 * overlayScale}px`,
    borderRadius: 8 * overlayScale,
    background: subtitle.preset === 'minimal' ? 'transparent' : `${subtitle.background}${Math.round(subtitle.backgroundOpacity * 255).toString(16).padStart(2, '0')}`,
    color: subtitle.color,
    textShadow: subtitle.preset === 'minimal' ? '0 2px 4px #000' : undefined,
    fontSize: subtitle.fontSize * overlayScale,
    fontWeight: subtitle.preset === 'highlight' ? 900 : 700,
  };

  const seek = useCallback((seconds: number) => {
    const element = video.current;
    const target = clamp(seconds, 0, Math.max(0, total || seconds));
    if (element) element.currentTime = target;
    setTime(target);
  }, [total]);

  /** Cues of one scene on the video clock: the local edit if any, otherwise the saved ones. */
  const cuesFor = useCallback((sceneIndex: number): SubtitleCue[] => {
    const override = overrides[sceneIndex];
    if (override) return override;
    return baseCues.filter(cue => cue.sceneIndex === sceneIndex).map(cue => ({ text: cue.text, start: cue.start, end: cue.end }));
  }, [baseCues, overrides]);

  function editScene(sceneIndex: number, next: SubtitleCue[]) {
    setOverrides(current => ({ ...current, [sceneIndex]: next }));
  }

  function updateCue(patch: Partial<SubtitleCue>) {
    if (!current || !board) return;
    const list = cuesFor(current.sceneIndex);
    const scene = board.scenes[current.sceneIndex];
    const limit = scene ? sceneSeconds(scene) : Infinity;
    editScene(current.sceneIndex, list.map((cue, index) => {
      if (index !== current.cueIndex) return cue;
      const start = clamp(patch.start ?? cue.start, 0, Math.max(0, limit - 0.05));
      const end = clamp(patch.end ?? cue.end, start + 0.05, limit);
      return { ...cue, ...patch, start: round(start), end: round(end) };
    }));
  }

  async function save() {
    if (!board || !dirty || saving || disabled) return;
    setSaving(true);
    try {
      let failed = '';
      for (const [key, list] of Object.entries(overrides)) {
        const sceneIndex = Number(key);
        const scene = board.scenes[sceneIndex];
        if (!scene) continue;
        const offset = timelineFor(board).scenes[sceneIndex]?.start ?? 0;
        const limit = Math.max(captionDuration(scene), sceneSeconds(scene));
        const relative = list
          .map(cue => ({ text: cue.text.trim(), start: round(clamp(cue.start - offset, 0, limit)), end: round(clamp(cue.end - offset, 0, limit)) }))
          .filter(cue => cue.text && cue.end > cue.start);
        // Emptying the list restores automatic timing for that scene.
        if (!await onSaveCues(sceneIndex, relative.length ? relative : undefined)) failed ||= `场景 ${sceneIndex + 1}`;
      }
      if (failed) onMessage(`${failed}的字幕没有保存成功，请重试`);
      else { setOverrides({}); onMessage('字幕已保存。SRT / VTT / ASS 与交付包已更新；烧在画面上的字幕需重新导出。'); }
    } finally {
      setSaving(false);
    }
  }

  if (!board) return <p className="hint">还没有分镜，先完成故事板。</p>;
  if (!jobId) {
    return (
      <section className="settings-card">
        <h3>还没有成片</h3>
        <p className="hint">成片精修要在真实 MP4 上对照字幕时间，请先导出一次。</p>
        <button className="button primary" onClick={onOpenRender}>去导出成片 →</button>
      </section>
    );
  }

  return (
    <div className="final-cut">
      <section className="cut-stage-wrap">
        <div className={`cut-stage${portrait ? ' portrait' : ''}`} ref={stage}>
          <video
            ref={video}
            className="cut-video"
            src={`/api/projects/${id}/output?jobId=${encodeURIComponent(jobId)}&inline=1`}
            controls
            preload="metadata"
            playsInline
            onLoadedMetadata={event => setDuration(event.currentTarget.duration || 0)}
            onTimeUpdate={event => setTime(event.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
          {caption && <div className="cut-caption" style={captionStyle}>{caption}</div>}
        </div>
        <div className="cut-meta">
          <span>{clock(time)} / {clock(total)}</span>
          <span>成片 {duration ? clock(duration) : '读取中'}</span>
          <span>当前分镜 {clock(boardTotal)}</span>
          <span>{cues.length} 条字幕</span>
        </div>
        {drift !== 0 && (
          <p className="cut-drift" role="status">
            成片基于旧分镜渲染，时长相差 {drift > 0 ? '+' : ''}{drift.toFixed(2)} 秒，字幕时间轴会整体偏移。
            <button className="text-button" onClick={onOpenRender}>重新导出以对齐 →</button>
          </p>
        )}
        <div className="cut-track" role="group" aria-label="字幕轨道">
          {timelineFor(board).scenes.map(segment => (
            <span className="cut-scene-mark" key={`mark-${segment.index}`} style={{ left: `${total > 0 ? segment.start / total * 100 : 0}%` }}>{segment.index + 1}</span>
          ))}
          {cues.map(cue => {
            const active = current?.sceneIndex === cue.sceneIndex && current?.cueIndex === cue.cueIndex;
            return (
              <button
                key={`${cue.sceneIndex}-${cue.cueIndex}`}
                className={`cut-cue${active ? ' selected' : ''}${cue.end > total && total > 0 ? ' past-end' : ''}`}
                style={{ left: `${total > 0 ? cue.start / total * 100 : 0}%`, width: `${total > 0 ? Math.max(0.4, (cue.end - cue.start) / total * 100) : 0}%` }}
                title={`${clock(cue.start)} → ${clock(cue.end)}　${cue.text}`}
                onClick={() => { setSelected({ sceneIndex: cue.sceneIndex, cueIndex: cue.cueIndex }); seek(cue.start); }}
              >
                {cue.text.slice(0, 12)}
              </button>
            );
          })}
          <span className="cut-playhead" style={{ left: `${total > 0 ? Math.min(100, time / total * 100) : 0}%` }} aria-hidden="true" />
        </div>
        <p className="hint">点击轨道上的字幕块即可跳到那一刻复看；拖动播放器进度条可对照画面。</p>
      </section>
      <aside className="cut-editor">
        {current && currentScene ? (
          <>
            <div className="cut-cue-head">
              <b>场景 {current.sceneIndex + 1}{currentScene.title ? ` · ${currentScene.title}` : ''}</b>
              <button className="text-button" onClick={() => onJumpScene(current.sceneIndex)}>跳到该场景 →</button>
            </div>
            <p className="hint">本条在成片里的位置：{clock(current.start)} → {clock(current.end)}（场景内 {round(current.start - (timelineFor(board).scenes[current.sceneIndex]?.start ?? 0))}s 起）</p>
            <label className="field-label">字幕文本</label>
            <textarea className="input" value={current.text} onChange={event => updateCue({ text: event.target.value })} />
            <div className="cut-times">
              <label>开始<input className="input" type="number" step={0.05} value={round(current.start)} onChange={event => updateCue({ start: Number(event.target.value) })} /></label>
              <label>结束<input className="input" type="number" step={0.05} value={round(current.end)} onChange={event => updateCue({ end: Number(event.target.value) })} /></label>
            </div>
            <div className="cut-nudge">
              <button className="button subtle" onClick={() => updateCue({ start: round(current.start - 0.1), end: round(current.end - 0.1) })}>整体 −0.1s</button>
              <button className="button subtle" onClick={() => updateCue({ start: round(current.start + 0.1), end: round(current.end + 0.1) })}>整体 +0.1s</button>
              <button className="button subtle" onClick={() => { seek(current.start); void video.current?.play(); }}>播放此条</button>
            </div>
            <p className="hint">改动只影响字幕时间与文本：播放器会立即按新时间显示，保存后 SRT / VTT / ASS 与交付包同步更新；画面里已经烧制的字幕需要重新导出。</p>
          </>
        ) : (
          <p className="hint">在上方轨道点选一条字幕开始精修。</p>
        )}
        <div className="cut-actions">
          <button className="button primary" disabled={!dirty || saving || disabled} onClick={() => void save()}>{saving ? '保存中…' : dirty ? '保存字幕修改' : '没有待保存的修改'}</button>
          <button className="button subtle" disabled={!dirty || saving} onClick={() => setOverrides({})}>撤销未保存修改</button>
        </div>
        {playing && <p className="hint" role="status">播放中：字幕覆盖层与轨道播放头都在按当前时间刷新。</p>}
      </aside>
    </div>
  );
}
