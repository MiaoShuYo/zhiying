'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ProductionTools, ExportHistory, SourceReview, licenseLabels } from './production-tools';
import { PronunciationEditor } from './pronunciation-editor';
import { Player } from '@remotion/player';
import { ExplainerVideo, getDurationInFrames } from '@m2v/video';
import { StoryboardSchema, type Scene, type Storyboard, type StyleId } from '@m2v/schema';
import { styles } from '@m2v/styles';

type ProgressInfo = { message?: string; phase?: string; percent?: number; chapterIndex?: number; chapterCount?: number; completedChapters?: number; currentChapter?: string };
type CommonsChoice = { title: string; thumbnail: string; sourceUrl: string; attribution: string; license: string; licenseUrl?: string; licenseClass?: string; requiresAttribution?: boolean; warnings?: string[] };

/** Stable key order, so two schema-parsed boards can be compared reliably. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
// 许可提示只做确认，不阻断使用；补写署名后对应提示消失。
const commonsWarnings = (choice: CommonsChoice | null, attribution: string) => (choice?.warnings ?? []).filter(warning => !(attribution.trim() && warning.includes('署名')));
type Data = { id: string; revision?: number; name: string; styleId: string; aspectRatio?: string; assets?: { path: string; name: string; kind?: string; attribution?: string; license?: string; licenseUrl?: string; sourceUrl?: string; licenseClass?: string; warnings?: string[] }[]; status: string; voiceId: string | null; storyboard: Storyboard | null; jobs: { id: string; status: string; stage: string; error: string | null; progress?: string | null; kind?: string; sceneId?: string | null; createdAt?: string | Date }[] };
const sceneLabels: Record<string, string> = { title: '标题', bullets: '要点', diagram: '图示', comparison: '对比', chart: '图表', code: '代码', timeline: '时间线', math: '公式', media: '图片' };
const stageLabels: Record<string, string> = { queued: '等待 Worker', bundling: '准备渲染资源', cancelling: '停止渲染并清理', extracting: '读取资料', analyzing: '分析内容', storyboarding: '生成分镜', generating_audio: '生成语音', rendering: '渲染视频', encoding: '视频编码' };
const analysisStatuses = ['created', 'extracting', 'analyzing', 'storyboarding'];
const activeStatuses = [...analysisStatuses, 'generating_audio', 'rendering', 'encoding'];
const analysisProgressValues: Record<string, number> = { created: 8, extracting: 20, analyzing: 58, storyboarding: 82 };

function readProgress(value?: string | null): ProgressInfo | null {
  if (!value) return null;
  try { return JSON.parse(value) as ProgressInfo; } catch { return null; }
}

function WorkflowProgress({ data }: { data: Data }) {
  const activeJob = data.jobs.find(job => ['queued', 'running', 'cancelling'].includes(job.status));
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
  const renderActive = Boolean(renderJob && ['queued', 'running', 'cancelling'].includes(renderJob.status));
  const renderDone = renderJob?.status === 'completed' && data.status !== 'generating_audio';
  const renderFailed = renderJob?.status === 'failed';
  const storyboardValue = storyboardActive
    ? (activeProgress?.percent ?? analysisProgressValues[data.status] ?? 10)
    : storyboardDone ? 100 : 0;
  const audioValue = audioActive ? Math.max(8, Math.min(95, audioProgress)) : audioDone ? 100 : 0;
  const renderValue = data.status === 'generating_audio' ? 0 : renderDone ? 100 : renderActive ? (renderJob?.stage === 'encoding' ? 80 + (readProgress(renderJob.progress)?.percent ?? 0) * .2 : renderJob?.stage === 'rendering' ? (readProgress(renderJob.progress)?.percent ?? 0) * .8 : 0) : 0;
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
  const [overflowSceneIds, setOverflowSceneIds] = useState<string[]>([]);
  const onOverflow = useCallback((sceneId: string, overflowing: boolean) => setOverflowSceneIds(current => overflowing ? current.includes(sceneId) ? current : [...current, sceneId] : current.filter(id => id !== sceneId)), []);
  const [pronunciationSelection, setPronunciationSelection] = useState<{ text: string; occurrence: number; sceneId: string } | null>(null);
  const [pendingCommons, setPendingCommons] = useState<CommonsChoice | null>(null);
  const [commonsAttribution, setCommonsAttribution] = useState(''), [commonsConfirmed, setCommonsConfirmed] = useState(false);
  function openCommons(image: CommonsChoice) { setPendingCommons(image); setCommonsAttribution(image.attribution ?? ''); setCommonsConfirmed(false); }
  const [autoSaveState, setAutoSaveState] = useState('已保存');
  const [saveError, setSaveError] = useState('');
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [previewNative, setPreviewNative] = useState(false);
  const [progressNotice, setProgressNotice] = useState('');
  const progressFailures = useRef(0);
  const revisionRef = useRef(initial.revision ?? 0);
  const savedBoard = useRef(JSON.stringify(initial.storyboard));
  const savingRequest = useRef<Promise<boolean> | null>(null);
  const latest = useRef(initial);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [data, setData] = useState(initial); const [tab, setTab] = useState<'storyboard' | 'voice' | 'render'>('storyboard'); const [active, setActive] = useState(0); const [saving, setSaving] = useState(false); const [message, setMessage] = useState(''); const [audioName, setAudioName] = useState(''); const [audioDraftName, setAudioDraftName] = useState(''); const [audioDraftReady, setAudioDraftReady] = useState(false); const [audioUploading, setAudioUploading] = useState(false); const [transcript, setTranscript] = useState(''); const [transcriptReady, setTranscriptReady] = useState(false); const [transcriptSaving, setTranscriptSaving] = useState(false); const [voiceSpeed, setVoiceSpeed] = useState(1); const [voiceId, setVoiceId] = useState(data.voiceId ?? 'my-voice'); const [imageQuery, setImageQuery] = useState(''); const [imageResults, setImageResults] = useState<CommonsChoice[]>([]); const [imageSearching, setImageSearching] = useState(false); const [imageSearchMessage, setImageSearchMessage] = useState(''); const transcriptRef = useRef(''); const transcriptTimer = useRef<number | null>(null); const speedTimer = useRef<number | null>(null); const [renderJob, setRenderJob] = useState(() => initial.jobs.find(job => job.kind === 'render')?.id ?? ''); const [renderStatus, setRenderStatus] = useState(() => { const job = initial.jobs.find(item => item.kind === 'render'); return job?.status === 'running' ? job.stage : job?.status ?? 'queued'; }); const autoDownloadJob = useRef<string | null>(null); const [renderError, setRenderError] = useState(() => initial.jobs.find(job => job.kind === 'render' && job.status === 'failed')?.error ?? ''); const [retryBusy, setRetryBusy] = useState(false);
  latest.current = data;
  useEffect(() => setPronunciationSelection(null), [active]);
  useEffect(() => { if (!previewExpanded) return; const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreviewExpanded(false); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [previewExpanded]);
  const storyboard = data.storyboard; const safeIndex = Math.min(active, Math.max(0, (storyboard?.scenes.length ?? 1) - 1)); const isBusy = retryBusy || saving || audioUploading || ['created', 'extracting', 'analyzing', 'storyboarding', 'generating_audio', 'rendering', 'encoding'].includes(data.status) || data.jobs.some(job => ['queued', 'running', 'cancelling'].includes(job.status));
  const videoFilename = `${data.name.replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/[.\s]+$/g, '') || '项目'}.mp4`;
  const failedJob = data.jobs.find(job => job.status === 'failed');
  const storyboardJob = data.jobs.find(job => job.kind === 'storyboard' && ['queued', 'running', 'cancelling'].includes(job.status));
  const generationProgress = readProgress(storyboardJob?.progress);
  const storyboardStartedAt = storyboardJob?.createdAt ? (storyboardJob.createdAt instanceof Date ? storyboardJob.createdAt.getTime() : Date.parse(storyboardJob.createdAt)) : null;
  useEffect(() => {
    if (!storyboardJob) return;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [storyboardJob?.id]);
  const elapsedSeconds = storyboardStartedAt && Number.isFinite(storyboardStartedAt) ? Math.max(0, Math.floor((clockNow - storyboardStartedAt) / 1000)) : null;
  const elapsedLabel = elapsedSeconds === null ? null : elapsedSeconds < 60 ? `${elapsedSeconds} 秒` : `${Math.floor(elapsedSeconds / 60)} 分 ${elapsedSeconds % 60} 秒`;
  const compositionWidth = storyboard?.aspectRatio === '9:16' ? 1080 : 1920; const compositionHeight = storyboard?.aspectRatio === '9:16' ? 1920 : 1080;
  const playerProps = useMemo(() => storyboard ? ({ component: ExplainerVideo, inputProps: { storyboard, onOverflow }, durationInFrames: getDurationInFrames(storyboard), fps: 30, compositionWidth: storyboard.aspectRatio === '9:16' ? 1080 : 1920, compositionHeight: storyboard.aspectRatio === '9:16' ? 1920 : 1080 }) : null, [storyboard, onOverflow]);
  useEffect(() => { let stopped = false; void fetch(`/api/projects/${data.id}/voice/draft`, { cache: 'no-store' }).then(response => response.json()).then(result => { if (stopped) return; if (result.filename) { setAudioDraftName(result.filename); setAudioName(result.displayName ?? result.filename); setAudioDraftReady(true); } const savedTranscript = typeof result.transcript === 'string' ? result.transcript : ''; transcriptRef.current = savedTranscript; setTranscript(savedTranscript); if (typeof result.speed === 'number' && result.speed >= 0.5 && result.speed <= 3) setVoiceSpeed(result.speed); setTranscriptReady(true); }).catch(() => { if (!stopped) setTranscriptReady(true); /* Selecting a new file remains available if draft lookup fails. */ }); return () => { stopped = true; if (transcriptTimer.current !== null) window.clearTimeout(transcriptTimer.current); if (speedTimer.current !== null) window.clearTimeout(speedTimer.current); }; }, [data.id]);
  useEffect(() => { if (!renderJob || ['completed', 'failed', 'cancelled'].includes(renderStatus)) return; let stopped = false; progressFailures.current = 0; const poll = async () => { try { const response = await fetch(`/api/jobs/${renderJob}`, { cache: 'no-store' }); if (!response.ok) throw new Error(`进度查询失败（HTTP ${response.status}）`); const job = await response.json(); if (stopped) return; progressFailures.current = 0; setProgressNotice(''); setRenderStatus(job.status === 'running' ? job.stage : job.status); setData(current => ({ ...current, status: ['completed', 'failed', 'cancelled'].includes(job.status) && current.jobs.find(item => item.kind === 'render')?.id === renderJob && ['rendering', 'encoding'].includes(current.status) ? (job.status === 'cancelled' ? 'awaiting_review' : job.status) : current.status, jobs: current.jobs.map(item => item.id === renderJob ? { ...item, status: job.status, stage: job.stage, error: job.error, progress: job.progress } : item) })); if (job.status === 'failed') setRenderError(job.error ?? '渲染失败'); } catch (error) { if (stopped) return; progressFailures.current += 1; if (progressFailures.current >= 3) setProgressNotice(`${error instanceof Error ? error.message : '无法获取渲染进度'}。已连续 ${progressFailures.current} 次失败，请确认本地 Worker 正在运行（pnpm dev）。`); } }; void poll(); const timer = window.setInterval(poll, 2500); return () => { stopped = true; window.clearInterval(timer); }; }, [renderJob, renderStatus]);
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
  const videoAvailable = data.jobs.some(job => job.kind === 'render' && job.status === 'completed');
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
  const shouldPollProgress = activeStatuses.includes(data.status) || data.jobs.some(job => ['queued', 'running', 'cancelling'].includes(job.status));
  useEffect(() => {
    if (!shouldPollProgress) return;
    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/projects/${data.id}`, { cache: 'no-store' });
        if (!response.ok) return;
        const project = await response.json();
        if (stopped) return;
        const dirty = JSON.stringify(latest.current.storyboard) !== savedBoard.current;
        if (!dirty) { revisionRef.current = project.revision ?? revisionRef.current; savedBoard.current = JSON.stringify(project.storyboard); }
        setData(current => ({ ...current, revision: dirty ? current.revision : project.revision, status: project.status, storyboard: dirty ? current.storyboard : project.storyboard, jobs: project.jobs ?? current.jobs, assets: project.assets ?? current.assets }));
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
  async function searchCommons() {
    if (!imageQuery.trim()) return;
    setImageSearching(true);
    setImageSearchMessage(''); setImageResults([]);
    try { const response = await fetch(`/api/commons/search?q=${encodeURIComponent(imageQuery)}`); const result = await response.json(); if (!response.ok) throw new Error(result.error ?? '搜索失败'); const images = result.images ?? []; setImageResults(images); if (!images.length) setImageSearchMessage('没有找到匹配图片，请尝试更简短或不同的关键词。'); }
    catch (error) { setImageSearchMessage(error instanceof Error ? error.message : '图片搜索失败'); }
    finally { setImageSearching(false); }
  }
  async function chooseCommons(title: string, attribution: string, confirmed: boolean) {
    if (!storyboard || isBusy) return;
    try {
      const response = await fetch(`/api/projects/${data.id}/assets/commons`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, attribution, confirmed }) });
      const result = await response.json();
      if (!response.ok) throw new Error([result.error ?? '素材导入失败', ...(Array.isArray(result.warnings) ? result.warnings : [])].join('；'));
      const asset = result.asset as NonNullable<Data['assets']>[number];
      const scene: Scene = { id: crypto.randomUUID(), type: 'media', title: title.replace(/^File:/, '').slice(0, 50), narration: '请添加图片讲解。', duration: 6, visual: { src: asset.path, attribution: asset.attribution, license: asset.license, licenseUrl: asset.licenseUrl, sourceUrl: asset.sourceUrl } };
      setData(current => ({ ...current, assets: [...(current.assets ?? []), asset], storyboard: current.storyboard ? { ...current.storyboard, scenes: [...current.storyboard.scenes, scene] } : null }));
      setActive(storyboard.scenes.length); setMessage('图片已下载到本地并添加到故事板');
    } catch (error) { setMessage(error instanceof Error ? error.message : '素材导入失败'); }
  }
  function useLocalImage(asset: NonNullable<Data['assets']>[number]) {
    if (!storyboard || isBusy) return;
    const scene: Scene = { id: crypto.randomUUID(), type: 'media', title: asset.name.slice(0, 50), narration: '请添加图片讲解。', duration: 6, visual: { src: asset.path, attribution: asset.attribution, license: asset.license, licenseUrl: asset.licenseUrl, sourceUrl: asset.sourceUrl } };
    setData(current => ({ ...current, storyboard: current.storyboard ? { ...current.storyboard, scenes: [...current.storyboard.scenes, scene] } : null })); setActive(storyboard.scenes.length);
  }
  async function uploadBgm(file: File | null) {
    if (!file || !storyboard || isBusy) return;
    const form = new FormData(); form.set('file', file); form.set('kind', 'audio');
    try { const response = await fetch(`/api/projects/${data.id}/assets`, { method: 'POST', body: form }); const result = await response.json(); if (!response.ok) throw new Error(result.error ?? 'BGM 上传失败'); setData(current => ({ ...current, assets: [...(current.assets ?? []), result.asset], storyboard: current.storyboard ? { ...current.storyboard, bgmSrc: result.asset.path } : null })); setMessage('BGM 已保存到本地'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'BGM 上传失败'); }
  }
  function updateScene(index: number, patch: Partial<Scene>) { if (!storyboard || isBusy) return; const scenes = [...storyboard.scenes]; const narrationChanged = patch.narration !== undefined && patch.narration !== scenes[index].narration; if (narrationChanged) setPronunciationSelection(null); scenes[index] = { ...scenes[index], ...patch, ...(narrationChanged || patch.pronunciationOverrides !== undefined ? { audioSrc: undefined, audioKey: undefined, audioDuration: undefined, wordTimings: undefined, pronunciationWarnings: undefined } : {}), ...(narrationChanged ? { pronunciationOverrides: scenes[index].pronunciationOverrides?.filter(rule => !rule.occurrence) } : {}) }; setData({ ...data, storyboard: { ...storyboard, scenes } }); }
  async function refreshRevision(projectId: string) {
    try {
      const response = await fetch(`/api/projects/${projectId}`, { cache: 'no-store' });
      if (!response.ok) return null;
      const project = await response.json();
      if (typeof project?.revision !== 'number' || !project.storyboard) return null;
      return { revision: project.revision as number, storyboard: project.storyboard as Storyboard };
    } catch { return null; }
  }
  async function persistBoard(): Promise<boolean> {
    if (savingRequest.current) { if (!await savingRequest.current) return false; return persistBoard(); }
    const current = latest.current;
    if (!current.storyboard || savedBoard.current === JSON.stringify(current.storyboard)) return true;
    const sent = JSON.stringify(current.storyboard);
    setAutoSaveState('保存中…');
    const task = Promise.resolve().then(async () => {
      try {
        const parsed = StoryboardSchema.parse(current.storyboard);
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const response = await fetch(`/api/projects/${current.id}/storyboard`, { method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': String(revisionRef.current) }, body: JSON.stringify(parsed) });
          if (response.status === 409) {
            const refused = await response.json().catch(() => null);
            const server = await refreshRevision(current.id);
            if (!server) throw new Error(refused?.error ?? '分镜已被其他操作更新，请重试保存');
            // A background job can bump the revision without touching the board, and
            // re-sending ours is harmless then. If the board itself moved on, another
            // window saved newer content: retrying with ours would silently revert it.
            if (canonical(server.storyboard) !== canonical(JSON.parse(savedBoard.current))) throw new Error('分镜已在其他窗口被修改，本次修改未保存。请刷新页面后重新设置；当前页面的内容不会被覆盖。');
            revisionRef.current = server.revision;
            continue;
          }
          const result = await response.json(); if (!response.ok) throw new Error(result.error ?? '保存失败');
          revisionRef.current = result.revision; savedBoard.current = JSON.stringify(result.storyboard);
          if (JSON.stringify(latest.current.storyboard) === sent) { latest.current = { ...latest.current, storyboard: result.storyboard, revision: result.revision }; setData(current => ({ ...current, storyboard: result.storyboard, revision: result.revision })); }
          setSaveError(''); setAutoSaveState('已自动保存'); return true;
        }
        throw new Error('分镜已被其他操作更新，请重试保存');
      } catch (error) { const message = error instanceof Error ? error.message : '保存失败'; setSaveError(message); setAutoSaveState('保存失败，请重试'); return false; }
      finally { savingRequest.current = null; }
    }); savingRequest.current = task; return task;
  }
  useEffect(() => {
    if (!storyboard || JSON.stringify(storyboard) === savedBoard.current) return;
    // `isBusy` also covers the save in flight; don't clobber '保存中…' there.
    if (isBusy) { if (!saving) setAutoSaveState('等待任务结束后自动保存'); return; }
    setAutoSaveState('有未保存修改');
    const timer = setTimeout(() => void persistBoard(), 1200); return () => clearTimeout(timer);
  }, [storyboard, isBusy, saving]);
  useEffect(() => { const warn = (event: BeforeUnloadEvent) => { if (JSON.stringify(latest.current.storyboard) !== savedBoard.current) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, []);
  async function reloadProject() { const response = await fetch(`/api/projects/${data.id}`, { cache: 'no-store' }); const project = await response.json(); if (!response.ok) throw new Error(project.error); revisionRef.current = project.revision; savedBoard.current = JSON.stringify(project.storyboard); latest.current = project; setData(project); }
  async function save() { if (!isBusy) await persistBoard(); }
  async function selectAudio(file: File | null) { if (!file || isBusy) return; setAudioName(file.name); setAudioDraftReady(false); setAudioUploading(true); setMessage(''); try { const form = new FormData(); form.set('audio', file); const response = await fetch(`/api/projects/${data.id}/voice/draft`, { method: 'POST', body: form }); const result = await response.json(); if (!response.ok) throw new Error(result.error); setAudioDraftName(result.filename); setAudioName(result.displayName ?? file.name); setAudioDraftReady(true); } catch (e) { setMessage(e instanceof Error ? e.message : '参考音频保存失败'); } finally { setAudioUploading(false); } }
  async function makeVoice() { if (isBusy || !audioDraftReady) return; setSaving(true); try { const form = new FormData(); form.set('draftName', audioDraftName); form.set('voiceId', voiceId); form.set('transcript', transcript); const r = await fetch(`/api/projects/${data.id}/voice`, { method: 'POST', body: form }); const result = await r.json(); if (r.ok) setData(current => ({ ...current, voiceId })); setMessage(r.ok ? '声音档案已保存' : result.error); } catch (e) { setMessage(e instanceof Error ? e.message : '声音档案保存失败'); } finally { setSaving(false); } }
  async function synthesize(force = false) { if (isBusy) return; if (speedTimer.current !== null) window.clearTimeout(speedTimer.current); speedTimer.current = null; void saveVoiceSpeed(voiceSpeed); setRetryBusy(true); setMessage('正在逐场生成语音…'); try { if (!await persistBoard()) throw new Error('保存分镜失败'); setData(current => ({ ...current, status: 'generating_audio' })); const r = await fetch(`/api/projects/${data.id}/voice/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ speed: voiceSpeed, force }) }); const result = await r.json(); if (!r.ok) { const latest = await fetch(`/api/projects/${data.id}`, { cache: 'no-store' }).then(response => response.json()); revisionRef.current = latest.revision; savedBoard.current = JSON.stringify(latest.storyboard); setData(current => ({ ...current, status: latest.status, storyboard: latest.storyboard, jobs: latest.jobs ?? current.jobs })); setMessage(result.error); return; } await reloadProject(); setMessage(result.message); } catch (e) { setData(current => ({ ...current, status: 'failed' })); setMessage(e instanceof Error ? e.message : '语音生成失败'); } finally { setRetryBusy(false); } }
  async function synthesizeScene(sceneId: string) {
    if (isBusy || !storyboard) return;
    setRetryBusy(true);
    setMessage('正在保存分镜并生成当前场景语音…');
    try {
      if (speedTimer.current !== null) window.clearTimeout(speedTimer.current);
      speedTimer.current = null;
      await saveVoiceSpeed(voiceSpeed);
      if (!await persistBoard()) throw new Error('保存分镜失败');
      setData(current => ({ ...current, status: 'generating_audio' }));
      const response = await fetch(`/api/projects/${data.id}/voice/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ speed: voiceSpeed, sceneId }) });
      const result = await response.json();
      if (!response.ok) {
        const latest = await fetch(`/api/projects/${data.id}`, { cache: 'no-store' }).then(item => item.json());
        revisionRef.current = latest.revision; savedBoard.current = JSON.stringify(latest.storyboard); setData(current => ({ ...current, status: latest.status, storyboard: latest.storyboard, jobs: latest.jobs ?? current.jobs }));
        throw new Error(result.error ?? '场景语音生成失败');
      }
      await reloadProject();
      setMessage(result.message ?? '当前场景语音已生成');
    } catch (error) {
      try {
        const latest = await fetch(`/api/projects/${data.id}`, { cache: 'no-store' }).then(response => response.json());
        revisionRef.current = latest.revision; savedBoard.current = JSON.stringify(latest.storyboard); setData(current => ({ ...current, status: latest.status, storyboard: latest.storyboard, jobs: latest.jobs ?? current.jobs }));
      } catch { setData(current => ({ ...current, status: 'awaiting_review' })); }
      setMessage(error instanceof Error ? error.message : '场景语音生成失败');
    } finally { setRetryBusy(false); }
  }
  async function render(preset: 'full' | 'draft' = 'full') { if (isBusy) return; if (!await persistBoard()) return; try { const response = await fetch(`/api/projects/${data.id}/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preset }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); autoDownloadJob.current = result.jobId; setRenderJob(result.jobId); setRenderStatus('queued'); setRenderError(''); setData(current => ({ ...current, jobs: [{ id: result.jobId, status: 'queued', stage: 'queued', error: null, kind: 'render' }, ...current.jobs] })); setTab('render'); } catch (error) { setMessage(String(error)); } }
  async function retryProject(mode: 'step' | 'restart') { if (isBusy) return; setRetryBusy(true); setMessage(''); try { const response = await fetch(`/api/projects/${data.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); setData(current => ({ ...current, status: result.status, storyboard: mode === 'restart' ? null : current.storyboard, jobs: [{ id: `retry-${Date.now()}`, status: 'queued', stage: result.stage, error: null, kind: 'storyboard' }, ...current.jobs] })); } catch (e) { setMessage(e instanceof Error ? e.message : '重新执行失败'); } finally { setRetryBusy(false); } }
  async function recoverProject() {
    if (retryBusy) return;
    setRetryBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/projects/${data.id}/recover`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '恢复失败');
      setMessage(result.active ? `仍有 ${result.active} 个任务在进行中，已请求 Worker 继续处理，请稍后刷新。` : result.released.length ? '已解除锁定，请按当前状态继续操作。' : '没有发现需要解锁的任务，项目状态正常。');
      await reloadProject();
    } catch (error) { setMessage(error instanceof Error ? error.message : '恢复失败'); } finally { setRetryBusy(false); }
  }
  async function retryScene() { if (isBusy || !storyboard || !storyboard.scenes[safeIndex]) return; const s = storyboard.scenes[safeIndex]; if (!await persistBoard()) return; setSaving(true); try { const r = await fetch(`/api/projects/${data.id}/scenes/${s.id}/regenerate`, { method: 'POST' }); const result = await r.json(); setMessage(r.ok ? '场景已重新生成' : result.error); if (r.ok && result.storyboard) await reloadProject(); } finally { setSaving(false); } }
  // Safety net: a busy status with nothing running is unreachable after the
  // server-side recovery passes, so this only appears if recovery was skipped.
  const stuckProject = activeStatuses.includes(data.status) && !data.jobs.some(job => ['queued', 'running', 'cancelling'].includes(job.status)) && !retryBusy && !saving && !isBusy;
  return <main className="shell editor-shell"><header className="topbar"><Link className="brand" href="/">知影 <span>LOCAL STUDIO</span></Link><div className="crumb">项目 / <b>{data.name}</b></div><div className="top-actions"><span role="status">{autoSaveState}</span><button className="button subtle" onClick={save} disabled={!storyboard || isBusy}>{saving ? '保存中…' : '保存分镜'}</button><button className="button primary" onClick={() => void render()} disabled={!storyboard || isBusy}>导出视频 ↗</button></div></header><div className="editor-heading"><div><p className="eyebrow">PROJECT WORKSPACE</p><h1>{data.name}</h1><p className="muted">{storyboard?.scenes.length ?? 0} 个场景 · {styles[data.styleId as StyleId]?.name ?? data.styleId} · {storyboard?.aspectRatio ?? data.aspectRatio ?? '16:9'}</p></div><WorkflowProgress data={data} /><div className="tabs">{(['storyboard', 'voice', 'render'] as const).map(t => <button className={tab === t ? 'active' : ''} onClick={() => setTab(t)} key={t}>{t === 'storyboard' ? '故事板' : t === 'voice' ? '声音设置' : '渲染导出'}</button>)}</div></div>
  {data.status === 'failed' && <section className="settings-card retry-card"><p className="eyebrow">TASK FAILED</p><h2>项目执行失败</h2><p className="error-text">{failedJob?.error ?? '执行遇到错误，请检查本地服务后重试。'}</p><p className="failure-step"><span>失败步骤</span><code>{failedJob ? stageLabels[failedJob.stage] ?? failedJob.stage : '未知'}</code></p><div className="retry-actions">{failedJob?.kind === 'storyboard' && <><button className="button primary" disabled={retryBusy} onClick={() => void retryProject('step')}>{retryBusy ? '重新执行中…' : '从失败步骤重试'}</button><button className="button subtle" disabled={retryBusy} onClick={() => void retryProject('restart')}>从头重新执行</button></>}{failedJob?.kind === 'render' && <button className="button primary" disabled={isBusy} onClick={() => { setTab('render'); void render(); }}>重新导出视频</button>}{failedJob?.kind === 'tts' && <button className="button primary" disabled={retryBusy} onClick={() => void synthesize()}>{retryBusy ? '重新执行中…' : '继续生成未完成语音'}</button>}<Link className="button subtle" href="/">返回项目列表</Link></div></section>}
  {stuckProject && <section className="settings-card retry-card"><p className="eyebrow">TASK NOT RUNNING</p><h2>任务已停止推进</h2><p className="muted">项目停在「{stageLabels[data.status] ?? data.status}」，但已经没有排队或运行中的任务。可能是本地服务被中断，或页面曾经关闭过。可以重新检查并解除锁定。</p><div className="retry-actions"><button className="button primary" disabled={retryBusy} onClick={() => void recoverProject()}>{retryBusy ? '检查中…' : '重新检查并解除锁定'}</button><Link className="button subtle" href="/">返回项目列表</Link></div></section>}
  {message && data.status !== 'failed' && <div className="toast" onClick={() => setMessage('')}>{message}<button>×</button></div>}
  {saveError && storyboard && <div className="save-error" role="alert"><b>分镜保存失败</b><span>{saveError}</span><button className="button subtle" disabled={isBusy} onClick={() => void persistBoard()}>重试保存</button><button className="button subtle" onClick={() => setSaveError('')}>关闭</button></div>}
  {tab === 'storyboard' && !storyboard && analysisStatuses.includes(data.status) && <section className="analysis-state-card"><span className="analysis-loader" aria-hidden="true" /><p className="eyebrow">LOCAL AI · 正在处理资料</p><h2>{generationProgress?.phase === 'storyboarding' ? '正在生成分镜' : '分析中'}</h2><p className="muted">{generationProgress?.message ?? (data.status === 'created' || data.status === 'extracting' ? '正在读取并整理导入资料…' : data.status === 'analyzing' ? '正在分析资料内容，请稍候…' : '正在根据分析结果生成分镜…')}</p>{generationProgress?.chapterCount && <p className="muted">章节进度：{generationProgress.completedChapters ?? 0} / {generationProgress.chapterCount} 章</p>}{generationProgress?.percent !== undefined && <div className="analysis-progress-track"><span style={{ width: `${Math.max(0, Math.min(100, generationProgress.percent))}%` }} /></div>}{generationProgress?.currentChapter && <span className="analysis-current-chapter">当前章节：{generationProgress.currentChapter}</span>}{generationProgress?.phase === 'storyboarding' && <span className="analysis-wait-time">{elapsedLabel ? `已等待 ${elapsedLabel} · ` : ''}本地模型正在生成内容，CPU 推理可能需要数分钟；章节进度会随批次更新。</span>}<span className="analysis-state-note">完成后，分镜会显示在这里供你检查和编辑。</span></section>}
  {(data.status === 'awaiting_source_review' || (data.status === 'failed' && failedJob?.kind === 'storyboard' && !storyboard)) && <SourceReview id={data.id} onContinue={() => { setData(current => ({ ...current, status: 'analyzing' })); }} />}
  {pendingCommons && <div className="modal-backdrop"><section className="modal"><h2>许可与署名预览</h2><img style={{ maxWidth: '100%', maxHeight: 240 }} src={pendingCommons.thumbnail} alt="素材预览" /><p>{pendingCommons.title}</p><p>许可：{pendingCommons.license || '未提供'} · {licenseLabels[pendingCommons.licenseClass ?? 'unknown'] ?? '许可未知'}</p><label className="field-label">署名（导出时写入画面角标）<input className="input" disabled={isBusy} maxLength={200} placeholder="例如：作者名 · CC BY 4.0" value={commonsAttribution} onChange={e => setCommonsAttribution(e.target.value)} /></label>{(pendingCommons.warnings ?? []).length > 0 && <div className="tools-warning" role="status"><b>许可与署名提示</b>{pendingCommons.warnings?.map(warning => <p key={warning}>{warning}</p>)}</div>}<a href={pendingCommons.sourceUrl} target="_blank" rel="noreferrer">查看 Commons 来源与许可详情</a>{pendingCommons.licenseUrl ? <> · <a href={pendingCommons.licenseUrl} target="_blank" rel="noreferrer">许可原文</a></> : null}{commonsWarnings(pendingCommons, commonsAttribution).length > 0 && <label className="v11-row"><input type="checkbox" checked={commonsConfirmed} onChange={e => setCommonsConfirmed(e.target.checked)} />我已阅读并确认上述许可与署名提示，仍要使用该素材</label>}<div className="v11-row"><button className="button subtle" onClick={() => setPendingCommons(null)}>返回</button><button className="button primary" disabled={isBusy || !pendingCommons || (commonsWarnings(pendingCommons, commonsAttribution).length > 0 && !commonsConfirmed)} onClick={() => { const title = pendingCommons.title; const remaining = commonsWarnings(pendingCommons, commonsAttribution).length > 0; setPendingCommons(null); void chooseCommons(title, commonsAttribution.trim(), commonsConfirmed || !remaining); }}>确认使用并下载</button></div></section></div>}
  {storyboard && tab === 'storyboard' && <ProductionTools id={data.id} board={storyboard} active={safeIndex} assets={data.assets ?? []} busy={isBusy} speed={voiceSpeed} save={persistBoard} onChange={board => setData(current => ({ ...current, storyboard: board }))} onSelect={setActive} reload={reloadProject} />}
  {tab === 'storyboard' && storyboard && <div className="editor-grid"><aside className="scene-list"><div className="panel-title"><b>故事板</b><span>{storyboard.scenes.length} 场景</span></div>{storyboard.scenes.map((s, i) => <button className={`scene-row ${i === safeIndex ? 'selected' : ''}`} onClick={() => setActive(i)} key={s.id}><span className="scene-number">{String(i + 1).padStart(2, '0')}</span><span className="scene-row-copy"><b>{s.title ?? sceneLabels[s.type]}</b><small>{sceneLabels[s.type]} · {s.duration ?? 6} 秒</small></span><span className="scene-drag">⠿</span></button>)}<button className="add-scene" disabled={isBusy} onClick={() => { const scene: Scene = { id: crypto.randomUUID(), type: 'bullets', title: '新场景', narration: '请补充讲解内容。', duration: 6, visual: { items: ['要点一'] } }; setData({ ...data, storyboard: { ...storyboard, scenes: [...storyboard.scenes, scene] } }); setActive(storyboard.scenes.length); }}>＋ 添加场景</button></aside><section className="preview-column"><div className="preview-toolbar"><span><i className="live-dot"/> 实时预览</span><span>{compositionWidth} × {compositionHeight} · 30 FPS</span><button className="text-button" disabled={!playerProps} onClick={() => setPreviewNative(value => !value)}>{previewNative ? '⤡ 适应窗口' : '⤢ 1:1 原始尺寸'}</button><button className="text-button" disabled={!playerProps} onClick={() => setPreviewExpanded(true)}>⛶ 放大预览</button></div>{previewExpanded && <div className="preview-backdrop" role="presentation" onClick={() => setPreviewExpanded(false)} />}<div className={`${storyboard.aspectRatio === '9:16' ? 'preview-frame portrait' : 'preview-frame'}${previewExpanded ? ' expanded' : ''}${previewNative && !previewExpanded ? ' native' : ''}`}>{playerProps && <Player {...playerProps} style={{ width: previewNative && !previewExpanded ? compositionWidth : '100%', aspectRatio: storyboard.aspectRatio === '9:16' ? '9 / 16' : '16 / 9' }} controls />}{previewExpanded && <button className="button subtle preview-close" onClick={() => setPreviewExpanded(false)}>关闭放大预览（Esc）</button>}</div><div className="preview-foot"><span>预览使用结构化分镜实时渲染</span>{overflowSceneIds.includes(storyboard.scenes[active]?.id) && <button className="text-button" role="status" onClick={() => document.querySelector(".inspector")?.scrollIntoView({ behavior: "smooth" })}>此画面文字过密，已自动缩小以适应；建议精简正文或把本场景拆成多个场景</button>}{overflowSceneIds.includes(storyboard.scenes[active]?.id) && !previewNative && !previewExpanded && <button className="text-button" onClick={() => setPreviewNative(true)}>⤢ 按 1:1 查看实际字号</button>}<button className="text-button" disabled={isBusy} onClick={retryScene}>↻ 重新生成当前场景</button></div></section><aside className="inspector"><div className="panel-title"><b>场景内容</b><span>{String(safeIndex + 1).padStart(2, '0')}</span></div>{storyboard.scenes[safeIndex] && <><label className="field-label">场景类型</label><select className="input" disabled={isBusy} value={storyboard.scenes[safeIndex].type} onChange={e => { const type = e.target.value as Scene['type']; const visual = type === 'bullets' ? { items: ['关键要点'] } : type === 'comparison' ? { columns: [{ title: '方案 A', items: ['特点'] }, { title: '方案 B', items: ['特点'] }] } : type === 'chart' ? { data: [{ label: '数据', value: 1 }] } : type === 'diagram' ? { nodes: [{ id: 'a', label: '起点' }, { id: 'b', label: '终点' }] } : type === 'code' ? { code: '// 示例代码' } : type === 'timeline' ? { items: [{ date: '2020', label: '起点' }, { date: '2024', label: '进展' }] } : type === 'math' ? { formula: 'a² + b² = c²', explanation: '公式说明' } : type === 'media' ? { src: data.assets?.find(asset => asset.kind !== 'audio')?.path ?? '' } : {}; updateScene(safeIndex, { type, visual }); }} >{Object.entries(sceneLabels).filter(([v]) => v !== 'media' || data.assets?.some(asset => asset.kind !== 'audio')).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select><label className="field-label">标题</label><input className="input" disabled={isBusy} maxLength={50} value={storyboard.scenes[safeIndex].title ?? ''} onChange={e => updateScene(safeIndex, { title: e.target.value })} /><label className="field-label">旁白</label><textarea className="input textarea inspector-textarea" disabled={isBusy} value={storyboard.scenes[safeIndex].narration} onSelect={e => { const el = e.currentTarget; const text = el.value.slice(el.selectionStart, el.selectionEnd); if (/^[\u3400-\u9fff]{1,80}$/.test(text)) setPronunciationSelection({ text, occurrence: el.value.slice(0, el.selectionStart).split(text).length, sceneId: storyboard.scenes[safeIndex].id }); }} onChange={e => updateScene(safeIndex, { narration: e.target.value })} /><PronunciationEditor key={storyboard.scenes[safeIndex].id} selection={pronunciationSelection?.sceneId === storyboard.scenes[safeIndex].id ? pronunciationSelection : null} disabled={isBusy} sceneRules={storyboard.scenes[safeIndex].pronunciationOverrides ?? []} projectRules={storyboard.pronunciationRules ?? []} onSceneRules={rules => updateScene(safeIndex, { pronunciationOverrides: rules })} onProjectRules={rules => { const texts = [...rules, ...(storyboard.pronunciationRules ?? [])].map(rule => rule.text); setData({ ...data, storyboard: { ...storyboard, pronunciationRules: rules, scenes: storyboard.scenes.map(scene => texts.some(text => scene.narration.includes(text)) ? { ...scene, audioSrc: undefined, wordTimings: undefined, pronunciationWarnings: undefined } : scene) } }); }} onGlobalChange={texts => setData(current => ({ ...current, storyboard: current.storyboard ? { ...current.storyboard, scenes: current.storyboard.scenes.map(scene => texts.some(text => scene.narration.includes(text)) ? { ...scene, audioSrc: undefined, wordTimings: undefined, pronunciationWarnings: undefined } : scene) } : null }))} />{storyboard.scenes[safeIndex].pronunciationWarnings?.map(warning => <p key={warning} className="hint" role="status">{warning}</p>)}<div className="scene-voice-actions"><button className="button primary" disabled={isBusy} onClick={() => void synthesizeScene(storyboard.scenes[safeIndex].id)}>{storyboard.scenes[safeIndex].audioSrc ? '重新生成此场景语音' : '生成此场景语音'}</button>{storyboard.scenes[safeIndex].audioSrc && <audio controls preload="metadata" src={`/${storyboard.scenes[safeIndex].audioSrc}`} />}</div><label className="field-label">画面数据（JSON）</label><textarea className="input textarea json-area" disabled={isBusy} value={JSON.stringify(storyboard.scenes[safeIndex].visual, null, 2)} onChange={e => { try { updateScene(safeIndex, { visual: JSON.parse(e.target.value) }); } catch { /* Keep editing incomplete JSON until it parses. */ } }} /><section className="settings-card"><label className="field-label">项目图片素材</label><div className="asset-search-results">{(data.assets ?? []).filter(asset => asset.kind !== 'audio').map(asset => <button className="asset-search-result" key={asset.path} onClick={() => useLocalImage(asset)}><img src={`/${asset.path}`} alt="" /><span><b>{asset.name}</b><small>{asset.attribution} · {asset.license}</small></span></button>)}</div><label className="field-label">Wikimedia Commons 图片搜索</label><div className="move-buttons"><input className="input" placeholder="搜索可用图片" value={imageQuery} onChange={e => setImageQuery(e.target.value)} /><button className="button subtle" disabled={imageSearching || isBusy} onClick={() => void searchCommons()}>{imageSearching ? '搜索中…' : '搜索'}</button></div><div className="asset-search-results">{imageResults.map(image => <button className="asset-search-result" key={image.title} onClick={() => openCommons(image)}><img src={image.thumbnail} alt="" /><span><b>{image.title.replace(/^File:/, '')}</b><small>{image.attribution} · {image.license}</small></span></button>)}</div>{imageSearchMessage && <p className="hint" role="status">{imageSearchMessage}</p>}</section><label className="field-label">时长（秒）</label><input className="input" disabled={isBusy} type="number" min="2" value={storyboard.scenes[safeIndex].duration ?? 6} onChange={e => updateScene(safeIndex, { duration: Number(e.target.value) })} /><div className="move-buttons"><button className="button subtle" disabled={isBusy || safeIndex === 0} onClick={() => { const scenes = [...storyboard.scenes]; [scenes[safeIndex - 1], scenes[safeIndex]] = [scenes[safeIndex], scenes[safeIndex - 1]]; setData({ ...data, storyboard: { ...storyboard, scenes } }); setActive(safeIndex - 1); }}>↑ 上移</button><button className="button subtle" disabled={isBusy || safeIndex === storyboard.scenes.length - 1} onClick={() => { const scenes = [...storyboard.scenes]; [scenes[safeIndex + 1], scenes[safeIndex]] = [scenes[safeIndex], scenes[safeIndex + 1]]; setData({ ...data, storyboard: { ...storyboard, scenes } }); setActive(safeIndex + 1); }}>↓ 下移</button><button className="button danger" disabled={isBusy} onClick={() => { if (storyboard.scenes.length < 2) return; const scenes = storyboard.scenes.filter((_, i) => i !== safeIndex); setData({ ...data, storyboard: { ...storyboard, scenes } }); setActive(Math.max(0, safeIndex - 1)); }}>删除</button></div></>}</aside></div>}
  {tab === 'voice' && <section className="settings-card"><p className="eyebrow">VOICE PROFILE</p><h2>创建你的声音档案</h2><p className="muted">可上传较长的清晰人声并填写准确转录。参考音频和对应转录用于生成项目语音；可调整下方语速。音频留在本机。</p>{!data.voiceId && <p className="general-voice-note">当前项目未设置专属声音，生成语音时将使用通用声音。</p>}<label className="field-label">声音档案 ID</label><input className="input" disabled={isBusy} value={voiceId} onChange={e => setVoiceId(e.target.value)} /><label className="field-label">参考音频</label><label className={`audio-picker ${isBusy ? 'disabled' : ''}`}><input className="audio-file-input" disabled={isBusy} type="file" accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a" onChange={e => { const file = e.currentTarget.files?.[0] ?? null; e.currentTarget.value = ''; void selectAudio(file); }} /><span className="audio-picker-button">选择文件</span><span className="audio-filename">{audioUploading ? '正在保存到本机…' : audioName ? (audioDraftReady ? audioName : `${audioName}（保存失败，请重选）`) : '尚未选择参考音频'}</span></label><label className="field-label">音频转录</label><p className="voice-transcript-hint">较长音频会自动选取句末停顿处的完整语句作为音色参考；转录请与录音逐字对应。</p><textarea className="input textarea" disabled={isBusy || !transcriptReady} value={transcript} onChange={e => { const value = e.target.value; transcriptRef.current = value; setTranscript(value); queueTranscriptSave(value); }} onBlur={flushTranscriptSave} placeholder={transcriptReady ? "准确填写音频中说出的内容…" : "正在读取已保存的转录…"} /><p className="transcript-save-state">{!transcriptReady ? "正在读取已保存转录…" : transcriptSaving ? "正在保存到本机…" : "转录内容会自动保存到本机"}</p><label className="field-label">生成语速</label><div className="voice-speed-control"><span>慢</span><input aria-label="生成语音速度" disabled={isBusy || !transcriptReady} type="range" min="0.5" max="3" step="0.1" value={voiceSpeed} onChange={e => { const value = Number(e.target.value); setVoiceSpeed(value); queueVoiceSpeedSave(value); }} onBlur={flushVoiceSpeedSave} /><span>快</span><strong>{voiceSpeed.toFixed(2).replace(/\.?0+$/, "")}×</strong></div><p className="voice-speed-hint">0.5× 较慢，1.0× 为正常语速，3× 较快；调整后会自动保存。</p><button className="button primary" disabled={isBusy || !audioDraftReady} onClick={makeVoice}>保存声音档案</button><button className="button subtle" style={{ marginLeft: 10 }} disabled={isBusy} onClick={() => synthesize()}>{storyboard?.scenes.some(scene => scene.audioSrc) ? "生成或更新受影响语音" : data.voiceId ? "为全部场景生成语音" : "使用通用声音生成语音"}</button><button className="button subtle" style={{ marginLeft: 10 }} disabled={isBusy || !storyboard?.scenes.some(scene => scene.audioSrc)} onClick={() => synthesize(true)}>强制重新生成全部语音</button><p className="hint">需要运行本地 Python 服务并安装 F5-TTS 及模型权重；「强制重新生成」会忽略缓存，重新合成每一个场景。</p><div className="generated-audio-section"><h3>场景语音试听</h3>{storyboard?.scenes.some(scene => scene.audioSrc) ? storyboard.scenes.map((scene, index) => scene.audioSrc ? <div className="generated-audio-item" key={scene.id}><b>{scene.title || `场景 ${index + 1}`}</b><audio controls preload="metadata" src={`/${scene.audioSrc}`} /><button className="text-button" disabled={isBusy} onClick={() => void synthesizeScene(scene.id)}>↻ 重新生成此场景</button></div> : null) : <p className="muted">生成全部场景语音后，可在这里逐段试听。</p>}</div></section>}
  {tab === 'render' && <section className="settings-card"><p className="eyebrow">EXPORT</p><h2>导出讲解视频</h2><p className="muted">使用已审核的分镜生成 {compositionWidth} × {compositionHeight}、30 FPS MP4。</p><section className="settings-card"><label className="field-label">背景音乐（本地文件）</label><label className="button subtle file-picker">选择背景音乐文件<input type="file" accept=".mp3,.wav,.m4a,.ogg,.flac,audio/*" disabled={isBusy} onChange={e => { const file = e.currentTarget.files?.[0] ?? null; e.currentTarget.value = ''; void uploadBgm(file); }} /></label>{storyboard?.bgmSrc && <><p className="muted">BGM 已添加：{storyboard.bgmSrc.split('/').at(-1)}</p><label className="field-label">背景音乐音量</label><input type="range" min="0" max="0.5" step="0.01" value={storyboard.bgmVolume ?? 0.12} onChange={e => setData(current => ({ ...current, storyboard: current.storyboard ? { ...current.storyboard, bgmVolume: Number(e.target.value) } : null }))} /><button className="button subtle" onClick={() => setData(current => ({ ...current, storyboard: current.storyboard ? { ...current.storyboard, bgmSrc: undefined } : null }))}>移除 BGM</button><label className="field-label">淡入秒数</label><input className="input" type="number" min="0" max="10" step="0.5" value={storyboard.bgmFadeIn ?? 1} onChange={e => setData(current => ({ ...current, storyboard: current.storyboard ? { ...current.storyboard, bgmFadeIn: Number(e.target.value) } : null }))} /><label className="field-label">淡出秒数</label><input className="input" type="number" min="0" max="10" step="0.5" value={storyboard.bgmFadeOut ?? 1} onChange={e => setData(current => ({ ...current, storyboard: current.storyboard ? { ...current.storyboard, bgmFadeOut: Number(e.target.value) } : null }))} /></>}</section><div className="export-summary"><span>画幅<b>{storyboard?.aspectRatio ?? '16:9'}</b></span><span>成片分辨率<b>{compositionWidth} × {compositionHeight}</b></span><span>草稿分辨率<b>{Math.round(compositionWidth / 2)} × {Math.round(compositionHeight / 2)}</b></span><span>编码<b>H.264</b></span></div><div className="render-actions"><button className="button subtle" disabled={isBusy} onClick={() => void render('draft')}>导出 540p 草稿</button><button className="button primary" disabled={isBusy} onClick={() => void render()}>{renderStatus === 'failed' ? '重新导出 →' : '开始渲染 →'}</button><button className="button primary" disabled={!videoAvailable || isBusy} onClick={() => void downloadVideo()}>下载视频 ↓</button></div>{renderJob && renderStatus !== 'completed' && <div className="job-card"><b>渲染状态：{({ queued: '等待渲染', running: '渲染中', rendering: '渲染中', encoding: '编码中', cancelling: '正在停止并清理', cancelled: '已取消', completed: '已完成', failed: '导出失败' } as Record<string, string>)[renderStatus] ?? renderStatus}</b>{renderError && <p className="error-text">{renderError}</p>}{progressNotice && <p className="error-text" role="alert">{progressNotice}</p>}<p>请保持本地 Worker 运行，任务状态会自动更新。</p></div>}</section>}
  {tab === 'render' && <ExportHistory id={data.id} busy={isBusy} />}
  {!storyboard && !['awaiting_source_review', 'created', 'extracting', 'analyzing', 'storyboarding', 'failed'].includes(data.status) && <div className="empty"><h2>项目还没有故事板</h2><p>返回首页并重新导入素材。</p></div>}
  </main>;
}





