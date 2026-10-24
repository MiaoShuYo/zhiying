'use client';

import { useMemo, useState } from 'react';
import type { PreflightCategory, PreflightFix, PreflightGap, PreflightResult, PreflightSeverity } from '@m2v/schema';
import {
  preflightCategoryLabels,
  preflightCategoryOf,
  preflightCodeLabels,
  preflightDelta,
  preflightFixLabels,
  preflightGapCounts,
  preflightGaps,
  preflightSeverityLabels,
} from '@m2v/schema';

/** `m:ss` for short videos; long projects get `h:mm:ss` so a 12-hour render cannot read as `756:12`. */
const clock = (seconds: number) => {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${Math.floor(total / 60)}:${pad(rest)}`;
};
const order: PreflightSeverity[] = ['error', 'warning', 'info'];

/** Enough of an issue to jump to the place that fixes it. */
export type PreflightTarget = { fix: PreflightFix; sceneIndex?: number };

type Props = {
  data: PreflightResult | null;
  /** The result before the last re-check, so the panel can report what changed. */
  previous: PreflightResult | null;
  loading: boolean;
  error: string;
  allowIssues: boolean;
  onAllowChange: (value: boolean) => void;
  onRefresh: () => void;
  onFix: (issue: PreflightTarget) => void;
  onLocateScene: (sceneIndex: number) => void;
};

/** Delivery check shown on the export tab: what would break the video, and where to fix it. */
export function PreflightPanel({ data, previous, loading, error, allowIssues, onAllowChange, onRefresh, onFix, onLocateScene }: Props) {
  const [filter, setFilter] = useState<PreflightCategory | 'all'>('all');
  const gaps = useMemo(() => (data ? preflightGaps(data) : []), [data]);
  const gapCounts = useMemo(() => preflightGapCounts(gaps), [gaps]);
  // Missing files stay first: they block the export, subtitle warnings only affect legibility.
  const gapSections: { title: string; gaps: PreflightGap[] }[] = [
    { title: '缺失语音、图片与素材文件', gaps: gaps.filter(gap => gap.kind !== 'subtitle') },
    { title: '字幕时间轴问题', gaps: gaps.filter(gap => gap.kind === 'subtitle') },
  ];
  const delta = useMemo(() => (data ? preflightDelta(previous, data) : null), [data, previous]);
  const counts = useMemo(() => {
    const result = new Map<PreflightCategory, number>();
    for (const issue of data?.issues ?? []) {
      const category = preflightCategoryOf(issue);
      result.set(category, (result.get(category) ?? 0) + 1);
    }
    return result;
  }, [data]);
  const issues = (data?.issues ?? []).filter(issue => filter === 'all' || preflightCategoryOf(issue) === filter);
  const grouped = order.map(severity => ({ severity, issues: issues.filter(issue => issue.severity === severity) })).filter(group => group.issues.length);

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
            <span>缺失文件<b>{gapCounts.files}</b></span>
            {gapCounts.subtitles > 0 && <span>字幕问题<b>{gapCounts.subtitles}</b></span>}
          </div>
          {delta && (delta.fixed > 0 || delta.added > 0) && (
            <p className="preflight-delta" role="status">
              与上次检查相比：修复 {delta.fixed} 项，新增 {delta.added} 项，剩余 {delta.remaining} 项。
            </p>
          )}
          {gapSections.map(section => section.gaps.length > 0 && (
            <div className="preflight-gaps" key={section.title}>
              <p className="preflight-group-title">{section.title}（{section.gaps.length}）</p>
              <ul className="preflight-list">
                {section.gaps.map(gap => (
                  <li key={gap.key} className={`preflight-item severity-${gap.severity}`}>
                    <div className="preflight-copy">
                      <b>{gap.label}{gap.path ? ` · ${gap.path.split('/').at(-1)}` : ''}</b>
                      <span>{gap.path ?? gap.message}</span>
                      <div className="preflight-scenes">
                        {gap.scenes.length
                          ? gap.scenes.map(scene => (
                            <button className="text-button" key={scene.sceneIndex} onClick={() => onLocateScene(scene.sceneIndex)}>
                              场景 {scene.sceneIndex + 1}{scene.sceneTitle ? ` · ${scene.sceneTitle}` : ''}
                            </button>
                          ))
                          : <span className="hint">项目级</span>}
                      </div>
                    </div>
                    <button className="text-button" onClick={() => onFix({ fix: gap.fix, sceneIndex: gap.scenes[0]?.sceneIndex })}>
                      {preflightFixLabels[gap.fix]}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="preflight-filters">
            <button className={`preflight-chip ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>全部（{data.issues.length}）</button>
            {[...counts.entries()].map(([category, count]) => (
              <button className={`preflight-chip ${filter === category ? 'active' : ''}`} key={category} onClick={() => setFilter(category)}>
                {preflightCategoryLabels[category]}（{count}）
              </button>
            ))}
          </div>
          {!grouped.length && <p className="hint" role="status">{data.issues.length ? '当前筛选没有问题。' : '没有发现需要处理的问题，可以直接导出。'}</p>}
          {grouped.map(group => (
            <div className="preflight-group" key={group.severity}>
              <p className={`preflight-group-title severity-${group.severity}`}>{preflightSeverityLabels[group.severity]}（{group.issues.length}）</p>
              <ul className="preflight-list">
                {group.issues.map((issue, index) => (
                  <li key={`${issue.code}-${issue.sceneIndex ?? 'project'}-${index}`} className={`preflight-item severity-${issue.severity}`}>
                    <div className="preflight-copy">
                      <b>
                        {preflightCodeLabels[issue.code]}
                        {issue.sceneIndex !== undefined ? ` · 场景 ${issue.sceneIndex + 1}` : ''}
                        {issue.sceneTitle ? ` · ${issue.sceneTitle}` : ''}
                      </b>
                      <span>{issue.message}</span>
                    </div>
                    <button className="text-button" onClick={() => onFix({ fix: issue.fix, sceneIndex: issue.sceneIndex })}>
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
