'use client';
import { useState } from 'react';
import { pageMethodLabel, pageQualityLabel, type PageInfo } from '@/lib/extraction';
import { scanLists, scanPageOrder, scanTables, type SourcePage } from '@/lib/structure';

type Tab = 'tables' | 'lists' | 'order';
const tabLabels: Record<Tab, string> = { tables: '表格', lists: '列表', order: '页序' };

/**
 * Structure review. Plain previews show whatever happens to be in the body, so a
 * mangled table or a broken list is easy to miss; these views list every table,
 * list and page marker on its own and jump straight to the page to fix it.
 */
export function StructureReview({ pages, pageInfo, disabled, initialTab = 'tables', onJump }: {
  pages: SourcePage[];
  pageInfo: PageInfo[];
  disabled: boolean;
  initialTab?: Tab;
  onJump: (index: number) => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const tables = scanTables(pages), lists = scanLists(pages), order = scanPageOrder(pages);
  const problems = {
    tables: tables.filter(table => table.issues.length).length,
    lists: lists.filter(list => list.issues.length).length,
    order: order.rows.filter(row => row.issues.length).length,
  };
  const firstProblem = order.rows.find(row => row.issues.length);
  const locate = (position: number) => <button className="button subtle structure-jump" disabled={disabled} onClick={() => onJump(position - 1)}>定位</button>;
  return <div className="structure-review">
    <div className="v11-row structure-review-head">
      <b>结构复核</b>
      <span className="hint">共 {pages.length} 页 · {tables.length} 个表格 · {lists.length} 个列表</span>
      <div className="tabs">{(['tables', 'lists', 'order'] as Tab[]).map(name => <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{tabLabels[name]}{problems[name] ? ` · ${problems[name]} 待处理` : ''}</button>)}</div>
    </div>
    {tab === 'tables' && (tables.length
      ? <div className="structure-list">{tables.map(table => <article className={`structure-row ${table.issues.length ? 'flagged' : ''}`} key={`${table.page}-${table.index}`}>
        <b>第 {table.page} 页 · 表 {table.index}</b>
        <span className="page-badge">{table.columns} 列 × {table.rows} 行</span>
        <span className="structure-preview">{table.header.length ? `表头：${table.header.join(' | ')}` : '无表头'}</span>
        {table.preview.map((row, index) => <span className="structure-preview" key={index}>{row}</span>)}
        <ul className="structure-issues">{table.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>
        {locate(table.page)}
      </article>) }</div>
      : <p className="hint">没有检测到表格。表格需要以 Markdown 表格（<code>| 单元格 |</code>）的形式抽取，缺失时可重跑对应页面。</p>)}
    {tab === 'lists' && (lists.length
      ? <div className="structure-list">{lists.map(list => <article className={`structure-row ${list.issues.length ? 'flagged' : ''}`} key={`${list.page}-${list.index}`}>
        <b>第 {list.page} 页 · 列表 {list.index}</b>
        <span className="page-badge">{list.ordered ? '有序' : '无序'} · {list.items} 项 · {list.depth} 级</span>
        <span className="structure-preview">{list.preview.join(' / ')}</span>
        <ul className="structure-issues">{list.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>
        {locate(list.page)}
      </article>) }</div>
      : <p className="hint">没有检测到列表。列表条目需要以 <code>-</code>、<code>*</code> 或 <code>1.</code> 开头，缺失时可重跑对应页面。</p>)}
    {tab === 'order' && <>
      <div className="v11-row structure-order-summary">
        <span>页码重复 <b>{order.duplicates.length ? order.duplicates.join('、') : '无'}</b></span>
        <span>缺页 <b>{order.gaps.length ? order.gaps.join('、') : '无'}</b></span>
        <span>顺序错乱 <b>{order.outOfOrder.length}</b> 处</span>
        <span>无法识别页码 <b>{order.unnumbered.length}</b> 页</span>
        <span>空页 <b>{order.empty.length}</b> 页</span>
        {firstProblem && <button className="button subtle" disabled={disabled} onClick={() => onJump(firstProblem.position - 1)}>定位到第一个问题</button>}
      </div>
      <div className="structure-list">{order.rows.map(row => {
        const info = pageInfo.find(page => page.page === row.position);
        return <article className={`structure-row ${row.issues.length ? 'flagged' : ''}`} key={row.position}>
          <b>#{row.position}</b>
          <span className="structure-preview">{row.label.replace(/^##\s*/, '') || '（无标题）'}</span>
          <span className="page-chars">{row.chars} 字</span>
          {info && <span className={`page-badge method-${info.method}`}>{pageMethodLabel(info.method)}</span>}
          {info && <span className={`page-badge quality-${info.quality}`}>{pageQualityLabel(info.quality)}</span>}
          <ul className="structure-issues">{row.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>
          {locate(row.position)}
        </article>;
      })}</div>
    </>}
  </div>;
}
