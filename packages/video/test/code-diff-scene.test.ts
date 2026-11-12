import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import {
  computeCodeDiffView,
  rendererScale,
  resolveCodeSceneMode,
  sanitizeSceneHtml,
  type CodeDiffLine,
  type Scene,
} from '@m2v/schema';
import { palettes, resolveCodeDiffColors } from '@m2v/styles';
import { CodeHtmlSceneView, renderCodeHtmlScene } from '../src/code-html-scene';
import {
  CODE_DIM_OPACITY,
  CodeSceneView,
  resolveCodeSceneFrameState,
  resolveCodeSceneLayout,
} from '../src/code-scene';

/**
 * #26 契约：diff 模式 Standard/HTML unified 渲染、hunk 切换、viewport 与主题颜色
 * （doc/V1.7.0_issues.md §2.6 / §2.7 / §2.8 / §2.9）。
 */

const webRequire = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const { renderToStaticMarkup } = webRequire('react-dom/server') as { renderToStaticMarkup: (element: unknown) => string };

const LANDSCAPE = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };
const STYLE_IDS = ['minimal-tech', 'clean-light', 'academic', 'social-short', 'whiteboard'] as const;

/** 20 行两处替换（第 2、12 行）→ 2 个 hunk。 */
const BEFORE_2HUNK = Array.from({ length: 20 }, (_, index) => (index === 1 ? 'const old2 = 1;' : index === 11 ? 'const old12 = 1;' : `const line${index + 1} = ${index + 1};`)).join('\n');
const AFTER_2HUNK = Array.from({ length: 20 }, (_, index) => (index === 1 ? 'const new2 = 2;' : index === 11 ? 'const new12 = 2;' : `const line${index + 1} = ${index + 1};`)).join('\n');

/** 40 行 5 处变更（行号 2/10/20/32/40，间隔均 >2×context=6）→ 5 个 hunk，diff 行数远超 viewport。 */
const BEFORE_LONG = Array.from({ length: 40 }, (_, index) => ([1, 9, 19, 31, 39].includes(index) ? `const old${index + 1} = 1;` : `const line${index + 1} = ${index + 1};`)).join('\n');
const AFTER_LONG = Array.from({ length: 40 }, (_, index) => ([1, 9, 19, 31, 39].includes(index) ? `const new${index + 1} = 2;` : `const line${index + 1} = ${index + 1};`)).join('\n');

function sceneOf(visual: Record<string, unknown>, patch: Record<string, unknown> = {}): Scene {
  return {
    id: 'diff-scene',
    type: 'code',
    title: '差异讲解',
    narration: '这一页对比代码修改前后的差异。',
    duration: 6,
    ...patch,
    visual: { language: 'typescript', filename: 'diff.ts', ...visual },
  } as Scene;
}

const diffScene = (extra: Record<string, unknown> = {}, patch: Record<string, unknown> = {}): Scene =>
  sceneOf({
    code: AFTER_2HUNK,
    mode: 'diff',
    beforeCode: BEFORE_2HUNK,
    afterCode: AFTER_2HUNK,
    diffBeats: [
      { hunkIds: ['h1'], label: '第一处修改', narrationText: '先看第一处修改' },
      { hunkIds: ['h2'], label: '第二处修改', narrationText: '再看第二处修改' },
    ],
    ...extra,
  }, patch);

const renderStandard = (scene: Scene, options: { frame?: number; width?: number; height?: number; styleId?: string } = {}): string =>
  renderToStaticMarkup(createElement(CodeSceneView, {
    scene,
    styleId: (options.styleId ?? 'minimal-tech') as never,
    frame: options.frame ?? 0,
    width: options.width ?? LANDSCAPE.width,
    height: options.height ?? LANDSCAPE.height,
  }));

const htmlProps = (scene: Scene, options: { frame?: number; width?: number; height?: number; styleId?: string } = {}) => ({
  scene,
  styleId: (options.styleId ?? 'minimal-tech') as never,
  frame: options.frame ?? 0,
  width: options.width ?? LANDSCAPE.width,
  height: options.height ?? LANDSCAPE.height,
  fps: 30,
});

const renderHtmlInner = (scene: Scene, options: { frame?: number; width?: number; height?: number; styleId?: string } = {}): string =>
  renderCodeHtmlScene(htmlProps(scene, options) as never);

const renderHtmlWrapper = (scene: Scene, options: { frame?: number; width?: number; height?: number; styleId?: string } = {}): string =>
  renderToStaticMarkup(createElement(CodeHtmlSceneView, htmlProps(scene, options) as never));

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const visibleText = (markup: string): string => decodeEntities(markup.replace(/<[^>]*>/g, ''));
const styleOf = (tag: string): string => /style="([^"]*)"/.exec(tag)?.[1] ?? '';
const opacityOf = (tag: string): number | undefined => {
  const match = /opacity:\s*([\d.]+)/.exec(styleOf(tag));
  return match ? Number(match[1]) : undefined;
};
const colorOf = (tag: string): string | undefined => /color:\s*(#[0-9a-f]{3,8})/i.exec(styleOf(tag))?.[1]?.toLowerCase();
const backgroundOf = (tag: string): string | undefined => /background(?:-color)?:\s*(#[0-9a-f]{3,8})/i.exec(styleOf(tag))?.[1]?.toLowerCase();

type DiffRow = {
  kind: 'add' | 'remove' | 'context';
  active: boolean;
  openTag: string;
  style: string;
  marker: string;
  markerTag: string;
  oldLine?: number;
  newLine?: number;
  text: string;
  contentRegion: string;
  innerRegion: string;
};

/** Standard diff 行：按 data-diff-kind 定位，解析 marker/旧新行号/content。 */
function standardDiffRows(markup: string): DiffRow[] {
  return [...markup.matchAll(/<div\b[^>]*\bdata-diff-kind="(add|remove|context)"[^>]*>/g)].map(match => {
    const openTag = match[0];
    const start = match.index! + openTag.length;
    const end = markup.indexOf('</div>', start);
    const region = markup.slice(start, end === -1 ? undefined : end);
    const markerSpan = /<span\b[^>]*class="diff-marker"[^>]*>([\s\S]*?)<\/span>/.exec(region);
    const oldSpan = /<span\b[^>]*class="diff-old-line-number"[^>]*>([\s\S]*?)<\/span>/.exec(region);
    const newSpan = /<span\b[^>]*class="diff-new-line-number"[^>]*>([\s\S]*?)<\/span>/.exec(region);
    const contentStart = region.search(/<span\b[^>]*class="diff-content"[^>]*>/);
    const contentRegion = contentStart === -1 ? '' : region.slice(region.indexOf('>', contentStart) + 1);
    const style = styleOf(openTag);
    const oldAttr = oldSpan ? /data-old-line="(\d+)"/.exec(oldSpan[0])?.[1] : undefined;
    const newAttr = newSpan ? /data-new-line="(\d+)"/.exec(newSpan[0])?.[1] : undefined;
    const oldText = visibleText(oldSpan?.[1] ?? '').trim();
    const newText = visibleText(newSpan?.[1] ?? '').trim();
    return {
      kind: match[1] as DiffRow['kind'],
      active: /data-diff-active="true"/.test(openTag),
      openTag,
      style,
      marker: visibleText(markerSpan?.[1] ?? ''),
      markerTag: /<span\b[^>]*class="diff-marker"[^>]*>/.exec(region)?.[0] ?? '',
      oldLine: oldAttr ? Number(oldAttr) : oldText ? Number(oldText) : undefined,
      newLine: newAttr ? Number(newAttr) : newText ? Number(newText) : undefined,
      text: visibleText(contentRegion),
      contentRegion,
      innerRegion: region,
    };
  });
}

type HtmlDiffRow = { kind: string; active: boolean; classes: string[]; marker: string; oldLine?: number; newLine?: number; text: string };

/** HTML diff 行：按 class="diff-line …" 定位。 */
function htmlDiffRows(inner: string): HtmlDiffRow[] {
  const result: HtmlDiffRow[] = [];
  let from = 0;
  while (true) {
    const markerIndex = inner.indexOf('class="diff-line', from);
    if (markerIndex === -1) break;
    const valueStart = markerIndex + 'class="'.length;
    const valueEnd = inner.indexOf('"', valueStart);
    const classValue = inner.slice(valueStart, valueEnd);
    const tagEnd = inner.indexOf('>', valueEnd);
    const rowEnd = inner.indexOf('</div>', tagEnd);
    const region = inner.slice(tagEnd + 1, rowEnd === -1 ? undefined : rowEnd);
    const markerSpan = /<span\b[^>]*class="diff-marker"[^>]*>([\s\S]*?)<\/span>/.exec(region);
    const oldSpan = /<span\b[^>]*class="diff-old-line-number"[^>]*>([\s\S]*?)<\/span>/.exec(region);
    const newSpan = /<span\b[^>]*class="diff-new-line-number"[^>]*>([\s\S]*?)<\/span>/.exec(region);
    const contentStart = region.search(/<span\b[^>]*class="diff-content"[^>]*>/);
    const contentRegion = contentStart === -1 ? '' : region.slice(region.indexOf('>', contentStart) + 1);
    const classes = classValue.split(/\s+/).filter(Boolean);
    result.push({
      kind: classes.includes('add') ? 'add' : classes.includes('remove') ? 'remove' : 'context',
      active: classes.includes('diff-active'),
      classes,
      marker: visibleText(markerSpan?.[1] ?? ''),
      oldLine: (() => {
        const text = visibleText(oldSpan?.[1] ?? '').trim();
        return text ? Number(text) : undefined;
      })(),
      newLine: (() => {
        const text = visibleText(newSpan?.[1] ?? '').trim();
        return text ? Number(text) : undefined;
      })(),
      text: visibleText(contentRegion),
    });
    from = tagEnd + 1;
  }
  return result;
}

const translateYOf = (markup: string): number | undefined => {
  const match = /translateY\(\s*(-?[\d.]+)px\s*\)/.exec(markup);
  return match ? Number(match[1]) : undefined;
};

const frameState = (scene: Scene, frame: number, width = LANDSCAPE.width, height = LANDSCAPE.height) =>
  resolveCodeSceneFrameState({ scene, frame, width, height, fps: 30 });

const expectedDiff = (before: string, after: string): CodeDiffLine[] => computeCodeDiffView(before, after).lines;

// ═════════════════════════════ #26-7 Standard diff 渲染 ═══════════════════════

test('#26-7 Standard diff：统一行结构/kind/marker/旧新行号/token 文本、活动 hunk data-diff-active、其余行 dim 0.38', () => {
  const scene = diffScene();
  assert.equal(resolveCodeSceneMode(scene.visual as never), 'diff', '有效 diff scene 解析为 diff');
  const markup = renderStandard(scene, { frame: 0 });
  assert.match(markup, /data-code-diff="true"/, '根节点 data-code-diff=true');

  const rows = standardDiffRows(markup);
  const expected = expectedDiff(BEFORE_2HUNK, AFTER_2HUNK);
  assert.ok(rows.length > 0, '渲染 diff 行');
  assert.equal(rows.length, expected.length, `diff 行数 ${rows.length} = computeCodeDiffView ${expected.length}`);
  assert.deepEqual(rows.map(row => row.kind), expected.map(line => line.kind), 'kind 序列与 diff 计算一致');
  assert.deepEqual(rows.map(row => row.text), expected.map(line => line.text), '内容文本逐字一致');

  // 行号：context 两侧都有；add 只有新行号；remove 只有旧行号
  rows.forEach((row, index) => {
    const line = expected[index];
    if (line.kind === 'context') {
      assert.equal(row.oldLine, line.oldLine, `context 旧行号 ${row.oldLine} = ${line.oldLine}`);
      assert.equal(row.newLine, line.newLine, `context 新行号 ${row.newLine} = ${line.newLine}`);
    } else if (line.kind === 'add') {
      assert.equal(row.oldLine, undefined, 'add 无旧行号');
      assert.equal(row.newLine, line.newLine, 'add 新行号');
    } else {
      assert.equal(row.newLine, undefined, 'remove 无新行号');
      assert.equal(row.oldLine, line.oldLine, 'remove 旧行号');
    }
  });
  assert.ok(markup.includes('data-old-line='), '旧行号 span 携带 data-old-line');
  assert.ok(markup.includes('data-new-line='), '新行号 span 携带 data-new-line');
  assert.equal(rows.filter(row => row.kind === 'add')[0].marker, '+', 'add marker +');
  assert.equal(rows.filter(row => row.kind === 'remove')[0].marker, '-', 'remove marker -');
  assert.equal(rows.filter(row => row.kind === 'context')[0].marker, ' ', 'context marker 空格');

  // token span 照旧：内容 span 内有 tok-* span，文本逐字
  const firstContentRow = rows.find(row => row.text.length > 0)!;
  assert.match(firstContentRow.contentRegion, /class="tok-[a-z]+"/, '内容使用 token span');
  assert.equal(visibleText(firstContentRow.contentRegion).trimEnd(), firstContentRow.text, 'token 拼接文本逐字');

  // 活动 hunk 行 data-diff-active；其余行 opacity 0.38
  const activeRows = rows.map((row, index) => (row.active ? index : -1)).filter(index => index >= 0);
  const view = computeCodeDiffView(BEFORE_2HUNK, AFTER_2HUNK);
  assert.deepEqual(activeRows, Array.from({ length: view.hunks[0].lines.length }, (_, index) => view.hunks[0].startIndex + index), '第一个 beat 的活动行 = hunk1 行区间');
  for (const [index, row] of rows.entries()) {
    if (row.active) continue;
    assert.equal(opacityOf(row.openTag), CODE_DIM_OPACITY, `非活动行 ${index} opacity=0.38（实际 ${opacityOf(row.openTag)}）`);
  }

  // 跨 beat 切换活动 hunk
  const second = renderStandard(scene, { frame: 90 });
  const secondRows = standardDiffRows(second);
  const secondActive = secondRows.map((row, index) => (row.active ? index : -1)).filter(index => index >= 0);
  assert.deepEqual(secondActive, Array.from({ length: view.hunks[1].lines.length }, (_, index) => view.hunks[1].startIndex + index), '第二个 beat 的活动行 = hunk2 行区间');
  assert.notDeepEqual(activeRows, secondActive, '跨 beat 活动 hunk 切换');
  assert.ok(visibleText(second).includes('第二处修改'), 'beat 卡显示当前 beat label');
  assert.equal(visibleText(second).includes('第一处修改'), false, '不同时显示其它 beat label');
});

// ═════════════════════════════ #26-11 Standard 差异颜色来自主题调色板 ═══════════

test('#26-11 Standard diff 颜色来自 resolveCodeDiffColors：add/remove marker 与行背景使用主题色而非写死 GitHub 配色', () => {
  const scene = diffScene();
  for (const styleId of STYLE_IDS) {
    const colors = resolveCodeDiffColors(palettes[styleId]);
    const markup = renderStandard(scene, { frame: 0, styleId });
    const rows = standardDiffRows(markup);
    const addRow = rows.find(row => row.kind === 'add')!;
    const removeRow = rows.find(row => row.kind === 'remove')!;
    const contextRow = rows.find(row => row.kind === 'context')!;

    assert.equal(colorOf(addRow.markerTag), colors.add.fg.toLowerCase(), `${styleId}: add marker 颜色 = add.fg`);
    assert.equal(colorOf(removeRow.markerTag), colors.remove.fg.toLowerCase(), `${styleId}: remove marker 颜色 = remove.fg`);
    assert.equal(colorOf(contextRow.markerTag), colors.context.fg.toLowerCase(), `${styleId}: context marker 颜色 = context.fg`);
    assert.equal(backgroundOf(addRow.openTag), colors.add.bg.toLowerCase(), `${styleId}: add 行背景 = add.bg`);
    assert.equal(backgroundOf(removeRow.openTag), colors.remove.bg.toLowerCase(), `${styleId}: remove 行背景 = remove.bg`);
    assert.doesNotMatch(markup, /#2ea44f|#ffdce0|#f6f8fa|#e6ffec|#ffebe9/i, `${styleId}: 不使用写死的 GitHub diff 配色`);
    assert.doesNotMatch(markup, /NaN|undefined/, `${styleId}: 无 NaN/undefined`);
  }
});

// ═════════════════════════════ #26-8 HTML diff 与 Standard 语义一致 ═════════════

test('#26-8 HTML diff 与 Standard 一致：行序列 kind/文本/旧新行号/active 相同；class 契约经 sanitizer 保留；不输出模型 diff HTML', () => {
  const scene = diffScene({ html: '<div class="model-diff">MODEL-DIFF-HTML-SHOULD-NOT-RENDER</div>' });
  for (const frame of [0, 45, 90]) {
    const standard = standardDiffRows(renderStandard(scene, { frame }));
    const inner = renderHtmlInner(scene, { frame });
    const rows = htmlDiffRows(inner);
    assert.equal(rows.length, standard.length, `frame ${frame}: 行数一致`);
    assert.deepEqual(rows.map(row => row.kind), standard.map(row => row.kind), `frame ${frame}: kind 一致`);
    assert.deepEqual(rows.map(row => row.text), standard.map(row => row.text), `frame ${frame}: 文本逐字一致`);
    assert.deepEqual(rows.map(row => row.oldLine), standard.map(row => row.oldLine), `frame ${frame}: 旧行号一致`);
    assert.deepEqual(rows.map(row => row.newLine), standard.map(row => row.newLine), `frame ${frame}: 新行号一致`);
    assert.deepEqual(rows.map(row => row.active), standard.map(row => row.active), `frame ${frame}: 活动行一致`);
    assert.deepEqual(rows.map(row => row.marker), standard.map(row => row.marker), `frame ${frame}: marker 一致`);

    // class 契约保留
    assert.match(inner, /class="diff-line[^"]*\badd\b/, 'HTML 保留 diff-line add');
    assert.match(inner, /class="diff-line[^"]*\bremove\b/, 'HTML 保留 diff-line remove');
    assert.match(inner, /class="diff-line[^"]*\bcontext\b/, 'HTML 保留 diff-line context');
    assert.ok(rows.some(row => row.active), 'HTML 保留 diff-active');
    assert.match(inner, /class="diff-marker"/, 'diff-marker 保留');
    assert.match(inner, /class="diff-old-line-number"/, 'diff-old-line-number 保留');
    assert.match(inner, /class="diff-new-line-number"/, 'diff-new-line-number 保留');
    assert.match(inner, /class="diff-content"/, 'diff-content 保留');

    // 不输出模型 diff HTML
    assert.equal(inner.includes('MODEL-DIFF-HTML-SHOULD-NOT-RENDER'), false, 'HTML 不使用模型生成的 diff HTML');
    const wrapper = renderHtmlWrapper(scene, { frame });
    assert.equal(wrapper.includes('MODEL-DIFF-HTML-SHOULD-NOT-RENDER'), false, '包装节点不输出模型 diff HTML');
    assert.match(wrapper, /data-code-html-scene="true"/);
  }

  // HTML 颜色同样来自主题调色板
  const colors = resolveCodeDiffColors(palettes['minimal-tech']);
  const inner = renderHtmlInner(scene, { frame: 0 });
  assert.ok(inner.toLowerCase().includes(colors.add.fg.toLowerCase()), 'HTML add 颜色来自调色板');
  assert.ok(inner.toLowerCase().includes(colors.remove.fg.toLowerCase()), 'HTML remove 颜色来自调色板');
});

// ═════════════════════════════ #26-8 diff 恶意源码转义 ════════════════════════

test('#26-8 diff 恶意源码转义：</span><script>、a < b && c > d 逐字显示，Standard/HTML 均无可执行内容', () => {
  const evilBefore = [
    'const safe = 1;',
    'const evil = "</span><script>alert(1)</script>";',
    'if (a < b && c > d) {',
    '  return a;',
    '}',
  ].join('\n');
  const evilAfter = evilBefore.replace('const safe = 1;', 'const safe = 2;');
  const scene = sceneOf({ code: evilAfter, mode: 'diff', beforeCode: evilBefore, afterCode: evilAfter });
  const expected = expectedDiff(evilBefore, evilAfter);

  for (const frame of [0, 90]) {
    const standard = renderStandard(scene, { frame });
    const rows = standardDiffRows(standard);
    assert.deepEqual(rows.map(row => row.text), expected.map(line => line.text), `frame ${frame}: Standard 恶意源码逐字显示`);
    assert.doesNotMatch(standard, /<script\b/i, `frame ${frame}: Standard 不产生 script 标签`);
    for (const tag of standard.match(/<[a-zA-Z][^>]*>/g) ?? []) {
      assert.doesNotMatch(tag, /\bon[a-z]+\s*=/i, `frame ${frame}: Standard 无事件属性 ${tag}`);
    }

    const inner = renderHtmlInner(scene, { frame });
    const htmlRows = htmlDiffRows(inner);
    assert.deepEqual(htmlRows.map(row => row.text), expected.map(line => line.text), `frame ${frame}: HTML 恶意源码逐字显示`);
    assert.doesNotMatch(inner, /<script\b/i, `frame ${frame}: HTML 不产生 script 标签`);
    assert.doesNotMatch(inner, /<\/script/i, `frame ${frame}: HTML 不产生 script 闭合标签`);
    for (const tag of inner.match(/<[a-zA-Z][^>]*>/g) ?? []) {
      assert.doesNotMatch(tag, /\bon[a-z]+\s*=/i, `frame ${frame}: HTML 无事件属性 ${tag}`);
      assert.doesNotMatch(tag, /javascript:/i, `frame ${frame}: HTML 无 javascript: 属性`);
    }
    // 再经一次 sanitizer 后源码逐字不变
    const sanitized = sanitizeSceneHtml(inner);
    assert.deepEqual(htmlDiffRows(sanitized).map(row => row.text), expected.map(line => line.text), `frame ${frame}: sanitizer 后源码逐字一致`);
  }
  // 恶意文本作为源码文本可见
  assert.ok(visibleText(renderHtmlInner(scene, { frame: 0 })).includes('alert(1)'), '恶意源码作为文本显示');
  assert.ok(visibleText(renderHtmlInner(scene, { frame: 0 })).includes('if (a < b && c > d) {'), '比较运算符源码逐字显示');
});

// ═════════════════════════════ #26-9 diff viewport ════════════════════════════

test('#26-9 diff viewport：长 diff 多 hunk 跨 beat 滚动、startLine/translatePx 正确 clamp、横竖屏整行无左右分栏、字号≥16*scale、Standard=HTML', () => {
  const scene = sceneOf({ code: AFTER_LONG, mode: 'diff', beforeCode: BEFORE_LONG, afterCode: AFTER_LONG });
  const view = computeCodeDiffView(BEFORE_LONG, AFTER_LONG);
  assert.ok(view.hunks.length >= 5, `5 处变更生成 ≥5 hunk（实际 ${view.hunks.length}）`);
  assert.ok(view.lines.length > 14, `diff 行数 ${view.lines.length} 超出横屏 viewport`);

  const state0 = frameState(scene, 0);
  assert.equal(state0.mode, 'diff');
  assert.ok(state0.diff, 'diff 状态非空');
  assert.equal(state0.rowCount, view.lines.length, 'diff rowCount = diff.lines.length');
  assert.ok(state0.stepCount >= 5, `stepCount=${state0.stepCount}（每 hunk 默认一条 beat）`);
  assert.deepEqual(state0.build, null);
  assert.deepEqual(state0.trace, null);

  const timelineFrames: number[] = [];
  for (let index = 0; index < state0.stepCount; index += 1) {
    timelineFrames.push(Math.round(180 * index / state0.stepCount));
  }
  const states = timelineFrames.map(frame => frameState(scene, frame));
  const starts = states.map(state => state.startLine);
  assert.equal(starts[0], 1, '首个 beat 首部 clamp 到 1');
  assert.ok(starts[starts.length - 1] > 1, `跨 beat 产生滚动（${starts.join(',')}）`);
  for (const [index, state] of states.entries()) {
    assert.equal(state.translatePx, (1 - state.startLine) * state.layout.lineHeightPx, `beat ${index}: translatePx 公式`);
    assert.ok(state.startLine >= 1, 'startLine ≥ 1');
    const maxStart = Math.max(1, view.lines.length - state.visibleLineCount + 1);
    assert.ok(state.startLine <= maxStart, `beat ${index}: startLine ≤ maxStart（${state.startLine} ≤ ${maxStart}）`);
    // 当前活动 hunk 的行在可见窗口内
    for (const activeRow of state.diff!.activeRows) {
      const rowNumber = activeRow + 1;
      assert.ok(rowNumber >= state.startLine && rowNumber < state.startLine + state.visibleLineCount, `beat ${index}: 活动行 ${rowNumber} 在窗口 ${state.startLine}..${state.startLine + state.visibleLineCount - 1}`);
    }
  }

  // Standard 与 HTML 同 frame 的 translateY 相等（≤1e-6）
  for (const frame of timelineFrames) {
    const standardY = translateYOf(renderStandard(scene, { frame }));
    const htmlY = translateYOf(renderHtmlInner(scene, { frame }));
    assert.ok(Number.isFinite(standardY) && Number.isFinite(htmlY), `frame ${frame}: 两渲染器有 translateY`);
    assert.ok(Math.abs(standardY! - htmlY!) <= 1e-6, `frame ${frame}: Standard ${standardY} = HTML ${htmlY}`);
  }

  // 横竖屏：整行宽度、无左右分栏、字号保护
  for (const frame of [LANDSCAPE, PORTRAIT]) {
    const portrait = frame.height > frame.width;
    const scale = rendererScale(frame.width, frame.height);
    const layout = resolveCodeSceneLayout({ width: frame.width, height: frame.height, hasBeats: true, hasBeatCard: true, captionReservedPx: 0 });
    assert.ok(layout.fontSizePx >= 16 * scale, `${frame.width}x${frame.height}: 字号 ≥16*scale`);
    if (portrait) assert.ok(layout.codeArea.widthPx >= frame.width * 0.9, '9:16 代码区接近整幅宽度（不做左右窄栏）');
    const markup = renderStandard(scene, { frame: 30, width: frame.width, height: frame.height });
    const rows = standardDiffRows(markup);
    assert.ok(rows.length > 0, `${frame.width}x${frame.height}: 渲染 diff 行`);
    for (const row of rows) {
      assert.equal((row.innerRegion.match(/class="diff-content"/g) ?? []).length, 1, '每行只有一个 diff-content（unified，不左右并排）');
    }
    assert.doesNotMatch(markup, /side-by-side|diff-columns|split-diff/i, '无左右分栏标记');
  }
});

// ═════════════════════════════ #26-10 HTML 非法 diff 数据安全降级 ══════════════

test('#26-10 非法 diff 数据在 HTML/Standard 渲染中安全降级 focus（不崩溃、无 NaN/undefined）', () => {
  const focusBaseline = sceneOf({ code: AFTER_2HUNK });
  const invalidDiffs: Scene[] = [
    sceneOf({ code: AFTER_2HUNK, mode: 'diff', beforeCode: BEFORE_2HUNK }), // 缺 afterCode
    sceneOf({ code: AFTER_2HUNK, mode: 'diff', beforeCode: BEFORE_2HUNK, afterCode: 'const different = 1;' }), // code≠afterCode
    sceneOf({ code: AFTER_2HUNK, mode: 'diff', beforeCode: AFTER_2HUNK, afterCode: AFTER_2HUNK }), // 无变更
    sceneOf({ code: AFTER_2HUNK, mode: 'diff', beforeCode: BEFORE_2HUNK, afterCode: AFTER_2HUNK, diffBeats: [{ hunkIds: ['h9'] }] }), // 合法格式但不存在 → 默认 beat（仍有效）
  ];
  for (const [index, scene] of invalidDiffs.entries()) {
    assert.doesNotThrow(() => renderStandard(scene), `case ${index}: Standard 不抛错`);
    assert.doesNotThrow(() => renderHtmlInner(scene), `case ${index}: HTML 不抛错`);
    const markup = renderStandard(scene);
    assert.doesNotMatch(markup, /NaN|undefined/, `case ${index}: 无 NaN/undefined`);
    if (index === 3) {
      // 非法 beats 但 diff 数据有效 → 默认每 hunk 一条 beat，仍渲染 diff
      assert.equal(resolveCodeSceneMode(scene.visual as never), 'diff');
      assert.match(markup, /data-code-diff="true"/);
    } else {
      assert.equal(resolveCodeSceneMode(scene.visual as never), 'focus', `case ${index}: 回退 focus`);
      assert.doesNotMatch(markup, /data-code-diff="true"/, `case ${index}: 不渲染 diff`);
      assert.equal(markup, renderStandard(focusBaseline, { frame: 0 }), `case ${index}: 与 focus 渲染一致`);
    }
  }
});
