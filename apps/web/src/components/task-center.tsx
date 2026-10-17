'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatElapsed, isActiveTask, retryLabels, retryRequest, taskKindLabels, taskStatusLabels, type ChapterTask, type RetryMode } from '@/lib/task-actions';
import type { PreflightIssue } from '@m2v/schema';

export type TaskEntry = {
  id: string;
  projectId: string;
  projectName: string;
  projectStatus: string;
  kind: string;
  status: string;
  stage: string;
  attempt: number;
  percent?: number;
  message: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  retryMode: RetryMode | null;
  chapters?: ChapterTask[];
  confirmed?: boolean;
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
  return <span className={`task-status task-status-${task.status}`}>{taskStatusLabels[task.status] ?? task.status}</span>;
}

/** One row: what ran, how far it got, why it stopped and how to continue it. */
export function TaskCard({ task, onChange, compact = false }: { task: TaskEntry; onChange: () => void | Promise<void>; compact?: boolean }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState<{ blocking: number; issues: PreflightIssue[] } | null>(null);
  const active = isActiveTask(task.status);
  const run = async (mode: RetryMode, allowIssues = false) => {
    const request = retryRequest(mode, { projectId: task.projectId, jobId: task.id, allowIssues });
    if (!request) { setError('这条任务没有可用的恢复入口'); return; }
    setBusy(mode); setError(''); setBlocked(null);
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
            : task.error
              ? task.error
              : task.status === 'completed' ? '已完成' : task.message ?? '已停止'}
        </p>
        {typeof task.percent === 'number' && active && (
          <div className="task-progress"><span style={{ width: `${Math.min(100, Math.max(0, task.percent))}%` }} /></div>
        )}
        <div className="task-meta">
          <span>{active ? `已运行 ${formatElapsed(Date.now() - new Date(task.createdAt).getTime())}` : new Date(task.updatedAt).toLocaleString('zh-CN')}</span>
          {task.chapters?.length ? <span>{task.chapters.length - pending} / {task.chapters.length} 章完成</span> : null}
          {typeof task.percent === 'number' && !compact ? <span>{task.percent}%</span> : null}
        </div>
        {task.chapters?.length ? (
          <ol className="task-chapters">
            {task.chapters.map(chapter => (
              <li key={chapter.index} className={chapter.done ? 'done' : 'pending'} title={chapter.page ? `来源第 ${chapter.page} 页` : undefined}>
                <i>{chapter.done ? '✓' : chapter.index}</i>
                <span>{chapter.title}</span>
              </li>
            ))}
          </ol>
        ) : null}
        {pending > 0 && task.status === 'failed' ? <p className="task-hint">还有 {pending} 章待处理，重试会从已完成的部分继续。</p> : null}
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
            <button className="button primary" disabled={!!busy} onClick={() => void run('render', true)}>{busy === 'render' ? '提交中…' : '确认风险并重新渲染'}</button>
            <button className="text-button" disabled={!!busy} onClick={() => setBlocked(null)}>返回</button>
          </>
        ) : task.retryMode && (
          <button className="button subtle" disabled={!!busy} onClick={() => run(task.retryMode as RetryMode)}>
            {busy === task.retryMode ? '处理中…' : retryLabels[task.retryMode]}
          </button>
        )}
        {task.status === 'failed' && task.kind === 'storyboard' && task.retryMode !== 'restart' && (
          <button className="text-button" disabled={!!busy} onClick={() => run('restart')}>从头重新执行</button>
        )}
        <Link className="text-button" href={`/project/${task.projectId}`}>打开项目</Link>
      </div>
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
      const data = await response.json() as { resumed?: number; released?: number; error?: string };
      if (!response.ok) throw new Error(data.error ?? '恢复失败');
      setNotice(`已恢复 ${data.resumed ?? 0} 个任务，释放 ${data.released ?? 0} 个占用`);
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
