import Link from 'next/link';
import { TaskCenter } from '@/components/task-center';

export default function Page() {
  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/">知影 <span>LOCAL STUDIO</span></Link>
        <div className="top-actions">
          <Link className="button subtle" href="/environment">环境自检</Link>
          <span className="local-indicator"><i /> 本地工作区</span>
          <Link className="button subtle" href="/settings">通用设置</Link>
          <Link className="button primary" href="/">返回项目</Link>
        </div>
      </header>
      <section className="section-head">
        <div><h2>任务中心</h2><p>长文生成、语音生成与视频渲染的进度、失败原因和恢复入口</p></div>
      </section>
      <TaskCenter />
    </main>
  );
}
