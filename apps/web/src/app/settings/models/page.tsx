import Link from 'next/link';
import { DesktopModels } from '@/components/desktop-models';
import { readDesktopModelStatus } from '@/lib/desktop-models';

export const dynamic = 'force-dynamic';

export default async function ModelsSettingsPage() {
  const status = await readDesktopModelStatus();
  return (
    <main className="shell editor-shell">
      <header className="topbar">
        <Link className="brand" href="/">知影 <span>LOCAL STUDIO</span></Link>
        <div className="crumb">设置 / 模型</div>
      </header>
      <section className="editor-heading settings-heading">
        <div>
          <p className="eyebrow">SETTINGS · MODELS</p>
          <h1>模型管理</h1>
          <p className="muted">查看安装版模型的保存位置、下载状态与许可信息；下载与断点续传由模型管理器负责。</p>
        </div>
        <Link className="button" href="/settings">返回设置</Link>
      </section>
      <DesktopModels status={status} />
    </main>
  );
}
