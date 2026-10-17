import test from 'node:test';
import assert from 'node:assert/strict';
import { pageNumberOf, scanLists, scanPageOrder, scanTables } from '../src/lib/structure';

const pages = [
  { label: '## 第 1 页', body: ['封面说明', '', '| 指标 | 数值 |', '| --- | --- |', '| 覆盖 | 3 |', '| 准确率 | 92% |'].join('\n') },
  { label: '## 第 2 页', body: ['- 第一步', '  - 子项 A', '- 第二步', '', '1. 准备', '2. 采集', '4. 复核'].join('\n') },
];

test('tables are listed with their shape and the OCR problems worth fixing', () => {
  const found = scanTables(pages);
  assert.equal(found.length, 1);
  assert.equal(found[0].page, 1);
  assert.equal(found[0].index, 1);
  assert.equal(found[0].columns, 2);
  assert.equal(found[0].rows, 2, 'the divider row is not a data row');
  assert.deepEqual(found[0].header, ['指标', '数值']);
  assert.deepEqual(found[0].preview, ['覆盖 | 3', '准确率 | 92%']);
  assert.deepEqual(found[0].issues, []);
});

test('a ragged table and a header-only table are flagged instead of rendering silently', () => {
  const found = scanTables([
    { label: '## 第 1 页', body: '| 名称 | 说明 | 备注 |\n| --- | --- | --- |\n| A | 只有两列 |' },
    { label: '## 第 2 页', body: '| 名称 |  |\n| --- | --- |' },
    { label: '## 第 3 页', body: '没有表格' },
  ]);
  assert.equal(found.length, 2);
  assert.ok(found[0].issues.some(issue => issue.includes('列数不一致')));
  assert.equal(found[0].columns, 3);
  assert.equal(found[0].rows, 1);
  assert.ok(found[1].issues.some(issue => issue.includes('只有表头')));
  assert.ok(found[1].issues.some(issue => issue.includes('表头为空')));
  assert.equal(found[1].page, 2);
});

test('lists split by marker type and report nesting, numbering and empty entries', () => {
  const found = scanLists(pages);
  assert.equal(found.length, 2);
  assert.equal(found[0].ordered, false);
  assert.equal(found[0].items, 3);
  assert.equal(found[0].depth, 2);
  assert.deepEqual(found[0].preview, ['第一步', '子项 A', '第二步']);
  assert.equal(found[1].ordered, true);
  assert.equal(found[1].items, 3);
  assert.ok(found[1].issues.some(issue => issue.includes('缺少编号 3')));
  const extra = scanLists([{ label: '## 第 1 页', body: '2. 从二开始\n3. 继续\n-\n- 有内容' }]);
  assert.equal(extra.length, 2);
  assert.ok(extra[0].issues.some(issue => issue.includes('编号从 2 开始')));
  assert.ok(extra[1].issues.some(issue => issue.includes('只有记号没有内容')));
});

test('page order review catches duplicates, gaps and out-of-order pages', () => {
  const report = scanPageOrder([
    { label: '## 第 1 页', body: '第一页正文，内容足够长可以算作一页。' },
    { label: '## 第 4 页', body: '第四页正文，内容足够长可以算作一页。' },
    { label: '## 第 2 页', body: '第二页正文，内容足够长可以算作一页。' },
    { label: '## 第 4 页', body: '重复的第四页，内容足够长可以算作一页。' },
    { label: '## 附录', body: '这一页没有页码，但正文足够长可以算作一页。' },
  ]);
  assert.equal(report.rows.length, 5);
  assert.deepEqual(report.duplicates, [4]);
  assert.deepEqual(report.gaps, [3], 'page 3 is missing between 1 and 4');
  assert.deepEqual(report.outOfOrder, [3]);
  assert.deepEqual(report.unnumbered, [5]);
  assert.ok(report.rows[1].issues.some(issue => issue.includes('缺少第 2~3 页')));
  assert.ok(report.rows[0].issues.every(issue => !issue.includes('页码重复')));
  assert.ok(report.rows[2].issues.some(issue => issue.includes('顺序错乱')));
  assert.ok(report.rows[3].issues.some(issue => issue.includes('页码重复')));
  assert.deepEqual(report.empty, [], 'short but non-empty bodies are not empty pages');
  assert.equal(report.rows[1].chars, '第四页正文，内容足够长可以算作一页。'.length);
});

test('page numbers are read from both PDF and slide markers', () => {
  assert.equal(pageNumberOf('## 第 12 页'), 12);
  assert.equal(pageNumberOf('## 幻灯片 3'), 3);
  assert.equal(pageNumberOf('##  第  7  页'), 7);
  assert.equal(pageNumberOf('## 附录'), null);
  const report = scanPageOrder([{ label: '## 第 1 页', body: '短' }, { label: '## 第 2 页', body: '  \n\t ' }]);
  assert.deepEqual(report.empty, [1, 2], 'pages without meaningful text are reported as empty');
  assert.ok(report.rows[0].issues.some(issue => issue.includes('几乎没有文字')));
});
