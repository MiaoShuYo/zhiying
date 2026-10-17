'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
type Status = 'ok' | 'warn' | 'fail';
type CheckRow = { name: string; status: Status; detail: string; fix: string };
type Summary = { total: number; ok: number; warn: number; fail: number };
export function EnvironmentCheck() {
  const [checks, setChecks] = useState<CheckRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function check() { setBusy(true); setError(''); try { const response = await fetch('/api/environment', { cache: 'no-store' }); if (!response.ok) throw new Error('自检请求失败'); const payload = await response.json(); setChecks(payload.checks); setSummary(payload.summary ?? null); } catch (error) { setError(String(error)); } finally { setBusy(false); } }
  useEffect(() => { void check(); }, []);
  return <main className="shell"><header className="topbar"><Link href="/" className="brand">知影 · 环境自检</Link><button className="button primary" disabled={busy} onClick={check}>{busy ? '检查中…' : '重新检查'}</button></header><p>检查本机服务和模型可用性。根据下方提示修复后重新检查。</p>{error && <p role="alert">{error}</p>}{summary && <p className="check-summary">{summary.ok} 项正常{summary.warn ? ` · ${summary.warn} 项警告` : ''}{summary.fail ? ` · ${summary.fail} 项失败` : ''}</p>}{checks.map(check => <section className="settings-card" key={check.name}><h3>{check.status === 'ok' ? '✓' : check.status === 'warn' ? '⚠' : '✕'} {check.name}</h3><p style={{ overflowWrap: 'anywhere' }}>{check.detail}</p>{check.status !== 'ok' && <p>{check.fix}</p>}</section>)}</main>;
}
