import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import {
  codeLines,
  rendererScale,
  resolveCodeBuildStepTimeline,
  resolveCodeSceneMode,
  SceneSchema,
  SceneTypeSchema,
  type Scene,
} from '@m2v/schema';
import { CodeHtmlSceneView, renderCodeHtmlScene } from '../src/code-html-scene';
import {
  CODE_DIM_OPACITY,
  CodeSceneView,
  resolveCodeSceneFrameState,
  resolveCodeSceneLayout,
} from '../src/code-scene';

/**
 * #25 契约：build 模式 Standard/HTML 逐步渲染、viewport 协同、确定性与降级
 * （doc/V1.7.0_issues.md §2.5 / §2.6 / §2.7）。
 */

// packages/video 没有 react-dom 依赖；从已安装 react-dom 的 apps/web 解析（与既有测试一致）。
const webRequire = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const { renderToStaticMarkup } = webRequire('react-dom/server') as { renderToStaticMarkup: (element: unknown) => string };

const LANDSCAPE = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };

const codeOf = (count: number) => Array.from({ length: count }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n');

/** 覆盖 1..8 的 4 步 build。 */
const BUILD_STEPS = [
  { revealLines: [1, 2], label: '第一步', narrationText: '先声明变量' },
  { revealLines: [3, 4], focusLines: [3], label: '第二步', narrationText: '再写判断' },
  { revealLines: [5, 6], focusLines: [5, 6], label: '第三步', narrationText: '然后写循环' },
  { revealLines: [7, 8], focusLines: [7, 8], label: '第四步', narrationText: '最后收尾' },
];

function sceneOf(visual: Record<string, unknown>, patch: Record<string, unknown> = {}): Scene {
  return {
    id: 'build-scene',
    type: 'code',
    title: '逐步构建',
    narration: '这一页讲解代码的逐步构建过程。',
    duration: 6,
    ...patch,
    visual: { code: codeOf(8), language: 'typescript', filename: 'build.ts', ...visual },
  } as Scene;
}

const buildScene = (patch: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
  const visual: Record<string, unknown> = { ...patch };
  return sceneOf(visual, extra);
};

const buildSceneWithSteps = (steps: unknown[], extra: Record<string, unknown> = {}) =>
  sceneOf({ mode: 'build', buildSteps: steps }, extra);

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

type Row = { lineNumber: number; openTag: string; style: string; text: string; active: boolean; dimmed: boolean; revealed: boolean; hiddenStyle: boolean };

/** Standard 每行：data-line-number 开标签 + 行内源码（去掉行号 span）。 */
function standardRows(markup: string): Row[] {
  return [...markup.matchAll(/<div[^>]*\bdata-line-number="(\d+)"[^>]*>/g)].map(match => {
    const openTag = match[0];
    const start = match.index! + openTag.length;
    const end = markup.indexOf('</div>', start);
    const inner = markup.slice(start, end === -1 ? undefined : end);
    const firstSpanClose = inner.indexOf('</span>');
    const content = firstSpanClose === -1 ? inner : inner.slice(firstSpanClose + '</span>'.length);
    const style = styleOf(openTag);
    return {
      lineNumber: Number(match[1]),
      openTag,
      style,
      text: visibleText(content),
      active: /data-active="true"/.test(openTag),
      dimmed: /data-dimmed="true"/.test(openTag),
      revealed: !/data-revealed="false"/.test(openTag),
      hiddenStyle: /visibility:\s*hidden/.test(style),
    };
  });
}

type HtmlRow = { lineNumber: number; classes: string[]; style: string; text: string };

/** HTML 内层每行（div.code-line … + span.line-number + 内容）。 */
function htmlRows(inner: string): HtmlRow[] {
  const result: HtmlRow[] = [];
  let from = 0;
  while (true) {
    const markerIndex = inner.indexOf('class="code-line', from);
    if (markerIndex === -1) break;
    const valueStart = markerIndex + 'class="'.length;
    const valueEnd = inner.indexOf('"', valueStart);
    const classValue = inner.slice(valueStart, valueEnd);
    const tagEnd = inner.indexOf('>', valueEnd);
    const lineEnd = inner.indexOf('</div>', tagEnd);
    const region = inner.slice(tagEnd + 1, lineEnd === -1 ? undefined : lineEnd);
    const lineNumberSpan = /<span\b[^>]*class="line-number"[^>]*>[\s\S]*?<\/span>/.exec(region);
    const content = lineNumberSpan ? region.replace(lineNumberSpan[0], '') : region;
    result.push({
      lineNumber: Number(visibleText(lineNumberSpan?.[0] ?? '').trim()),
      classes: classValue.split(/\s+/).filter(Boolean),
      style: styleOf(inner.slice(inner.lastIndexOf('<', markerIndex), tagEnd)),
      text: visibleText(content),
    });
    from = tagEnd + 1;
  }
  return result;
}

const rowStyle = (inner: string, row: HtmlRow): string => {
  const marker = `class="code-line`;
  for (const match of inner.matchAll(/<div\b[^>]*>/g)) {
    const tag = match[0];
    if (!/class="code-line/.test(tag)) continue;
    if (tag.includes('class="code-line')) {
      return styleOf(tag);
    }
  }
  return row.style ?? '';
};

/** 抽取 HTML 每行的开标签样式：按出现顺序与 htmlRows 对齐。 */
function htmlRowStyles(inner: string): string[] {
  return [...inner.matchAll(/<div\b[^>]*class="code-line[^"]*"[^>]*>/g)].map(match => styleOf(match[0]));
}

const translateYOf = (markup: string): number | undefined => {
  const match = /translateY\(\s*(-?[\d.]+)px\s*\)/.exec(markup);
  return match ? Number(match[1]) : undefined;
};

const frameState = (scene: Scene, frame: number, width = LANDSCAPE.width, height = LANDSCAPE.height) =>
  resolveCodeSceneFrameState({ scene, frame, width, height, fps: 30 });

const stepStarts = (scene: Scene) => resolveCodeBuildStepTimeline(scene as unknown as Record<string, unknown>, 30);

// ═════════════════════════════ #25-4 Standard build 渲染 ══════════════════════

test('#25-4 Standard build：未出现行 data-revealed=false + visibility:hidden；当前步 focus 行 active、其余已出现行 dim(0.38)；无逐字符打字', () => {
  const scene = buildSceneWithSteps(BUILD_STEPS);
  const timeline = stepStarts(scene);
  assert.equal(timeline.length, 4, '4 个 build 步骤');

  const step0 = renderStandard(scene, { frame: timeline[0].startFrame });
  const rows0 = standardRows(step0);
  assert.deepEqual(rows0.map(row => row.lineNumber), [1, 2, 3, 4, 5, 6, 7, 8], '所有源码行都渲染（行号稳定）');
  assert.deepEqual(rows0.filter(row => row.revealed).map(row => row.lineNumber), [1, 2], 'step0 只出现 revealLines 1,2');
  for (const row of rows0.filter(row => !row.revealed)) {
    assert.match(row.openTag, /data-revealed="false"/, `未出现行 ${row.lineNumber} 标记 data-revealed=false`);
    assert.ok(row.hiddenStyle, `未出现行 ${row.lineNumber} visibility:hidden`);
  }
  for (const row of rows0.filter(row => row.revealed)) {
    assert.equal(row.hiddenStyle, false, `已出现行 ${row.lineNumber} 不隐藏`);
  }
  assert.deepEqual(rows0.filter(row => row.active).map(row => row.lineNumber), [1, 2], 'step0 focus 行 active');
  assert.deepEqual(rows0.filter(row => row.dimmed).map(row => row.lineNumber), [], 'step0 无已出现的非焦点行');

  // step1：revealed 1..4，focus [3] active，其余已出现 1,2,4 dim
  const step1 = renderStandard(scene, { frame: timeline[1].startFrame });
  const rows1 = standardRows(step1);
  assert.deepEqual(rows1.filter(row => row.revealed).map(row => row.lineNumber), [1, 2, 3, 4], 'step1 累积 reveal 1..4');
  assert.deepEqual(rows1.filter(row => row.active).map(row => row.lineNumber), [3], 'step1 focus 行 3');
  const dimmed1 = rows1.filter(row => row.dimmed);
  assert.deepEqual(dimmed1.map(row => row.lineNumber), [1, 2, 4], 'step1 其余已出现行 dim');
  for (const row of dimmed1) {
    assert.equal(opacityOf(row.openTag), CODE_DIM_OPACITY, `dim 行 ${row.lineNumber} opacity=${CODE_DIM_OPACITY}`);
  }
  for (const row of rows1.filter(row => row.revealed && !row.active)) assert.match(row.openTag, /data-dimmed="true"/);

  // step2 / step3
  const rows2 = standardRows(renderStandard(scene, { frame: timeline[2].startFrame }));
  assert.deepEqual(rows2.filter(row => row.revealed).map(row => row.lineNumber), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(rows2.filter(row => row.active).map(row => row.lineNumber), [5, 6]);
  const rows3 = standardRows(renderStandard(scene, { frame: timeline[3].startFrame }));
  assert.deepEqual(rows3.filter(row => row.revealed).map(row => row.lineNumber), [1, 2, 3, 4, 5, 6, 7, 8], '最后一步全部出现');
  assert.deepEqual(rows3.filter(row => row.active).map(row => row.lineNumber), [7, 8]);
  assert.deepEqual(rows3.filter(row => row.dimmed).map(row => row.lineNumber), [1, 2, 3, 4, 5, 6]);

  // 无逐字符打字：同一行文本在任何 frame 都完整等于源码行（不随 frame 增长）
  const source = codeLines(sceneOf({}).visual.code as string);
  for (const frame of [timeline[0].startFrame, timeline[0].endFrame - 1, timeline[1].startFrame, timeline[3].startFrame]) {
    const rows = standardRows(renderStandard(scene, { frame }));
    for (const row of rows) assert.equal(row.text, source[row.lineNumber - 1], `frame ${frame} 行 ${row.lineNumber} 文本完整`);
  }
  assert.equal(visibleText(step0).includes('const line1 = 1;'), true, 'step0 可见整行源码');
  assert.doesNotMatch(step0, /data-code-diff="true"/, 'build 不输出 diff 标记');
  assert.doesNotMatch(step0, /data-trace-panel="true"/, 'build 不输出 trace 面板');
});

// ═════════════════════════════ #25-5 HTML build 与 Standard 一致 ══════════════

test('#25-5 HTML build 与 Standard 一致：可见/active/dim/hidden、行号、源码文本一致；hidden 行 visibility 经 sanitizer 保留；长代码不丢行', () => {
  const scene = buildSceneWithSteps(BUILD_STEPS);
  const timeline = stepStarts(scene);
  for (const step of timeline) {
    const frame = step.startFrame;
    const standard = standardRows(renderStandard(scene, { frame }));
    const inner = renderHtmlInner(scene, { frame });
    const rows = htmlRows(inner);
    const styles = htmlRowStyles(inner);
    assert.equal(rows.length, standard.length, `frame ${frame}: HTML 行数等于 Standard 行数`);
    assert.deepEqual(rows.map(row => row.lineNumber), standard.map(row => row.lineNumber), `frame ${frame}: 行号一致 1..N`);
    assert.deepEqual(rows.map(row => row.text), standard.map(row => row.text), `frame ${frame}: 源码文本逐字一致`);

    const htmlRevealed = rows.filter(row => !row.classes.includes('hidden')).map(row => row.lineNumber);
    const standardRevealed = standard.filter(row => row.revealed).map(row => row.lineNumber);
    assert.deepEqual(htmlRevealed, standardRevealed, `frame ${frame}: 可见行集合一致`);
    assert.deepEqual(rows.filter(row => row.classes.includes('active')).map(row => row.lineNumber), standard.filter(row => row.active).map(row => row.lineNumber), `frame ${frame}: active 一致`);
    assert.deepEqual(rows.filter(row => row.classes.includes('dim')).map(row => row.lineNumber), standard.filter(row => row.dimmed).map(row => row.lineNumber), `frame ${frame}: dim 一致`);

    // hidden 行 class=hidden 且 visibility:hidden 经 sanitizer 保留
    rows.forEach((row, index) => {
      const style = styles[index] ?? row.style;
      if (row.classes.includes('hidden')) {
        assert.match(style, /visibility:\s*hidden/, `frame ${frame}: hidden 行 ${row.lineNumber} visibility:hidden 保留`);
      } else {
        assert.doesNotMatch(style, /visibility:\s*hidden/, `frame ${frame}: 可见行 ${row.lineNumber} 不隐藏`);
      }
    });
  }

  // 60 行长代码 + 6 步 build：分块 sanitize 后不丢行/半截标签
  const longSteps = Array.from({ length: 6 }, (_, index) => ({ revealLines: Array.from({ length: 10 }, (_, row) => index * 10 + row + 1), label: `第${index + 1}段` }));
  const longScene = sceneOf({ code: codeOf(60), mode: 'build', buildSteps: longSteps });
  const longInner = renderHtmlInner(longScene, { frame: 90 });
  const longRows = htmlRows(longInner);
  assert.equal(longRows.length, 60, '60 行全部渲染');
  assert.deepEqual(longRows.map(row => row.lineNumber), Array.from({ length: 60 }, (_, index) => index + 1));
  assert.deepEqual(longRows.map(row => row.text), codeLines(codeOf(60)));
  assert.ok(longInner.lastIndexOf('<') < longInner.lastIndexOf('>'), 'HTML 尾部不是半截标签');
  assert.equal((longInner.match(/<div\b/g) ?? []).length, (longInner.match(/<\/div>/g) ?? []).length, 'div 标签配对');

  // 200 行代码 + 12 步 build（上限）：分块 sanitize 后仍逐行完整、无丢行/半截标签
  const code200 = codeOf(200);
  const lengths = [17, 17, 17, 17, 17, 17, 17, 17, 16, 16, 16, 16];
  let cursor = 1;
  const steps200 = lengths.map(length => {
    const revealLines = Array.from({ length }, (_, index) => cursor + index);
    cursor += length;
    return { revealLines };
  });
  assert.equal(cursor - 1, 200, '12 步覆盖 200 行');
  const scene200 = sceneOf({ code: code200, mode: 'build', buildSteps: steps200 });
  const inner200 = renderHtmlInner(scene200, { frame: 150 });
  const rows200 = htmlRows(inner200);
  assert.equal(rows200.length, 200, '200 行全部渲染');
  assert.deepEqual(rows200.map(row => row.text), codeLines(code200), '200 行逐字完整');
  assert.ok(inner200.lastIndexOf('<') < inner200.lastIndexOf('>'), '200 行 HTML 尾部不是半截标签');
  assert.equal((inner200.match(/<div\b/g) ?? []).length, (inner200.match(/<\/div>/g) ?? []).length, '200 行 div 配对');
  assert.equal((inner200.match(/<span\b/g) ?? []).length, (inner200.match(/<\/span>/g) ?? []).length, '200 行 span 配对');

  // 外层包装节点
  const wrapper = renderHtmlWrapper(scene);
  assert.match(wrapper, /data-code-scene="true"/);
  assert.match(wrapper, /data-code-html-scene="true"/);
  assert.doesNotMatch(wrapper, /NaN|undefined/);
});

// ═════════════════════════════ #25-6 build viewport 协同 ═════════════════════

test('#25-6 build viewport：60 行、跨 viewport 步骤 startLine/translatePx 正确、首尾 clamp、同区不滚动、Standard=HTML', () => {
  const longSteps = Array.from({ length: 6 }, (_, index) => ({
    revealLines: Array.from({ length: 10 }, (_, row) => index * 10 + row + 1),
    focusLines: [index * 10 + 5],
  }));
  const scene = sceneOf({ code: codeOf(60), mode: 'build', buildSteps: longSteps });
  const timeline = stepStarts(scene);
  assert.equal(timeline.length, 6);
  const layout = resolveCodeSceneLayout({ width: LANDSCAPE.width, height: LANDSCAPE.height, hasBeats: true, hasBeatCard: true, captionReservedPx: 0 });
  const maxStart = 60 - layout.visibleLineCount + 1;

  const states = timeline.map(step => frameState(scene, step.startFrame));
  assert.equal(states[0].startLine, 1, '第一个 step 首部 clamp 到 1');
  assert.ok(states[states.length - 1].startLine <= maxStart, `最后 step startLine ≤ maxStart（${states[states.length - 1].startLine} ≤ ${maxStart}）`);
  assert.ok(states[states.length - 1].startLine > 1, '跨 viewport 步骤产生滚动');
  for (let index = 1; index < states.length; index += 1) {
    assert.ok(states[index].startLine >= states[index - 1].startLine, `startLine 单调不减：${states.map(state => state.startLine).join(',')}`);
  }
  for (const state of states) {
    assert.equal(state.startLine, Math.round(state.startLine), 'startLine 为整数行');
    assert.ok(state.startLine >= 1 && state.startLine <= maxStart, 'startLine clamp 在 [1, maxStart]');
    assert.equal(state.translatePx, (1 - state.startLine) * layout.lineHeightPx, 'translatePx = (1-startLine)*lineHeightPx');
  }

  // Standard 与 HTML 同 frame translateY 相等（≤1e-6）
  for (const step of timeline) {
    const standardY = translateYOf(renderStandard(scene, { frame: step.startFrame }));
    const htmlY = translateYOf(renderHtmlInner(scene, { frame: step.startFrame }));
    assert.ok(Number.isFinite(standardY) && Number.isFinite(htmlY), `frame ${step.startFrame}: 两渲染器都有 translateY`);
    assert.ok(Math.abs(standardY! - htmlY!) <= 1e-6, `frame ${step.startFrame}: Standard ${standardY} = HTML ${htmlY}`);
  }

  // 同区不滚动：两个 step 的 focus 行落在同一 viewport
  const sameArea = sceneOf({
    code: codeOf(60),
    mode: 'build',
    buildSteps: [
      { revealLines: Array.from({ length: 30 }, (_, index) => index + 1), focusLines: [20] },
      { revealLines: Array.from({ length: 30 }, (_, index) => index + 31), focusLines: [21] },
    ],
  });
  const sameTimeline = stepStarts(sameArea);
  const sameStates = sameTimeline.map(step => frameState(sameArea, step.startFrame));
  assert.equal(sameStates[0].startLine, sameStates[1].startLine, '同一 viewport 内不滚动');

  // 末尾 clamp：最后一个 step 的 focus 行在可见窗口内
  const lastState = states[states.length - 1];
  const lastFocus = longSteps[longSteps.length - 1].focusLines[0];
  assert.ok(lastFocus >= lastState.startLine && lastFocus <= lastState.startLine + lastState.visibleLineCount - 1, `末尾 focus 行 ${lastFocus} 在窗口 ${lastState.startLine}..${lastState.startLine + lastState.visibleLineCount - 1}`);
});

// ═════════════════════════════ #25-7 确定性与安全降级 ════════════════════════

test('#25-7 build 确定性/降级：重复渲染 deepEqual、缺可选字段不抛错无 NaN/undefined、无步骤时与 focus 渲染完全一致', () => {
  const scene = buildSceneWithSteps(BUILD_STEPS);
  const timeline = stepStarts(scene);
  for (const frame of [0, timeline[1].startFrame, timeline[3].startFrame]) {
    assert.equal(renderStandard(scene, { frame }), renderStandard(scene, { frame }), `frame ${frame}: Standard 重复渲染一致`);
    assert.equal(renderHtmlInner(scene, { frame }), renderHtmlInner(scene, { frame }), `frame ${frame}: HTML 重复渲染一致`);
  }

  // 缺 label/filename/language/步骤 label
  const bare = sceneOf({
    code: codeOf(8),
    mode: 'build',
    buildSteps: BUILD_STEPS.map(step => ({ revealLines: step.revealLines })),
  }, { title: undefined });
  const bareMarkup = renderStandard(bare);
  assert.doesNotMatch(bareMarkup, /NaN|undefined/, '缺可选字段无 NaN/undefined');
  assert.equal(standardRows(bareMarkup).length, 8);
  assert.doesNotMatch(bareMarkup, /data-beat-label="true"/, '无步骤 label 不渲染文本卡');

  // 无构建步骤的 build visual → 实际渲染 focus，与无 mode 的 focus 渲染完全一致
  const fallbackBuild = sceneOf({ mode: 'build', beats: [{ lines: [2], label: '命中' }] });
  const plainFocus = sceneOf({ beats: [{ lines: [2], label: '命中' }] });
  assert.equal(resolveCodeSceneMode(fallbackBuild.visual as never), 'focus');
  assert.equal(renderStandard(fallbackBuild, { frame: 30 }), renderStandard(plainFocus, { frame: 30 }), '无步骤 build 与 focus 渲染一致');
  assert.equal(renderHtmlInner(fallbackBuild, { frame: 30 }), renderHtmlInner(plainFocus, { frame: 30 }), 'HTML 同样回退 focus');

  // 非法 buildSteps 数据 → focus 渲染、不抛错（无 beats 时对比无 beats 的 focus 基线）
  const invalidBuild = sceneOf({ mode: 'build', buildSteps: [{ revealLines: [99] }] });
  const plainNoBeats = sceneOf({});
  assert.doesNotThrow(() => renderStandard(invalidBuild), '非法 buildSteps 不抛错');
  assert.equal(renderStandard(invalidBuild, { frame: 0 }), renderStandard(plainNoBeats, { frame: 0 }), '非法 buildSteps 回退 focus');
});

// ═════════════════════════════ #25-10 步骤数据一致性 ═════════════════════════

test('#25-10 resolveCodeSceneFrameState：displayRows 与 build.revealedLines 多 frame 一致；stepIndex/stepCount 与时间轴一致', () => {
  const scene = buildSceneWithSteps(BUILD_STEPS);
  const timeline = stepStarts(scene);
  const source = codeLines(codeOf(8));

  for (const [index, step] of timeline.entries()) {
    const state = frameState(scene, step.startFrame);
    assert.equal(state.mode, 'build');
    assert.equal(state.stepIndex, index, `stepIndex=${index}`);
    assert.equal(state.stepCount, BUILD_STEPS.length, 'stepCount=4');
    assert.equal(state.stepLabel, BUILD_STEPS[index].label, 'stepLabel 跟随当前步骤');
    assert.equal(state.rowCount, 8, 'build rowCount = 源码行数');
    assert.equal(state.activeLines.length > 0, true, 'activeLines 非空');

    const expectedRevealed = [...new Set(timeline.slice(0, index + 1).flatMap(frame => frame.revealLines))].sort((a, b) => a - b);
    assert.deepEqual(state.build?.revealedLines, expectedRevealed, `frame ${step.startFrame}: revealedLines 为 0..stepIndex 并集`);
    const expectedActive = BUILD_STEPS[index].focusLines ?? BUILD_STEPS[index].revealLines;
    assert.deepEqual(state.activeLines, [...expectedActive].sort((a, b) => a - b), 'activeLines = 当前 step focusLines');

    assert.equal(state.displayRows.length, 8, 'displayRows 含全部行不截断');
    for (const [rowIndex, row] of state.displayRows.entries()) {
      assert.equal(row.rowNumber, rowIndex + 1, 'rowNumber 1 基源码行号');
      assert.equal(row.text, source[rowIndex], 'text 为源码原文');
      assert.equal(row.revealed, expectedRevealed.includes(rowIndex + 1), `行 ${rowIndex + 1} revealed 与并集一致`);
      assert.equal(row.active, row.revealed && expectedActive.includes(rowIndex + 1), `行 ${rowIndex + 1} active`);
      assert.equal(row.dimmed, row.revealed && !row.active, `行 ${rowIndex + 1} dimmed`);
      assert.equal(row.kind, undefined, 'build 行无 diff kind');
      assert.equal(row.oldLineNumber, undefined);
      assert.equal(row.newLineNumber, undefined);
    }

    // 纯数据、可 deepEqual，无 NaN
    assert.deepEqual(state, frameState(scene, step.startFrame), '相同输入 deepEqual');
    assert.doesNotMatch(JSON.stringify(state), /NaN/, '状态无 NaN');
  }

  // frame 早于首步取首步、晚于末步取末步
  const first = frameState(scene, -5);
  assert.equal(first.stepIndex, 0, 'frame 早于首步取首步');
  const last = frameState(scene, 99999);
  assert.equal(last.stepIndex, timeline.length - 1, 'frame 晚于末步取末步');

  // focus 模式 stepIndex=-1、stepCount=0、build=null（回归不变）
  const focusState = frameState(sceneOf({ beats: [{ lines: [2], label: '命中' }] }), 0);
  assert.equal(focusState.mode, 'focus');
  assert.equal(focusState.stepIndex, -1);
  assert.equal(focusState.stepCount, 0);
  assert.equal(focusState.build, null);
});

// ═════════════════════════════ #25-8 既有回归（focus 渲染路径不变） ═════════

test('#25-8 既有 focus 渲染回归：无 build 字段时 active/dim/scroll 行为与 V1.6.9 契约一致、SceneTypeSchema 不变', () => {
  const scene = sceneOf({ beats: [{ lines: [2, 3], label: '命中' }, { lines: [7], label: '回源' }] });
  assert.ok((SceneTypeSchema.options as string[]).includes('code'));
  assert.equal((SceneTypeSchema.options as string[]).includes('html-code'), false);

  // 合法 build scene 也通过 SceneSchema
  assert.equal(SceneSchema.safeParse(buildSceneWithSteps(BUILD_STEPS)).success, true, 'build scene 通过 SceneSchema');

  const markup = renderStandard(scene, { frame: 0 });
  assert.match(markup, /data-code-scene="true"/);
  assert.doesNotMatch(markup, /data-revealed="false"/, 'focus 模式不输出 build 的 revealed 标记');
  const rows = standardRows(markup);
  assert.deepEqual(rows.map(row => row.lineNumber), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(rows.filter(row => row.active).map(row => row.lineNumber), [2, 3], 'focus active 行不变');
  assert.deepEqual(rows.filter(row => row.dimmed).map(row => row.lineNumber), [1, 4, 5, 6, 7, 8], 'focus dim 行不变');
  for (const row of rows.filter(row => row.dimmed)) assert.equal(opacityOf(row.openTag), CODE_DIM_OPACITY);
  assert.ok(Number.isFinite(translateYOf(markup)), 'focus 仍有滚动 translateY');
  assert.ok(rendererScale(LANDSCAPE.width, LANDSCAPE.height) > 0);
});
