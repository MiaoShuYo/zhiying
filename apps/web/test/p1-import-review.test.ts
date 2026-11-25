/**
 * P1 import regressions, batch 2: #204 slide peek, #211 escaped pipes, #221 nested lists,
 * #299 rerun batches, #303 page badges by page number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pageBody } from '../src/lib/extraction';
import { markdownTableData, normalizeMarkdown, sourceBulletItems } from '../src/lib/pipeline';
import { rerunBatches } from '../src/components/page-review';
import { scanPageOrder } from '../src/lib/structure';

test('[#211] escaped pipes stay inside their cell', () => {
  const table = markdownTableData('| 名称 | 说明 |\n| --- | --- |\n| A\\|B | C |');
  assert.deepEqual(table?.rows, [['A|B', 'C']]);
});

test('[#221] nested Markdown lists keep their hierarchy', () => {
  const normalized = normalizeMarkdown('- 一级甲\n  - 子项一\n  - 子项二\n- 一级乙');
  assert.match(normalized, /^  • 子项一$/m);
  assert.deepEqual(sourceBulletItems(normalized), [{ text: '一级甲', children: ['子项一', '子项二'] }, '一级乙']);
});

test('[#204] the source peek locates a PPTX slide', () => {
  const view = pageBody('## 幻灯片 1\n第一页\n\n## 幻灯片 2\n第二页', 2);
  assert.equal(view.body, '第二页');
  assert.deepEqual(view.pages, [1, 2]);
  assert.equal(view.missing, false);
});

test('[#299] page reruns are sent in batches of at most 50', () => {
  const pages = Array.from({ length: 120 }, (_, index) => index + 1);
  const batches = rerunBatches(pages);
  assert.deepEqual(batches.map(batch => batch.length), [50, 50, 20]);
  assert.deepEqual(batches.flat(), pages);
});

test('[#303] page order rows carry the parsed page number for metadata lookup', () => {
  const order = scanPageOrder([{ label: '## 第 1 页', body: '正文一'.repeat(10) }, { label: '## 第 3 页', body: '正文三'.repeat(10) }]);
  assert.deepEqual(order.rows.map(row => [row.position, row.page]), [[1, 1], [2, 3]]);
});
