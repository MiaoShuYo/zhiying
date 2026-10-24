'use client';

import { useEffect, useState } from 'react';
import {
  templateChanges,
  templateFromProject,
  templateSummary,
  type ProductionTemplate,
  type Storyboard,
  type TemplateChange,
} from '@m2v/schema';

export type TemplateApplyResult = {
  changedCount: number;
  sceneCount: number;
  staleAudio: number[];
  renderPreset: 'full' | 'draft';
  voice: boolean;
};

type Options = { voice: boolean; scenes: boolean; export: boolean };

async function json(response: Response) {
  const text = await response.text();
  let body: unknown = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!response.ok) throw new Error((body as { error?: string }).error ?? `请求失败（${response.status}）`);
  return body as Record<string, unknown>;
}

const scopeLabels: Record<TemplateChange['scope'], string> = { project: '项目', scene: '场景' };

/** True when the row is written by one of the three apply switches. */
function rowEnabled(change: TemplateChange, options: Options) {
  if (change.key === 'voiceId') return options.voice;
  return change.scope === 'scene' ? options.scenes : options.export;
}

export function ProductionTemplates({
  id, board, busy, save, currentPreset, onApplied,
}: {
  id: string;
  board: Storyboard;
  busy: boolean;
  save: () => Promise<boolean>;
  currentPreset: 'full' | 'draft';
  onApplied: (result: TemplateApplyResult) => void;
}) {
  const [templates, setTemplates] = useState<ProductionTemplate[]>([]);
  const [max, setMax] = useState(30);
  const [name, setName] = useState('');
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [pending, setPending] = useState<ProductionTemplate | null>(null);
  const [options, setOptions] = useState<Options>({ voice: true, scenes: true, export: true });
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let stopped = false;
    void fetch('/api/settings/production-templates', { cache: 'no-store' })
      .then(response => json(response))
      .then(result => { if (stopped) return; setTemplates((result.templates as ProductionTemplate[]) ?? []); setMax(Number(result.max) || 30); })
      .catch(problem => { if (!stopped) setError(problem instanceof Error ? problem.message : '读取制作方案失败'); });
    void fetch(`/api/projects/${id}`, { cache: 'no-store' })
      .then(response => json(response))
      .then(project => { if (!stopped) setVoiceId(typeof project.voiceId === 'string' ? project.voiceId : null); })
      .catch(() => undefined);
    return () => { stopped = true; };
  }, [id]);

  const impact = pending ? templateChanges(board, voiceId, pending, currentPreset) : null;
  const rows = impact ? impact.rows : [];

  async function reload() {
    const result = await json(await fetch('/api/settings/production-templates', { cache: 'no-store' }));
    setTemplates((result.templates as ProductionTemplate[]) ?? []);
    setMax(Number(result.max) || 30);
  }

  async function saveTemplate() {
    if (busy || working) return;
    setWorking(true); setError(''); setMessage('');
    try {
      const payload = templateFromProject({ board, voiceId, renderPreset: currentPreset });
      const result = await json(await fetch('/api/settings/production-templates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, name: name.trim() || payload.name || '我的制作方案' }),
      }));
      const template = result.template as ProductionTemplate;
      setTemplates(current => [template, ...current.filter(item => item.id !== template.id)]);
      setName('');
      setMessage(`已保存制作方案「${template.name}」`);
    } catch (problem) { setError(problem instanceof Error ? problem.message : '保存制作方案失败'); } finally { setWorking(false); }
  }

  async function templateAction(template: ProductionTemplate, action: 'rename' | 'duplicate' | 'default', nextName?: string) {
    setWorking(true); setError(''); setMessage('');
    try {
      await json(await fetch('/api/settings/production-templates', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: template.id, action, ...(nextName ? { name: nextName } : {}) }),
      }));
      await reload();
      setRenaming(null);
      setMessage(action === 'rename' ? '已重命名制作方案' : action === 'duplicate' ? `已复制「${template.name}」` : `已将「${template.name}」设为默认方案`);
    } catch (problem) { setError(problem instanceof Error ? problem.message : '更新制作方案失败'); } finally { setWorking(false); }
  }

  async function remove(template: ProductionTemplate) {
    setWorking(true); setError(''); setMessage('');
    try {
      await json(await fetch(`/api/settings/production-templates?id=${encodeURIComponent(template.id)}`, { method: 'DELETE' }));
      setTemplates(current => current.filter(item => item.id !== template.id));
      if (pending?.id === template.id) setPending(null);
      setMessage(`已删除制作方案「${template.name}」`);
    } catch (problem) { setError(problem instanceof Error ? problem.message : '删除制作方案失败'); } finally { setWorking(false); }
  }

  async function apply() {
    if (!pending || busy || working) return;
    setWorking(true); setError(''); setMessage('');
    try {
      // The route rewrites the stored storyboard, so unsaved edits must land first.
      if (!await save()) throw new Error('分镜保存失败，请先保存再应用制作方案');
      const result = await json(await fetch(`/api/projects/${id}/production-template`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          templateId: pending.id,
          applyVoice: options.voice,
          applyScenes: options.scenes,
          applyExport: options.export,
          renderPreset: currentPreset,
        }),
      }));
      const staleAudio = Array.isArray(result.staleAudio) ? result.staleAudio as number[] : [];
      const changedCount = Number(result.changedCount) || 0;
      const sceneCount = Number(result.sceneCount) || 0;
      onApplied({
        changedCount,
        sceneCount,
        staleAudio,
        renderPreset: pending.renderPreset,
        voice: Boolean(result.voice),
      });
      setMessage([
        `已应用「${pending.name}」：${changedCount} 项设置`,
        sceneCount ? `${sceneCount} 个场景的语速与节奏已更新` : '',
        staleAudio.length ? `${staleAudio.length} 个场景的语音已失效，需重新生成` : '',
      ].filter(Boolean).join('，'));
      setPending(null);
    } catch (problem) { setError(problem instanceof Error ? problem.message : '应用制作方案失败'); } finally { setWorking(false); }
  }

  return <section className="settings-card template-card">
    <h3>制作方案</h3>
    <p className="hint">把声音、语速与停顿、场景间隔、画幅、字幕样式和片头片尾组合成一份可复用方案，新项目或其它项目都能直接套用。</p>
    <div className="v11-row">
      <input className="input" maxLength={40} placeholder={`方案名称，例如「${board.title.slice(0, 12) || '竖屏讲解'}」`} value={name} onChange={event => setName(event.target.value)} disabled={busy || working} />
      <button className="button subtle" disabled={busy || working} onClick={() => void saveTemplate()}>{working ? '处理中…' : '保存当前方案'}</button>
    </div>
    <p className="hint">将保存：声音 {voiceId || '未指定'} · 语速 {board.scenes[0]?.speechSpeed ?? 1}× · 画幅 {board.aspectRatio ?? '16:9'} · 导出画质 {currentPreset === 'draft' ? '草稿' : '正式'} · 共 {board.scenes.length} 个场景</p>
    {max > 0 && templates.length >= max ? <p className="hint">已达上限 {max} 份，删除不用的方案后可继续保存。</p> : null}
    {error ? <p role="alert" className="error-text">{error}</p> : null}
    {message ? <p className="hint" role="status">{message}</p> : null}
    {pending && impact ? <div className="preset-confirm" role="dialog" aria-label="应用制作方案前的修改预览">
      <b>应用「{pending.name}」会修改 {rows.filter(row => row.changed && rowEnabled(row, options)).length} 项设置，并改写 {options.scenes ? impact.sceneCount : 0} 个场景的语速与节奏</b>
      <div className="template-scopes">
        {([
          ['voice', `声音（1 项）`],
          ['scenes', `场景语速与节奏（${impact.sceneCount} 个场景受影响）`],
          ['export', `画面与字幕设置（${rows.filter(row => row.scope === 'project' && row.key !== 'voiceId' && row.changed).length} 项）`],
        ] as [keyof Options, string][]).map(([key, label]) => <label className="template-scope" key={key}>
          <input type="checkbox" checked={options[key]} disabled={working} onChange={event => setOptions(current => ({ ...current, [key]: event.target.checked }))} />
          <span>{label}</span>
        </label>)}
      </div>
      <ul className="template-changes">
        {rows.filter(row => rowEnabled(row, options)).map(row => <li key={row.key} className={row.changed ? 'changed' : 'same'}>
          <span><span className={`template-badge ${row.scope}`}>{scopeLabels[row.scope]}</span>{row.label}</span>
          <span>{row.changed ? <>{row.current} → <b>{row.next}</b></> : `${row.current}（不变）`}</span>
        </li>)}
      </ul>
      <p className="hint">旁白、分镜内容、素材与发音规则不会被修改；语速或停顿有变化的场景会清除已有语音，需要重新生成。</p>
      <div className="v11-row">
        <button className="button primary" disabled={busy || working} onClick={() => void apply()}>{working ? '应用中…' : '确认应用'}</button>
        <button className="text-button" disabled={busy || working} onClick={() => setPending(null)}>取消</button>
      </div>
    </div> : null}
    {templates.length ? <ul className="qc-presets template-list">{templates.map(template => <li key={template.id}>
      <span>
        <b>{template.name}{template.isDefault ? <span className="preset-default">默认</span> : null}</b>
        <small>{templateSummary(template)}</small>
        {renaming?.id === template.id && <span className="v11-row">
          <input className="input" maxLength={40} value={renaming.name} disabled={working} onChange={event => setRenaming({ id: template.id, name: event.target.value })} aria-label="新的方案名称" />
          <button className="button subtle" disabled={working || !renaming.name.trim()} onClick={() => void templateAction(template, 'rename', renaming.name.trim())}>保存名称</button>
          <button className="text-button" disabled={working} onClick={() => setRenaming(null)}>取消</button>
        </span>}
      </span>
      <span className="qc-actions">
        <button className="button subtle" disabled={busy || working} onClick={() => { setPending(template); setOptions({ voice: true, scenes: true, export: true }); setError(''); setMessage(''); }}>应用</button>
        <button className="text-button" disabled={working} onClick={() => setRenaming({ id: template.id, name: template.name })}>重命名</button>
        <button className="text-button" disabled={working} onClick={() => void templateAction(template, 'duplicate')}>复制</button>
        {!template.isDefault ? <button className="text-button" disabled={working} onClick={() => void templateAction(template, 'default')}>设为默认</button> : null}
        <button className="text-button" disabled={working} onClick={() => void remove(template)}>删除</button>
      </span>
    </li>)}</ul> : <p className="hint">还没有保存过制作方案。先调好导出预设或分镜里的语速与字幕，再回来保存。</p>}
  </section>;
}
