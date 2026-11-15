import Link from 'next/link';
import { GeneralSettings } from '@/components/general-settings';
import { BrandKits } from '@/components/brand-kits';

export default function SettingsPage() {
  return <main className="shell editor-shell"><header className="topbar"><Link className="brand" href="/">知影 <span>LOCAL STUDIO</span></Link><div className="crumb">设置</div></header><section className="editor-heading settings-heading"><div><p className="eyebrow">SETTINGS</p><h1>设置</h1><p className="muted">为所有项目配置默认声音；品牌套件定义颜色、字体与 Logo。</p></div></section><GeneralSettings /><BrandKits /><section className="settings-card"><p className="eyebrow">MODELS</p><h2>模型管理</h2><p className="muted">查看安装版模型的保存位置、下载状态与许可信息，并打开模型管理器下载/修复模型。</p><Link className="button primary" href="/settings/models">打开模型管理</Link></section></main>;
}
