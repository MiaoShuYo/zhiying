'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  formatElapsed,
  isActiveTask,
  renderRetryLabels,
  retryLabels,
  retryRequest,
  shouldShowChapterProgress,
  shouldShowTaskPercent,
  taskKindLabels,
  taskStatusLabels,
  type ChapterTask,
  type FailureInfo,
  type RenderRecovery,
  type RenderRetryMode,
  type RetryMode,
} from '@/lib/task-actions';
import { formatBytes } from '@m2v/schema';
import type { PreflightIssue } from '@m2v/schema';

export type TaskRenderPlan = { preset: 'draft' | 'full'; segments: number; reused: number; rendered: number; renderedSeconds: number; totalSeconds: number };

export type TaskEntry = {
  id: string;
  projectId: string;
  projectName: string;
  projectStatus: string;
  kind: string;
  status: string;
  stage: string;
  stageLabel?: string | null;
  failedStage?: string | null;
  failedStageLabel?: string | null;
  failureCode?: string | null;
  failureCodeHint?: string | null;
  attempt: number;
  percent?: number;
  /** Render stages report stage-local progress; this is the overall bar value. */
  overallPercent?: number;
  message: string | null;
  error: string | null;
  startedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  retryMode: RetryMode | null;
  failure?: FailureInfo | null;
  chapters?: ChapterTask[];
  confirmed?: boolean;
  logUrl?: string | null;
  plan?: TaskRenderPlan | null;
  cachedSegments?: number;
  recovery?: RenderRecovery | null;
  orphanOutput?: { bytes: number } | null;
};

type Payload = { tasks: TaskEntry[]; active: number };

const statusFilters = [{ value: '', label: '全部状态' }, { value: 'active', label: '进行中' }, { value: 'failed', label: '失败' }, { value: 'completed', label: '已完成' }];
const kindFilters = [{ value: '', label: '全部类型' }, { value: 'storyboard', label: '长文生成' }, { value: 'tts', label: '语音生成' }, { value: 'render', label: '视频渲染' }];

type TaskFailure = Error & { issues?: PreflightIssue[]; blocking?: number };

async function sendTask(request: { url: string; method: string; body?: Record<string, unknown> }) {
  const response = await fetch(request.url, { method: request.method, ...(request.body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.body) } : {}) });
  const data = await response.json().catch(() => ({})) as { error?: string; issues?: PreflightIssue[]; blocking?: number };
  if (!response.ok) {
    // A refused render retry carries the preflight issues so they can be shown here.
    const failure = new Error(data.error ?? `请求失败（${response.status}）`) as TaskFailure;
    if (data.issues?.length) { failure.issues = data.issues; failure.blocking = data.blocking; }
    throw failure;
  }
}

function Status({ task }: { task: TaskEntry }) {
  return (
    <span className="task-status-group">
      {isActiveTask(task.status) && task.stageLabel ? <span className="task-stage">{task.stageLabel}</span> : null}
      <span className={`task-status task-status-${task.status}`}>{taskStatusLabels[task.status] ?? task.status}</span>
    </span>
  );
}

/** Log drawer: the worker's per-job log file, tailed through the API. */
function TaskLogs({ task, onClose }: { task: TaskEntry; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [meta, setMeta] = useState({ exists: false, bytes: 0, diagnostic: false });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const active = isActiveTask(task.status);
  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(task.id)}/logs?tail=200`, { cache: 'no-store' });
      const data = await response.json().catch(() => ({})) as { lines?: string[]; exists?: boolean; bytes?: number; diagnostic?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error ?? '无法读取日志');
      setLines(data.lines ?? []);
      setMeta({ exists: data.exists ?? false, bytes: data.bytes ?? 0, diagnostic: data.diagnostic ?? false });
      setError('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '无法读取日志'); }
    finally { setLoading(false); }
  }, [task.id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [active, load]);
  return (
    <div className="task-logs" role="region" aria-label="任务日志">
      <div className="task-logs-head">
        <b>任务日志</b>
        <span>{meta.exists ? `${lines.length} 行 · ${formatBytes(meta.bytes)}` : meta.diagnostic ? '系统诊断信息' : '暂无日志文件'}</span>
        <button className="text-button" disabled={loading} onClick={() => void load()}>{loading ? '读取中…' : '刷新'}</button>
        <button className="text-button" onClick={onClose}>收起日志</button>
      </div>
      {error
        ? <p className="task-error">{error}</p>
        : meta.exists
          ? <pre className="task-logs-body">{lines.length ? lines.join('\n') : '（日志文件已创建，还没有内容）'}</pre>
          : lines.length ? <pre className="task-logs-body">{lines.join('\n')}</pre> : <p className="task-hint">Worker 还没有写入日志；渲染开始后会在这里出现逐阶段的输出。</p>}
    </div>
  );
}

/** One row: what ran, how far it got, why it stopped and how to continue it. */
export function TaskCard({ task, onChange, compact = false }: { task: TaskEntry; onChange: () => void | Promise<void>; compact?: boolean }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState<{ blocking: number; issues: PreflightIssue[] } | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const active = isActiveTask(task.status);
  const isRender = task.kind === 'render';
  // Failed task progress is only an attempt-local counter. A checkpoint may be
  // rejected after its source or model changes, so it must not be presented as
  // a promise that those chapters are safely resumable.
  const showChapterProgress = Boolean(task.chapters?.length && shouldShowChapterProgress(task.status));
  const bar = task.overallPercent ?? task.percent;
  const since = new Date(task.startedAt ?? task.createdAt).getTime();
  const run = async (mode: RetryMode, options: { allowIssues?: boolean; renderMode?: RenderRetryMode } = {}) => {
    const request = retryRequest(mode, { projectId: task.projectId, jobId: task.id, allowIssues: options.allowIssues, renderMode: options.renderMode });
    if (!request) { setError('这条任务没有可用的恢复入口'); return; }
    const key = options.renderMode ? `${mode}:${options.renderMode}` : mode;
    setBusy(key); setError(''); setBlocked(null);
    try { await sendTask(request); await onChange(); }
    catch (failure) {
      const details = failure as TaskFailure;
      // A refused render retry has already run the export check; show what blocked it.
      if (details.issues?.length) setBlocked({ blocking: details.blocking ?? details.issues.length, issues: details.issues });
      else setError(failure instanceof Error ? failure.message : '操作失败');
    }
    finally { setBusy(''); }
  };
  const pending = task.chapters?.filter(item => !item.done).length ?? 0;
  return (
    <article className={`task-card${compact ? ' task-card-compact' : ''}${task.status === 'failed' ? ' task-card-failed' : ''}`}>
      <div className="task-card-head">
        <div className="task-card-title">
          <b>{taskKindLabels[task.kind] ?? task.kind}</b>
          <Link href={`/project/${task.projectId}`} className="task-project">{task.projectName}</Link>
          {task.attempt > 1 && <span className="task-attempt">第 {task.attempt} 次</span>}
          {task.confirmed && <span className="task-attempt">已确认风险导出</span>}
        </div>
        <Status task={task} />
      </div>
      <div className="task-card-body">
        <p className="task-message">
          {active
            ? task.message ?? `${taskStatusLabels[task.status] ?? task.status}…`
            : task.failure
              ? task.failure.title
              : task.error
                ? task.error
                : task.status === 'completed' ? '已完成' : task.message ?? '已停止'}
        </p>
        {!active && task.failure && (
          <div className="task-failure" role="status">
            <p className="task-failure-detail">{task.failure.detail}</p>
            <p className="task-hint">{task.failure.hint}</p>
            {task.failureCodeHint ? <p className="task-hint">{task.failureCodeHint}</p> : null}
            {task.recovery ? <p className="task-hint">继续方式：{renderRetryLabels[task.recovery.kind]}——{task.recovery.hint}</p> : null}
            {task.orphanOutput ? <p className="task-hint">上次中断留下 {formatBytes(task.orphanOutput.bytes)} 的未完成视频，重新渲染成功后会一并清理。</p> : null}
          </div>
        )}
        {typeof bar === 'number' && active && (
          <div className="task-progress"><span style={{ width: `${Math.min(100, Math.max(0, bar))}%` }} /></div>
        )}
        <div className="task-meta">
          <span>{active ? `已运行 ${formatElapsed(Date.now() - since)}` : new Date(task.updatedAt).toLocaleString('zh-CN')}</span>
          {showChapterProgress && task.chapters?.length ? <span>{task.chapters.length - pending} / {task.chapters.length} 章完成</span> : null}
          {typeof bar === 'number' && !compact && shouldShowTaskPercent(task.status) ? <span>{bar}%</span> : null}
          {isRender && task.cachedSegments ? <span>可复用片段 {task.cachedSegments} 个</span> : null}
        </div>
        {task.plan ? (
          <div className="task-reuse">
            <span>{task.plan.preset === 'draft' ? '草稿' : '成片'} · 共 {task.plan.segments} 个片段</span>
            <span>复用 {task.plan.reused} 个</span>
            <span>本次渲染 {task.plan.rendered} 个</span>
            {task.plan.renderedSeconds > 0 ? <span>约 {formatElapsed(task.plan.renderedSeconds * 1000)}</span> : null}
          </div>
        ) : null}
        {showChapterProgress && task.chapters?.length ? (
          <ol className="task-chapters">
            {task.chapters.map(chapter => (
              <li key={chapter.index} className={chapter.done ? 'done' : 'pending'} title={chapter.page ? `来源第 ${chapter.page} 页` : undefined}>
                <i>{chapter.done ? '✓' : chapter.index}</i>
                <span>{chapter.title}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      {blocked && (
        <div className="tools-warning task-preflight" role="status">
          <b>导出前检查发现 {blocked.blocking} 个错误</b>
          <ul>{blocked.issues.slice(0, 5).map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.sceneIndex !== undefined ? `场景 ${issue.sceneIndex + 1}：` : ''}{issue.message}</li>)}</ul>
          {blocked.issues.length > 5 && <p className="hint">另有 {blocked.issues.length - 5} 个问题，打开项目可查看完整检查结果。</p>}
        </div>
      )}
      <div className="task-card-actions">
        {blocked ? (
          <>
            <button className="button primary" disabled={!!busy} onClick={() => void run('render', { allowIssues: true, renderMode: task.recovery?.kind })}>{busy.startsWith('render') ? '提交中…' : '确认风险并重新渲染'}</button>
            <button className="text-button" disabled={!!busy} onClick={() => setBlocked(null)}>返回</button>
          </>
        ) : isRender && task.recovery ? (
          <>
            <button className="button primary" disabled={!!busy} onClick={() => void run('render', { renderMode: task.recovery?.kind })}>
              {busy === `render:${task.recovery.kind}` ? '提交中…' : renderRetryLabels[task.recovery.kind]}
            </button>
            {/* Only offer the cold path when the cache can actually carry a retry. */}
            {task.recovery.kind === 'resume' ? (
              <button className="text-button" disabled={!!busy} onClick={() => void run('render', { renderMode: 'restart' })}>
                {busy === 'render:restart' ? '提交中…' : renderRetryLabels.restart}
              </button>
            ) : null}
          </>
        ) : (
          (task.failure?.actions ?? (task.retryMode ? [task.retryMode] : [])).map((mode, index) => (
            <button key={mode} className={index === 0 ? 'button subtle' : 'text-button'} disabled={!!busy} onClick={() => void run(mode)}>
              {busy === mode ? '处理中…' : retryLabels[mode]}
            </button>
          ))
        )}
        {isRender ? <button className="text-button" onClick={() => setShowLogs(value => !value)}>{showLogs ? '收起日志' : '查看日志'}</button> : null}
        <Link className="text-button" href={`/project/${task.projectId}`}>打开项目</Link>
      </div>
      {showLogs && isRender ? <TaskLogs task={task} onClose={() => setShowLogs(false)} /> : null}
      {error && <p className="task-error">{error}</p>}
    </article>
  );
}

/** Compact list embedded in the editor so a failed or running job is never invisible. */
export function ProjectTaskStrip({ projectId }: { projectId: string }) {
  const [tasks, setTasks] = useState<TaskEntry[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/tasks?projectId=${encodeURIComponent(projectId)}&limit=6`, { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json() as Payload;
      setTasks(data.tasks.filter(task => isActiveTask(task.status) || task.status === 'failed'));
    } catch { /* The strip is informational; the task centre shows the failure details. */ }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    if (tasks.some(task => isActiveTask(task.status))) timer.current = setInterval(() => void load(), 4000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load, tasks]);
  if (!tasks.length) return null;
  return (
    <div className="task-strip">
      <div className="task-strip-head"><b>相关任务</b><Link className="text-button" href="/tasks">任务中心 →</Link></div>
      {tasks.map(task => <TaskCard key={task.id} task={task} compact onChange={load} />)}
    </div>
  );
}

export function TaskCenter() {
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [projectId, setProjectId] = useState('');
  const [payload, setPayload] = useState<Payload>({ tasks: [], active: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [recovering, setRecovering] = useState(false);

  const load = useCallback(async () => {
    const query = new URLSearchParams({ limit: '60' });
    if (status) query.set('status', status);
    if (kind) query.set('kind', kind);
    if (projectId) query.set('projectId', projectId);
    try {
      const response = await fetch(`/api/tasks?${query}`, { cache: 'no-store' });
      const data = await response.json() as Payload & { error?: string };
      if (!response.ok) throw new Error(data.error ?? '无法读取任务');
      setPayload({ tasks: data.tasks ?? [], active: data.active ?? 0 });
      setError('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '无法读取任务'); }
    finally { setLoading(false); }
  }, [status, kind, projectId]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useEffect(() => {
    if (!payload.active) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load, payload.active]);
  const recover = async () => {
    setRecovering(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/tasks/recover', { method: 'POST' });
      const data = await response.json() as { resumed?: number; released?: number; pending?: number; error?: string };
      if (!response.ok) throw new Error(data.error ?? '恢复失败');
      const resumed = data.resumed ?? 0;
      const released = data.released ?? 0;
      const pending = data.pending ?? 0;
      const lines = [`已恢复 ${resumed} 个任务，释放 ${released} 个占用`];
      if (pending) lines.push(`另有 ${pending} 个渲染任务在最近 5 分钟内仍有心跳，暂不判定为中断，稍后再检查一次即可`);
      else if (!resumed && !released) lines.push('没有发现需要恢复的任务，当前任务状态正常');
      setNotice(lines.join('；'));
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : '恢复失败'); }
    finally { setRecovering(false); }
  };

  const projects = [...new Map(payload.tasks.map(task => [task.projectId, task.projectName])).entries()];
  return (
    <div className="task-center">
      <div className="task-filters">
        <div className="task-filter-note">
          <b>{payload.active ? `${payload.active} 个任务进行中` : '当前没有进行中的任务'}</b>
          <span>失败的任务可以在这里直接继续，无需回到项目。</span>
        </div>
        <select aria-label="状态筛选" value={status} onChange={event => setStatus(event.target.value)}>
          {statusFilters.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select aria-label="类型筛选" value={kind} onChange={event => setKind(event.target.value)}>
          {kindFilters.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select aria-label="项目筛选" value={projectId} onChange={event => setProjectId(event.target.value)}>
          <option value="">全部项目</option>
          {projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <button className="button subtle" disabled={recovering} onClick={recover}>{recovering ? '检查中…' : '检查中断任务'}</button>
        <button className="text-button" onClick={() => void load()}>刷新</button>
      </div>
      {notice && <p className="notice-box">{notice}</p>}
      {error && <p className="error-box">{error}</p>}
      {loading ? <p className="muted">正在读取任务…</p> : payload.tasks.length ? (
        <div className="task-list">{payload.tasks.map(task => <TaskCard key={task.id} task={task} onChange={load} />)}</div>
      ) : (
        <div className="empty"><div className="empty-icon">◔</div><h3>没有符合条件的任务</h3><p>长文生成、语音生成与视频渲染的进度都会出现在这里。</p></div>
      )}
    </div>
  );
}
