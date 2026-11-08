import Link from 'next/link';
import { GeneralSettings } from '@/components/general-settings';
import { BrandKits } from '@/components/brand-kits';

export default function SettingsPage() {
  return <main className="shell editor-shell"><header className="topbar"><Link className="brand" href="/">知影 <span>LOCAL STUDIO</span></Link><div className="crumb">设置</div></header><section className="editor-heading settings-heading"><div><p className="eyebrow">SETTINGS</p><h1>设置</h1><p className="muted">为所有项目配置默认声音；品牌套件定义颜色、字体与 Logo。</p></div></section><GeneralSettings /><BrandKits /></main>;
}
