import test from 'node:test';
import assert from 'node:assert/strict';
import { joinPageSections, mergePageText, normalizePageInfo, pageBody, pageMethodLabel, pageQualityLabel, pageRecord, pageSections, reviewPages, type PageInfo } from '../src/lib/extraction';

const source = '封面说明\n\n## 第 1 页\n第一页正文\n\n## 第 2 页\n第二页正文\n\n## 第 3 页\n第三页正文\n';
const rows: PageInfo[] = [
  { page: 1, method: 'text', chars: 400, quality: 'good', warnings: [] },
  { page: 2, method: 'ocr', chars: 260, quality: 'fair', warnings: ['此页来自 OCR 识别，请核对数字、公式与专有名词'] },
  { page: 3, method: 'none', chars: 0, quality: 'poor', warnings: ['此页没有识别出文字'], error: 'tesseract 超时' },
];

test('page sections parse the page markers written by the extractor', () => {
  const { preamble, sections } = pageSections(source);
  assert.equal(preamble, '封面说明');
  assert.deepEqual(sections.map(section => section.page), [1, 2, 3]);
  assert.equal(sections[1].body, '第二页正文');
  assert.deepEqual(pageSections('没有分页标记的正文'), { preamble: '没有分页标记的正文', sections: [] });
});

test('joining page sections round-trips the extractor format', () => {
  const { preamble, sections } = pageSections(source);
  assert.equal(joinPageSections(preamble, sections), source.trim());
});

test('merging replaces only the requested pages and keeps the rest untouched', () => {
  const merged = mergePageText(source, [{ page: 2, body: '第二页重新识别' }]);
  assert.ok(merged);
  const sections = pageSections(merged!).sections;
  assert.equal(sections[0].body, '第一页正文');
  assert.equal(sections[1].body, '第二页重新识别');
  assert.equal(sections[2].body, '第三页正文');
  assert.equal(pageSections(merged!).preamble, '封面说明');
  assert.equal(mergePageText('网页正文没有分页', [{ page: 1, body: 'x' }]), null);
});

test('merging inserts a page number that the source text was missing', () => {
  const merged = mergePageText(source, [{ page: 4, body: '新增页' }]);
  assert.deepEqual(pageSections(merged!).sections.map(section => section.page), [1, 2, 3, 4]);
});

test('review rows flag failed, low quality and warned pages only', () => {
  assert.deepEqual(reviewPages(rows), [2, 3]);
  assert.deepEqual(reviewPages(undefined), []);
});

test('legacy extraction records are normalised into review rows', () => {
  const legacy = normalizePageInfo({ kind: 'pdf', pages: 3, ocrPages: [2], failedPages: [{ page: 3, error: 'boom' }] });
  assert.deepEqual(legacy.map(page => [page.page, page.method, page.quality]), [[1, 'text', 'fair'], [2, 'ocr', 'fair'], [3, 'none', 'poor']]);
  assert.equal(legacy[2].error, 'boom');
  assert.deepEqual(reviewPages(legacy), [1, 2, 3]);
  assert.deepEqual(normalizePageInfo({ kind: 'url', pages: 3 }), []);
  assert.deepEqual(normalizePageInfo(null), []);
});

test('stored review rows are sorted and page bodies never reach extraction.json', () => {
  assert.deepEqual(normalizePageInfo({ kind: 'pdf', pageInfo: [rows[2], rows[0], rows[1]] }).map(page => page.page), [1, 2, 3]);
  const stored = pageRecord({ ...rows[0], text: '整页正文' });
  assert.equal('text' in stored, false);
  assert.equal(stored.chars, 400);
});

test('a truncated pageInfo is padded so a single re-run cannot hide the other pages', () => {
  const truncated = normalizePageInfo({ kind: 'pdf', pages: 3, ocrPages: [2], pageInfo: [rows[0]] });
  assert.deepEqual(truncated.map(page => page.page), [1, 2, 3]);
  assert.equal(truncated[0].chars, 400, '已重跑页面保留真实统计');
  assert.deepEqual([truncated[1].method, truncated[1].quality], ['ocr', 'fair']);
  assert.equal(truncated[2].chars, 0);
  assert.ok(truncated[2].warnings.length > 0);
  // 没有 pages 字段时以已有行的最大页码为准。
  assert.deepEqual(normalizePageInfo({ kind: 'pdf', pageInfo: [rows[1]] }).map(page => page.page), [1, 2]);
});

test('labels stay in the product vocabulary', () => {
  assert.deepEqual(['good', 'fair', 'poor'].map(quality => pageQualityLabel(quality as PageInfo['quality'])), ['良好', '需复核', '识别不佳']);
  assert.deepEqual(['text', 'ocr', 'none'].map(method => pageMethodLabel(method as PageInfo['method'])), ['文本层', 'OCR', '失败']);
});

test('a scene source page resolves to that page body for review', () => {
  const pageTwo = pageBody(source, 2);
  assert.equal(pageTwo.body, '第二页正文');
  assert.deepEqual(pageTwo.pages, [1, 2, 3]);
  assert.equal(pageTwo.missing, false);
  // 页码来自正文标记，而不是场景序号。
  assert.equal(pageBody(source, 3).body, '第三页正文');
  const gone = pageBody(source, 7);
  assert.equal(gone.missing, true);
  assert.equal(gone.body, '');
  assert.deepEqual(gone.pages, [1, 2, 3]);
  // 没有分页标记的来源（网页/文本）退回完整正文。
  const single = pageBody('整段正文没有分页标记', 1);
  assert.deepEqual([single.body, single.pages.length, single.missing], ['整段正文没有分页标记', 0, false]);
});
