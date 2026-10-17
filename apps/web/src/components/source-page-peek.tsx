'use client';
import { useEffect, useMemo, useState } from 'react';
import { normalizePageInfo, pageBody, pageMethodLabel, pageQualityLabel, type ExtractionMeta } from '@/lib/extraction';

type SourcePayload = { sourceText?: string; extraction?: ExtractionMeta | null };

/** Read-only source page opened from a storyboard scene card, so a scene can be traced back to its page. */
export function SourcePagePeek({ id, page, onClose }: { id: string; page: number; onClose: () => void }) {
  const [payload, setPayload] = useState<SourcePayload | null>(null);
  const [error, setError] = useState('');
  const [active, setActive] = useState(page);
  useEffect(() => { setActive(page); }, [page]);
  useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        const response = await fetch(`/api/projects/${id}/source`, { cache: 'no-store' });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? '读取来源失败');
        if (!stopped) setPayload(result);
      } catch (error) { if (!stopped) setError(error instanceof Error ? error.message : '读取来源失败'); }
    })();
    return () => { stopped = true; };
  }, [id]);
  const view = useMemo(() => pageBody(payload?.sourceText ?? '', active), [payload, active]);
  const info = useMemo(() => normalizePageInfo(payload?.extraction).find(row => row.page === active), [payload, active]);
  const position = view.pages.indexOf(active);
  return <div className="modal-backdrop" role="presentation" onClick={onClose}>
    <section className="modal source-peek" role="dialog" aria-label={`来源第 ${active} 页`} onClick={event => event.stopPropagation()}>
      <button className="modal-close" onClick={onClose} aria-label="关闭来源页">×</button>
      <p className="eyebrow">SOURCE PAGE</p>
      <h2>来源第 {active} 页</h2>
      {info && <p className="hint">{pageMethodLabel(info.method)} · {pageQualityLabel(info.quality)} · {info.chars} 字{info.error ? ` · ${info.error}` : ''}</p>}
      {error && <p role="alert">{error}</p>}
      {!payload && !error && <p className="hint">正在读取来源正文…</p>}
      {payload && !view.pages.length && <p className="hint" role="status">这份来源没有分页标记，下面显示完整正文。</p>}
      {payload && view.missing && <p className="tools-warning" role="status">来源中已经没有第 {page} 页，可能重新抽取后页数减少了。</p>}
      {payload && <pre className="source-raw">{view.body || '（该页没有正文）'}</pre>}
      <div className="v11-row source-peek-nav">
        <button className="button subtle" disabled={position < 1} onClick={() => setActive(view.pages[position - 1])}>上一页</button>
        {view.pages.length > 1 && position >= 0 && <select className="input" aria-label="选择来源页" value={active} onChange={event => setActive(Number(event.target.value))}>{view.pages.map(item => <option key={item} value={item}>第 {item} 页</option>)}</select>}
        <button className="button subtle" disabled={position < 0 || position >= view.pages.length - 1} onClick={() => setActive(view.pages[position + 1])}>下一页</button>
        <span className="hint">{view.pages.length ? (position >= 0 ? `第 ${position + 1} / ${view.pages.length} 页` : `共 ${view.pages.length} 页`) : '单页正文'}</span>
        <button className="button subtle" onClick={onClose}>关闭</button>
      </div>
    </section>
  </div>;
}
