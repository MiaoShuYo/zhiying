'use client';
import { useCallback, useEffect, useState } from 'react';
import type { Storyboard } from '@m2v/schema';

export type AssetItem = { path: string; name: string; displayName?: string; kind?: string; attribution?: string; license?: string; licenseUrl?: string; sourceUrl?: string; licenseClass?: string; requiresAttribution?: boolean; warnings?: string[]; archived?: boolean; archivedAt?: string };
type SceneRef = { index: number; title?: string };
type Usage = {
  total: number; bytes: number;
  referenced: { path: string; scenes: SceneRef[]; bgm: boolean }[];
  unused: { path: string; name: string; displayName?: string; bytes: number }[];
  archived: { path: string; name: string; displayName?: string; bytes: number }[];
  missing: { path: string; kind: 'image' | 'audio' | 'bgm'; scenes: SceneRef[]; registered: boolean }[];
  duplicates: { hash: string; paths: string[]; bytes: number }[];
  scannedAt: string;
};
type Group = 'all' | 'unused' | 'missing' | 'duplicate' | 'archived';

const kinds: Record<string, string> = { image: '图片', audio: '语音', bgm: '背景音乐' };
const bytesText = (bytes?: number) => !bytes ? '—' : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const extFor = (kind: string) => kind === 'audio' ? '.wav,.mp3,.m4a,.ogg,.flac' : '.png,.jpg,.jpeg,.webp';

/** Rewrites every reference to `from` so it points at `to`, which is how duplicate and missing assets get unified. */
function retarget(board: Storyboard, from: string, to: string): Storyboard {
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') return value === from ? to : value;
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
    return value;
  };
  const next: Storyboard = { ...board, scenes: board.scenes.map(scene => ({ ...scene, audioSrc: scene.audioSrc === from ? to : scene.audioSrc, visual: rewrite(scene.visual) as typeof scene.visual })) };
  return board.bgmSrc === from ? { ...next, bgmSrc: to } : next;
}

export function AssetManager({ id, board, assets, disabled, save, onChange, onSelect, onReload, onMessage }: {
  id: string; board: Storyboard; assets: AssetItem[]; disabled: boolean;
  save: (board?: Storyboard) => Promise<boolean>; onChange: (board: Storyboard) => void;
  onSelect: (index: number) => void; onReload: () => Promise<void>; onMessage: (message: string) => void;
}) {
  const [usage, setUsage] = useState<Usage | null>(null), [group, setGroup] = useState<Group>('all'), [error, setError] = useState('');
  const [working, setWorking] = useState(false), [open, setOpen] = useState<string | null>(null), [targets, setTargets] = useState<number[]>([]);
  const [linked, setLinked] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setError('');
    const response = await fetch(`/api/projects/${id}/assets/usage`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) { setUsage(null); setError(payload.error ?? '素材检查失败'); return; }
    setUsage(payload as Usage);
  }, [id]);

  useEffect(() => { void refresh(); }, [refresh, assets.length]);

  function mutate(action: () => Promise<string>) {
    setWorking(true); setError('');
    void (async () => {
      try { onMessage(await action()); await onReload(); await refresh(); }
      catch (failure) { setError(failure instanceof Error ? failure.message : '素材操作失败'); }
      finally { setWorking(false); setOpen(null); setTargets([]); }
    })();
  }

  async function api(method: 'PATCH' | 'DELETE', body: object) {
    const response = await fetch(`/api/projects/${id}/assets`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? '素材操作失败');
    return payload;
  }

  function replaceInto(file: File, path: string, scenes: number[]) {
    mutate(async () => {
      if (!await save()) throw new Error('请先处理分镜保存错误');
      const form = new FormData();
      form.set('file', file); form.set('kind', assets.find(item => item.path === path)?.kind ?? 'image'); form.set('replace', path);
      form.set('scenes', JSON.stringify(scenes));
      const response = await fetch(`/api/projects/${id}/assets`, { method: 'POST', body: form });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? '替换素材失败');
      const skipped = (payload.skipped as number[] | undefined) ?? [];
      const kept = (payload.stillReferenced as { scenes: number[]; bgm: boolean } | undefined);
      const notes = [payload.archived ? '旧素材已归档，可随时恢复' : '旧素材仍有场景在用，保持未归档'];
      if (kept?.scenes.length) notes.push(`场景 ${kept.scenes.map(index => index + 1).join('、')} 还在用它`);
      if (skipped.length) notes.push(`场景 ${skipped.map(index => index + 1).join('、')} 不是图片场景，已跳过`);
      return `已替换 ${scenes.length} 个场景 · ${notes.join('；')}`;
    });
  }

  function fillMissing(entry: Usage['missing'][number], file: File) {
    if (entry.registered) { replaceInto(file, entry.path, entry.scenes.map(scene => scene.index)); return; }
    mutate(async () => {
      const form = new FormData();
      form.set('file', file); form.set('kind', entry.kind === 'image' ? 'image' : 'audio');
      const response = await fetch(`/api/projects/${id}/assets`, { method: 'POST', body: form });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? '上传素材失败');
      const next = retarget(board, entry.path, payload.asset.path as string);
      onChange(next);
      if (!await save(next)) throw new Error('补充素材后分镜没有保存成功');
      return `已补齐缺失素材并更新 ${entry.scenes.length} 个场景`;
    });
  }

  /**
   * In-app repair path: re-point the scenes at a file the project already has, which
   * needs no OS file dialog (embedders and sandboxed viewers never show one).
   */
  function linkMissing(entry: Usage['missing'][number], to: string) {
    mutate(async () => {
      const next = retarget(board, entry.path, to);
      onChange(next);
      if (!await save(next)) throw new Error('关联已有素材后分镜没有保存成功');
      const uses = entry.scenes.length + (board.bgmSrc === entry.path ? 1 : 0);
      return `已把 ${uses} 处引用改为 ${to.split('/').at(-1)}`;
    });
  }

  function unify(paths: string[]) {    mutate(async () => {
      const [keep, ...drop] = paths;
      if (!keep || !drop.length) throw new Error('重复素材不足两组');
      let next = board;
      for (const path of drop) next = retarget(next, path, keep);
      onChange(next);
      if (!await save(next)) throw new Error('统一素材引用没有保存成功');
      for (const path of drop) await api('DELETE', { path });
      return `已统一 ${paths.length} 份重复素材到 1 份`;
    });
  }

  const referenced = (path: string) => usage?.referenced.find(ref => ref.path === path);
  const groupSize = (key: Group) => key === 'all' ? assets.filter(asset => !asset.archived).length : key === 'unused' ? usage?.unused.length ?? 0 : key === 'missing' ? usage?.missing.length ?? 0 : key === 'duplicate' ? usage?.duplicates.length ?? 0 : usage?.archived.length ?? 0;
  const tabs: [Group, string][] = [['all', '全部素材'], ['unused', '未使用'], ['missing', '缺失'], ['duplicate', '重复'], ['archived', '归档']];
  const busy = disabled || working;
  const visible = assets.filter(asset => !asset.archived);

  return <section className="asset-manager">
    <div className="asset-workspace-bar">
      <label className="button subtle file-picker">导入本地图片<input type="file" accept={extFor('image')} disabled={busy} onChange={e => { const file = e.target.files?.[0]; e.currentTarget.value = ''; if (file) mutate(async () => { const form = new FormData(); form.set('file', file); form.set('kind', 'image'); const response = await fetch(`/api/projects/${id}/assets`, { method: 'POST', body: form }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.error ?? '导入素材失败'); return `已导入 ${file.name}`; }); }} /></label>
      <button className="button subtle" disabled={busy} onClick={() => mutate(async () => { await refresh(); return '已重新检查素材状态'; })}>重新检查</button>
      {usage && <span className="hint">共 {usage.total} · 未使用 {usage.unused.length} · 缺失 {usage.missing.length} · 重复 {usage.duplicates.length} · 归档 {usage.archived.length} · {bytesText(usage.bytes)}</span>}
    </div>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="tabs asset-tabs">{tabs.map(([key, label]) => <button key={key} className={group === key ? 'active' : ''} disabled={busy} onClick={() => setGroup(key)}>{label}{groupSize(key) ? ` · ${groupSize(key)}` : ''}</button>)}</div>

    {group === 'all' && <div className="v11-assets">{visible.map(asset => {
      const ref = referenced(asset.path), chosen = open === asset.path ? targets : ref?.scenes.map(scene => scene.index) ?? [];
      return <article className="settings-card" key={asset.path}>
        {asset.kind === 'audio' ? <audio controls src={`/${asset.path}`} /> : <a href={`/${asset.path}`} target="_blank" rel="noreferrer"><img src={`/${asset.path}`} alt={asset.displayName ?? asset.name} /></a>}
        <b>{asset.displayName ?? asset.name}</b>
        <p>{asset.attribution} {asset.license}{asset.licenseClass && <span className="license-tag">{asset.licenseClass}</span>}</p>
        {(asset.warnings ?? []).length > 0 && <ul className="license-warnings">{(asset.warnings ?? []).map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        <p className="asset-usage">
          {ref ? <>被 {ref.scenes.length + (ref.bgm ? 1 : 0)} 处引用：{ref.scenes.map(scene => <button key={scene.index} className="button link" disabled={busy} onClick={() => onSelect(scene.index)}>场景 {scene.index + 1}</button>)}{ref.bgm && <span className="badge">背景音乐</span>}</> : <span className="badge warn">未使用</span>}
        </p>
        <div className="v11-row">
          <label className="button subtle file-picker">替换素材<input type="file" disabled={busy} accept={extFor(asset.kind ?? 'image')} onChange={e => { const file = e.target.files?.[0]; e.currentTarget.value = ''; if (file) replaceInto(file, asset.path, chosen); }} /></label>
          <button className="button subtle" disabled={busy} onClick={() => { setOpen(open === asset.path ? null : asset.path); setTargets(ref?.scenes.map(scene => scene.index) ?? []); }}>{open === asset.path ? '收起场景选择' : '在场景中替换'}</button>
          <button className="button danger" disabled={busy} onClick={() => mutate(async () => { if (!await save()) throw new Error('请先处理分镜保存错误'); await api('DELETE', { path: asset.path }); return '已删除素材'; })}>删除</button>
        </div>
        {open === asset.path && <div className="asset-targets">
          <p className="hint">勾选要用新素材替换的场景（默认是当前引用它的场景）；未勾选的场景保持原样，旧素材不会被归档。</p>
          {board.scenes.map((item, index) => <label key={item.id} className="asset-target">
            <input type="checkbox" disabled={busy} checked={targets.includes(index)} onChange={e => setTargets(current => e.target.checked ? [...current, index].sort((a, b) => a - b) : current.filter(item => item !== index))} />
            场景 {index + 1} · {item.title ?? item.type}{item.type !== 'media' && <span className="badge">非图片场景，将被跳过</span>}
          </label>)}
        </div>}
      </article>;
    })}</div>}

    {group === 'unused' && (usage?.unused.length ? <ul className="asset-list">{usage.unused.map(item => <li key={item.path}><span><b>{item.displayName ?? item.name}</b> · {bytesText(item.bytes)}</span><button className="button danger" disabled={busy} onClick={() => mutate(async () => { await api('DELETE', { path: item.path }); return '已删除未使用的素材'; })}>删除</button></li>)}</ul> : <p className="hint">没有未使用的素材。</p>)}

    {group === 'missing' && (usage?.missing.length ? <ul className="asset-list">{usage.missing.map(item => {
      const candidates = assets.filter(asset => !asset.archived && asset.path !== item.path && (item.kind === 'image' ? (asset.kind ?? 'image') === 'image' : asset.kind === 'audio' || asset.kind === 'bgm'));
      const target = linked[item.path] ?? '';
      return <li key={item.path}><div><b>{kinds[item.kind] ?? item.kind}</b> · {item.path}{item.registered ? '' : '（未登记）'}<div className="hint">上传本地文件，或关联到项目里已有的素材，两种方式都会让引用它的场景改用新文件。</div></div><div className="asset-actions">{item.scenes.map(scene => <button key={scene.index} className="button link" disabled={busy} onClick={() => onSelect(scene.index)}>场景 {scene.index + 1}</button>)}<label className="button subtle file-picker" title="选择本地文件后自动上传，并让这些场景改用它">{item.registered ? '上传补齐' : '上传并关联'}<input type="file" disabled={busy} accept={extFor(item.kind === 'image' ? 'image' : 'audio')} onChange={e => { const file = e.target.files?.[0]; e.currentTarget.value = ''; if (file) fillMissing(item, file); }} /></label>{candidates.length > 0 && <span className="asset-link"><select className="input" disabled={busy} value={target} aria-label="选择已有素材" onChange={e => { const value = e.currentTarget.value; setLinked(current => ({ ...current, [item.path]: value })); }}><option value="">关联到已有素材…</option>{candidates.map(asset => <option key={asset.path} value={asset.path}>{asset.displayName ?? asset.name}</option>)}</select><button className="button subtle" disabled={busy || !target} onClick={() => { if (target) linkMissing(item, target); }}>关联</button></span>}</div></li>;
    })}</ul> : <p className="hint">没有缺失的素材文件。</p>)}

    {group === 'duplicate' && (usage?.duplicates.length ? <ul className="asset-list">{usage.duplicates.map(grouped => <li key={grouped.hash}><div><b>{grouped.paths.length} 份相同文件</b> · 每份 {bytesText(grouped.bytes)}<div className="hint">{grouped.paths.join('、')}</div></div><div className="asset-actions"><button className="button subtle" disabled={busy} onClick={() => unify(grouped.paths)}>统一为一份</button></div></li>)}</ul> : <p className="hint">没有重复素材。</p>)}

    {group === 'archived' && (usage?.archived.length ? <ul className="asset-list">{usage.archived.map(item => <li key={item.path}><span><b>{item.displayName ?? item.name}</b> · {bytesText(item.bytes)}</span><div className="asset-actions"><button className="button subtle" disabled={busy} onClick={() => mutate(async () => { await api('PATCH', { path: item.path, action: 'restore' }); return '已恢复素材，可在全部素材中重新引用'; })}>恢复</button><button className="button danger" disabled={busy} onClick={() => mutate(async () => { if (!confirm('彻底删除后无法恢复，确定继续吗？')) throw new Error('已取消'); await api('PATCH', { path: item.path, action: 'purge', confirm: true }); return '已彻底删除素材'; })}>彻底删除</button></div></li>)}</ul> : <p className="hint">归档区是空的。替换掉的旧素材会先放在这里。</p>)}
  </section>;
}
