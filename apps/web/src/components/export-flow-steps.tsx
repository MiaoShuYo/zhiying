'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ExportFlow, ExportStep, ExportStepAction } from '@m2v/schema';

const stateLabels: Record<ExportStep['state'], string> = {
  pending: '待执行',
  running: '进行中',
  passed: '已通过',
  failed: '失败',
  blocked: '待处理',
};

const actionLabels: Record<ExportStepAction, string> = {
  check: '重新检查',
  render: '开始导出',
  validate: '校验成片',
  package: '生成交付包',
};

const when = (at?: string) => {
  if (!at) return '';
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
};

type Props = {
  id: string;
  preset: 'full' | 'draft';
  busy: boolean;
  allowIssues: boolean;
  /** Bumped by the parent whenever an export record may have changed. */
  refreshKey: number;
  onCheck: () => void;
  onRender: () => void;
  onDone: (message: string) => void;
};

/** 检查 → 渲染 → 校验 → 打包：each step records its own outcome, and a retry resumes there. */
export function ExportFlowSteps({ id, preset, busy, allowIssues, refreshKey, onCheck, onRender, onDone }: Props) {
  const [flow, setFlow] = useState<ExportFlow | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState<ExportStepAction | null>(null);
  const [nonce, setNonce] = useState(0);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${id}/export-flow?preset=${preset}`, { cache: 'no-store' });
      const result = await response.json() as ExportFlow & { jobId?: string | null; error?: string };
      if (!response.ok) throw new Error(result.error ?? '无法读取导出步骤');
      setFlow({ steps: result.steps, resumeFrom: result.resumeFrom, passed: result.passed, canExport: result.canExport, headline: result.headline });
      setJobId(result.jobId ?? null);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法读取导出步骤');
    }
  }, [id, preset]);

  useEffect(() => { void load(); }, [load, refreshKey, nonce]);

  async function run(action: ExportStepAction) {
    if (busy || running) return;
    if (action === 'check') { onCheck(); return; }
    if (action === 'render') { onRender(); return; }
    if (!jobId) { onDone('还没有可用的导出记录，先导出成片'); return; }
    setRunning(action);
    try {
      const response = action === 'validate'
        ? await fetch(`/api/projects/${id}/exports/${jobId}/validate`, { method: 'POST' })
        : await fetch(`/api/projects/${id}/delivery`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? (action === 'validate' ? '校验失败' : '打包失败'));
      onDone(action === 'validate' ? '成片校验已完成' : '交付包已生成');
    } catch (failure) {
      onDone(failure instanceof Error ? failure.message : '操作失败');
    } finally {
      setRunning(null);
      setNonce(value => value + 1);
    }
  }

  const current = flow?.resumeFrom ?? null;
  const currentStep = flow?.steps.find(item => item.key === current) ?? null;
  const blocked = currentStep?.state === 'blocked';
  const actionDisabled = (action: ExportStepAction) => Boolean(busy || running)
    || (action === 'render' && blocked && !allowIssues)
    || ((action === 'validate' || action === 'package') && !jobId);

  return (
    <section className="settings-card export-flow" aria-label="导出步骤">
      <div className="export-flow-head">
        <div>
          <h3>导出步骤</h3>
          <p className="hint">{flow?.headline ?? '正在读取导出步骤…'}</p>
        </div>
        {currentStep && (
          <button className={`button ${currentStep.key === 'render' ? 'subtle' : 'primary'}`} disabled={actionDisabled(currentStep.action)} onClick={() => void run(currentStep.action)}>
            {running === currentStep.action ? '执行中…' : currentStep.state === 'failed' ? `从${currentStep.label}继续` : actionLabels[currentStep.action]}
          </button>
        )}
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      <ol className="export-flow-steps">
        {(flow?.steps ?? []).map((step, index) => (
          <li className={`export-flow-step ${step.state} ${step.key === current ? 'current' : ''}`} key={step.key}>
            <span className="export-flow-index" aria-hidden="true">{step.state === 'passed' ? '✓' : index + 1}</span>
            <span className="export-flow-copy">
              <b>{step.label}<em className={`export-flow-state ${step.state}`}>{stateLabels[step.state]}</em></b>
              <small>{step.message}{when(step.at) ? `（${when(step.at)}）` : ''}</small>
            </span>
          </li>
        ))}
      </ol>
      {blocked && (
        <p className="hint">
          先在上方的「导出前检查」处理缺失项；处理完点「重新检查」，通过后即可直接从渲染继续，已通过的步骤不会重做。
        </p>
      )}
    </section>
  );
}
