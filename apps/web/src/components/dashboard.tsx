'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { styles } from '@m2v/styles';
import type { StyleId } from '@m2v/schema';

type ProjectRow = { id: string; name: string; status: string; styleId: string; createdAt: string; sceneCount: number; busy: boolean; busyStage: string | null };
const styleIds: StyleId[] = ['minimal-tech', 'clean-light', 'academic', 'social-short'];
const labels: Record<string, string> = { created: '新建', extracting: '读取资料', analyzing: '分析中', storyboarding: '生成分镜', awaiting_review: '待审核', generating_audio: '生成语音', rendering: '渲染中', encoding: '编码中', completed: '已完成', failed: '失败' };
const analysisProgress: Record<string, number> = { created: 8, extracting: 20, analyzing: 58, storyboarding: 82 };

export function Dashboard({ initialProjects }: { initialProjects: ProjectRow[] }) {
  const [projects, setProjects] = useState(initialProjects); const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [file, setFile] = useState<File | null>(null); const [text, setText] = useState(''); const [name, setName] = useState(''); const [styleId, setStyleId] = useState<StyleId>('minimal-tech'); const [preferAI, setPreferAI] = useState(false); const [manageProject, setManageProject] = useState<ProjectRow | null>(null); const [manageMode, setManageMode] = useState<'rename' | 'delete' | null>(null); const [manageName, setManageName] = useState(''); const [manageBusy, setManageBusy] = useState(false); const [manageError, setManageError] = useState(''); const router = useRouter();
  const hasActiveAnalysis = projects.some(project => project.busy || Object.hasOwn(analysisProgress, project.status));
  useEffect(() => { if (manageProject && projects.some(project => project.id === manageProject.id && project.busy)) { setManageProject(null); setManageMode(null); } }, [projects, manageProject]);
  useEffect(() => {
    if (!hasActiveAnalysis) return;
    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch('/api/projects', { cache: 'no-store' });
        if (!response.ok) return;
        const current = await response.json() as ProjectRow[];
        if (!stopped) setProjects(current);
      } catch { /* Retry on the next interval while the local app is running. */ }
    };
    const timer = window.setInterval(poll, 1500);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [hasActiveAnalysis]);
  async function create() { setBusy(true); setError(''); try { const form = new FormData(); form.set('name', name); form.set('text', text); form.set('styleId', styleId); form.set('preferLocalAI', String(preferAI)); if (file) form.set('file', file); const response = await fetch('/api/projects', { method: 'POST', body: form }); const result = await response.json(); if (!response.ok) throw new Error(result.error); router.push(`/project/${result.id}`); } catch (e) { setError(e instanceof Error ? e.message : '创建失败'); } finally { setBusy(false); } }
  function openManage(project: ProjectRow, mode: 'rename' | 'delete') { if (project.busy) return; setManageProject(project); setManageMode(mode); setManageName(project.name); setManageError(''); }
  async function submitManage() {
    if (!manageProject || !manageMode) return;
    if (manageMode === 'rename' && !manageName.trim()) { setManageError('项目名称不能为空'); return; }
    setManageBusy(true); setManageError('');
    try {
      const response = manageMode === 'rename'
        ? await fetch(`/api/projects/${manageProject.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: manageName.trim() }) })
        : await fetch(`/api/projects/${manageProject.id}`, { method: 'DELETE' });
      const result = response.status === 204 ? null : await response.json();
      if (!response.ok) throw new Error(result?.error ?? (manageMode === 'rename' ? '修改项目失败' : '删除项目失败'));
      setProjects(current => manageMode === 'rename' ? current.map(item => item.id === manageProject.id ? { ...item, name: result.name } : item) : current.filter(item => item.id !== manageProject.id));
      setManageProject(null); setManageMode(null);
    } catch (e) { setManageError(e instanceof Error ? e.message : '操作失败'); }
    finally { setManageBusy(false); }
  }
  return <main className="shell"><header className="topbar"><Link className="brand" href="/">知影 <span>LOCAL STUDIO</span></Link><div className="top-actions"><span className="local-indicator"><i /> 本地工作区</span><Link className="button subtle" href="/settings">通用设置</Link><button className="button primary" onClick={() => setOpen(true)}>＋ 新建视频</button></div></header>{error && !open && <p className="error-box">{error}</p>}<section className="hero"><div><p className="eyebrow">AI EXPLAINER VIDEO STUDIO</p><h1>把复杂知识，讲得清楚。</h1><p className="hero-sub">从资料到分镜、声音与视频，在你的电脑上完成。</p></div><div className="hero-art"><div className="orb orb-a"/><div className="orb orb-b"/><div className="art-card"><span>资料</span><b>→</b><span>故事板</span><b>→</b><span>视频</span></div><div className="art-wave">▂▅▃▇▅▂▆▃▅</div></div></section><section className="section-head"><div><h2>最近项目</h2><p>你的本地创作空间</p></div><span className="count-pill">{projects.length.toString().padStart(2, '0')} 个项目</span></section>{projects.length ? <div className="project-grid">{projects.map((p, i) => <article className="project-card" key={p.id}><Link href={`/project/${p.id}`} className="project-card-link"><div className={`project-thumb thumb-${i % 4}`}><span className="thumb-kicker">{styles[p.styleId as StyleId]?.name ?? 'VIDEO PROJECT'}</span><strong>{p.name}</strong><span className="thumb-bars">▰ ▰ ▰</span></div><div className="project-info"><div><h3>{p.name}</h3><p>{new Date(p.createdAt).toLocaleDateString('zh-CN')} · {p.sceneCount} 个场景</p></div><span className={`status status-${p.busy ? 'analyzing' : p.status}`}>{p.busy ? '执行中' : labels[p.status] ?? p.status}</span></div>{p.busy && <div className="project-progress"><div className="project-progress-label"><span>{labels[p.busyStage ?? p.status] ?? p.busyStage ?? labels[p.status] ?? '处理中'}</span><span>{analysisProgress[p.status] ?? 55}%</span></div><div className="project-progress-track"><span style={{ width: `${analysisProgress[p.status] ?? 55}%` }} /></div></div>}</Link><div className="project-actions"><button className="text-button" disabled={p.busy} title={p.busy ? '执行过程中暂不可修改' : undefined} onClick={() => openManage(p, 'rename')}>重命名</button><button className="text-button project-delete" disabled={p.busy} title={p.busy ? '执行过程中暂不可删除' : undefined} onClick={() => openManage(p, 'delete')}>删除项目</button></div></article>)}</div> : <div className="empty"><div className="empty-icon">✳</div><h3>从一份资料开始</h3><p>导入 PDF、Markdown 或粘贴文本，生成第一条知识视频。</p><button className="button primary" onClick={() => setOpen(true)}>创建第一个项目</button></div>}
  {open && <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && setOpen(false)}><div className="modal"><button className="modal-close" onClick={() => setOpen(false)}>×</button><p className="eyebrow">NEW VIDEO</p><h2>新建讲解视频</h2><p className="muted">选择一份资料，让 AI 帮你整理成故事板。</p><label className="field-label">项目名称</label><input className="input" placeholder="例如：量子计算入门" value={name} onChange={e => setName(e.target.value)} /><label className="field-label">导入 PDF 或 Markdown</label><label className="file-drop"><input type="file" accept="application/pdf,.pdf,text/markdown,.md,.markdown" onChange={e => setFile(e.target.files?.[0] ?? null)} /><span className="file-icon">↑</span><b>{file?.name ?? '点击选择 PDF 或 Markdown 文件'}</b><small>支持 PDF、.md、.markdown，也可以在下方粘贴文本</small></label><label className="field-label">或粘贴文本</label><textarea className="input textarea" placeholder="粘贴文章、笔记或讲解素材…" value={text} onChange={e => setText(e.target.value)} /><label className="field-label">视频风格</label><div className="style-select">{styleIds.map(id => <button key={id} className={`style-chip ${styleId === id ? 'selected' : ''}`} onClick={() => setStyleId(id)}>{styles[id].name}</button>)}</div><label className="checkbox-row"><input type="checkbox" checked={preferAI} onChange={e => setPreferAI(e.target.checked)} /> 必须使用本地 Ollama 生成（不可用时显示错误）</label>{error && <p className="error-box">{error}</p>}<button className="button primary create-button" disabled={busy || (!file && !text.trim())} onClick={create}>{busy ? '正在整理资料…' : '生成故事板 →'}</button></div></div>}
  {manageProject && manageMode && <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && !manageBusy && setManageProject(null)}><section className="modal manage-modal" role="dialog" aria-modal="true" aria-labelledby="manage-title"><button className="modal-close" disabled={manageBusy} onClick={() => setManageProject(null)}>×</button><p className="eyebrow">PROJECT SETTINGS</p><h2 id="manage-title">{manageMode === 'rename' ? '重命名项目' : '删除项目'}</h2>{manageMode === 'rename' ? <><p className="muted">修改项目名称，之后可以在项目列表中查看。</p><label className="field-label" htmlFor="project-rename">项目名称</label><input id="project-rename" className="input" maxLength={100} value={manageName} onChange={e => setManageName(e.target.value)} onKeyDown={e => e.key === 'Enter' && void submitManage()} autoFocus /></> : <p className="muted">确定删除“{manageProject.name}”吗？项目的场景、作业和导出视频也会一并删除，此操作无法撤销。</p>}{manageError && <p className="error-box">{manageError}</p>}<div className="manage-actions"><button className="button subtle" disabled={manageBusy} onClick={() => setManageProject(null)}>取消</button><button className={`button ${manageMode === 'delete' ? 'danger' : 'primary'}`} disabled={manageBusy} onClick={() => void submitManage()}>{manageBusy ? '处理中…' : manageMode === 'delete' ? '确认删除' : '保存名称'}</button></div></section></div>}
  </main>;
}

