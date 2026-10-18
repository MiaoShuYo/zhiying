'use client';
import { useEffect, useState } from 'react';
import {
  SubtitleSchema,
  presetBoardPatch,
  renderValidationLabels,
  type ExportPreset,
  type ExportPresetPatch,
  type RenderValidation,
  type Storyboard,
} from '@m2v/schema';

type QcIssue = {
  id: string;
  kind: 'subtitle' | 'audio';
  code: string;
  severity: 'error' | 'warning';
  message: string;
  fix: string;
  sceneId: string;
  sceneIndex: number;
  sceneTitle: string;
  cueIndex?: number;
  cueText?: string;
};

type QcResult = {
  projectId: string;
  checkedAt: string;
  summary: { total: number; errors: number; warnings: number; scenes: number };
  subtitles: { enabled: boolean; cueCount: number; issues: QcIssue[] };
  audio: { available: boolean; measurable: number; issues: QcIssue[] };
};

type ExportRow = {
  id: string;
  status: string;
  stage: string;
  createdAt: string;
  error: string | null;
  outputPath: string | null;
  validation: RenderValidation | null;
};

const qcCodeLabels: Record<string, string> = {
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

async function json(response: Response) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? '操作失败');
  return result;
}

const seconds = (value?: number) => (value === undefined || !Number.isFinite(value) ? '—' : `${value.toFixed(1)} 秒`);
const megabytes = (bytes?: number) => (bytes === undefined || !Number.isFinite(bytes) ? '—' : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export function QualityDelivery({
  id, board, busy, save, onLocate, onRegenerateAudio, onApplyPreset, onOpenRender,
}: {
  id: string;
  board: Storyboard;
  busy: boolean;
  save: () => Promise<boolean>;
  onLocate: (issue: QcIssue) => void;
  onRegenerateAudio: (sceneId: string) => void;
  onApplyPreset: (patch: ExportPresetPatch) => void;
  onOpenRender: () => void;
}) {
  const [qc, setQc] = useState<QcResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [exports, setExports] = useState<ExportRow[]>([]);
  const [validating, setValidating] = useState('');
  const [audition, setAudition] = useState('');
  const [delivering, setDelivering] = useState(false);
  const [presets, setPresets] = useState<ExportPreset[]>([]);
  const [presetName, setPresetName] = useState('');
  const [presetBusy, setPresetBusy] = useState(false);
  const [presetError, setPresetError] = useState('');

  const latest = exports.find(job => job.status === 'completed') ?? null;
  const validation = latest?.validation ?? null;
  const blocked = Boolean(validation && validation.issues.some(issue => issue.blocking));

  useEffect(() => {
    let stopped = false;
    void fetch(`/api/projects/${id}/exports`, { cache: 'no-store' }).then(json).then((rows: ExportRow[]) => { if (!stopped) setExports(rows); }).catch(() => undefined);
    void fetch('/api/settings/export-presets', { cache: 'no-store' }).then(json).then(result => { if (!stopped) setPresets(result.presets ?? []); }).catch(error => { if (!stopped) setPresetError(String(error)); });
    return () => { stopped = true; };
  }, [id]);

  async function run(action: () => Promise<void>) {
    setChecking(true); setError(''); setMessage('');
    try { await action(); } catch (problem) { setError(problem instanceof Error ? problem.message : '操作失败'); } finally { setChecking(false); }
  }

  // The QC endpoint reads the saved storyboard, so unsaved edits must be persisted first.
  const checkQc = (refresh: boolean) => run(async () => {
    if (!await save()) { setError('请先处理分镜保存错误'); return; }
    setQc(await json(await fetch(`/api/projects/${id}/qc${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' })));
    setMessage(refresh ? '已重新检查字幕与语音质量' : '');
  });

  async function refreshExports() {
    try { setExports(await json(await fetch(`/api/projects/${id}/exports`, { cache: 'no-store' }))); } catch (problem) { setError(problem instanceof Error ? problem.message : '读取导出记录失败'); }
  }

  async function validate(jobId: string) {
    setValidating(jobId); setError('');
    try {
      const result = await json(await fetch(`/api/projects/${id}/exports/${jobId}/validate`, { method: 'POST' }));
      setExports(current => current.map(job => job.id === jobId ? { ...job, validation: result.validation } : job));
      setMessage(result.validation?.ok ? '成片校验通过' : `成片校验发现 ${result.validation?.issues.length ?? 0} 项问题`);
    } catch (problem) { setError(problem instanceof Error ? problem.message : '校验失败'); } finally { setValidating(''); }
  }

  async function deliver() {
    if (!await save()) { setError('请先处理分镜保存错误'); return; }
    setDelivering(true); setError(''); setMessage('');
    try {
      const response = await fetch(`/api/projects/${id}/delivery`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(latest ? { jobId: latest.id } : {}) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? '生成交付包失败');
      const disposition = response.headers.get('content-disposition') ?? '';
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      const name = encoded ? decodeURIComponent(encoded) : '交付包.zip';
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url; link.download = name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setMessage(`交付包已生成：${name}`);
    } catch (problem) { setError(problem instanceof Error ? problem.message : '生成交付包失败'); } finally { setDelivering(false); }
  }

  async function savePreset() {
    setPresetBusy(true); setPresetError(''); setMessage('');
    try {
      const result = await json(await fetch('/api/settings/export-presets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: presetName.trim() || '我的导出预设',
          aspectRatio: board.aspectRatio,
          renderPreset: 'full',
          subtitles: SubtitleSchema.parse(board.subtitles ?? {}),
          intro: board.intro,
          outro: board.outro,
          transition: board.transition,
        }),
      }));
      setPresets(current => [result.preset, ...current.filter(preset => preset.id !== result.preset.id)]);
      setPresetName('');
      setMessage(`已保存预设「${result.preset.name}」`);
    } catch (problem) { setPresetError(problem instanceof Error ? problem.message : '保存导出预设失败'); } finally { setPresetBusy(false); }
  }

  async function removePreset(preset: ExportPreset) {
    setPresetBusy(true); setPresetError('');
    try {
      await json(await fetch(`/api/settings/export-presets?id=${encodeURIComponent(preset.id)}`, { method: 'DELETE' }));
      setPresets(current => current.filter(item => item.id !== preset.id));
      setMessage(`已删除预设「${preset.name}」`);
    } catch (problem) { setPresetError(problem instanceof Error ? problem.message : '删除导出预设失败'); } finally { setPresetBusy(false); }
  }

  function applyPreset(preset: ExportPreset) {
    if (!window.confirm(`应用预设「${preset.name}」？只会修改画幅、字幕样式与片头片尾，不改动分镜、旁白与素材。`)) return;
    onApplyPreset(presetBoardPatch(preset));
    setMessage(`已应用预设「${preset.name}」，请保存分镜以保留修改`);
  }

  const audioFor = (sceneId: string) => board.scenes.find(scene => scene.id === sceneId)?.audioSrc;
  const issueRow = (issue: QcIssue) => <li className={`qc-issue ${issue.severity}`} key={issue.id}>
    <span className="qc-badge">{qcCodeLabels[issue.code] ?? issue.code}</span>
    <span className="qc-issue-copy">
      <b>{issue.sceneTitle}</b>
      {issue.cueText ? <q>{issue.cueText}</q> : null}
      <span>{issue.message}</span>
    </span>
    <span className="qc-actions">
      {issue.kind === 'subtitle' && <button className="button subtle" disabled={busy || checking} onClick={() => onLocate(issue)}>定位到字幕</button>}
      {issue.fix === 'audition_audio' && audioFor(issue.sceneId) && <button className="text-button" onClick={() => setAudition(audition === issue.sceneId ? '' : issue.sceneId)}>{audition === issue.sceneId ? '收起试听' : '试听'}</button>}
      {issue.kind === 'audio' && <><button className="button subtle" disabled={busy} onClick={() => onRegenerateAudio(issue.sceneId)}>重新生成语音</button><button className="text-button" disabled={busy} onClick={() => onLocate(issue)}>查看场景</button></>}
    </span>
    {audition === issue.sceneId && audioFor(issue.sceneId) && <audio className="qc-audio" controls autoPlay src={`/${audioFor(issue.sceneId)}`} />}
  </li>;

  return <>
    <section className="settings-card quality-check">
      <p className="eyebrow">QUALITY CHECK</p>
      <h2>成片质检</h2>
      <p className="muted">检查字幕长度、停留时间、时间重叠与场景时长，并测量每个场景的旁白音量与长度。检查结果只读取当前保存的分镜。</p>
      <div className="v11-row">
        <button className="button primary" disabled={busy || checking} onClick={() => void checkQc(false)}>{checking ? '检查中…' : qc ? '重新检查' : '开始检查'}</button>
        <button className="button subtle" disabled={busy || checking || !qc} onClick={() => void checkQc(true)}>重新测量音频</button>
        {qc && <span className={`qc-summary ${qc.summary.errors ? 'error' : qc.summary.warnings ? 'warning' : 'ok'}`}>共 {qc.summary.total} 项 · 错误 {qc.summary.errors} · 提醒 {qc.summary.warnings}</span>}
      </div>
      {qc && <p className="hint">检查时间 {new Date(qc.checkedAt).toLocaleString()} · 场景 {qc.summary.scenes} 个 · 字幕 {qc.subtitles.cueCount} 条{qc.subtitles.enabled ? '' : '（当前已关闭显示）'}</p>}
      {error && <p role="alert" className="error-text">{error}</p>}
      {message && <p role="status" className="hint">{message}</p>}
      {qc && <div className="qc-groups">
        <div className="qc-group">
          <h3>字幕质检</h3>
          {!qc.subtitles.enabled ? <p className="hint">字幕显示已关闭：只统计字幕条目，打开字幕后才会检查过长、停留与重叠。</p> : qc.subtitles.issues.length ? <ul className="qc-issue-list">{qc.subtitles.issues.map(issueRow)}</ul> : <p className="hint">没有发现字幕问题。</p>}
        </div>
        <div className="qc-group">
          <h3>语音质检</h3>
          {!qc.audio.available ? <p className="hint" role="status">本机未找到 FFmpeg，暂时无法测量音量与时长；字幕检查不受影响。</p> : <>
            {qc.audio.issues.length ? <ul className="qc-issue-list">{qc.audio.issues.map(issueRow)}</ul> : <p className="hint">没有发现语音问题。</p>}
            <p className="hint">已用 FFmpeg 测量 {qc.audio.measurable} / {qc.summary.scenes} 个场景的旁白。</p>
          </>}
        </div>
      </div>}
    </section>

    <section className="settings-card">
      <h3>成片文件校验</h3>
      {!latest ? <p className="hint">还没有渲染完成的成片。导出完成后再来校验文件。<button className="text-button" onClick={onOpenRender}>前往渲染导出</button></p> : <>
        <p className="hint">最近成片：{new Date(latest.createdAt).toLocaleString()}{latest.outputPath ? '' : ' · 历史记录（视频已被后续导出覆盖）'}</p>
        {validation ? <div className={`qc-verdict ${validation.ok ? 'ok' : blocked ? 'error' : 'warning'}`}>
          <b>{validation.ok ? '校验通过' : blocked ? '文件不可用于交付' : '校验通过，但有提醒'}</b>
          <span>分辨率 {validation.width ?? '?'} × {validation.height ?? '?'}（预期 {validation.expected.width} × {validation.expected.height}） · 时长 {seconds(validation.duration)}（预期 {seconds(validation.expected.duration)}） · 音频轨道 {validation.hasAudio ? '有' : '无'} · 文件 {megabytes(validation.fileBytes)}</span>
          {validation.issues.length > 0 && <ul className="qc-issue-list">{validation.issues.map(issue => <li className="qc-issue" key={issue.code}><span className={`qc-badge ${issue.blocking ? 'blocking' : ''}`}>{renderValidationLabels[issue.code] ?? issue.code}</span><span className="qc-issue-copy"><span>{issue.message}</span></span></li>)}</ul>}
          <span className="hint">校验时间 {new Date(validation.checkedAt).toLocaleString()}</span>
        </div> : <p className="hint">这条成片还没有校验记录。</p>}
        <div className="v11-row">
          <button className="button subtle" disabled={validating !== '' || busy} onClick={() => void validate(latest.id)}>{validating === latest.id ? '校验中…' : validation ? '重新校验' : '校验成片文件'}</button>
          {blocked && latest.status === 'completed' && <button className="button subtle" onClick={onOpenRender}>重新渲染成片</button>}
          <button className="text-button" disabled={validating !== ''} onClick={() => void refreshExports()}>刷新导出记录</button>
        </div>
      </>}
    </section>

    <section className="settings-card">
      <h3>交付包</h3>
      <p className="hint">一键整理成片 MP4、字幕（SRT / VTT / ASS）、封面图与项目备份，字幕与成片使用同一时间轴。</p>
      <ul className="qc-files">
        <li><b>MP4 成片</b><span>{latest ? '可打包（最近一次完成的导出）' : '缺少渲染完成的成片'}</span></li>
        <li><b>字幕 SRT / VTT / ASS</b><span>{board.scenes.length} 个场景 · 与画面对齐</span></li>
        <li><b>封面图</b><span>{board.intro ? '使用片头标题卡' : '使用首个场景画面'}</span></li>
        <li><b>项目备份 .m2v</b><span>可恢复的完整项目包</span></li>
      </ul>
      {blocked && <p className="error-text" role="alert">成片校验未通过，先处理上面的问题或重新渲染，再打包交付。</p>}
      <button className="button primary" disabled={busy || delivering || !latest || blocked} onClick={() => void deliver()}>{delivering ? '正在打包…' : '生成交付包 ZIP'}</button>
    </section>

    <section className="settings-card">
      <h3>导出预设</h3>
      <p className="hint">保存常用画幅、字幕样式与片头片尾设置，可随时复用或切换。应用预设只修改这三类设置，不改动分镜、旁白与素材。</p>
      <div className="v11-row">
        <input className="input" maxLength={40} placeholder="预设名称，例如「竖屏交付」" value={presetName} onChange={event => setPresetName(event.target.value)} disabled={busy || presetBusy} />
        <button className="button subtle" disabled={busy || presetBusy} onClick={() => void savePreset()}>{presetBusy ? '处理中…' : '保存当前设置'}</button>
      </div>
      <p className="hint">将保存：画幅 {board.aspectRatio} · 字幕{({ minimal: '简洁', boxed: '底板', highlight: '醒目' } as Record<string, string>)[SubtitleSchema.parse(board.subtitles ?? {}).preset] ?? '默认'} · {board.intro ? '片头' : '无片头'} / {board.outro ? '片尾' : '无片尾'} · 转场 {board.transition === 'fade' ? '淡入淡出' : '直切'}</p>
      {presetError && <p role="alert" className="error-text">{presetError}</p>}
      {presets.length ? <ul className="qc-presets">{presets.map(preset => <li key={preset.id}>
        <span><b>{preset.name}</b><small>{preset.aspectRatio} · {({ minimal: '简洁', boxed: '底板', highlight: '醒目' } as Record<string, string>)[preset.subtitles.preset] ?? preset.subtitles.preset} · {preset.intro ? '有片头' : '无片头'} · {preset.outro ? '有片尾' : '无片尾'} · {new Date(preset.updatedAt).toLocaleDateString()}</small></span>
        <span className="qc-actions">
          <button className="button subtle" disabled={busy || presetBusy} onClick={() => applyPreset(preset)}>应用</button>
          <button className="text-button" disabled={busy || presetBusy} onClick={() => void removePreset(preset)}>删除</button>
        </span>
      </li>      )}</ul> : <p className="hint">还没有保存过导出预设。</p>}
    </section>
  </>;
}
