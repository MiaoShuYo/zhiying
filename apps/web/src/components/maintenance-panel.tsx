'use client';
import { useEffect, useState } from 'react';

type StorageAsset = { path: string; name: string; displayName?: string; bytes: number; referenced: boolean };
type StorageTotals = { assets: number; audio: number; output: number; pages: number; source: number; backups: number; total: number };
type StorageReport = { assets: StorageAsset[]; unreferenced: string[]; totals: StorageTotals };

export const formatBytes = (value: number) => value >= 1024 * 1024 * 1024 ? `${(value / 1024 / 1024 / 1024).toFixed(2)} GB` : value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(0, Math.round(value / 1024))} KB`;

const usageLabels: Record<keyof Omit<StorageTotals, 'total'>, string> = { assets: '素材', audio: '语音', output: '导出成片', pages: '抽取页面', source: '源文件', backups: '快照备份' };

/** Disk usage plus the "assets no scene points at" cleanup list. */
export function StoragePanel({ id, disabled, reload }: { id: string; disabled: boolean; reload: () => Promise<void> }) {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await fetch(`/api/projects/${id}/storage`, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '读取占用失败');
    setReport(result);
    setPicked(current => current.filter(path => result.unreferenced.includes(path)));
  }
  useEffect(() => { void load().catch(error => setMessage(String(error))); }, [id]);

  async function clean() {
    if (!picked.length) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/projects/${id}/storage`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: picked }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '清理失败');
      setPicked([]); setMessage(`已清理 ${result.deleted.length} 个素材，释放 ${formatBytes(result.bytes)}`);
      await reload(); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : '清理失败'); }
    finally { setBusy(false); }
  }

  const totals = report?.totals;
  const unreferenced = report?.assets.filter(asset => !asset.referenced) ?? [];
  return <div className="maintenance-panel">
    <h3>空间占用</h3>
    {totals ? <div className="storage-totals">{Object.entries(usageLabels).map(([key, label]) => <span key={key}>{label}<b>{formatBytes(totals[key as keyof typeof usageLabels])}</b></span>)}<span className="storage-total">合计<b>{formatBytes(totals.total)}</b></span></div> : <p className="hint">正在统计…</p>}
    <h3>未被场景引用的素材</h3>
    <p className="hint">这里的文件没有被任何场景、旁白或背景音乐引用，删除前会再校验一次引用关系。</p>
    {unreferenced.length ? <>
      <div className="v11-row"><label><input type="checkbox" checked={picked.length === unreferenced.length} onChange={event => setPicked(event.target.checked ? unreferenced.map(asset => asset.path) : [])} />全选</label><span>已选 {picked.length} 项 · {formatBytes(unreferenced.filter(asset => picked.includes(asset.path)).reduce((sum, asset) => sum + asset.bytes, 0))}</span><button className="button danger" disabled={disabled || busy || !picked.length} onClick={() => { if (confirm(`确认删除 ${picked.length} 个未引用素材？此操作无法撤销。`)) void clean(); }}>{busy ? '清理中…' : '清理所选素材'}</button></div>
      <ul className="storage-list">{unreferenced.map(asset => <li key={asset.path}><label><input type="checkbox" disabled={disabled || busy} checked={picked.includes(asset.path)} onChange={event => setPicked(current => event.target.checked ? [...current, asset.path] : current.filter(path => path !== asset.path))} />{asset.displayName ?? asset.name}</label><span>{formatBytes(asset.bytes)}</span></li>)}</ul>
    </> : <p className="notice-box">没有发现未引用的素材。</p>}
    {message && <p className="hint" role="status">{message}</p>}
  </div>;
}

type VerifyResult = { id: string; ok: boolean; checked: number; bytes: number; missing: string[]; mismatched: string[] };

/** Snapshot check: re-hash every archived file and report anything that drifted. */
export function SnapshotVerifier({ id, snapshotId, disabled }: { id: string; snapshotId: string; disabled: boolean }) {
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function verify() {
    setBusy(true); setError(''); setResult(null);
    try {
      const response = await fetch(`/api/projects/${id}/backups?verify=${snapshotId}`, { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? '校验失败');
      setResult(body);
    } catch (e) { setError(e instanceof Error ? e.message : '校验失败'); }
    finally { setBusy(false); }
  }
  return <span className="snapshot-verify">
    <button className="button subtle" disabled={disabled || busy} onClick={() => void verify()}>{busy ? '校验中…' : '校验'}</button>
    {result && (result.ok ? <span className="verify-ok">完整 · {result.checked} 个文件 · {formatBytes(result.bytes)}</span> : <span className="verify-bad">缺失 {result.missing.length} 个、损坏 {result.mismatched.length} 个文件</span>)}
    {error && <span className="verify-bad">{error}</span>}
  </span>;
}
