'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  estimateSummary,
  formatBytes,
  formatDuration,
  type EstimateFinding,
  type PlanReasonSummary,
  type RenderEstimate,
  type RenderPlan,
} from '@m2v/schema';
import { cacheHint, confidenceLabels, encoderLabel, freeDiskLabel, levelLabels, reasonSegments, workerLabel } from '@/lib/render-estimate-view';

export type RenderEstimatePayload = {
  projectId: string;
  preset: 'full' | 'draft';
  plan: RenderPlan;
  estimate: RenderEstimate;
  reasons: PlanReasonSummary[];
  worker: { online: boolean; busy: boolean; encoder: string | null; ageMs: number | null; resources?: { cpuPercent?: number | null; memoryAvailableBytes?: number; memoryTotalBytes?: number; workerRssBytes?: number } };
  cache: { segments: number; bytes: number };
  samples: number;
};

/** Presentational half of the panel; the fetching half lives below so this part stays testable. */
export function RenderEstimateBody({ payload, preset }: { payload: RenderEstimatePayload; preset: 'full' | 'draft' }) {
  const findings: EstimateFinding[] = payload.estimate.findings;
  const danger = payload.estimate.danger === true;
  const willRender = payload.reasons.filter(reason => reason.count > 0);
  const hint = cacheHint(payload.cache, payload.plan);
  return (
    <div className={`render-estimate-body${danger ? ' render-estimate-danger' : ''}`}>
      <div className="render-estimate-head">
        <b>渲染前估算</b>
        <span>{preset === 'draft' ? '540p 草稿' : '成片'}</span>
      </div>
      <p className="render-estimate-summary">{estimateSummary(payload.estimate, payload.plan)}</p>
      <div className="render-estimate-stats">
        <span>预计耗时<b>{formatDuration(payload.estimate.totalDurationSeconds)}</b></span>
        <span>画面渲染<b>{formatDuration(payload.estimate.renderSeconds)}</b></span>
        <span>片段复用<b>{`${payload.plan.reusedCount} / ${payload.plan.segments.length}`}</b></span>
        <span>需要空间<b>{formatBytes(payload.estimate.diskNeedBytes)}</b></span>
        <span>可用空间<b>{freeDiskLabel(payload.estimate.freeDiskBytes)}</b></span>
        <span>编码<b>{encoderLabel(payload.worker.encoder)}</b></span>
        <span>估算可信度<b>{confidenceLabels[payload.estimate.confidence]}</b></span>
        <span>Worker<b>{workerLabel(payload.worker)}</b></span>
        {typeof payload.worker.resources?.cpuPercent === 'number' ? <span>当前系统 CPU<b>{payload.worker.resources.cpuPercent}%</b></span> : null}
        {typeof payload.worker.resources?.memoryAvailableBytes === 'number' ? <span>当前可用内存<b>{formatBytes(payload.worker.resources.memoryAvailableBytes)} / {formatBytes(payload.worker.resources.memoryTotalBytes ?? 0)}</b></span> : null}
        {typeof payload.worker.resources?.workerRssBytes === 'number' ? <span>Worker 内存<b>{formatBytes(payload.worker.resources.workerRssBytes)}</b></span> : null}
      </div>
      {willRender.length ? (
        <ul className="render-estimate-reasons">
          {willRender.map(reason => (
            <li key={reason.code} className={reason.code === 'new' ? 'new' : 'changed'}>
              <b>{`${reason.label} · ${reason.count} 个`}</b>
              <span>{reasonSegments(reason)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {findings.length ? (
        <ul className="render-estimate-findings">
          {findings.map((finding, index) => (
            <li key={`${finding.code}-${index}`} className={`finding-${finding.level}`}>
              <b>{levelLabels[finding.level]}</b>
              <span>{finding.message}{finding.hint ? <em>{finding.hint}</em> : null}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}


/**
 * Pre-render assessment: which segments can be reused, how long the render will
 * take and whether there is room for it. Mirrors the server-side gate, which
 * refuses to queue a render that would run out of disk.
 */
export function RenderEstimatePanel({ projectId, preset, refreshKey = 0, disabled = false }: { projectId: string; preset: 'full' | 'draft'; refreshKey?: number; disabled?: boolean }) {
  const [payload, setPayload] = useState<RenderEstimatePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/render-estimate?preset=${preset}`, { cache: 'no-store' });
      const data = await response.json().catch(() => ({})) as RenderEstimatePayload & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `无法估算渲染成本（HTTP ${response.status}）`);
      setPayload(data);
      setError('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '无法估算渲染成本'); }
    finally { setLoading(false); }
  }, [projectId, preset]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  return (
    <section className="render-estimate" aria-live="polite">
      <header className="render-estimate-head">
        <b>渲染前估算</b>
        <span>{preset === 'draft' ? '540p 草稿' : '成片'}</span>
        <button className="text-button" disabled={loading || disabled} onClick={() => void load()}>{loading ? '估算中…' : '重新估算'}</button>
      </header>
      {error ? <p className="error-text">{error}</p> : null}
      {!payload && !error && loading ? <p className="hint">正在统计可复用的片段与磁盘空间…</p> : null}
      {payload ? <RenderEstimateBody payload={payload} preset={preset} /> : null}
    </section>
  );
}
