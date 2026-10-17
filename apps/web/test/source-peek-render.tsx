/**
 * Render smoke test for the storyboard source-page peek. Server rendering stops
 * before the fetch effect, so this only proves the panel mounts with its own
 * page number and controls; the page lookup itself is covered in extraction.test.ts.
 */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SourcePagePeek } from '../src/components/source-page-peek';

const markup = renderToStaticMarkup(createElement(SourcePagePeek, { id: 'demo', page: 2, onClose: () => {} }));
assert.ok(markup.includes('来源第 2 页'), 'peek opens on the scene source page');
assert.ok(markup.includes('role="dialog"'), 'peek renders as a dialog');
assert.ok(markup.includes('正在读取来源正文…'), 'peek shows a loading state while fetching');
assert.ok(markup.includes('上一页') && markup.includes('下一页'), 'peek offers page navigation');
assert.ok(markup.includes('关闭'), 'peek can be dismissed');

console.log('PASS: SourcePagePeek opens on the scene source page');
