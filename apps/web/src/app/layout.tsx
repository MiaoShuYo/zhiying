import './globals.css';
import type { ReactNode } from 'react';
export const metadata = { title: '知影 · 本地 AI 知识视频', description: '把资料变成可编辑的讲解视频' };
export default function RootLayout({ children }: { children: ReactNode }) { return <html lang="zh-CN"><body>{children}</body></html>; }
