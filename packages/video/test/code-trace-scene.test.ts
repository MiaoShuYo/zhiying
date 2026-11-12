import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import {
  rendererScale,
  resolveCodeSceneMode,
  resolveCodeTraceStepTimeline,
  type Scene,
} from '@m2v/schema';
import { palettes } from '@m2v/styles';
import { CodeHtmlSceneView, renderCodeHtmlScene } from '../src/code-html-scene';
import {
  CODE_DIM_OPACITY,
  CodeSceneView,
  resolveCodeSceneFrameState,
  resolveCodeSceneLayout,
} from '../src/code-scene';

/**
 * #27 契约：trace 模式代码行 + 执行状态卡（Variables/Output）、changed 强调与布局
 * （doc/V1.7.0_issues.md §2.5 / §2.6 / §2.7 / §2.9）。
 */

const webRequire = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const { renderToStaticMarkup } = webRequire('react-dom/server') as { renderToStaticMarkup: (element: unknown) => string };

const LANDSCAPE = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };
const STYLE_IDS = ['minimal-tech', 'clean-light', 'academic', 'social-short', 'whiteboard'] as const;

const codeOf = (count: number) => Array.from({ length: count }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n');

/** 3 个 trace step：state 变化、可选 output、callDepth。 */
const TRACE_STEPS = [
  {
    lines: [1, 2],
    label: '初始化',
    narrationText: '初始化变量',
    state: [{ name: 'sum', value: '0' }, { name: 'i', value: '0' }],
  },
  {
    lines: [4],
    label: '累加',
    narrationText: '累加当前元素',
    state: [{ name: 'sum', value: '3', changed: true }, { name: 'i', value: '1', changed: true }],
    output: '3',
    callDepth: 1,
  },
  {
    lines: [6],
    label: '返回',
    narrationText: '返回结果',
    state: [{ name: 'result', value: '3', changed: true }],
    output: '3',
    callDepth: 0,
  },
];

function sceneOf(visual: Record<string, unknown>, patch: Record<string, unknown> = {}): Scene {
  return {
    id: 'trace-scene',
    type: 'code',
    title: '执行跟踪',
    narration: '这一页跟踪代码的执行状态变化。',
    duration: 6,
    ...patch,
    visual: { code: codeOf(8), language: 'typescript', filename: 'trace.ts', ...visual },
  } as Scene;
}

const traceScene = (steps: unknown[] = TRACE_STEPS, patch: Record<string, unknown> = {}): Scene =>
  sceneOf({ mode: 'trace', traceSteps: steps }, patch);

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
const openTags = (markup: string): string[] => [...markup.matchAll(/<[a-zA-Z][^>]*>/g)].map(match => match[0]);
const tagsWith = (markup: string, pattern: RegExp): string[] => openTags(markup).filter(tag => pattern.test(tag));
const styleOf = (tag: string): string => /style="([^"]*)"/.exec(tag)?.[1] ?? '';
const colorOf = (tag: string): string | undefined => /color:\s*(#[0-9a-f]{3,8})/i.exec(styleOf(tag))?.[1]?.toLowerCase();
const fontWeightOf = (tag: string): string | undefined => /font-weight:\s*([\w]+)/.exec(styleOf(tag))?.[1];
const opacityOf = (tag: string): number | undefined => {
  const match = /opacity:\s*([\d.]+)/.exec(styleOf(tag));
  return match ? Number(match[1]) : undefined;
};
const classOf = (tag: string): string => /class="([^"]*)"/.exec(tag)?.[1] ?? '';

type CodeRow = { lineNumber: number; openTag: string; active: boolean; dimmed: boolean; text: string };

function standardCodeRows(markup: string): CodeRow[] {
  return [...markup.matchAll(/<div[^>]*\bdata-line-number="(\d+)"[^>]*>/g)].map(match => {
    const openTag = match[0];
    const start = match.index! + openTag.length;
    const end = markup.indexOf('</div>', start);
    const inner = markup.slice(start, end === -1 ? undefined : end);
    const firstSpanClose = inner.indexOf('</span>');
    const content = firstSpanClose === -1 ? inner : inner.slice(firstSpanClose + '</span>'.length);
    return {
      lineNumber: Number(match[1]),
      openTag,
      active: /data-active="true"/.test(openTag),
      dimmed: /data-dimmed="true"/.test(openTag),
      text: visibleText(content),
    };
  });
}

type HtmlCodeRow = { lineNumber: number; classes: string[]; text: string };

/** HTML 内层代码行（div.code-line …）。 */
function htmlCodeRows(markup: string): HtmlCodeRow[] {
  const result: HtmlCodeRow[] = [];
  let from = 0;
  while (true) {
    const markerIndex = markup.indexOf('class="code-line', from);
    if (markerIndex === -1) break;
    const valueStart = markerIndex + 'class="'.length;
    const valueEnd = markup.indexOf('"', valueStart);
    const classValue = markup.slice(valueStart, valueEnd);
    const tagEnd = markup.indexOf('>', valueEnd);
    const lineEnd = markup.indexOf('</div>', tagEnd);
    const region = markup.slice(tagEnd + 1, lineEnd === -1 ? undefined : lineEnd);
    const lineNumberSpan = /<span\b[^>]*class="line-number"[^>]*>[\s\S]*?<\/span>/.exec(region);
    const content = lineNumberSpan ? region.replace(lineNumberSpan[0], '') : region;
    result.push({
      lineNumber: Number(visibleText(lineNumberSpan?.[0] ?? '').trim()),
      classes: classValue.split(/\s+/).filter(Boolean),
      text: visibleText(content),
    });
    from = tagEnd + 1;
  }
  return result;
}

type StateRow = { name: string; value: string; changed: boolean; nameText: string; nameTag: string; valueText: string; valueTag: string; markerText: string; openTag: string; style: string };

/** Standard trace 状态行：data-trace-state-row + data-state-name/data-state-value span。 */
function standardStateRows(markup: string): StateRow[] {
  return [...markup.matchAll(/<div\b[^>]*data-trace-state-row="true"[^>]*>/g)].map(match => {
    const openTag = match[0];
    const start = match.index! + openTag.length;
    const end = markup.indexOf('</div>', start);
    const inner = markup.slice(start, end === -1 ? undefined : end);
    const nameSpan = /<span\b[^>]*data-state-name="([^"]*)"[^>]*>([\s\S]*?)<\/span>/.exec(inner);
    const valueSpan = /<span\b[^>]*data-state-value="([^"]*)"[^>]*>([\s\S]*?)<\/span>/.exec(inner);
    const markerTag = /<span\b[^>]*data-changed-marker="true"[^>]*>([\s\S]*?)<\/span>/.exec(inner);
    return {
      name: nameSpan?.[1] ?? '',
      value: valueSpan?.[1] ?? '',
      changed: /data-changed="true"/.test(openTag),
      nameTag: nameSpan?.[0] ?? '',
      nameText: visibleText(nameSpan?.[2] ?? '').trim(),
      valueTag: valueSpan?.[0] ?? '',
      valueText: visibleText(valueSpan?.[2] ?? '').trim(),
      markerText: visibleText(markerTag?.[1] ?? '').trim(),
      openTag,
      style: styleOf(openTag),
    };
  });
}

type HtmlStateRow = { name: string; changed: boolean; nameText: string; valueText: string; markerText: string; classes: string[] };

function htmlStateRows(inner: string): HtmlStateRow[] {
  const result: HtmlStateRow[] = [];
  let from = 0;
  while (true) {
    const markerIndex = inner.indexOf('class="trace-state-row', from);
    if (markerIndex === -1) break;
    const valueStart = markerIndex + 'class="'.length;
    const valueEnd = inner.indexOf('"', valueStart);
    const classValue = inner.slice(valueStart, valueEnd);
    const tagEnd = inner.indexOf('>', valueEnd);
    const rowEnd = inner.indexOf('</div>', tagEnd);
    const region = inner.slice(tagEnd + 1, rowEnd === -1 ? undefined : rowEnd);
    const nameSpan = /<span\b[^>]*class="[^"]*\btrace-state-name\b[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(region);
    const valueSpan = /<span\b[^>]*class="[^"]*\btrace-state-value\b[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(region);
    const markerSpan = /<span\b[^>]*class="[^"]*\bchanged-marker\b[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(region);
    const classes = classValue.split(/\s+/).filter(Boolean);
    result.push({
      name: nameSpan ? visibleText(nameSpan[1]).trim() : '',
      changed: classes.includes('changed'),
      nameText: visibleText(nameSpan?.[1] ?? '').trim(),
      valueText: visibleText(valueSpan?.[1] ?? '').trim(),
      markerText: visibleText(markerSpan?.[1] ?? '').trim(),
      classes,
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

const stepStarts = (scene: Scene) => resolveCodeTraceStepTimeline(scene as unknown as Record<string, unknown>, 30);

// ═════════════════════════════ #27-2 frame → active trace step ════════════════

test('#27-2 frame→active trace step：stepIndex/activeLines/trace.state/output/callDepth 随 frame 切换、旧 step 不残留', () => {
  const scene = traceScene();
  const timeline = stepStarts(scene);
  assert.equal(timeline.length, 3);
  assert.equal(resolveCodeSceneMode(scene.visual as never), 'trace');

  for (const [index, step] of timeline.entries()) {
    const state = frameState(scene, step.startFrame);
    assert.equal(state.mode, 'trace');
    assert.equal(state.stepIndex, index, `stepIndex=${index}`);
    assert.equal(state.stepCount, 3, 'stepCount=3');
    assert.equal(state.stepLabel, TRACE_STEPS[index].label, 'stepLabel 跟随当前步骤');
    assert.ok(state.trace, 'trace 状态非空');
    assert.deepEqual(state.activeLines, [...TRACE_STEPS[index].lines].sort((a, b) => a - b), 'activeLines = 当前 step lines');
    assert.deepEqual(state.trace!.state, TRACE_STEPS[index].state, 'trace.state 与当前 step 一致');
    assert.equal(state.trace!.output, TRACE_STEPS[index].output, 'output 与当前 step 一致');
    assert.equal(state.trace!.callDepth, TRACE_STEPS[index].callDepth, 'callDepth 与当前 step 一致');
    assert.equal(state.trace!.panelVisible, true, '有状态数据时面板可见');
    assert.equal(state.rowCount, 8, 'trace rowCount = 源码行数');
    assert.equal(state.diff, null);
    assert.equal(state.build, null);
    assert.deepEqual(state, frameState(scene, step.startFrame), '相同输入 deepEqual');
  }

  // 旧 step 数据不残留：不同 frame 的状态行 name 只来自当前 step
  const step0Text = visibleText(renderStandard(scene, { frame: timeline[0].startFrame }));
  assert.ok(step0Text.includes('sum') && step0Text.includes('i'), 'step0 显示 sum/i');
  assert.equal(step0Text.includes('result'), false, 'step0 不显示后续 step 的 result');
  const step2Text = visibleText(renderStandard(scene, { frame: timeline[2].startFrame }));
  assert.ok(step2Text.includes('result'), '最后一步显示 result');
  assert.equal(step2Text.includes('sum'), false, '最后一步不残留 sum');

  // frame 早于首步取首步、晚于末步取末步
  assert.equal(frameState(scene, -10).stepIndex, 0);
  assert.equal(frameState(scene, 99999).stepIndex, 2);
});

// ═════════════════════════════ #27-3 changed 强调 ═════════════════════════════

test('#27-3 changed 强调：data-changed/data-changed-marker、value 用 accent 且加粗；未 changed 行稳定无 marker/无逐帧闪烁', () => {
  const scene = traceScene();
  const timeline = stepStarts(scene);
  const markup = renderStandard(scene, { frame: timeline[1].startFrame });
  const rows = standardStateRows(markup);
  assert.equal(rows.length, 2, 'step1 两行状态');
  const sumRow = rows.find(row => row.name === 'sum')!;
  const iRow = rows.find(row => row.name === 'i')!;
  const palette = palettes['minimal-tech'];
  for (const row of [sumRow, iRow]) {
    assert.match(row.openTag, /data-changed="true"/, `${row.name} 标记 changed`);
    assert.equal(row.markerText, '←', `${row.name} 显示 ← 标记`);
    assert.match(row.valueTag, /color:\s*#[0-9a-f]{6}/i);
    assert.equal(colorOf(row.nameTag), palette.muted.toLowerCase(), `${row.name} name 使用 colors.muted`);
    assert.equal(colorOf(row.valueTag), palette.accent.toLowerCase(), `${row.name} changed value 使用 colors.accent`);
    assert.equal(fontWeightOf(row.openTag), '700', `${row.name} changed 行 font-weight:700`);
  }

  // 未 changed 行（step0）：无 marker、行不加粗、value 用 colors.fg
  const step0Rows = standardStateRows(renderStandard(scene, { frame: timeline[0].startFrame }));
  for (const row of step0Rows) {
    assert.equal(/data-changed="true"/.test(row.openTag), false, `${row.name} 未 changed`);
    assert.equal(row.markerText, '', `${row.name} 无 ← 标记`);
    assert.notEqual(fontWeightOf(row.openTag), '700', `${row.name} 行不加粗`);
    assert.equal(colorOf(row.valueTag), palette.fg.toLowerCase(), `${row.name} 未 changed value 使用 colors.fg`);
  }

  // 未变化变量在相邻 frame 之间文本/样式稳定（无闪烁）
  const customSteps = [
    { lines: [1], label: '一', state: [{ name: 'alpha', value: '1' }, { name: 'beta', value: '0' }] },
    { lines: [2], label: '二', state: [{ name: 'alpha', value: '1' }, { name: 'beta', value: '2', changed: true }] },
  ];
  const custom = traceScene(customSteps);
  const customTimeline = stepStarts(custom);
  const alphaBefore = standardStateRows(renderStandard(custom, { frame: customTimeline[0].startFrame })).find(row => row.name === 'alpha')!;
  const alphaAfter = standardStateRows(renderStandard(custom, { frame: customTimeline[1].startFrame })).find(row => row.name === 'alpha')!;
  assert.equal(alphaBefore.valueText, alphaAfter.valueText, 'alpha 值不变');
  assert.equal(alphaBefore.changed, false);
  assert.equal(alphaAfter.changed, false);
  assert.equal(alphaBefore.markerText, alphaAfter.markerText, 'alpha 无 marker，前后稳定');
  assert.equal(alphaBefore.valueTag.replace(/style="[^"]*"/, ''), alphaAfter.valueTag.replace(/style="[^"]*"/, ''), 'alpha 结构稳定');
  const betaAfter = standardStateRows(renderStandard(custom, { frame: customTimeline[1].startFrame })).find(row => row.name === 'beta')!;
  assert.equal(betaAfter.changed, true, 'beta 变化时标记 changed');

  // 面板/状态行无持续动画属性
  assert.doesNotMatch(markup, /animation|@keyframes|data-frame-animation/, '无逐帧闪烁动画');
});

// ═════════════════════════════ #27-4 output 可选 ══════════════════════════════

test('#27-4 output 可选：有 output 渲染 text；无 output 不渲染空区块；state 空+output 只渲染 output；都无 → 无面板且布局与 focus 一致', () => {
  const timeline = stepStarts(traceScene());

  // 有 output
  const withOutput = renderStandard(traceScene(), { frame: timeline[1].startFrame });
  assert.match(withOutput, /data-trace-section="output"/, '有 output 区块');
  assert.ok(visibleText(withOutput).includes('3'), 'output 文本渲染');

  // state 空 + output 存在 → panelVisible=true 且只渲染 output
  const outputOnly = traceScene([{ lines: [2], label: '只有输出', output: '42' }]);
  const outputOnlyState = frameState(outputOnly, 0);
  assert.equal(outputOnlyState.trace!.panelVisible, true, 'state 空但 output 存在 → 面板可见');
  const outputOnlyMarkup = renderStandard(outputOnly, { frame: 0 });
  assert.match(outputOnlyMarkup, /data-trace-panel="true"/, '渲染面板');
  assert.match(outputOnlyMarkup, /data-trace-section="output"/, '渲染 output 区块');
  assert.doesNotMatch(outputOnlyMarkup, /data-trace-section="variables"/, '不渲染空 variables 区块');
  assert.ok(visibleText(outputOnlyMarkup).includes('42'));

  // output 缺失（有 state）→ 不渲染 output 区块
  const stateOnly = traceScene([{ lines: [2], label: '只有状态', state: [{ name: 'n', value: '1' }] }]);
  const stateOnlyMarkup = renderStandard(stateOnly, { frame: 0 });
  assert.match(stateOnlyMarkup, /data-trace-section="variables"/);
  assert.doesNotMatch(stateOnlyMarkup, /data-trace-section="output"/, '无 output 不渲染空区块');

  // 两者都无 → panelVisible=false、不渲染面板、布局与 focus 一致
  const noPanel = traceScene([{ lines: [2], label: '仅代码' }]);
  const noPanelState = frameState(noPanel, 0);
  assert.equal(noPanelState.trace!.panelVisible, false, '都无 → panelVisible=false');
  assert.equal(noPanelState.layout.tracePanel, null, '布局无面板');
  const noPanelMarkup = renderStandard(noPanel, { frame: 0 });
  assert.doesNotMatch(noPanelMarkup, /data-trace-panel/, '不渲染 trace 面板');
  const focusEquivalent = sceneOf({ beats: [{ lines: [2], label: '仅代码' }] });
  assert.deepEqual(noPanelState.layout, frameState(focusEquivalent, 0).layout, '无面板时布局与 focus 一致');
  assert.deepEqual(standardCodeRows(noPanelMarkup).filter(row => row.active).map(row => row.lineNumber), [2], '代码行高亮与 focus 一致');
  assert.doesNotMatch(noPanelMarkup, /NaN|undefined/);
});

// ═════════════════════════════ #27-5 布局 ═════════════════════════════════════

test('#27-5 布局：16:9 面板右侧 width∈[0.28,0.34]W、代码区缩小、底边 ≤ H-reserved；9:16 面板下方整行；12 项状态不溢出', () => {
  // 16:9
  const layoutLandscape = resolveCodeSceneLayout({
    width: LANDSCAPE.width, height: LANDSCAPE.height, hasBeats: true, hasBeatCard: true, captionReservedPx: 100, tracePanel: true,
  });
  const panel = layoutLandscape.tracePanel;
  assert.ok(panel, '16:9 有 trace 面板布局');
  assert.equal(panel!.placement, 'right', '16:9 面板在右侧');
  const ratio = panel!.widthPx / LANDSCAPE.width;
  assert.ok(ratio >= 0.28 && ratio <= 0.34, `面板宽度占比 ${ratio} ∈ [0.28,0.34]`);
  const focusLandscape = resolveCodeSceneLayout({ width: LANDSCAPE.width, height: LANDSCAPE.height, hasBeats: true, hasBeatCard: true, captionReservedPx: 100 });
  assert.ok(layoutLandscape.codeArea.widthPx < focusLandscape.codeArea.widthPx, '代码区宽度相应缩小');
  assert.ok(panel!.topPx + panel!.heightPx <= LANDSCAPE.height - 100 + 1e-6, '面板底边不越过字幕安全区');
  assert.ok(panel!.heightPx > 0 && panel!.topPx > 0);

  // 9:16
  const layoutPortrait = resolveCodeSceneLayout({
    width: PORTRAIT.width, height: PORTRAIT.height, hasBeats: true, hasBeatCard: true, captionReservedPx: 100, tracePanel: true,
  });
  const portraitPanel = layoutPortrait.tracePanel;
  assert.ok(portraitPanel, '9:16 有 trace 面板布局');
  assert.equal(portraitPanel!.placement, 'below', '9:16 面板在代码窗口下方');
  assert.ok(portraitPanel!.widthPx >= PORTRAIT.width * 0.8, `9:16 面板整行宽度（${portraitPanel!.widthPx}）`);
  assert.ok(portraitPanel!.heightPx <= PORTRAIT.height * 0.34 + 1e-6, '面板高度 ≤0.34H');
  assert.ok(portraitPanel!.topPx + portraitPanel!.heightPx <= PORTRAIT.height - 100 + 1e-6, '面板底边不越过字幕安全区');
  const focusPortrait = resolveCodeSceneLayout({ width: PORTRAIT.width, height: PORTRAIT.height, hasBeats: true, hasBeatCard: true, captionReservedPx: 100 });
  assert.ok(layoutPortrait.codeArea.heightPx < focusPortrait.codeArea.heightPx, '9:16 代码窗口高度相应扣减');

  // focus 布局数值不变：无 tracePanel 参数时新增字段为 null，其它字段与 tracePanel:false 完全一致
  assert.deepEqual(resolveCodeSceneLayout({ width: LANDSCAPE.width, height: LANDSCAPE.height, hasBeats: true, hasBeatCard: true, captionReservedPx: 0 }).tracePanel, null);
  assert.deepEqual(
    resolveCodeSceneLayout({ width: LANDSCAPE.width, height: LANDSCAPE.height, hasBeats: true, hasBeatCard: true, captionReservedPx: 0, tracePanel: false }),
    resolveCodeSceneLayout({ width: LANDSCAPE.width, height: LANDSCAPE.height, hasBeats: true, hasBeatCard: true, captionReservedPx: 0 }),
    'tracePanel:false 与缺省行为一致（focus 数值不变）',
  );

  // 12 个 state 条目不溢出面板
  const twelve = Array.from({ length: 12 }, (_, index) => ({ name: `v${index}`, value: String(index), changed: index % 3 === 0 }));
  const scene = traceScene([{ lines: [2], label: '状态', state: twelve }]);
  const markup = renderStandard(scene, { frame: 0 });
  assert.equal(standardStateRows(markup).length, 12, '12 条状态全部渲染');
  const panelTags = tagsWith(markup, /data-trace-panel="true"/);
  assert.equal(panelTags.length, 1, '单一 trace 面板');
  assert.match(styleOf(panelTags[0]), /overflow:\s*hidden/, '面板 overflow:hidden 防溢出');
  for (const frame of [LANDSCAPE, PORTRAIT]) {
    const state = frameState(scene, 0, frame.width, frame.height);
    assert.ok(state.layout.tracePanel, `${frame.width}x${frame.height} 有面板布局`);
    assert.ok(state.layout.tracePanel!.topPx + state.layout.tracePanel!.heightPx <= frame.height + 1e-6);
  }
});

// ═════════════════════════════ #27-7 Standard trace 渲染 ══════════════════════

test('#27-7 Standard trace：data-trace-panel/variables/output 标题、状态行 name/value、callDepth 标签、代码 active/dim 正确', () => {
  const scene = traceScene();
  const timeline = stepStarts(scene);
  const markup = renderStandard(scene, { frame: timeline[1].startFrame });
  assert.match(markup, /data-trace-panel="true"/, '面板标记');
  assert.match(markup, /data-trace-section="variables"/, 'variables 区块');
  assert.match(markup, /data-trace-section="output"/, 'output 区块');
  assert.ok(visibleText(markup).includes('Variables'), '标题 Variables');
  assert.ok(visibleText(markup).includes('Output'), '标题 Output');
  assert.match(markup, /data-trace-call-depth="1"/, 'callDepth 标签 data-trace-call-depth=1');
  assert.ok(visibleText(markup).includes('depth 1'), 'callDepth 文本 depth 1');

  const rows = standardStateRows(markup);
  assert.deepEqual(rows.map(row => [row.name, row.nameText, row.valueText]), [['sum', 'sum', '3'], ['i', 'i', '1']], '状态行 name/value');

  // 面板颜色来自主题
  const palette = palettes['minimal-tech'];
  const panelTag = tagsWith(markup, /data-trace-panel="true"/)[0];
  assert.ok(styleOf(panelTag).toLowerCase().includes(palette.card.toLowerCase()), '面板背景 colors.card');
  assert.ok(styleOf(panelTag).toLowerCase().includes(`${palette.accent.toLowerCase()}66`), '面板边框 accent66');

  // 代码行 active/dim 正确（与 focus 同构）
  const codeRows = standardCodeRows(markup);
  assert.deepEqual(codeRows.filter(row => row.active).map(row => row.lineNumber), [4], '当前 step lines 高亮');
  assert.deepEqual(codeRows.filter(row => row.dimmed).map(row => row.lineNumber), [1, 2, 3, 5, 6, 7, 8], '其余行 dim');
  for (const row of codeRows.filter(row => row.dimmed)) assert.equal(opacityOf(row.openTag), CODE_DIM_OPACITY);
  assert.ok(visibleText(markup).includes('累加'), 'beat 卡显示当前 step label');

  // callDepth 无定义时不渲染
  const noDepth = traceScene([{ lines: [2], label: '无深度', state: [{ name: 'n', value: '0' }] }]);
  assert.doesNotMatch(renderStandard(noDepth, { frame: 0 }), /data-trace-call-depth/, '无 callDepth 不渲染标签');
});

// ═════════════════════════════ #27-8 HTML 与 Standard 一致 ════════════════════

test('#27-8 HTML trace 与 Standard 一致：状态 name/value/changed/output/active 行相同；class 契约经 sanitize 保留；不输出模型状态卡 HTML', () => {
  const scene = traceScene(TRACE_STEPS, {});
  for (const frame of [0, 60, 120]) {
    const standard = renderStandard(scene, { frame });
    const inner = renderHtmlInner(scene, { frame });
    const standardRows = standardStateRows(standard);
    const htmlRows = htmlStateRows(inner);
    assert.equal(htmlRows.length, standardRows.length, `frame ${frame}: 状态行数一致`);
    assert.deepEqual(htmlRows.map(row => row.nameText), standardRows.map(row => row.nameText), `frame ${frame}: name 一致`);
    assert.deepEqual(htmlRows.map(row => row.valueText), standardRows.map(row => row.valueText), `frame ${frame}: value 一致`);
    assert.deepEqual(htmlRows.map(row => row.changed), standardRows.map(row => row.changed), `frame ${frame}: changed 一致`);
    assert.deepEqual(htmlRows.map(row => row.markerText), standardRows.map(row => row.markerText), `frame ${frame}: ← 标记一致`);
    assert.deepEqual(htmlCodeRows(inner).map(row => row.lineNumber), standardCodeRows(standard).map(row => row.lineNumber), `frame ${frame}: 代码行号一致`);
    assert.deepEqual(
      htmlCodeRows(inner).filter(row => row.classes.includes('active')).map(row => row.lineNumber),
      standardCodeRows(standard).filter(row => row.active).map(row => row.lineNumber),
      `frame ${frame}: active 代码行一致`,
    );
    const standardOutput = /<div\b[^>]*data-trace-output="true"[^>]*>([\s\S]*?)<\/div>/.exec(standard)?.[1] ?? '';
    const htmlOutput = /<div\b[^>]*class="[^"]*\btrace-output\b[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(inner)?.[1] ?? '';
    assert.equal(visibleText(htmlOutput).trim(), visibleText(standardOutput).trim(), `frame ${frame}: output 文本一致`);

    // class 契约
    for (const className of ['trace-panel', 'trace-section', 'trace-state-row', 'trace-state-name', 'trace-state-value']) {
      assert.ok(new RegExp(`class="[^"]*\\b${className}\\b`).test(inner), `HTML 保留 class ${className}`);
    }
    if (standardRows.some(row => row.changed)) assert.match(inner, /class="[^"]*changed[^"]*"/, 'changed class 保留');
    if (standardRows.some(row => row.markerText)) assert.match(inner, /class="[^"]*changed-marker[^"]*"/, 'changed-marker 保留');
    if (/data-trace-output="true"/.test(standard)) assert.match(inner, /class="[^"]*trace-output[^"]*"/, 'trace-output class 保留');
    if (/data-trace-call-depth="/.test(standard)) assert.match(inner, /class="[^"]*trace-call-depth[^"]*"/, 'trace-call-depth class 保留');

    // 模型生成的状态卡 HTML 不得被使用
    const withModelHtml = traceScene(TRACE_STEPS, {});
    (withModelHtml.visual as Record<string, unknown>).html = '<div class="model-trace">MODEL-TRACE-HTML-SHOULD-NOT-RENDER</div>';
    const modelInner = renderHtmlInner(withModelHtml, { frame });
    assert.equal(modelInner.includes('MODEL-TRACE-HTML-SHOULD-NOT-RENDER'), false, '不输出模型状态卡 HTML');
  }
  assert.match(renderHtmlWrapper(scene), /data-code-html-scene="true"/);
});

// ═════════════════════════════ #27-8 trace 恶意状态文本转义 ════════════════════

test('#27-8 trace 恶意 state/output 文本：HTML 转义后逐字显示，Standard/HTML 均无可执行内容', () => {
  const evilValue = '</span><script>alert(1)</script>';
  const evilOutput = '<img src=x onerror=alert(2)>';
  const scene = traceScene([
    { lines: [2], label: '恶意', state: [{ name: 'evil', value: evilValue }, { name: 'lt', value: 'a < b && c > d', changed: true }], output: evilOutput },
  ]);
  const markup = renderStandard(scene, { frame: 0 });
  const inner = renderHtmlInner(scene, { frame: 0 });

  for (const [label, html] of [['Standard', markup], ['HTML', inner]] as const) {
    assert.doesNotMatch(html, /<script\b/i, `${label}: 不产生 script 标签`);
    assert.doesNotMatch(html, /<\/script/i, `${label}: 不产生 script 闭合标签`);
    for (const tag of html.match(/<[a-zA-Z][^>]*>/g) ?? []) {
      assert.doesNotMatch(tag, /\bon[a-z]+\s*=/i, `${label}: 无事件属性 ${tag}`);
      assert.doesNotMatch(tag, /javascript:/i, `${label}: 无 javascript: 属性`);
    }
    assert.ok(visibleText(html).includes('alert(1)'), `${label}: 恶意 value 作为文本显示`);
    assert.ok(visibleText(html).includes('a < b && c > d'), `${label}: 比较运算符 value 逐字显示`);
    assert.ok(visibleText(html).includes('alert(2)'), `${label}: 恶意 output 作为文本显示`);
  }
  // 状态 value/output 文本逐字一致
  const standardRows = standardStateRows(markup);
  const htmlRows = htmlStateRows(inner);
  assert.deepEqual(htmlRows.map(row => row.valueText), standardRows.map(row => row.valueText), '恶意状态 value 文本两渲染器一致');
  assert.equal(htmlRows.find(row => row.name === 'evil')!.valueText, evilValue, '恶意 value 逐字保留');
});

// ═════════════════════════════ #27-9 viewport 协同 ════════════════════════════

test('#27-9 trace viewport：长代码跨区域 step 滚动正确、clamp、Standard/HTML translateY 一致、面板存在时滚动仍正确', () => {
  const longSteps = [
    { lines: [2], label: '开头', state: [{ name: 'i', value: '0' }] },
    { lines: [30], label: '中段', state: [{ name: 'i', value: '29', changed: true }] },
    { lines: [58], label: '末尾', state: [{ name: 'i', value: '57', changed: true }] },
  ];
  const scene = sceneOf({ code: codeOf(60), mode: 'trace', traceSteps: longSteps });
  const timeline = stepStarts(scene);
  assert.equal(timeline.length, 3);
  const states = timeline.map(step => frameState(scene, step.startFrame));
  const starts = states.map(state => state.startLine);
  assert.equal(starts[0], 1, '首 step clamp 到 1');
  assert.ok(starts[starts.length - 1] > starts[0], `跨区域滚动（${starts.join(',')}）`);
  const maxStart = Math.max(1, 60 - states[0].visibleLineCount + 1);
  for (const [index, state] of states.entries()) {
    assert.ok(state.startLine >= 1 && state.startLine <= maxStart, `step ${index} startLine clamp`);
    assert.equal(state.translatePx, (1 - state.startLine) * state.layout.lineHeightPx);
    assert.ok(state.layout.tracePanel, `step ${index}: 面板存在时仍滚动`);
    for (const line of state.activeLines) {
      assert.ok(line >= state.startLine && line < state.startLine + state.visibleLineCount, `step ${index}: 活动行 ${line} 在窗口内`);
    }
  }
  assert.ok(starts[states.length - 1] >= maxStart - 1, '末尾 clamp 到最大 startLine 附近');

  for (const step of timeline) {
    const standardY = translateYOf(renderStandard(scene, { frame: step.startFrame }));
    const htmlY = translateYOf(renderHtmlInner(scene, { frame: step.startFrame }));
    assert.ok(Number.isFinite(standardY) && Number.isFinite(htmlY));
    assert.ok(Math.abs(standardY! - htmlY!) <= 1e-6, `Standard ${standardY} = HTML ${htmlY}`);
  }
  // 面板存在不影响滚动：去掉 state 后同一 focus scene 的滚动仍一致
  const withoutPanel = sceneOf({ code: codeOf(60), mode: 'trace', traceSteps: longSteps.map(step => ({ lines: step.lines })) });
  const noPanelState = frameState(withoutPanel, timeline[1].startFrame);
  assert.equal(noPanelState.layout.tracePanel, null, '无状态时无面板');
  assert.equal(noPanelState.startLine, states[1].startLine, '面板有无不改变代码滚动位置');
});

// ═════════════════════════════ #27-11 主题/数值健壮性 ═════════════════════════

test('#27-11 trace 主题/数值：5 套 style 面板颜色来自 palette、无 NaN/undefined、相同输入 deepEqual、空 value 不崩溃', () => {
  for (const styleId of STYLE_IDS) {
    const scene = traceScene();
    const markup = renderStandard(scene, { frame: 60, styleId });
    assert.doesNotMatch(markup, /NaN|undefined/, `${styleId}: 无 NaN/undefined`);
    const palette = palettes[styleId];
    assert.ok(markup.toLowerCase().includes(palette.card.toLowerCase()), `${styleId}: 面板/代码背景来自 palette.card`);
    assert.ok(markup.toLowerCase().includes(palette.accent.toLowerCase()), `${styleId}: accent 来自 palette`);
    const state = frameState(scene, 60);
    assert.deepEqual(state, frameState(scene, 60), `${styleId}: 相同输入 deepEqual`);
  }

  // 空字符串 value 不崩溃
  const emptyValue = traceScene([{ lines: [2], label: '空值', state: [{ name: 'empty', value: '' }, { name: 'zero', value: '0' }] }]);
  assert.doesNotThrow(() => renderStandard(emptyValue, { frame: 0 }));
  const rows = standardStateRows(renderStandard(emptyValue, { frame: 0 }));
  assert.deepEqual(rows.map(row => [row.nameText, row.valueText]), [['empty', ''], ['zero', '0']], '空 value 正常渲染');
  assert.doesNotThrow(() => renderHtmlInner(emptyValue, { frame: 0 }));

  // 无状态数据/空数组不产生 NaN
  const noState = traceScene([{ lines: [2], state: [] }]);
  const noStateMarkup = renderStandard(noState, { frame: 0 });
  assert.doesNotMatch(noStateMarkup, /NaN|undefined/);
  const noStateInfo = frameState(noState, 0);
  assert.equal(noStateInfo.trace!.panelVisible, false, '空 state 无 output/callDepth → 无面板');
  assert.ok(rendererScale(LANDSCAPE.width, LANDSCAPE.height) > 0);
});
