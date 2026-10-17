'use client';

import type { PreflightIssue, PreflightResult, PreflightSeverity } from '@m2v/schema';
import { preflightCodeLabels, preflightFixLabels, preflightSeverityLabels } from '@m2v/schema';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
const order: PreflightSeverity[] = ['error', 'warning', 'info'];

type Props = {
  data: PreflightResult | null;
  loading: boolean;
  error: string;
  allowIssues: boolean;
  onAllowChange: (value: boolean) => void;
  onRefresh: () => void;
  onFix: (issue: PreflightIssue) => void;
};

/** Delivery check shown on the export tab: what would break the video, and where to fix it. */
export function PreflightPanel({ data, loading, error, allowIssues, onAllowChange, onRefresh, onFix }: Props) {
  const grouped = order.map(severity => ({ severity, issues: data?.issues.filter(issue => issue.severity === severity) ?? [] })).filter(group => group.issues.length);
  return (
    <section className="settings-card preflight-panel">
      <div className="preflight-head">
        <div>
          <h3>导出前检查</h3>
          <p className="hint">检查缺失素材、未生成的语音、字幕溢出和时长，避免重复导出。</p>
        </div>
        <button className="button subtle" disabled={loading} onClick={onRefresh}>{loading ? '检查中…' : '重新检查'}</button>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {data && (
        <>
          <div className="export-summary preflight-summary">
            <span>预计时长<b>{clock(data.estimatedSeconds)}</b></span>
            <span>分辨率<b>{data.width} × {data.height}</b></span>
            <span>导出类型<b>{data.preset === 'draft' ? '540p 草稿' : '1080p 成片'}</b></span>
            <span>问题<b>{data.blocking} 错误 / {data.warnings} 警告</b></span>
          </div>
          {!grouped.length && <p className="hint" role="status">没有发现需要处理的问题，可以直接导出。</p>}
          {grouped.map(group => (
            <div className="preflight-group" key={group.severity}>
              <p className={`preflight-group-title severity-${group.severity}`}>{preflightSeverityLabels[group.severity]}（{group.issues.length}）</p>
              <ul className="preflight-list">
                {group.issues.map((issue, index) => (
                  <li key={`${issue.code}-${issue.sceneIndex ?? 'project'}-${index}`} className={`preflight-item severity-${issue.severity}`}>
                    <div className="preflight-copy">
                      <b>{preflightCodeLabels[issue.code]}</b>
                      <span>{issue.message}</span>
                    </div>
                    <button className="text-button" onClick={() => onFix(issue)}>
                      {issue.sceneIndex === undefined ? preflightFixLabels[issue.fix] : '定位场景'}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {data.blocking > 0 && (
            <label className="preflight-confirm">
              <input type="checkbox" checked={allowIssues} onChange={event => onAllowChange(event.currentTarget.checked)} />
              我已确认上述 {data.blocking} 个错误，仍要导出（成片可能出现缺图、静音或字幕被裁切）
            </label>
          )}
        </>
      )}
    </section>
  );
}
