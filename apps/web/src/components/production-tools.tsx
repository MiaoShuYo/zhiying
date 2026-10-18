'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { SubtitleSchema, templates, cloneScene, storyboardWarnings, renderValidationLabels, type RenderValidation, type Storyboard, type Scene, type StyleId } from '@m2v/schema';
import { styles } from '@m2v/styles';
import { CaptionTimeline } from './caption-editor';
import { PageReview } from './page-review';
import { StructureReview } from './source-structure';
import { normalizePageInfo, type ExtractionMeta, type PageInfo } from '@/lib/extraction';
import { SnapshotVerifier, StoragePanel } from './maintenance-panel';

type Asset = { path: string; name: string; displayName?: string; kind?: string; attribution?: string; license?: string; licenseUrl?: string; sourceUrl?: string; licenseClass?: string; requiresAttribution?: boolean; warnings?: string[] };
type Snapshot = { id: string; createdAt: string; locked: boolean; bytes: number };
type Export = { id: string; status: string; stage: string; progress: string | null; error: string | null; createdAt: string; outputPath?: string | null; inputJson?: string | null; validation?: RenderValidation | null };
async function json(response: Response) { const result = await response.json(); if (!response.ok) throw new Error(result.error ?? '操作失败'); return result; }
const safeLink = (value?: string) => value && /^https?:\/\//i.test(value) ? value : undefined;
export const licenseLabels: Record<string, string> = { 'public-domain': '公有领域', 'cc-by': 'CC BY · 需署名', 'cc-by-sa': 'CC BY-SA · 需署名并相同方式共享', other: '其他许可', unknown: '许可未知' };export function ProductionTools({ id, board, active, assets, busy, save, onChange, onSelect, reload, speed, focus }: { id: string; board: Storyboard; active: number; assets: Asset[]; busy: boolean; save: () => Promise<boolean>; onChange: (board: Storyboard) => void; onSelect: (index: number) => void; reload: () => Promise<void>; speed: number; focus?: { section: string; nonce: number } | null }) {
  const [section, setSection] = useState('layout'), [message, setMessage] = useState(''), [working, setWorking] = useState(false);
  const [selected, setSelected] = useState<string[]>([]), [seconds, setSeconds] = useState(6), [batchStyle, setBatchStyle] = useState<StyleId>(board.styleId);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]), [customTemplates, setCustomTemplates] = useState<{ name: string; scene: Scene }[]>([]);
  const [fragment, setFragment] = useState(''), [preview, setPreview] = useState('');
  const scene = board.scenes[active]; const subtitle = SubtitleSchema.parse(board.subtitles ?? {});
  const disabled = busy || working;
  const minimalPreset = subtitle.preset === 'minimal';
  const backgroundDisabled = disabled || minimalPreset;
  useEffect(() => { setFragment(''); setPreview(''); }, [scene?.id]);
  useEffect(() => { if (focus) setSection(focus.section); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [focus?.nonce]);
  useEffect(() => { void fetch('/api/templates').then(json).then(setCustomTemplates).catch(error => setMessage(String(error))); }, []);
  async function run(action: () => Promise<void>) { setWorking(true); setMessage(''); try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : '操作失败'); } finally { setWorking(false); } }
  async function saved() { if (!await save()) throw new Error('请先处理分镜保存错误'); }
  function patchScene(patch: Partial<Scene>) { onChange({ ...board, scenes: board.scenes.map((item, index) => index === active ? { ...item, ...patch, ...(patch.speechSpeed !== undefined || patch.sentencePause !== undefined ? { audioSrc: undefined, audioKey: undefined, audioDuration: undefined, wordTimings: undefined, subtitleCues: undefined } : {}) } : item) }); }
  async function loadSnapshots() { setSnapshots(await json(await fetch(`/api/projects/${id}/backups`))); }
  async function backup(action: string, extra: object = {}) {
    await saved(); const result = await json(await fetch(`/api/projects/${id}/backups`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) }));
    if (result.id) location.assign(`/project/${result.id}`); else { await loadSnapshots(); if (action === 'download') location.assign(`/api/projects/${id}/backups?download=${result.snapshotId}`); }
  }
  async function upload(file: File, replace?: string) { await saved(); const form = new FormData(); form.set('file', file); form.set('kind', replace ? assets.find(item => item.path === replace)?.kind ?? 'image' : 'image'); if (replace) form.set('replace', replace); await json(await fetch(`/api/projects/${id}/assets`, { method: 'POST', body: form })); await reload(); }
  const warnings = storyboardWarnings(board);
  return <section className="settings-card production-tools"><div className="tools-tabs"><div className="tabs">{[['layout', '分镜精修'], ['captions', '字幕与节奏'], ['assets', '素材库'], ['backups', '备份与恢复']].map(([key, label]) => <button key={key} className={section === key ? 'active' : ''} onClick={() => { setSection(key); if (key === 'backups') void run(loadSnapshots); }}>{label}</button>)}</div></div>{message && <p role="status" className="hint">{message}</p>}
  {section === 'layout' && <><div className="v11-row tools-strip"><label>插入模板<select className="input" disabled={disabled} value="" onChange={event => { const item = [...templates, ...customTemplates][Number(event.target.value)]; if (!item) return; const newScene = { ...structuredClone(item.scene), id: crypto.randomUUID(), audioSrc: undefined, audioKey: undefined, wordTimings: undefined, audioDuration: undefined }; onChange({ ...board, scenes: [...board.scenes.slice(0, active + 1), newScene, ...board.scenes.slice(active + 1)] }); onSelect(active + 1); }}><option value="">选择场景模板</option>{[...templates, ...customTemplates].map((item, i) => <option key={i} value={i}>{item.name}</option>)}</select></label><button className="button subtle" disabled={disabled} onClick={() => { onChange({ ...board, scenes: [...board.scenes.slice(0, active + 1), cloneScene(scene), ...board.scenes.slice(active + 1)] }); onSelect(active + 1); }}>复制当前场景</button><button className="button subtle" disabled={disabled} onClick={() => void run(async () => { const result = await json(await fetch('/api/templates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: scene.title ?? '我的模板', scene }) })); setCustomTemplates(result); setMessage('当前版式已保存为可复用模板'); })}>保存当前为模板</button><label>当前版式<select className="input" disabled={disabled} value={scene.layout ?? 'auto'} onChange={e => patchScene({ layout: e.target.value as Scene['layout'] })}>{[['auto','自动'],['stack','纵向'],['columns','并排'],['compact','紧凑']].map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label></div>
    <details className="batch-panel"><summary><span>批量选择与调整</span><b>已选 {selected.length} 项</b></summary><div className="batch-toolbar"><button className="button subtle" onClick={() => setSelected(board.scenes.map(scene => scene.id))}>全选</button><button className="button subtle" onClick={() => setSelected([])}>清空选择</button><span className="batch-count">共 {board.scenes.length} 个场景</span></div><div className="batch-grid">{board.scenes.map((item, index) => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={e => setSelected(e.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} /><span>{index + 1}. {item.title ?? item.type}</span></label>)}</div><div className="v11-row batch-actions"><label>时长（秒）<input className="input" type="number" min={3} max={3600} value={seconds} onChange={e => setSeconds(Number(e.target.value))} /></label><button className="button subtle" disabled={disabled || !selected.length || seconds < 3 || seconds > 3600} onClick={() => onChange({ ...board, scenes: board.scenes.map(item => selected.includes(item.id) ? { ...item, duration: seconds } : item) })}>批量设置时长</button><select className="input" value={batchStyle} onChange={e => setBatchStyle(e.target.value as StyleId)}>{Object.values(styles).map(style => <option key={style.id} value={style.id}>{style.name}</option>)}</select><button className="button subtle" disabled={disabled || !selected.length} onClick={() => onChange({ ...board, scenes: board.scenes.map(item => selected.includes(item.id) ? { ...item, sceneStyle: batchStyle } : item) })}>批量应用风格</button></div></details>
    {warnings.length > 0 && <div role="status" className="tools-warning"><b>排版检查</b>{warnings.map((warning, i) => <p key={i}><button className="text-button" onClick={() => onSelect(warning.index)}>场景 {warning.index + 1}</button>：{warning.message}</p>)}</div>}
  </>}
  {section === 'captions' && <><div className="v11-row"><label><input type="checkbox" disabled={disabled} checked={subtitle.enabled} onChange={e => onChange({ ...board, subtitles: { ...subtitle, enabled: e.target.checked } })} />显示字幕</label><label>字幕预设<select className="input" disabled={disabled} value={subtitle.preset} onChange={e => onChange({ ...board, subtitles: { ...subtitle, preset: e.target.value as typeof subtitle.preset } })}>{[['minimal','简洁'],['boxed','底板'],['highlight','醒目']].map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label><label>位置<select className="input" disabled={disabled} value={subtitle.position} onChange={e => onChange({ ...board, subtitles: { ...subtitle, position: e.target.value as typeof subtitle.position } })}>{[['top','顶部'],['center','居中'],['bottom','底部']].map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label><label>字号<input className="input" disabled={disabled} type="number" min={18} max={72} value={subtitle.fontSize} onChange={e => onChange({ ...board, subtitles: { ...subtitle, fontSize: Number(e.target.value) } })} /></label><label>文字颜色<input className="input" type="color" disabled={disabled} value={subtitle.color.toLowerCase()} onChange={e => onChange({ ...board, subtitles: { ...subtitle, color: e.target.value.toLowerCase() } })} /><code className="field-readout">{subtitle.color.toLowerCase()}</code></label><label className={minimalPreset ? 'is-muted' : ''}>底板颜色<input className="input" type="color" disabled={backgroundDisabled} value={subtitle.background.toLowerCase()} onChange={e => onChange({ ...board, subtitles: { ...subtitle, background: e.target.value.toLowerCase() } })} /><code className="field-readout">{subtitle.background.toLowerCase()}</code></label><label className={minimalPreset ? 'is-muted' : ''}>底板透明度<input className="input" type="range" disabled={backgroundDisabled} min={0} max={1} step={.01} value={subtitle.backgroundOpacity} onChange={e => onChange({ ...board, subtitles: { ...subtitle, backgroundOpacity: Number(e.target.value) } })} /><code className="field-readout">{subtitle.backgroundOpacity.toFixed(2)}</code></label>{['srt','vtt','ass'].map(format => <button className="button subtle" disabled={disabled} key={format} onClick={() => void run(async () => { await saved(); location.assign(`/api/projects/${id}/subtitles?format=${format}`); })}>导出 {format.toUpperCase()}</button>)}</div><p className="hint">字幕使用旁白对齐时间；未完成对齐的场景采用估算时间。在下方时间轴手动修改后，本场景改用你设定的时间，导出与画面保持一致。位置保留画面 5% 安全边距。</p>{minimalPreset && <p className="hint" role="status">「简洁」预设不绘制底板，底板颜色与底板透明度不会生效；如需底板请切换到「底板」或「醒目」预设。</p>}<div className="v11-row">{([{ key: 'speechSpeed', label: '当前场景语速', min: .5, max: 3, fallback: speed }, { key: 'sentencePause', label: '句间停顿（秒）', min: 0, max: 3, fallback: .12 }, { key: 'sceneGap', label: '场景末间隔（秒）', min: 0, max: 10, fallback: 0 }] as const).map(item => <label key={item.key}>{item.label}<input className="input" disabled={disabled} type="number" step={.1} min={item.min} max={item.max} value={scene[item.key] ?? item.fallback} onChange={e => patchScene({ [item.key]: Number(e.target.value) })} /></label>)}</div><CaptionTimeline scene={scene} portrait={board.aspectRatio === '9:16'} disabled={disabled} onChange={cues => patchScene({ subtitleCues: cues })} /><label className="field-label">试听单句或片段（从当前旁白复制）</label><textarea className="input" value={fragment} onChange={e => setFragment(e.target.value)} placeholder={scene.narration.slice(0,80)} /><div className="v11-row"><button className="button subtle" disabled={disabled} onClick={() => setFragment(scene.narration.match(/[^。！？!?]+[。！？!?]?/)?.[0] ?? scene.narration)}>取第一句</button><button className="button primary" disabled={disabled || !fragment.trim()} onClick={() => void run(async () => { await saved(); const result = await json(await fetch(`/api/projects/${id}/voice/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sceneId: scene.id, text: fragment, speed }) })); setPreview(result.src); })}>{working ? '生成试听中…' : '生成片段试听'}</button>{preview && <audio controls src={preview} />}</div></>}
  {section === 'assets' && <><label className="button subtle file-picker">导入本地图片<input type="file" accept=".png,.jpg,.jpeg,.webp" disabled={disabled} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void run(() => upload(file)); }} /></label><div className="v11-assets">{assets.map(asset => <article className="settings-card" key={asset.path}>{asset.kind === 'audio' ? <audio controls src={`/${asset.path}`} /> : <a href={`/${asset.path}`} target="_blank" rel="noreferrer"><img src={`/${asset.path}`} alt={asset.displayName ?? asset.name} /></a>}<b>{asset.displayName ?? asset.name}</b><p>{asset.attribution} {asset.license}{asset.licenseClass && <span className="license-tag">{licenseLabels[asset.licenseClass] ?? asset.licenseClass}</span>}</p>{asset.warnings?.length ? <ul className="license-warnings">{asset.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul> : null}{safeLink(asset.sourceUrl) && <a href={safeLink(asset.sourceUrl)} target="_blank" rel="noreferrer">来源页面</a>} {safeLink(asset.licenseUrl) && <a href={safeLink(asset.licenseUrl)} target="_blank" rel="noreferrer">许可说明</a>}<div className="v11-row"><label className="button subtle file-picker">替换图片<input type="file" disabled={disabled} accept={asset.kind === 'audio' ? '.wav,.mp3,.m4a,.ogg,.flac' : '.png,.jpg,.jpeg,.webp'} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void run(() => upload(file, asset.path)); }} /></label><button className="button danger" disabled={disabled} onClick={() => void run(async () => { await saved(); await json(await fetch(`/api/projects/${id}/assets`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: asset.path }) })); await reload(); })}>删除</button></div></article>)}</div>{scene.type === 'media' && <><h3>当前图片裁切与焦点</h3><div className="v11-row"><select className="input" disabled={disabled} value={scene.image?.fit ?? 'contain'} onChange={e => patchScene({ image: { zoom: 1, x: 50, y: 50, ...scene.image, fit: e.target.value as 'contain' | 'cover' } })}><option value="contain">完整显示</option><option value="cover">填满并裁切</option></select>{(['zoom','x','y'] as const).map(key => <label key={key}>{({zoom:'缩放',x:'水平焦点',y:'垂直焦点'})[key]}<input type="range" disabled={disabled} min={key === 'zoom' ? 1 : 0} max={key === 'zoom' ? 3 : 100} step={key === 'zoom' ? .05 : 1} value={scene.image?.[key] ?? (key === 'zoom' ? 1 : 50)} onChange={e => patchScene({ image: { fit: 'contain', zoom: 1, x: 50, y: 50, ...scene.image, [key]: Number(e.target.value) } })} /></label>)}</div></>}<StoragePanel id={id} disabled={disabled} reload={reload} /></>}
  {section === 'backups' && <><p>项目包包括源文件、声音参考、图片、旁白、配置和每次导出的成片。V1.0 的旧导出记录共用同一个视频文件，只有最近一次可以下载。恢复后创建新项目。自动快照每 5 分钟最多保存一次，保留最近 10 份未锁定版本。</p><div className="v11-row"><button className="button primary" disabled={disabled} onClick={() => void run(() => backup('download'))}>导出完整项目包</button><button className="button subtle" disabled={disabled} onClick={() => void run(() => backup('snapshot'))}>立即创建快照</button><button className="button subtle" disabled={disabled} onClick={() => void run(() => backup('duplicate'))}>复制项目</button></div>{snapshots.map(snapshot => <div className="v11-row" key={snapshot.id}><span>{new Date(snapshot.createdAt).toLocaleString()} · {(snapshot.bytes / 1024 / 1024).toFixed(1)} MB</span><button className="button subtle" disabled={disabled} onClick={() => void run(() => backup('lock', { snapshotId: snapshot.id, locked: !snapshot.locked }))}>{snapshot.locked ? '解除锁定' : '锁定快照'}</button><button className="button subtle" disabled={disabled} onClick={() => void run(() => backup('restore', { snapshotId: snapshot.id }))}>恢复为新项目</button><SnapshotVerifier id={id} snapshotId={snapshot.id} disabled={disabled} /><a className="button subtle" href={`/api/projects/${id}/backups?download=${snapshot.id}`}>下载</a></div>)}</>}
  </section>;
}

export function ExportHistory({ id, busy, onRecheck }: { id: string; busy: boolean; onRecheck?: () => void }) {
  const [exports, setExports] = useState<Export[]>([]), [error, setError] = useState('');
  const [validating, setValidating] = useState('');
  async function validate(jobId: string) {
    setValidating(jobId); setError('');
    try {
      const result = await json(await fetch(`/api/projects/${id}/exports/${jobId}/validate`, { method: 'POST' }));
      setExports(current => current.map(job => job.id === jobId ? { ...job, validation: result.validation } : job));
    } catch (problem) { setError(problem instanceof Error ? problem.message : '校验失败'); } finally { setValidating(''); }
  }
  async function refresh() { try { setExports(await json(await fetch(`/api/projects/${id}/exports`))); } catch (error) { setError(String(error)); } }
  useEffect(() => { void refresh(); if (busy) { const timer = setInterval(refresh, 1500); return () => clearInterval(timer); } }, [id, busy]);
  // 接口按创建时间倒序返回：旧的共享 final.mp4 只属于最近一次完成的导出记录。
  const sharedClaimed = exports.some(job => job.outputPath === 'final.mp4');
  const sharedOwner = sharedClaimed ? null : exports.find(job => job.status === 'completed' && !job.outputPath)?.id;
  return <section className="settings-card"><h3>导出记录</h3>{error && <p role="alert">{error}</p>}{exports.map(job => { let progress: { percent?: number; message?: string } = {}; try { progress = JSON.parse(job.progress ?? '{}'); } catch {} let preset = 'full'; try { preset = JSON.parse(job.inputJson ?? '{}').preset; } catch {} const unavailable = job.status === 'completed' && !job.outputPath && job.id !== sharedOwner; return <div className="settings-card" key={job.id}><b>{preset === 'draft' ? '540p 草稿' : '1080p 成片'} · {new Date(job.createdAt).toLocaleString()}{unavailable ? ' · 历史记录' : ''}</b><p>{({ queued:'排队中', running:'执行中', cancelling:'正在停止并清理', cancelled:'已取消', completed:'已完成', failed:'失败' } as Record<string,string>)[job.status]} {progress.message} {progress.percent !== undefined ? `${progress.percent}%` : ''}</p>{progress.percent !== undefined && job.status === 'running' && <progress value={progress.percent} max={100} />}{job.validation && <p className={`qc-verdict-line ${job.validation.ok ? 'ok' : job.validation.issues.some(issue => issue.blocking) ? 'error' : 'warning'}`}>成片校验：{job.validation.ok ? '通过' : job.validation.issues.some(issue => issue.blocking) ? '文件不可用' : `${job.validation.issues.length} 项提醒`} · {job.validation.width ?? '?'} × {job.validation.height ?? '?'} · {job.validation.duration === undefined ? '时长未知' : `${job.validation.duration.toFixed(1)} 秒`} · 音频轨道 {job.validation.hasAudio ? '有' : '无'}{job.validation.issues.length > 0 ? ` · ${job.validation.issues.map(issue => renderValidationLabels[issue.code] ?? issue.code).join('、')}` : ''}</p>}{job.error && <p className="error-text">{job.error}</p>}{job.status === 'failed' && onRecheck && <button className="button subtle" onClick={onRecheck}>先做导出前检查再重试</button>}{['queued','running','cancelling'].includes(job.status) && <button className="button danger" disabled={job.status === 'cancelling'} onClick={() => void fetch(`/api/jobs/${job.id}/cancel`, { method: 'POST' }).then(json).then(refresh).catch(error => setError(String(error)))}>取消渲染</button>}{job.status === 'completed' && (job.outputPath || job.id === sharedOwner ? <button className="button subtle" disabled={busy} onClick={async () => { setError(''); try { const probe = await fetch(`/api/projects/${id}/output?jobId=${job.id}`, { method: 'HEAD' }); if (!probe.ok) { const data = await probe.json().catch(() => ({})); throw new Error(data.error ?? '视频文件不存在，请重新渲染'); } window.location.assign(`/api/projects/${id}/output?jobId=${job.id}`); } catch (error) { setError(error instanceof Error ? error.message : '下载失败'); } }}>下载视频</button> : <p className="hint">历史记录（视频不可用）：V1.0 的多次导出共用同一个视频文件，这条记录的视频已被后续导出覆盖，文件已不存在。需要成片请重新导出。</p>)}{job.status === 'completed' && <button className="text-button" disabled={validating === job.id} onClick={() => void validate(job.id)}>{validating === job.id ? '校验中…' : job.validation ? '重新校验成片' : '校验成片文件'}</button>}</div>; })}</section>;
}

type ExtractionInfo = { kind?: ExtractionMeta['kind']; filename?: string; pages?: number; ocrPages?: number[]; failedPages?: { page: number; error: string }[]; pageInfo?: PageInfo[]; extractedAt?: string };
const pageMarker = /^##\s*(第\s*\d+\s*页|幻灯片\s*\d+)\s*$/;
function splitSource(text: string) {
  const preamble: string[] = []; const pages: { label: string; body: string[] }[] = [];
  for (const line of text.split('\n')) {
    if (pageMarker.test(line.trim())) pages.push({ label: line.trim(), body: [] });
    else if (pages.length) pages[pages.length - 1].body.push(line);
    else preamble.push(line);
  }
  return { preamble, pages };
}
const joinSource = (preamble: string[], pages: { label: string; body: string[] }[]) => [...preamble, ...pages.flatMap(page => [page.label, ...page.body])].join('\n');
function renderPage(body: string) {
  const nodes: ReactNode[] = []; let table: string[][] = [];
  const flushTable = () => {
    if (!table.length) return;
    const rows = table; table = [];
    nodes.push(<table className="preview-table" key={`table-${nodes.length}`}><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => rowIndex === 0 ? <th key={cellIndex}>{cell}</th> : <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table>);
  };
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (/^\|.*\|$/.test(trimmed)) {
      const cells = trimmed.slice(1, -1).split('|').map(cell => cell.trim());
      if (!cells.every(cell => /^:?-{2,}:?$/.test(cell))) table.push(cells);
      continue;
    }
    flushTable();
    if (!trimmed) continue;
    if (/^#{1,6}\s/.test(trimmed)) nodes.push(<h4 key={nodes.length}>{trimmed.replace(/^#+\s*/, '')}</h4>);
    else if (/^[-*•]\s/.test(trimmed)) nodes.push(<li key={nodes.length}>{trimmed.replace(/^[-*•]\s*/, '')}</li>);
    else nodes.push(<p key={nodes.length}>{trimmed}</p>);
  }
  flushTable();
  return nodes;
}

export function SourceReview({ id, onContinue }: { id: string; onContinue: () => void }) {
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [info, setInfo] = useState<ExtractionInfo | null>(null);
  const [stale, setStale] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [active, setActive] = useState(0), [view, setView] = useState<'page' | 'raw'>('page');
  useEffect(() => {
    void (async () => {
      setLoading(true); setError('');
      try { const result = await json(await fetch(`/api/projects/${id}/source`)); setText(result.sourceText ?? ''); setSaved(result.sourceText ?? ''); setInfo(result.extraction ?? null); }
      catch (error) { setError(String(error)); }
      finally { setLoading(false); }
    })();
  }, [id]);
  const { preamble, pages } = splitSource(text);
  const index = pages.length ? Math.min(active, pages.length - 1) : 0;
  const current = pages[index];
  // Page headings are structural: PPTX chapters and page order are rebuilt from
  // them, so only the page body is editable and the markers are re-emitted.
  function updateBody(body: string) { setText(joinSource(preamble, pages.map((page, i) => i === index ? { ...page, body: body.split('\n') } : page))); }
  const markersLost = (info?.pages ?? 0) > 0 && pages.length === 0;
  const pageRows = normalizePageInfo({ ...info, pages: info?.pages ?? pages.length });
  return <section className="settings-card"><h2>抽取结果预览</h2><p>检查页面顺序、表格内容和 OCR 识别结果，可直接编辑后生成故事板。页标题由系统维护，编辑正文不会破坏分页标记。</p>
    {loading && <p className="hint">正在读取抽取结果…</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && <>
      <div className="v11-row source-summary">
        <span>共 <b>{pages.length || info?.pages || 0}</b> 页</span>
        <span>正文 <b>{text.replace(/\s+/g, '').length}</b> 字</span>
        {info?.kind && <span>来源 <b>{{ pdf: 'PDF', pptx: 'PPTX', markdown: 'Markdown', url: '网页', text: '文本' }[info.kind] ?? info.kind}</b></span>}
        {info?.ocrPages?.length ? <span>OCR 识别页 <b>{info.ocrPages.join('、')}</b></span> : null}
      </div>
      <PageReview id={id} kind={info?.kind} pageInfo={pageRows} disabled={busy} dirty={text !== saved} onUpdated={result => {
        setText(result.sourceText); setSaved(result.sourceText);
        setInfo(current => {
          const merged = new Map(normalizePageInfo({ ...current, pages: current?.pages ?? splitSource(result.sourceText).pages.length }).map(page => [page.page, page] as const));
          for (const page of result.pages) merged.set(page.page, page);
          const rows = [...merged.values()].sort((a, b) => a.page - b.page);
          return { ...current, kind: current?.kind ?? 'pdf', pages: rows[rows.length - 1]?.page ?? rows.length, ocrPages: result.ocrPages, failedPages: result.failedPages, pageInfo: rows };
        });
        setStale(result.staleScenes.length ? `第 ${[...new Set(result.staleScenes.map(scene => scene.sourcePage))].join('、')} 页对应的 ${result.staleScenes.length} 个场景仍使用旧内容，请重新生成分镜后再导出。` : '');
      }} />
      {stale && <p className="tools-warning" role="status">{stale}</p>}
      {pages.length > 0 && <StructureReview pages={pages} pageInfo={pageRows} disabled={busy} onJump={index => { setActive(index); setView('page'); }} />}
      {markersLost && <p className="hint" role="status">未检测到分页标记，正文将作为单页处理。</p>}
      {pages.length > 0 && <>
        <div className="v11-row source-nav">
          <button className="button subtle" disabled={busy || index === 0} onClick={() => setActive(index - 1)}>上一页</button>
          <select className="input" disabled={busy} value={index} onChange={e => setActive(Number(e.target.value))}>{pages.map((page, i) => <option key={page.label + i} value={i}>{page.label.replace(/^##\s*/, '')}</option>)}</select>
          <button className="button subtle" disabled={busy || index >= pages.length - 1} onClick={() => setActive(index + 1)}>下一页</button>
          <span className="hint">第 {index + 1} / {pages.length} 页</span>
          <div className="tabs"><button className={view === 'page' ? 'active' : ''} onClick={() => setView('page')}>渲染预览</button><button className={view === 'raw' ? 'active' : ''} onClick={() => setView('raw')}>只读原文</button></div>
        </div>
        {view === 'page'
          ? <div className="v11-row source-pane"><div className="source-preview">{renderPage(current?.body.join('\n') ?? '')}</div><textarea aria-label={`第 ${index + 1} 页正文`} className="input source-editor" value={current?.body.join('\n') ?? ''} onChange={e => updateBody(e.target.value)} disabled={busy} /></div>
          : <pre className="source-raw">{current?.body.join('\n')}</pre>}
      </>}
      {!pages.length && <textarea aria-label="抽取正文" className="input" style={{ minHeight: 400 }} value={text} onChange={e => setText(e.target.value)} disabled={busy} />}
    </>}
    <button className="button primary" disabled={busy || loading || text.trim().length < 30} onClick={async () => { setBusy(true); setError(''); try { await json(await fetch(`/api/projects/${id}/source`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })); onContinue(); } catch (error) { setError(String(error)); } finally { setBusy(false); } }}>{busy ? '提交中…' : '使用此正文生成分镜'}</button></section>;
}

export function RestoreProject() {
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  return <label className="button subtle file-picker">{busy ? '正在恢复…' : '恢复项目包'}<input aria-label="选择项目备份包" type="file" accept=".m2v" disabled={busy} onChange={async e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; setBusy(true); try { const result = await json(await fetch('/api/backups/restore', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file })); location.assign(`/project/${result.id}`); } catch (error) { setMessage(String(error)); setBusy(false); } }} />{message && <span role="alert">{message}</span>}</label>;
}
