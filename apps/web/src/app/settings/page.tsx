import Link from 'next/link';
import { GeneralSettings } from '@/components/general-settings';

export default function SettingsPage() {
  return <main className="shell editor-shell"><header className="topbar"><Link className="brand" href="/">知影 <span>LOCAL STUDIO</span></Link><div className="crumb">通用设置</div></header><section className="editor-heading settings-heading"><div><p className="eyebrow">GENERAL SETTINGS</p><h1>通用设置</h1><p className="muted">为所有项目配置默认声音。</p></div></section><GeneralSettings /></main>;
}
