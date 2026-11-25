'use client';
import { useEffect, useState } from 'react';
import { pageMethodLabel, pageQualityLabel, reviewPages, type PageInfo } from '@/lib/extraction';

/** #299: `/source/pages` accepts at most this many pages per request. */
export const RERUN_BATCH_PAGES = 50;

export function rerunBatches(pages: number[], size = RERUN_BATCH_PAGES): number[][] {
  const batches: number[][] = [];
  for (let start = 0; start < pages.length; start += size) batches.push(pages.slice(start, start + size));
  return batches;
}

type RerunResult = { pages: PageInfo[]; sourceText: string; ocrPages: number[]; failedPages: { page: number; error: string }[]; staleScenes: { id: string; title: string; sourcePage: number }[] };

/**
 * Per-page extraction review. Only the selected pages are re-extracted, so a
 * single bad scan never forces a full re-import of the document.
 */
export function PageReview({ id, kind, pageInfo, disabled, dirty, onUpdated, onBusyChange }: {
  id: string;
  kind?: string;
  pageInfo: PageInfo[];
  disabled: boolean;
  dirty: boolean;
  onUpdated: (result: RerunResult) => void;
  /** #287: lets the source editor lock editing and submission while pages are re-extracted. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  useEffect(() => { onBusyChange?.(busy); }, [busy]);
  const failed = pageInfo.filter(page => page.error).map(page => page.page);
  const needsReview = reviewPages(pageInfo);
  async function rerun(pages: number[], forceOcr: boolean) {
    if (!pages.length) return;
    setBusy(true); setError(''); setMessage('');
    // #299: scanned PDFs can have 51+ pages to review, so pages go out in sequential batches of at
    // most 50. Each finished batch is applied immediately; a failure stops and reports what is left.
    const done: number[] = [];
    const again: number[] = [];
    try {
      for (const batch of rerunBatches(pages)) {
        const response = await fetch(`/api/projects/${id}/source/pages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pages: batch, forceOcr }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? '重跑失败');
        onUpdated(result as RerunResult);
        done.push(...batch);
        again.push(...(result.pages as PageInfo[]).filter(page => page.error).map(page => page.page));
      }
      const label = pages.length > 10 ? `${pages.length} 页` : `第 ${pages.join('、')} 页`;
      setMessage(`已重跑${label}${again.length ? `；第 ${again.join('、')} 页仍然失败` : '，其余页面未改动'}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : '重跑失败';
      const left = pages.filter(page => !done.includes(page));
      setError(done.length ? `已完成 ${done.length} 页，其余 ${left.length} 页重跑失败：${reason}` : reason);
    }
    finally { setBusy(false); }
  }
  if (kind !== 'pdf') return null;
  const blocked = disabled || busy;
  return <div className="page-review">
    <div className="v11-row page-review-head">
      <b>逐页抽取状态</b>
      <span className="hint">共 {pageInfo.length} 页需要复核 {needsReview.length} 页</span>
      <button className="button subtle" disabled={blocked || dirty || !needsReview.length} onClick={() => void rerun(needsReview, false)}>重跑需复核的 {needsReview.length} 页</button>
      <button className="button subtle" disabled={blocked || dirty || !failed.length} onClick={() => void rerun(failed, true)}>强制 OCR 重跑失败页</button>
    </div>
    {dirty && <p className="hint" role="status">正文有未提交的修改，请先提交当前内容再重跑单页，否则本次编辑会被覆盖。</p>}
    {error && <p role="alert">{error}</p>}
    {message && <p className="hint" role="status">{message}</p>}
    <div className="page-review-list">
      {pageInfo.map(page => <article key={page.page} className={`page-review-row ${page.error ? 'failed' : page.quality}`}>
        <b>第 {page.page} 页</b>
        <span className={`page-badge method-${page.method}`}>{pageMethodLabel(page.method)}</span>
        <span className={`page-badge quality-${page.quality}`}>{pageQualityLabel(page.quality)}</span>
        <span className="page-chars">{page.chars} 字{page.tables ? ` · 表格 ${page.tables}` : ''}{page.images ? ` · 图片 ${page.images}` : ''}</span>
        <button className="button subtle" disabled={blocked || dirty} onClick={() => void rerun([page.page], false)}>重跑</button>
        <button className="button subtle" disabled={blocked || dirty || page.method === 'ocr'} onClick={() => void rerun([page.page], true)}>强制 OCR</button>
        {page.error && <p className="caption-problem">提取失败：{page.error}</p>}
        {page.warnings.length > 0 && <ul className="page-warnings">{page.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      </article>)}
    </div>
  </div>;
}
