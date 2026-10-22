'use client';
import { useEffect, useState } from 'react';
import {
  SubtitleSchema,
  changedPresetCount,
  presetBoardPatch,
  presetChanges,
  qcStatusHints,
  qcStatusLabels,
  renderValidationLabels,
  type ExportPreset,
  type ExportPresetPatch,
  type QcStatus,
  type RenderValidation,
  type Storyboard,
} from '@m2v/schema';

type QcIssueKind = 'subtitle' | 'audio' | 'render';

type QcIssue = {
  id: string;
  kind: QcIssueKind;
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

type QcSummary = { total: number; errors: number; warnings: number; scenes: number };

type QcRender = { jobId: string; status: string; error: string | null; createdAt: string; issue: QcIssue | null };

type QcResult = {
  projectId: string;
  status: QcStatus;
  stale?: boolean;
  reason?: 'never' | 'revision';
  checkedAt?: string;
  previousSummary?: QcSummary;
  persisted?: boolean;
  summary?: QcSummary;
  subtitles?: { enabled: boolean; cueCount: number; issues: QcIssue[] };
  audio?: { available: boolean; measurable: number; silent?: number; issues: QcIssue[] };
  render?: QcRender | null;
};

type DeliveryMissing = { step: string; message: string };

type DeliveryRecord = {
  status: 'ready' | 'failed';
  name?: string;
  bytes?: number;
  files?: number;
  missing: DeliveryMissing[];
  error?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  fileExists: boolean;
  revision?: number;
  qc?: { status: QcStatus; errors: number; warnings: number };
  stale?: 'qc-blocking' | 'project-changed' | null;
};

type ExportRow = {
  id: string;
  status: string;
  stage: string;
  createdAt: string;
  error: string | null;
  outputPath: string | null;
  validation: RenderValidation | null;
  videoState?: 'current' | 'superseded' | 'missing';
  delivery?: DeliveryRecord | null;
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
  scene_too_short: '场景过短',
  bgm_missing: '背景音乐缺失',
  render_failed: '渲染失败',
};

const deliveryStepLabels: Record<string, string> = {
  render: '成片渲染',
  validation: '成片校验',
  video: '视频文件',
  subtitles: '字幕时间轴',
  cover: '封面图',
  backup: '项目备份',
  package: '打包 ZIP',
};

const subtitlePresetText: Record<string, string> = { minimal: '简洁', boxed: '底板', highlight: '醒目' };

async function json(response: Response) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? '操作失败');
  return result;
}

/**
 * Hands the ZIP to the browser's own download stack. A 14 MB package must not go through
 * fetch + blob: buffering it in the page is what turned a finished archive into a failed request.
 */
function startDownload(url: string, name?: string) {
  const link = document.createElement('a');
  link.href = url; link.download = name ?? ''; link.rel = 'noopener';
  document.body.appendChild(link); link.click(); link.remove();
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
  const [downloading, setDownloading] = useState('');
  const [deliveryMissing, setDeliveryMissing] = useState<DeliveryMissing[]>([]);
  const [presets, setPresets] = useState<ExportPreset[]>([]);
  const [presetName, setPresetName] = useState('');
  const [presetBusy, setPresetBusy] = useState(false);
  const [presetError, setPresetError] = useState('');
  const [pendingPreset, setPendingPreset] = useState<ExportPreset | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const newest = exports[0] ?? null;
  // The newest completed render owns the file; an older success must not hide a newer failure.
  const latest = exports.find(job => job.status === 'completed') ?? null;
  const validation = latest?.validation ?? null;
  const blocked = Boolean(validation && validation.issues.some(issue => issue.blocking));
  // Blocking QC findings gate packaging just like a failed render validation; a
  // stale or never-run report does not, so the message under the button matches.
  const qcBlocked = qc?.status === 'blocking';
  const delivery = latest?.delivery ?? null;
  // A package built under an earlier revision or an older QC verdict is expired, not ready.
  const deliveryState = !delivery ? 'missing' : delivery.status === 'failed' ? 'failed' : delivery.stale ? 'stale' : delivery.fileExists ? 'ready' : 'expired';

  useEffect(() => {
    let stopped = false;
    void fetch(`/api/projects/${id}/exports`, { cache: 'no-store' }).then(json).then((rows: ExportRow[]) => { if (!stopped) setExports(rows); }).catch(() => undefined);
    void fetch(`/api/projects/${id}/qc?cached=1`, { cache: 'no-store' }).then(json).then((cached: QcResult) => { if (!stopped) setQc(cached); }).catch(() => undefined);
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

  /** Reads the export list without touching the message area; null means the request itself failed. */
  async function readExports(): Promise<ExportRow[] | null> {
    try {
      const rows = await json(await fetch(`/api/projects/${id}/exports`, { cache: 'no-store' })) as ExportRow[];
      setExports(rows);
      return rows;
    } catch { return null; }
  }

  const deliveryUrl = (jobId: string) => `/api/projects/${id}/delivery/${encodeURIComponent(jobId)}`;

  /** Reads the refusal so the panel shows the server's reason instead of a bare network error. */
  async function deliveryRefusal(response: Response) {
    const data = await response.json().catch(() => ({})) as { error?: string; missing?: DeliveryMissing[] };
    return { error: data.error ?? '交付包不可下载', missing: data.missing ?? [] };
  }

  /** Confirms the package is still deliverable, then lets the browser transfer it. */
  async function savePackage(jobId: string, name?: string) {
    const probe = await fetch(`${deliveryUrl(jobId)}?probe=1`, { cache: 'no-store' }).catch(() => null);
    // 预检本身不通时也照常交给浏览器：能下载的包不该被记成失败。
    if (probe && !probe.ok) return false;
    startDownload(deliveryUrl(jobId), name);
    return true;
  }

  async function download(jobId: string, name?: string) {
    setDownloading(jobId); setError(''); setDeliveryMissing([]);
    try {
      const probe = await fetch(`${deliveryUrl(jobId)}?probe=1`, { cache: 'no-store' }).catch(() => null);
      if (probe && !probe.ok) {
        const refusal = await deliveryRefusal(probe);
        setDeliveryMissing(refusal.missing);
        throw new Error(refusal.error);
      }
      startDownload(deliveryUrl(jobId), name);
      setMessage('交付包已开始下载');
    } catch (problem) { setError(problem instanceof Error ? problem.message : '下载交付包失败'); } finally { setDownloading(''); }
  }

  async function deliver() {
    if (qcBlocked) { setError('质检还有阻断问题，请先修复并重新检查，通过或只剩提醒时再打包。'); return; }
    if (!await save()) { setError('请先处理分镜保存错误'); return; }
    setDelivering(true); setError(''); setMessage(''); setDeliveryMissing([]);
    const jobId = latest?.id ?? '';
    try {
      const response = await fetch(`/api/projects/${id}/delivery`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(latest ? { jobId: latest.id } : {}) }).catch(() => null);
      // The build writes its record before replying, so a dropped connection must not be
      // reported as a failure when the package was in fact generated.
      if (!response) {
        const record = (await readExports())?.find(row => row.id === jobId)?.delivery;
        if (record?.status === 'ready' && !record.stale) {
          startDownload(deliveryUrl(jobId), record.name);
          setMessage('交付包已生成并开始下载');
          return;
        }
        throw new Error('与服务器的连接中断，交付包状态未知。请刷新页面后查看导出记录。');
      }
      const data = await response.json().catch(() => null) as { error?: string; missing?: DeliveryMissing[]; name?: string } | null;
      if (!response.ok) { setDeliveryMissing(data?.missing ?? []); throw new Error(data?.error ?? '生成交付包失败'); }
      await refreshExports();
      setMessage(await savePackage(jobId, data?.name)
        ? '交付包已生成并开始下载'
        : '交付包已生成，但自动下载没有开始，请点「再次下载」获取 ZIP');
    } catch (problem) { setError(problem instanceof Error ? problem.message : '生成交付包失败'); } finally { setDelivering(false); }
  }

  async function validate(jobId: string) {
    setValidating(jobId); setError('');
    try {
      const result = await json(await fetch(`/api/projects/${id}/exports/${jobId}/validate`, { method: 'POST' }));
      setExports(current => current.map(job => job.id === jobId ? { ...job, validation: result.validation } : job));
      setMessage(result.validation?.ok ? '成片校验通过' : `成片校验发现 ${result.validation?.issues.length ?? 0} 项问题`);
    } catch (problem) { setError(problem instanceof Error ? problem.message : '校验失败'); } finally { setValidating(''); }
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

  async function reloadPresets() {
    const result = await json(await fetch('/api/settings/export-presets', { cache: 'no-store' }));
    setPresets(result.presets ?? []);
  }

  async function presetAction(preset: ExportPreset, action: 'rename' | 'duplicate' | 'default', name?: string) {
    setPresetBusy(true); setPresetError(''); setMessage('');
    try {
      await json(await fetch('/api/settings/export-presets', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: preset.id, action, ...(name ? { name } : {}) }),
      }));
      await reloadPresets();
      setRenaming(null);
      setMessage(action === 'rename' ? '已重命名预设' : action === 'duplicate' ? `已复制预设「${preset.name}」` : `已将「${preset.name}」设为默认预设`);
    } catch (problem) { setPresetError(problem instanceof Error ? problem.message : '更新导出预设失败'); } finally { setPresetBusy(false); }
  }

  function applyPreset(preset: ExportPreset) {
    setPendingPreset(preset);
    setMessage(''); setError('');
  }

  function confirmPreset() {
    if (!pendingPreset) return;
    onApplyPreset(presetBoardPatch(pendingPreset));
    setMessage(`已应用预设「${pendingPreset.name}」，请保存分镜以保留修改`);
    setPendingPreset(null);
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
      {issue.kind !== 'subtitle' && issue.fix === 'open_render' && <button className="button subtle" disabled={busy} onClick={onOpenRender}>前往渲染导出</button>}
      {issue.fix === 'audition_audio' && issue.sceneId && audioFor(issue.sceneId) && <button className="text-button" onClick={() => setAudition(audition === issue.sceneId ? '' : issue.sceneId)}>{audition === issue.sceneId ? '收起试听' : '试听'}</button>}
      {issue.kind === 'audio' && issue.sceneId && <><button className="button subtle" disabled={busy} onClick={() => onRegenerateAudio(issue.sceneId)}>重新生成语音</button><button className="text-button" disabled={busy} onClick={() => onLocate(issue)}>查看场景</button></>}
    </span>
    {audition === issue.sceneId && issue.sceneId && audioFor(issue.sceneId) && <audio className="qc-audio" controls autoPlay src={`/${audioFor(issue.sceneId)}`} />}
  </li>;

  return <>
    <section className="settings-card quality-check">
      <p className="eyebrow">QUALITY CHECK</p>
      <h2>成片质检</h2>
      <p className="muted">检查字幕、旁白音量、背景音乐、场景时长与最近一次渲染。检查结果会保存，分镜修改后自动标记为待检查。</p>
      <div className="v11-row">
        <button className="button primary" disabled={busy || checking} onClick={() => void checkQc(false)}>{checking ? '检查中…' : qc?.summary ? '重新检查' : '开始检查'}</button>
        <button className="button subtle" disabled={busy || checking || !qc?.summary} onClick={() => void checkQc(true)}>重新测量音频</button>
        {qc && <span className={`qc-status qc-status-${qc.status}`}>
          {qcStatusLabels[qc.status]}
          {qc.summary ? ` · 错误 ${qc.summary.errors} · 提醒 ${qc.summary.warnings}` : ''}
        </span>}
      </div>
      {qc && <p className="hint">{qcStatusHints[qc.status]}</p>}
      {qc?.stale && <p className="hint" role="status">{qc.reason === 'revision'
        ? `分镜在上次检查（${qc.checkedAt ? new Date(qc.checkedAt).toLocaleString() : '未知时间'}）后修改过${qc.previousSummary ? `，上次结果为错误 ${qc.previousSummary.errors}、提醒 ${qc.previousSummary.warnings}` : ''}，需要重新检查。`
        : '还没有检查过当前分镜，交付前建议先检查字幕与语音。'}</p>}
      {error && <p role="alert" className="error-text">{error}</p>}
      {message && <p role="status" className="hint">{message}</p>}
      {qc?.summary && qc.subtitles && qc.audio && <div className="qc-groups">
        <div className="qc-group">
          <h3>字幕质检</h3>
          {!qc.subtitles.enabled ? <p className="hint">字幕显示已关闭：只统计字幕条目，打开字幕后才会检查过长、停留与重叠。</p> : qc.subtitles.issues.length ? <ul className="qc-issue-list">{qc.subtitles.issues.map(issueRow)}</ul> : <p className="hint">没有发现字幕问题。</p>}
        </div>
        <div className="qc-group">
          <h3>语音质检</h3>
          {!qc.audio.available ? <p className="hint" role="status">本机未找到 FFmpeg，暂时无法测量音量与时长；字幕检查不受影响。</p> : <>
            {qc.audio.issues.length ? <ul className="qc-issue-list">{qc.audio.issues.map(issueRow)}</ul> : <p className="hint">没有发现语音问题。</p>}
            <p className="hint">已用 FFmpeg 测量 {qc.audio.measurable} / {qc.summary.scenes} 个场景的旁白{board.bgmSrc ? '，并测量了背景音乐' : ''}。</p>
            {(qc.audio.silent ?? 0) > 0 && <p className="hint" role="status">另有 {qc.audio.silent} 个场景没有写台词，按“有意静音”处理：这些场景保持无声，不计入阻断。需要旁白时补上台词再生成语音即可。</p>}
          </>}
        </div>
        <div className="qc-group">
          <h3>成片渲染</h3>
          {!qc.render ? <p className="hint">还没有渲染记录，质检结论只覆盖分镜与语音。</p> : qc.render.issue ? <ul className="qc-issue-list">{issueRow(qc.render.issue)}</ul> : <p className="hint">最近一次渲染（{new Date(qc.render.createdAt).toLocaleString()}）状态：{({ queued: '排队中', running: '执行中', cancelling: '正在停止', cancelled: '已取消', completed: '已完成', failed: '失败' } as Record<string, string>)[qc.render.status] ?? qc.render.status}。{qc.render.status === 'completed' ? '当前成片可用于交付。' : ''}</p>}
        </div>
      </div>}
      {qc?.summary && <p className="hint">检查时间 {qc.checkedAt ? new Date(qc.checkedAt).toLocaleString() : '—'} · 场景 {qc.summary.scenes} 个{qc.subtitles ? ` · 字幕 ${qc.subtitles.cueCount} 条${qc.subtitles.enabled ? '' : '（当前已关闭显示）'}` : ''}{qc.persisted === false ? ' · 检查结果未能写入磁盘，刷新后可能丢失' : ''}</p>}
    </section>

    <section className="settings-card">
      <h3>成片文件校验</h3>
      {!latest ? <p className="hint">还没有渲染完成的成片。导出完成后再来校验文件。<button className="text-button" onClick={onOpenRender}>前往渲染导出</button></p> : <>
        <p className="hint">最近成片：{new Date(latest.createdAt).toLocaleString()}{latest.outputPath ? '' : ' · 历史记录（视频已被后续导出覆盖）'}{latest.videoState === 'missing' ? ' · 视频文件已不存在' : ''}</p>
        {newest && newest.id !== latest.id && <p className="hint" role="status">最近一次导出（{new Date(newest.createdAt).toLocaleString()}）{newest.status === 'failed' ? `失败：${newest.error ?? '未提供原因'}，下面显示的是更早的成功成片` : newest.status === 'completed' ? '已完成' : `仍在${({ queued: '排队', running: '执行', cancelling: '停止' } as Record<string, string>)[newest.status] ?? newest.status}中，下面显示的是更早的成功成片`}。</p>}
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
      <div className={`qc-verdict ${deliveryState === 'ready' ? 'ok' : deliveryState === 'failed' ? 'error' : deliveryState === 'expired' || deliveryState === 'stale' ? 'warning' : ''}`}>
        <b>{{
          missing: latest ? '尚未生成交付包' : '缺少渲染完成的成片',
          ready: '交付包已生成',
          failed: '上次生成失败',
          expired: '交付包文件已被清理',
          stale: '交付包已过期',
        }[deliveryState]}</b>
        {deliveryState === 'ready' && delivery && <span>{delivery.name ?? '交付包.zip'} · {megabytes(delivery.bytes)} · {delivery.files ?? 0} 个文件 · 生成于 {new Date(delivery.updatedAt).toLocaleString()}{delivery.attempts > 1 ? ` · 第 ${delivery.attempts} 次尝试` : ''}</span>}
        {deliveryState === 'stale' && delivery && <span>
          {delivery.name ?? '交付包.zip'} · 生成于 {new Date(delivery.updatedAt).toLocaleString()} · {delivery.stale === 'qc-blocking'
            ? '生成时质检未通过（存在阻断问题），当前质检仍未通过，这个包不能再作为交付依据'
            : '生成之后项目又有修改，包内内容已不是最新版本'}
        </span>}
        {deliveryState === 'expired' && <span>记录仍可查看，但 ZIP 已不在交付目录中。重新生成不会删除导出记录。</span>}
        {deliveryState === 'failed' && delivery && <span>{delivery.error ?? '交付包生成未完成'} · 已尝试 {delivery.attempts} 次</span>}
        {deliveryState === 'missing' && latest && <span>可以为这次成片生成交付包，生成前会重新检查校验结果、字幕时间轴与备份。</span>}
      </div>
      {deliveryState === 'failed' && delivery?.missing.length ? <ul className="qc-issue-list">
        {delivery.missing.map((item, index) => <li className="qc-issue error" key={`${item.step}-${index}`}>
          <span className="qc-badge">{deliveryStepLabels[item.step] ?? item.step}</span>
          <span className="qc-issue-copy"><span>{item.message}</span></span>
        </li>)}
      </ul> : null}
      {deliveryMissing.length ? <ul className="qc-issue-list">
        {deliveryMissing.map((item, index) => <li className="qc-issue error" key={`${item.step}-${index}`}>
          <span className="qc-badge">{deliveryStepLabels[item.step] ?? item.step}</span>
          <span className="qc-issue-copy"><span>{item.message}</span></span>
        </li>)}
      </ul> : null}
      <ul className="qc-files">
        <li><b>MP4 成片</b><span>{latest ? '可打包（最近一次完成的导出）' : '缺少渲染完成的成片'}</span></li>
        <li><b>字幕 SRT / VTT / ASS</b><span>{board.scenes.length} 个场景 · 与画面对齐</span></li>
        <li><b>封面图</b><span>{board.intro ? '使用片头标题卡' : '使用首个场景画面'}</span></li>
        <li><b>项目备份 .m2v</b><span>可恢复的完整项目包</span></li>
      </ul>
      {blocked && <p className="error-text" role="alert">成片校验未通过，先处理上面的问题或重新渲染，再打包交付。</p>}
      {qcBlocked && <p className="error-text" role="alert">质检还有 {qc?.summary?.errors ?? 0} 项阻断问题，先在「成片质检」修复并重新检查，通过或只剩提醒后再打包。</p>}
      <div className="v11-row">
        <button className="button primary" disabled={busy || delivering || downloading !== '' || !latest || blocked || qcBlocked} onClick={() => void deliver()} title={qcBlocked ? '质检有阻断问题，暂时不能打包' : undefined}>{delivering ? '正在打包…' : deliveryState === 'ready' || deliveryState === 'expired' || deliveryState === 'failed' || deliveryState === 'stale' ? '重新生成交付包' : '生成交付包 ZIP'}</button>
        {deliveryState === 'ready' && latest && <button className="button subtle" disabled={busy || delivering || downloading !== ''} onClick={() => void download(latest.id, delivery?.name)}>{downloading === latest.id ? '下载中…' : '再次下载'}</button>}
        {deliveryState === 'expired' && latest && <button className="button subtle" disabled={busy || delivering} onClick={() => void download(latest.id, delivery?.name)} title="若文件已被清理，会提示重新生成">尝试下载</button>}
      </div>
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
      {pendingPreset && <div className="preset-confirm" role="dialog" aria-label="应用预设前的修改预览">
        <b>应用「{pendingPreset.name}」会修改 {changedPresetCount(presetChanges(board, pendingPreset))} 项导出设置</b>
        <ul>
          {presetChanges(board, pendingPreset).map(change => <li key={change.key} className={change.changed ? 'changed' : 'same'}>
            <span>{change.label}</span>
            <span>{change.changed ? <>{change.current} → <b>{change.next}</b></> : `${change.current}（不变）`}</span>
          </li>)}
        </ul>
        <p className="hint">分镜、旁白与素材不会被修改；应用后记得保存分镜。</p>
        <div className="v11-row">
          <button className="button primary" disabled={busy} onClick={confirmPreset}>确认应用</button>
          <button className="text-button" disabled={busy} onClick={() => setPendingPreset(null)}>取消</button>
        </div>
      </div>}
      {presets.length ? <ul className="qc-presets">{presets.map(preset => <li key={preset.id}>
        <span>
          <b>{preset.name}{preset.isDefault ? <span className="preset-default">默认</span> : null}</b>
          <small>{preset.aspectRatio} · {subtitlePresetText[preset.subtitles.preset] ?? preset.subtitles.preset} · {preset.intro ? '有片头' : '无片头'} · {preset.outro ? '有片尾' : '无片尾'} · {new Date(preset.updatedAt).toLocaleDateString()}</small>
          {renaming?.id === preset.id && <span className="v11-row">
            <input className="input" maxLength={40} value={renaming.name} disabled={presetBusy} onChange={event => setRenaming({ id: preset.id, name: event.target.value })} aria-label="新的预设名称" />
            <button className="button subtle" disabled={presetBusy || !renaming.name.trim()} onClick={() => void presetAction(preset, 'rename', renaming.name.trim())}>保存名称</button>
            <button className="text-button" disabled={presetBusy} onClick={() => setRenaming(null)}>取消</button>
          </span>}
        </span>
        <span className="qc-actions">
          <button className="button subtle" disabled={busy || presetBusy} onClick={() => applyPreset(preset)}>应用</button>
          <button className="text-button" disabled={busy || presetBusy} onClick={() => setRenaming({ id: preset.id, name: preset.name })}>重命名</button>
          <button className="text-button" disabled={busy || presetBusy} onClick={() => void presetAction(preset, 'duplicate')}>复制</button>
          {!preset.isDefault && <button className="text-button" disabled={busy || presetBusy} onClick={() => void presetAction(preset, 'default')}>设为默认</button>}
          <button className="text-button" disabled={busy || presetBusy} onClick={() => void removePreset(preset)}>删除</button>
        </span>
      </li>      )}</ul> : <p className="hint">还没有保存过导出预设。</p>}
    </section>
  </>;
}
