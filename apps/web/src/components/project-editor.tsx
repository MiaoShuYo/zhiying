'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Player } from '@remotion/player';
import { ExplainerVideo, getDurationInFrames } from '@m2v/video';
import { StoryboardSchema, type Scene, type Storyboard, type StyleId } from '@m2v/schema';
import { styles } from '@m2v/styles';

type ProgressInfo = { message?: string; percent?: number; chapterIndex?: number; chapterCount?: number; completedChapters?: number; currentChapter?: string };
type Data = { id: string; name: string; styleId: string; status: string; voiceId: string | null; storyboard: Storyboard | null; jobs: { id: string; status: string; stage: string; error: string | null; progress?: string | null; kind?: string; sceneId?: string | null }[] };
const sceneLabels: Record<string, string> = { title: '标题', bullets: '要点', diagram: '图示', comparison: '对比', chart: '图表', code: '代码' };
const stageLabels: Record<string, string> = { extracting: '读取资料', analyzing: '分析内容', storyboarding: '生成分镜', generating_audio: '生成语音', rendering: '渲染视频', encoding: '视频编码' };
const analysisStatuses = ['created', 'extracting', 'analyzing', 'storyboarding'];
const activeStatuses = [...analysisStatuses, 'generating_audio', 'rendering', 'encoding'];
const analysisProgressValues: Record<string, number> = { created: 8, extracting: 20, analyzing: 58, storyboarding: 82 };

function readProgress(value?: string | null): ProgressInfo | null {
  if (!value) return null;
  try { return JSON.parse(value) as ProgressInfo; } catch { return null; }
}

function WorkflowProgress({ data }: { data: Data }) {
  const activeJob = data.jobs.find(job => ['queued', 'running'].includes(job.status));
  const activeProgress = readProgress(activeJob?.progress);
  const storyboardActive = analysisStatuses.includes(data.status);
  const storyboardDone = Boolean(data.storyboard) && !storyboardActive;
  const storyboardFailed = data.status === 'failed' && data.jobs.some(job => job.kind === 'storyboard' && job.status === 'failed');
  const scenes = data.storyboard?.scenes ?? [];
  const audioCount = scenes.filter(scene => Boolean(scene.audioSrc)).length;
  const audioProgress = scenes.length ? Math.round(audioCount / scenes.length * 100) : 0;
  const audioActive = data.status === 'generating_audio' || activeJob?.kind === 'tts';
  const audioDone = scenes.length > 0 && audioProgress === 100;
  const audioFailed = data.status === 'failed' && data.jobs.some(job => job.kind === 'tts' && job.status === 'failed');
  const renderJob = data.jobs.find(job => job.kind === 'render');
  const renderActive = Boolean(renderJob && ['queued', 'running'].includes(renderJob.status));
  const renderDone = renderJob?.status === 'completed' && data.status !== 'generating_audio';
  const renderFailed = renderJob?.status === 'failed';
  const storyboardValue = storyboardActive
    ? (activeProgress?.percent ?? analysisProgressValues[data.status] ?? 10)
    : storyboardDone ? 100 : 0;
  const audioValue = audioActive ? Math.max(8, Math.min(95, audioProgress)) : audioDone ? 100 : 0;
  const renderValue = data.status === 'generating_audio' ? 0 : renderDone ? 100 : renderActive ? (renderJob?.stage === 'encoding' ? 88 : renderJob?.status === 'queued' ? 8 : 62) : 0;
  const progress = storyboardActive ? Math.round(storyboardValue / 3)
    : renderDone ? 100
    : renderActive ? Math.round((audioDone ? 67 : 34) + renderValue / 3)
    : audioActive ? Math.round(33 + audioValue / 3)
    : audioDone ? 67
    : storyboardDone ? 33
    : 0;
  const currentStage = activeJob?.stage ?? (activeStatuses.includes(data.status) ? data.status : '');
  const summary = data.status === 'failed' ? '执行失败'
    : activeProgress?.message ?? (currentStage ? `正在${stageLabels[currentStage] ?? currentStage}`
    : renderDone ? '视频已导出'
    : audioDone ? '语音已完成，等待导出'
    : storyboardDone ? '分镜已就绪，等待审核'
    : '等待生成分镜');
  const stepState = (active: boolean, done: boolean, failed: boolean) => failed ? 'failed' : active ? 'active' : done ? 'done' : 'pending';
  const steps = [
    { label: '故事板', detail: storyboardActive ? (activeProgress?.chapterCount ? `${activeProgress.completedChapters ?? 0}/${activeProgress.chapterCount} 章` : stageLabels[data.status] ?? '处理中') : storyboardFailed ? '失败' : storyboardDone ? '已完成' : '待生成', state: stepState(storyboardActive, storyboardDone, storyboardFailed) },
    { label: '场景语音', detail: audioActive ? `${audioCount}/${scenes.length} 场景` : audioFailed ? '失败' : audioDone ? '已完成' : scenes.length ? `${audioCount}/${scenes.length} 场景` : '待分镜', state: stepState(audioActive, audioDone, audioFailed) },
    { label: '渲染导出', detail: renderActive ? (stageLabels[renderJob?.stage ?? 'rendering'] ?? '处理中') : renderFailed ? '失败' : renderDone ? '已完成' : '待导出', state: stepState(renderActive, renderDone, renderFailed) },
  ];

  return <section className={`workflow-progress ${data.status === 'failed' ? 'has-failure' : ''}`} aria-label="项目综合进度">
    <div className="workflow-summary"><p className="eyebrow">制作进度</p><strong>{progress}%</strong><span>{summary}</span></div>
    <div className="workflow-detail"><div className="workflow-track"><span style={{ width: `${progress}%` }} /></div><div className="workflow-steps">{steps.map((step, index) => <div className={`workflow-step ${step.state}`} key={step.label}><i>{step.state === 'done' ? '✓' : index + 1}</i><span><b>{step.label}</b><small>{step.detail}</small></span></div>)}</div></div>
  </section>;
}
export function ProjectEditor({ initial }: { initial: Data }) {
  const [data, setData] = useState(initial); const [tab, setTab] = useState<'storyboard' | 'voice' | 'render'>('storyboard'); const [active, setActive] = useState(0); const [saving, setSaving] = useState(false); const [message, setMessage] = useState(''); const [audioName, setAudioName] = useState(''); const [audioDraftName, setAudioDraftName] = useState(''); const [audioDraftReady, setAudioDraftReady] = useState(false); const [audioUploading, setAudioUploading] = useState(false); const [transcript, setTranscript] = useState(''); const [transcriptReady, setTranscriptReady] = useState(false); const [transcriptSaving, setTranscriptSaving] = useState(false); const [voiceSpeed, setVoiceSpeed] = useState(1); const [voiceId, setVoiceId] = useState(data.voiceId ?? 'my-voice'); const transcriptRef = useRef(''); const transcriptTimer = useRef<number | null>(null); const speedTimer = useRef<number | null>(null); const [renderJob, setRenderJob] = useState(() => initial.jobs.find(job => job.kind === 'render')?.id ?? ''); const [renderStatus, setRenderStatus] = useState(() => { const job = initial.jobs.find(item => item.kind === 'render'); return job?.status === 'running' ? job.stage : job?.status ?? 'queued'; }); const autoDownloadJob = useRef<string | null>(null); const [renderError, setRenderError] = useState(''); const [retryBusy, setRetryBusy] = useState(false);
  const storyboard = data.storyboard; const safeIndex = Math.min(active, Math.max(0, (storyboard?.scenes.length ?? 1) - 1)); const isBusy = retryBusy || saving || audioUploading || ['created', 'extracting', 'analyzing', 'storyboarding', 'generating_audio', 'rendering', 'encoding'].includes(data.status) || data.jobs.some(job => ['queued', 'running'].includes(job.status));
  const videoFilename = `${data.name.replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/[.\s]+$/g, '') || '项目'}.mp4`;
  const failedJob = data.jobs.find(job => job.status === 'failed');
  const storyboardJob = data.jobs.find(job => job.kind === 'storyboard' && ['queued', 'running'].includes(job.status));
  const generationProgress = readProgress(storyboardJob?.progress);
  const playerProps = useMemo(() => storyboard ? ({ component: ExplainerVideo, inputProps: { storyboard }, durationInFrames: getDurationInFrames(storyboard), fps: 30, compositionWidth: 1920, compositionHeight: 1080 }) : null, [storyboard]);
  useEffect(() => { let stopped = false; void fetch(`/api/projects/${data.id}/voice/draft`, { cache: 'no-store' }).then(response => response.json()).then(result => { if (stopped) return; if (result.filename) { setAudioDraftName(result.filename); setAudioName(result.displayName ?? result.filename); setAudioDraftReady(true); } const savedTranscript = typeof result.transcript === 'string' ? result.transcript : ''; transcriptRef.current = savedTranscript; setTranscript(savedTranscript); if (typeof result.speed === 'number' && result.speed >= 0.7 && result.speed <= 1.2) setVoiceSpeed(result.speed); setTranscriptReady(true); }).catch(() => { if (!stopped) setTranscriptReady(true); /* Selecting a new file remains available if draft lookup fails. */ }); return () => { stopped = true; if (transcriptTimer.current !== null) window.clearTimeout(transcriptTimer.current); if (speedTimer.current !== null) window.clearTimeout(speedTimer.current); }; }, [data.id]);
  useEffect(() => { if (!renderJob || ['completed', 'failed'].includes(renderStatus)) return; const poll = async () => { try { const response = await fetch(`/api/jobs/${renderJob}`); const job = await response.json(); setRenderStatus(job.status === 'running' ? job.stage : job.status); setData(current => ({ ...current, jobs: current.jobs.map(item => item.id === renderJob ? { ...item, status: job.status, stage: job.stage, error: job.error } : item) })); if (job.status === 'failed') setRenderError(job.error ?? '渲染失败'); } catch { /* Poll again while the local worker is available. */ } }; void poll(); const timer = window.setInterval(poll, 2500); return () => window.clearInterval(timer); }, [renderJob, renderStatus]);
  useEffect(() => {
    if (!renderJob || renderStatus !== 'completed' || autoDownloadJob.current !== renderJob) return;
    autoDownloadJob.current = null;
    const link = document.createElement('a');
    link.href = `/api/projects/${data.id}/output`;
    link.download = videoFilename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, [data.id, renderJob, renderStatus]);
  const videoAvailable = renderStatus === 'completed';
  async function downloadVideo() {
    if (!videoAvailable || isBusy) return;
    try {
      const response = await fetch(`/api/projects/${data.id}/output`);
      if (!response.ok) throw new Error('当前项目没有可下载的视频');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = videoFilename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '视频下载失败');
    }
  }
  const shouldPollProgress = activeStatuses.includes(data.status) || data.jobs.some(job => ['queued', 'running'].includes(job.status));
  useEffect(() => {
    if (!shouldPollProgress) return;
    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/projects/${data.id}`, { cache: 'no-store' });
        if (!response.ok) return;
        const project = await response.json();
        if (!stopped) setData(current => ({ ...current, status: project.status, storyboard: project.storyboard, jobs: project.jobs ?? current.jobs }));
      } catch { /* Keep polling while the local service is available. */ }
    };
    void poll();
    const timer = window.setInterval(poll, 1800);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [data.id, shouldPollProgress]);
  async function saveTranscript(value: string) {
    setTranscriptSaving(true);
    try {
      const response = await fetch(`/api/projects/${data.id}/voice/draft`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transcript: value }), keepalive: true });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '转录保存失败');
    } catch (error) {
      setMessage(error instanceof Error ? `转录保存失败：${error.message}` : '转录保存失败');
    } finally { setTranscriptSaving(false); }
  }
  function queueTranscriptSave(value: string) {
    if (transcriptTimer.current !== null) window.clearTimeout(transcriptTimer.current);
    transcriptTimer.current = window.setTimeout(() => { transcriptTimer.current = null; void saveTranscript(value); }, 450);
  }
  function flushTranscriptSave() {
    if (transcriptTimer.current !== null) window.clearTimeout(transcriptTimer.current);
    transcriptTimer.current = null;
    void saveTranscript(transcriptRef.current);
  }
  async function saveVoiceSpeed(value: number) {
    try {
      const response = await fetch(`/api/projects/${data.id}/voice/draft`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ speed: value }), keepalive: true });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '语速保存失败');
    } catch (error) { setMessage(error instanceof Error ? `语速保存失败：${error.message}` : '语速保存失败'); }
  }
  function queueVoiceSpeedSave(value: number) {
    if (speedTimer.current !== null) window.clearTimeout(speedTimer.current);
    speedTimer.current = window.setTimeout(() => { speedTimer.current = null; void saveVoiceSpeed(value); }, 400);
  }
  function flushVoiceSpeedSave() {
    if (speedTimer.current !== null) window.clearTimeout(speedTimer.current);
    speedTimer.current = null;
    void saveVoiceSpeed(voiceSpeed);
  }
  function updateScene(index: number, patch: Partial<Scene>) { if (!storyboard || isBusy) return; const scenes = [...storyboard.scenes]; scenes[index] = { ...scenes[index], ...patch }; setData({ ...data, storyboard: { ...storyboard, scenes } }); }
  async function save() { if (!storyboard || isBusy) return; setSaving(true); setMessage(''); try { const parsed = StoryboardSchema.parse(storyboard); const r = await fetch(`/api/projects/${data.id}/storyboard`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(parsed) }); const result = await r.json(); if (!r.ok) throw new Error(result.error); setMessage('已保存'); } catch (e) { setMessage(e instanceof Error ? e.message : '保存失败'); } finally { setSaving(false); } }
  async function selectAudio(file: File | null) { if (!file || isBusy) return; setAudioName(file.name); setAudioDraftReady(false); setAudioUploading(true); setMessage(''); try { const form = new FormData(); form.set('audio', file); const response = await fetch(`/api/projects/${data.id}/voice/draft`, { method: 'POST', body: form }); const result = await response.json(); if (!response.ok) throw new Error(result.error); setAudioDraftName(result.filename); setAudioName(result.displayName ?? file.name); setAudioDraftReady(true); } catch (e) { setMessage(e instanceof Error ? e.message : '参考音频保存失败'); } finally { setAudioUploading(false); } }
  async function makeVoice() { if (isBusy || !audioDraftReady) return; setSaving(true); try { const form = new FormData(); form.set('draftName', audioDraftName); form.set('voiceId', voiceId); form.set('transcript', transcript); const r = await fetch(`/api/projects/${data.id}/voice`, { method: 'POST', body: form }); const result = await r.json(); if (r.ok) setData(current => ({ ...current, voiceId })); setMessage(r.ok ? '声音档案已保存' : result.error); } catch (e) { setMessage(e instanceof Error ? e.message : '声音档案保存失败'); } finally { setSaving(false); } }
  async function synthesize() { if (isBusy) return; if (speedTimer.current !== null) window.clearTimeout(speedTimer.current); speedTimer.current = null; void saveVoiceSpeed(voiceSpeed); setRetryBusy(true); setData(current => ({ ...current, status: 'generating_audio', storyboard: current.storyboard ? { ...current.storyboard, scenes: current.storyboard.scenes.map(scene => ({ ...scene, audioSrc: undefined })) } : null })); setMessage('正在逐场生成语音…'); try { const r = await fetch(`/api/projects/${data.id}/voice/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ speed: voiceSpeed, force: true }) }); const result = await r.json(); if (!r.ok) { const latest = await fetch(`/api/projects/${data.id}`, { cache: 'no-store' }).then(response => response.json()); setData(current => ({ ...current, status: latest.status, storyboard: latest.storyboard, jobs: latest.jobs ?? current.jobs })); setMessage(result.error); return; } setData(current => ({ ...current, storyboard: result.storyboard, status: 'awaiting_review' })); setMessage(result.message); } catch (e) { setData(current => ({ ...current, status: 'failed' })); setMessage(e instanceof Error ? e.message : '语音生成失败'); } finally { setRetryBusy(false); } }
  async function render() { if (isBusy) return; const r = await fetch(`/api/projects/${data.id}/render`, { method: 'POST' }); const result = await r.json(); if (r.ok) { autoDownloadJob.current = result.jobId; setRenderJob(result.jobId); setRenderStatus('queued'); setRenderError(''); setData(current => ({ ...current, jobs: [{ id: result.jobId, status: 'queued', stage: 'rendering', error: null, kind: 'render' }, ...current.jobs] })); setTab('render'); setMessage('渲染任务已加入本地队列'); } else setMessage(result.error); }
  async function retryProject(mode: 'step' | 'restart') { if (isBusy) return; setRetryBusy(true); setMessage(''); try { const response = await fetch(`/api/projects/${data.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); setData(current => ({ ...current, status: result.status, storyboard: mode === 'restart' ? null : current.storyboard, jobs: [{ id: `retry-${Date.now()}`, status: 'queued', stage: result.stage, error: null, kind: 'storyboard' }, ...current.jobs] })); } catch (e) { setMessage(e instanceof Error ? e.message : '重新执行失败'); } finally { setRetryBusy(false); } }
  async function retryScene() { if (isBusy || !storyboard || !storyboard.scenes[safeIndex]) return; const s = storyboard.scenes[safeIndex]; setSaving(true); try { const r = await fetch(`/api/projects/${data.id}/scenes/${s.id}/regenerate`, { method: 'POST' }); const result = await r.json(); setMessage(r.ok ? '场景已重新生成' : result.error); if (r.ok && result.storyboard) setData({ ...data, storyboard: result.storyboard }); } finally { setSaving(false); } }
  return <main className="shell editor-shell"><header className="topbar"><Link className="brand" href="/">知影 <span>LOCAL STUDIO</span></Link><div className="crumb">项目 / <b>{data.name}</b></div><div className="top-actions"><button className="button subtle" onClick={save} disabled={!storyboard || isBusy}>{saving ? '保存中…' : '保存分镜'}</button><button className="button primary" onClick={render} disabled={!storyboard || isBusy}>导出视频 ↗</button></div></header><div className="editor-heading"><div><p className="eyebrow">PROJECT WORKSPACE</p><h1>{data.name}</h1><p className="muted">{storyboard?.scenes.length ?? 0} 个场景 · {styles[data.styleId as StyleId]?.name ?? data.styleId} · 16:9</p></div><WorkflowProgress data={data} /><div className="tabs">{(['storyboard', 'voice', 'render'] as const).map(t => <button className={tab === t ? 'active' : ''} onClick={() => setTab(t)} key={t}>{t === 'storyboard' ? '故事板' : t === 'voice' ? '声音设置' : '渲染导出'}</button>)}</div></div>
  {data.status === 'failed' && <section className="settings-card retry-card"><p className="eyebrow">TASK FAILED</p><h2>项目执行失败</h2><p className="error-text">{failedJob?.error ?? '执行遇到错误，请检查本地服务后重试。'}</p><p className="failure-step"><span>失败步骤</span><code>{failedJob ? stageLabels[failedJob.stage] ?? failedJob.stage : '未知'}</code></p><div className="retry-actions">{failedJob?.kind === 'storyboard' && <><button className="button primary" disabled={retryBusy} onClick={() => void retryProject('step')}>{retryBusy ? '重新执行中…' : '从失败步骤重试'}</button><button className="button subtle" disabled={retryBusy} onClick={() => void retryProject('restart')}>从头重新执行</button></>}{failedJob?.kind === 'tts' && <button className="button primary" disabled={retryBusy} onClick={() => void synthesize()}>{retryBusy ? '重新执行中…' : '继续生成未完成语音'}</button>}<Link className="button subtle" href="/">返回项目列表</Link></div></section>}
  {message && data.status !== 'failed' && <div className="toast" onClick={() => setMessage('')}>{message}<button>×</button></div>}
  {tab === 'storyboard' && !storyboard && analysisStatuses.includes(data.status) && <section className="analysis-state-card"><span className="analysis-loader" aria-hidden="true" /><p className="eyebrow">LOCAL AI · 正在处理资料</p><h2>{generationProgress?.phase === 'storyboarding' ? '正在生成分镜' : '分析中'}</h2><p className="muted">{generationProgress?.message ?? (data.status === 'created' || data.status === 'extracting' ? '正在读取并整理导入资料…' : data.status === 'analyzing' ? '正在分析资料内容，请稍候…' : '正在根据分析结果生成分镜…')}</p>{generationProgress?.chapterCount && <p className="muted">章节进度：{generationProgress.completedChapters ?? 0} / {generationProgress.chapterCount} 章</p>}{generationProgress?.percent !== undefined && <div className="analysis-progress-track"><span style={{ width: `${Math.max(0, Math.min(100, generationProgress.percent))}%` }} /></div>}{generationProgress?.currentChapter && <span className="analysis-current-chapter">当前章节：{generationProgress.currentChapter}</span>}<span className="analysis-state-note">进度会自动更新；完成后，分镜会显示在这里供你检查和编辑。</span></section>}
  {tab === 'storyboard' && storyboard && <div className="editor-grid"><aside className="scene-list"><div className="panel-title"><b>故事板</b><span>{storyboard.scenes.length} 场景</span></div>{storyboard.scenes.map((s, i) => <button className={`scene-row ${i === safeIndex ? 'selected' : ''}`} onClick={() => setActive(i)} key={s.id}><span className="scene-number">{String(i + 1).padStart(2, '0')}</span><span className="scene-row-copy"><b>{s.title ?? sceneLabels[s.type]}</b><small>{sceneLabels[s.type]} · {s.duration ?? 6} 秒</small></span><span className="scene-drag">⠿</span></button>)}<button className="add-scene" disabled={isBusy} onClick={() => { const scene: Scene = { id: crypto.randomUUID(), type: 'bullets', title: '新场景', narration: '请补充讲解内容。', duration: 6, visual: { items: ['要点一'] } }; setData({ ...data, storyboard: { ...storyboard, scenes: [...storyboard.scenes, scene] } }); setActive(storyboard.scenes.length); }}>＋ 添加场景</button></aside><section className="preview-column"><div className="preview-toolbar"><span><i className="live-dot"/> 实时预览</span><span>1920 × 1080 · 30 FPS</span></div><div className="preview-frame">{playerProps && <Player {...playerProps} style={{ width: '100%' }} controls />}</div><div className="preview-foot"><span>预览使用结构化分镜实时渲染</span><button className="text-button" disabled={isBusy} onClick={retryScene}>↻ 重新生成当前场景</button></div></section><aside className="inspector"><div className="panel-title"><b>场景内容</b><span>{String(safeIndex + 1).padStart(2, '0')}</span></div>{storyboard.scenes[safeIndex] && <><label className="field-label">场景类型</label><select className="input" disabled={isBusy} value={storyboard.scenes[safeIndex].type} onChange={e => { const type = e.target.value as Scene['type']; const visual = type === 'bullets' ? { items: ['关键要点'] } : type === 'comparison' ? { columns: [{ title: '方案 A', items: ['特点'] }, { title: '方案 B', items: ['特点'] }] } : type === 'chart' ? { data: [{ label: '数据', value: 1 }] } : type === 'diagram' ? { nodes: [{ id: 'a', label: '起点' }, { id: 'b', label: '终点' }] } : type === 'code' ? { code: '// 示例代码' } : {}; updateScene(safeIndex, { type, visual }); }} >{Object.entries(sceneLabels).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select><label className="field-label">标题</label><input className="input" disabled={isBusy} maxLength={50} value={storyboard.scenes[safeIndex].title ?? ''} onChange={e => updateScene(safeIndex, { title: e.target.value })} /><label className="field-label">旁白</label><textarea className="input textarea inspector-textarea" disabled={isBusy} value={storyboard.scenes[safeIndex].narration} onChange={e => updateScene(safeIndex, { narration: e.target.value })} /><label className="field-label">画面数据（JSON）</label><textarea className="input textarea json-area" disabled={isBusy} value={JSON.stringify(storyboard.scenes[safeIndex].visual, null, 2)} onChange={e => { try { updateScene(safeIndex, { visual: JSON.parse(e.target.value) }); } catch { /* Keep editing incomplete JSON until it parses. */ } }} /><label className="field-label">时长（秒）</label><input className="input" disabled={isBusy} type="number" min="2" value={storyboard.scenes[safeIndex].duration ?? 6} onChange={e => updateScene(safeIndex, { duration: Number(e.target.value) })} /><div className="move-buttons"><button className="button subtle" disabled={isBusy || safeIndex === 0} onClick={() => { const scenes = [...storyboard.scenes]; [scenes[safeIndex - 1], scenes[safeIndex]] = [scenes[safeIndex], scenes[safeIndex - 1]]; setData({ ...data, storyboard: { ...storyboard, scenes } }); setActive(safeIndex - 1); }}>↑ 上移</button><button className="button subtle" disabled={isBusy || safeIndex === storyboard.scenes.length - 1} onClick={() => { const scenes = [...storyboard.scenes]; [scenes[safeIndex + 1], scenes[safeIndex]] = [scenes[safeIndex], scenes[safeIndex + 1]]; setData({ ...data, storyboard: { ...storyboard, scenes } }); setActive(safeIndex + 1); }}>↓ 下移</button><button className="button danger" disabled={isBusy} onClick={() => { if (storyboard.scenes.length < 2) return; const scenes = storyboard.scenes.filter((_, i) => i !== safeIndex); setData({ ...data, storyboard: { ...storyboard, scenes } }); setActive(Math.max(0, safeIndex - 1)); }}>删除</button></div></>}</aside></div>}
  {tab === 'voice' && <section className="settings-card"><p className="eyebrow">VOICE PROFILE</p><h2>创建你的声音档案</h2><p className="muted">可上传较长的清晰人声并填写准确转录。参考音频和对应转录用于生成项目语音；可调整下方语速。音频留在本机。</p>{!data.voiceId && <p className="general-voice-note">当前项目未设置专属声音，生成语音时将使用通用声音。</p>}<label className="field-label">声音档案 ID</label><input className="input" disabled={isBusy} value={voiceId} onChange={e => setVoiceId(e.target.value)} /><label className="field-label">参考音频</label><label className={`audio-picker ${isBusy ? 'disabled' : ''}`}><input className="audio-file-input" disabled={isBusy} type="file" accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a" onChange={e => { const file = e.currentTarget.files?.[0] ?? null; e.currentTarget.value = ''; void selectAudio(file); }} /><span className="audio-picker-button">选择文件</span><span className="audio-filename">{audioUploading ? '正在保存到本机…' : audioName ? (audioDraftReady ? audioName : `${audioName}（保存失败，请重选）`) : '尚未选择参考音频'}</span></label><label className="field-label">音频转录</label><p className="voice-transcript-hint">较长音频会自动选取句末停顿处的完整语句作为音色参考；转录请与录音逐字对应。</p><textarea className="input textarea" disabled={isBusy || !transcriptReady} value={transcript} onChange={e => { const value = e.target.value; transcriptRef.current = value; setTranscript(value); queueTranscriptSave(value); }} onBlur={flushTranscriptSave} placeholder={transcriptReady ? "准确填写音频中说出的内容…" : "正在读取已保存的转录…"} /><p className="transcript-save-state">{!transcriptReady ? "正在读取已保存转录…" : transcriptSaving ? "正在保存到本机…" : "转录内容会自动保存到本机"}</p><label className="field-label">生成语速</label><div className="voice-speed-control"><span>慢</span><input aria-label="生成语音速度" disabled={isBusy || !transcriptReady} type="range" min="0.7" max="1.2" step="0.05" value={voiceSpeed} onChange={e => { const value = Number(e.target.value); setVoiceSpeed(value); queueVoiceSpeedSave(value); }} onBlur={flushVoiceSpeedSave} /><span>快</span><strong>{voiceSpeed.toFixed(2).replace(/\.?0+$/, "")}×</strong></div><p className="voice-speed-hint">0.7× 较慢，1.0× 为正常语速；调整后会自动保存。</p><button className="button primary" disabled={isBusy || !audioDraftReady} onClick={makeVoice}>保存声音档案</button><button className="button subtle" style={{ marginLeft: 10 }} disabled={isBusy} onClick={synthesize}>{storyboard?.scenes.some(scene => scene.audioSrc) ? "按当前语速重新生成全部语音" : data.voiceId ? "为全部场景生成语音" : "使用通用声音生成语音"}</button><p className="hint">需要运行本地 Python 服务并安装 F5-TTS 及模型权重。</p><div className="generated-audio-section"><h3>场景语音试听</h3>{storyboard?.scenes.some(scene => scene.audioSrc) ? storyboard.scenes.filter(scene => scene.audioSrc).map((scene, index) => <div className="generated-audio-item" key={scene.id}><b>{scene.title || `场景 ${index + 1}`}</b><audio controls preload="metadata" src={`/${scene.audioSrc}`} /></div>) : <p className="muted">生成全部场景语音后，可在这里逐段试听。</p>}</div></section>}
  {tab === 'render' && <section className="settings-card"><p className="eyebrow">EXPORT</p><h2>导出讲解视频</h2><p className="muted">使用已审核的分镜生成 1920 × 1080、30 FPS MP4。</p><div className="export-summary"><span>画幅<b>16:9</b></span><span>分辨率<b>1080p</b></span><span>编码<b>H.264</b></span><span>渲染器<b>Remotion</b></span></div><div className="render-actions"><button className="button primary" disabled={isBusy} onClick={render}>开始渲染 →</button><button className="button primary" disabled={!videoAvailable || isBusy} onClick={() => void downloadVideo()}>下载视频 ↓</button></div>{renderJob && renderStatus !== 'completed' && <div className="job-card"><b>渲染状态：{renderStatus}</b>{renderError && <p className="error-text">{renderError}</p>}<p>请保持本地 Worker 运行，任务状态会自动更新。</p></div>}</section>}
  {!storyboard && !['created', 'extracting', 'analyzing', 'storyboarding', 'failed'].includes(data.status) && <div className="empty"><h2>项目还没有故事板</h2><p>返回首页并重新导入素材。</p></div>}
  </main>;
}





