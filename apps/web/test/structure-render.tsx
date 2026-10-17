/**
 * Render smoke test for the structure review views. Run with `--tsconfig
 * apps/web/test/tsconfig.json` because the app tsconfig preserves JSX for Next
 * while tsx needs the automatic runtime here.
 */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StructureReview } from '../src/components/source-structure';
import { normalizePageInfo } from '../src/lib/extraction';

const pages = [
  { label: '## 第 1 页', body: ['封面', '', '| 指标 | 数值 | 备注 |', '| --- | --- | --- |', '| 覆盖 | 3 |'].join('\n') },
  { label: '## 第 3 页', body: ['- 第一步', '  - 子项', '- 第二步', '', '1. 准备', '2. 采集', '4. 复核'].join('\n') },
  { label: '## 第 3 页', body: '重复页正文足够长，可以算作一页内容。' },
];
const pageInfo = normalizePageInfo({ kind: 'pdf', pages: 3 });
const render = (initialTab: 'tables' | 'lists' | 'order') =>
  renderToStaticMarkup(createElement(StructureReview, { pages, pageInfo, disabled: false, initialTab, onJump: () => {} }));

const tables = render('tables');
assert.ok(tables.includes('结构复核'), 'block title renders');
assert.ok(tables.includes('共 3 页 · 1 个表格 · 2 个列表'), 'summary counts render');
assert.ok(tables.includes('3 列 × 1 行'), 'table shape renders');
assert.ok(tables.includes('列数不一致'), 'ragged table issue renders');
assert.ok(tables.includes('定位'), 'locate action renders');

const lists = render('lists');
assert.ok(lists.includes('第 2 页 · 列表 2'), 'ordered list row renders');
assert.ok(lists.includes('无序 · 3 项 · 2 级'), 'list kind, size and nesting render');
assert.ok(lists.includes('缺少编号 3'), 'numbering gap renders');
assert.ok(lists.includes('第一步 / 子项'), 'list preview renders');

const order = render('order');
assert.ok(order.includes('页码重复'), 'duplicate page numbers render');
assert.ok(order.includes('顺序错乱'), 'out-of-order pages render');
assert.ok(order.includes('缺页'), 'gap summary renders');
assert.ok(order.includes('定位到第一个问题'), 'first-problem action renders');
assert.ok(order.includes('文本层') && order.includes('需复核'), 'page method and quality badges render');

console.log('PASS: StructureReview renders table, list and page-order review views');
