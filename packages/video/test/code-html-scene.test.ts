import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import {
  captionSafeArea,
  clearCodeTokenCache,
  codeLines,
  codeTokenCacheStats,
  codeVisualOf,
  rendererScale,
  resolveCodeBeatTimeline,
  sanitizeSceneHtml,
  SceneTypeSchema,
  tokenizeCode,
  type CodeTokenType,
  type Scene,
} from '@m2v/schema';
import { palettes, resolveCodeTokenColors } from '@m2v/styles';
import { CodeSceneView, resolveCodeSceneLayout } from '../src/code-scene';
import { CodeHtmlScene, CodeHtmlSceneView, renderCodeHtmlScene } from '../src/code-html-scene';

/**
 * #21 契约：HTML 模式动态 CodeHtmlScene（doc/V1.6.9_issues.md §2.6/§2.7）以及
 * #23-7/#23-8（渲染器 token 输出与共享）、#22-8（CodeHtmlScene × sanitizer 集成）。
 * 无 jsdom：CodeHtmlSceneView/CodeSceneView 都是无 Remotion hook 的确定性视图，直接 renderToStaticMarkup。
 */

// packages/video 没有 react-dom 依赖；从已安装 react-dom 的 apps/web 解析（等价 runner/tsx 均可用）。
const webRequire = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const { renderToStaticMarkup } = webRequire('react-dom/server') as { renderToStaticMarkup: (element: unknown) => string };

const STYLE_IDS = ['minimal-tech', 'clean-light', 'academic', 'social-short', 'whiteboard'] as const;
const LANDSCAPE = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };
const TOKEN_TYPES: CodeTokenType[] = ['plain', 'keyword', 'string', 'comment', 'number', 'function', 'variable', 'punctuation'];

// ── markup 工具（HTML 内层片段 / Standard 的 React markup 通用）────────────────────

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

/** 去标签 + 解码实体，得到用户看到的文本。 */
function visibleText(markup: string): string {
  return decodeEntities(markup.replace(/<[^>]*>/g, ''));
}

function openTags(markup: string): string[] {
  return markup.split('<').slice(1).map(chunk => {
    const end = chunk.indexOf('>');
    return end === -1 ? '' : chunk.slice(0, end);
  }).filter(tag => /^[a-zA-Z]/.test(tag));
}

const tagWith = (markup: string, pattern: RegExp): string | undefined => openTags(markup).find(tag => pattern.test(tag));
const styleOfTag = (tag: string): string => /style="([^"]*)"/.exec(tag)?.[1] ?? '';
const classOfTag = (tag: string): string => /class="([^"]*)"/.exec(tag)?.[1] ?? '';
const classContains = (markup: string, className: string): boolean => new RegExp(`class="[^"]*\\b${className}\\b`).test(markup);
const lineNumberTags = (markup: string) => openTags(markup).filter(tag => /data-line-number="/.test(tag));
const standardLineNumbers = (markup: string) => lineNumberTags(markup).map(tag => Number(/data-line-number="(\d+)"/.exec(tag)![1]));
const standardActiveLines = (markup: string) => openTags(markup)
  .filter(tag => /data-active="true"/.test(tag) && /data-line-number="/.test(tag))
  .map(tag => Number(/data-line-number="(\d+)"/.exec(tag)![1]))
  .sort((a, b) => a - b);
const standardDimmedLines = (markup: string) => openTags(markup)
  .filter(tag => /data-dimmed="true"/.test(tag) && /data-line-number="/.test(tag))
  .map(tag => Number(/data-line-number="(\d+)"/.exec(tag)![1]));

/** Standard 每行源码文本：去掉行号 span 后按可见文本比较（token span 会切分源码）。 */
function standardCodeLines(markup: string): { lineNumber: number; text: string; active: boolean; dimmed: boolean; tag: string }[] {
  const tags = [...markup.matchAll(/<div[^>]*\bdata-line-number="(\d+)"[^>]*>/g)];
  return tags.map(match => {
    const tagEnd = match.index! + match[0].length;
    const closeIndex = markup.indexOf('</div>', tagEnd);
    const region = markup.slice(tagEnd, closeIndex === -1 ? undefined : closeIndex);
    const firstSpanClose = region.indexOf('</span>');
    const contentRegion = firstSpanClose === -1 ? region : region.slice(firstSpanClose + '</span>'.length);
    return {
      lineNumber: Number(match[1]),
      text: visibleText(contentRegion),
      active: /data-active="true"/.test(match[0]),
      dimmed: /data-dimmed="true"/.test(match[0]),
      tag: match[0],
    };
  });
}

/** HTML 内层每行源码文本（div.code-line active|dim + span.line-number + span.code-content）。 */
function htmlCodeLines(inner: string): { lineNumber: number; text: string; classes: string[] }[] {
  const result: { lineNumber: number; text: string; classes: string[] }[] = [];
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
      text: visibleText(content),
    });
    from = tagEnd + 1;
  }
  return result;
}

const htmlActiveLines = (inner: string) => htmlCodeLines(inner)
  .filter(line => line.classes.includes('active'))
  .map(line => line.lineNumber)
  .sort((a, b) => a - b);

/** Standard 滚动位移 translateY(px)：CodeSceneView 内唯一的 translateY。 */
function standardTranslateY(markup: string): number | undefined {
  for (const tag of openTags(markup)) {
    const match = /translateY\(\s*(-?[\d.]+)px\s*\)/.exec(styleOfTag(tag));
    if (match) return Number(match[1]);
  }
  return undefined;
}

/** HTML 内层轨道 div.code-track 的 translateY：契约要求 -Npx（N = 已滚动行数 × 行高）。 */
function htmlTrackTranslateY(inner: string): number | undefined {
  const tag = tagWith(inner, /class="[^"]*\bcode-track\b/);
  if (!tag) return undefined;
  const match = /translateY\(\s*(-?[\d.]+)(?:px)?\s*\)/.exec(styleOfTag(tag));
  return match ? Number(match[1]) : undefined;
}

/** 从 markup 中抽出全部 token span：class 含 tok-<type>，style 含 color。 */
function tokenSpans(markup: string): { type: string; text: string; color: string }[] {
  const result: { type: string; text: string; color: string }[] = [];
  for (const match of markup.matchAll(/<span\b([^>]*)>([^<]*)<\/span>/g)) {
    const className = /class="([^"]*)"/.exec(match[1])?.[1] ?? '';
    const type = /(?:^|\s)tok-([a-z]+)/.exec(className)?.[1];
    if (!type) continue;
    const style = /style="([^"]*)"/.exec(match[1])?.[1] ?? '';
    result.push({ type, text: decodeEntities(match[2]), color: /color:\s*([^;"]+)/.exec(style)?.[1]?.trim() ?? '' });
  }
  return result;
}

/** HTML 内层 beat 卡文本（div.beat-label）。 */
function htmlBeatLabels(inner: string): string[] {
  return [...inner.matchAll(/<div\b[^>]*class="beat-label"[^>]*>([\s\S]*?)<\/div>/g)].map(match => visibleText(match[1]).trim());
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── 场景与渲染 ────────────────────────────────────────────────────────────────

const CODE = [
  '// 缓存读取',
  'const cache = new Map();',
  'function getUser(id) {',
  '  if (cache.has(id)) {',
  '    return cache.get(id);',
  '  }',
  '  return fetchUser(id);',
  '}',
].join('\n');

const codeOf = (count: number) => Array.from({ length: count }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n');

/** 含全部 8 类 token 的 20 行样例（keyword/string/comment/number/function/variable/punctuation/plain），并跨 viewport。 */
const HIGHLIGHT_CODE = [
  '// 颜色覆盖注释',
  'function greet(name) {',
  '  const value = 42;',
  '  return "hi " + name;',
  '}',
  '',
  ...Array.from({ length: 14 }, (_, index) => `const row${index + 1} = ${index + 1};`),
].join('\n');

function sceneOf(visual: Record<string, unknown> = {}, patch: Record<string, unknown> = {}): Scene {
  return {
    id: 'code-html-scene',
    type: 'code',
    title: '缓存逻辑',
    narration: '这一页讲解缓存命中后的处理流程。',
    duration: 6,
    ...patch,
    visual: { code: CODE, ...visual },
  } as Scene;
}

type RenderOptions = {
  frame?: number;
  width?: number;
  height?: number;
  styleId?: string;
  captionReservedPx?: number;
  syntaxHighlight?: boolean;
};

function renderStandard(scene: Scene, options: RenderOptions = {}): string {
  return renderToStaticMarkup(createElement(CodeSceneView, {
    scene,
    styleId: (options.styleId ?? 'minimal-tech') as never,
    frame: options.frame ?? 0,
    width: options.width ?? LANDSCAPE.width,
    height: options.height ?? LANDSCAPE.height,
    ...(options.captionReservedPx === undefined ? {} : { captionReservedPx: options.captionReservedPx }),
    ...(options.syntaxHighlight === undefined ? {} : { syntaxHighlight: options.syntaxHighlight }),
  }));
}

function htmlProps(scene: Scene, options: RenderOptions = {}) {
  return {
    scene,
    styleId: (options.styleId ?? 'minimal-tech') as never,
    frame: options.frame ?? 0,
    width: options.width ?? LANDSCAPE.width,
    height: options.height ?? LANDSCAPE.height,
    fps: 30,
    ...(options.captionReservedPx === undefined ? {} : { captionReservedPx: options.captionReservedPx }),
    ...(options.syntaxHighlight === undefined ? {} : { syntaxHighlight: options.syntaxHighlight }),
  };
}

/** 已 sanitize 的内层 HTML 片段（§2.6 规定 renderCodeHtmlScene 返回 sanitizer 后的片段）。 */
const renderHtmlInner = (scene: Scene, options: RenderOptions = {}): string => renderCodeHtmlScene(htmlProps(scene, options) as never);

/** 外层 React 包装节点（data-code-scene + data-code-html-scene + dangerouslySetInnerHTML）。 */
const renderHtmlWrapper = (scene: Scene, options: RenderOptions = {}): string =>
  renderToStaticMarkup(createElement(CodeHtmlSceneView, htmlProps(scene, options) as never));

const timelineOf = (scene: Scene) => resolveCodeBeatTimeline(scene as unknown as Record<string, unknown>, 30);

/** 生成接近 target 字符数的多行代码（不超过 CodeVisualSchema 的 8000 字符上限）。 */
function codeNearLength(target: number): string {
  let code = '';
  let index = 0;
  while (true) {
    const line = `const value${index} = ${index} * 2 + 1;`;
    const next = code ? `${code}\n${line}` : line;
    if (next.length > target) return code;
    code = next;
    index += 1;
  }
}

/** 8000 字符单行、token 密度极高（约 6000 个 token）的源码。 */
const DENSE_SINGLE_LINE = `const dense = ${'a + '.repeat(1996)}1;`;

/**
 * 断言一份 HTML 片段完整保留全部源码行：
 * 行号/可见文本逐行等于 codeLines、标签配对、尾部不是半截标签、无可执行内容。
 */
function assertCompleteCodeHtml(markup: string, code: string, label: string): void {
  const source = codeLines(code);
  const lines = htmlCodeLines(markup);
  assert.equal(lines.length, source.length, `${label}: 渲染行数必须等于 codeLines 行数（${lines.length}/${source.length}）`);
  assert.deepEqual(lines.map(line => line.lineNumber), source.map((_, index) => index + 1), `${label}: 行号必须 1..N 连续`);
  assert.deepEqual(lines.map(line => line.text), source, `${label}: 每行可见文本必须逐字等于 codeLines`);
  // 不允许被截断成半截标签
  assert.ok(markup.lastIndexOf('<') < markup.lastIndexOf('>'), `${label}: HTML 尾部不得是半截标签`);
  assert.equal((markup.match(/<div\b/g) ?? []).length, (markup.match(/<\/div>/g) ?? []).length, `${label}: div 开闭标签数必须配对`);
  assert.equal((markup.match(/<span\b/g) ?? []).length, (markup.match(/<\/span>/g) ?? []).length, `${label}: span 开闭标签数必须配对`);
  // 仍然是安全的 inert presentation HTML
  assert.doesNotMatch(markup, /<script\b/i, `${label}: 不得含 script`);
  for (const tag of openTags(markup)) assert.doesNotMatch(tag, /\bon[a-z]+\s*=/i, `${label}: 不得含事件属性`);
}

const beatsScene = (visual: Record<string, unknown> = {}, patch: Record<string, unknown> = {}) => sceneOf({
  language: 'typescript',
  filename: 'cache.ts',
  beats: [
    { lines: [2, 3], label: '命中后返回' },
    { lines: [7], label: '回源请求' },
  ],
  ...visual,
}, patch);

/** 全部 token 类型都出现的场景（并且 beats 跨越 viewport，产生滚动）。 */
const highlightScene = () => sceneOf({
  code: HIGHLIGHT_CODE,
  language: 'typescript',
  filename: 'highlight.ts',
  beats: [
    { lines: [2], label: '开始' },
    { lines: [18], label: '滚动' },
  ],
});

// ═════════════════════════════ #21-1 逐行展示源码 ═════════════════════════════

test('#21-1 HTML 模式 code scene 逐行展示源码与行号，包装节点含 data-code-scene + data-code-html-scene', () => {
  assert.equal(typeof renderCodeHtmlScene, 'function', 'renderCodeHtmlScene 可调用');
  assert.equal(typeof CodeHtmlSceneView, 'function', 'CodeHtmlSceneView 可调用');
  assert.equal(typeof CodeHtmlScene, 'function', 'CodeHtmlScene Remotion 入口可调用');

  const scene = beatsScene();
  const inner = renderHtmlInner(scene);
  assert.equal(typeof inner, 'string', 'renderCodeHtmlScene 返回字符串片段');

  // 内层结构（§2.6）
  for (const className of ['code-scene', 'code-header', 'code-filename', 'code-language', 'code-title', 'code-body', 'code-window', 'code-track', 'line-number', 'code-content']) {
    assert.ok(classContains(inner, className), `内层 HTML 应包含 class="${className}"：${inner.slice(0, 400)}`);
  }
  assert.ok(classContains(inner, 'code-line'), '每行是 div.code-line');

  const lines = htmlCodeLines(inner);
  assert.deepEqual(lines.map(line => line.lineNumber), [1, 2, 3, 4, 5, 6, 7, 8], '逐行行号 1..8');
  assert.deepEqual(lines.map(line => line.text), codeLines(CODE), '每行源码逐字展示（含缩进）');
  const sourceLines = codeLines(CODE);
  sourceLines.forEach((sourceLine, index) => {
    assert.ok(visibleText(inner).includes(sourceLine), `第 ${index + 1} 行源码可见：${sourceLine}`);
  });

  // 外层包装节点
  const wrapper = renderHtmlWrapper(scene);
  assert.match(wrapper, /data-code-scene="true"/, '外层 data-code-scene=true');
  assert.match(wrapper, /data-code-html-scene="true"/, '外层 data-code-html-scene=true');
  assert.ok(classContains(wrapper, 'code-scene'), '内层片段被注入外层');
  assert.ok(visibleText(wrapper).includes('const cache = new Map();'), '包装节点内可见源码');
});

// ═════════════════════════════ #21-1 长代码完整性（分块 sanitize 回归）════════════════════════════

test('#21-1 HTML 长代码完整性：60/200 行、接近 8000 字符、8000 字符单行高 token 密度逐行展示且无半截标签', () => {
  const fixtures = [
    { label: '60 行', code: codeOf(60) },
    { label: '200 行', code: codeOf(200) },
    { label: '接近 8000 字符（多行）', code: codeNearLength(7950) },
    { label: '8000 字符单行（高 token 密度）', code: DENSE_SINGLE_LINE },
  ];
  for (const { label, code } of fixtures) {
    assert.ok(code.length > 0 && code.length <= 8000, `${label}: 源码长度 ${code.length} 应 ≤ 8000`);
    const scene = sceneOf({ code, language: 'typescript' });
    const inner = renderHtmlInner(scene);
    assertCompleteCodeHtml(inner, code, label);
    // 可见文本拼接也包含每一行
    const visible = visibleText(inner);
    for (const sourceLine of codeLines(code)) assert.ok(visible.includes(sourceLine), `${label}: 可见文本含源码行 ${JSON.stringify(sourceLine.slice(0, 40))}`);
  }
  // 8000 字符单行：token 密度断言（确保不是被截断后的少量 token）
  const denseLines = htmlCodeLines(renderHtmlInner(sceneOf({ code: DENSE_SINGLE_LINE, language: 'typescript' })));
  assert.equal(denseLines.length, 1, '8000 字符单行仍是 1 行');
  assert.equal(denseLines[0].text, DENSE_SINGLE_LINE, '8000 字符整行逐字保留');
});

// ═════════════════════════════ #21-2 共享同一 visual ═════════════════════════════

test('#21-2 与 Standard 共享同一 visual：源码行/beats/header 一致，HTML 输出不含静态 visual.html 旧文案', () => {
  const legacyHtml = '<div class="legacy-explanation">OLD-EXPLANATION-MARKER 旧解释与旧步骤</div>';
  const scene = beatsScene({ html: legacyHtml });
  const standard = renderStandard(scene);
  const inner = renderHtmlInner(scene);
  const wrapper = renderHtmlWrapper(scene);

  // visual.html 仅作为 HTML 生成模式路由标记，不作为代码内容
  for (const [label, markup] of [['内层片段', inner], ['包装节点', wrapper], ['Standard', standard]] as const) {
    assert.equal(markup.includes('OLD-EXPLANATION-MARKER'), false, `${label}不得使用静态 visual.html 文案`);
    assert.equal(markup.includes('旧解释与旧步骤'), false, `${label}不得渲染旧 explanation/steps 文案`);
  }

  // 同一份 visual.code：两渲染器源码行逐字一致
  assert.deepEqual(htmlCodeLines(inner).map(line => line.text), codeLines(CODE), 'HTML 使用 visual.code');
  assert.deepEqual(standardCodeLines(standard).map(line => line.text), codeLines(CODE), 'Standard 使用同一 visual.code');
  assert.deepEqual(htmlCodeLines(inner).map(line => line.text), standardCodeLines(standard).map(line => line.text), '两渲染器源码行一致');

  // 同一份 header 数据
  for (const value of ['cache.ts', 'typescript', '缓存逻辑']) {
    assert.ok(visibleText(inner).includes(value), `HTML header 含 ${value}`);
    assert.ok(visibleText(standard).includes(value), `Standard header 含 ${value}`);
  }

  // 同一份 beats：同 frame active 行一致
  const timeline = timelineOf(scene);
  for (const beat of timeline) {
    const frame = beat.startFrame + 1;
    assert.deepEqual(htmlActiveLines(renderHtmlInner(scene, { frame })), standardActiveLines(renderStandard(scene, { frame })), `frame ${frame} active 行一致`);
  }
});

// ═════════════════════════════ #21-3 frame → active beat ═════════════════════════════

test('#21-3 frame → active beat：同 frame active 行集合一致、跨 beat 变化、beat label 跟随当前 beat', () => {
  const scene = beatsScene();
  const timeline = timelineOf(scene);
  assert.equal(timeline.length, 2);
  const firstFrame = timeline[0].startFrame + 1;
  const secondFrame = timeline[1].startFrame + 1;

  const standardFirst = renderStandard(scene, { frame: firstFrame });
  const htmlFirst = renderHtmlInner(scene, { frame: firstFrame });
  const standardSecond = renderStandard(scene, { frame: secondFrame });
  const htmlSecond = renderHtmlInner(scene, { frame: secondFrame });

  assert.deepEqual(htmlActiveLines(htmlFirst), [2, 3], '第一个 beat 高亮 2,3');
  assert.deepEqual(htmlActiveLines(htmlFirst), standardActiveLines(standardFirst), '第一个 beat 与 Standard 一致');
  assert.deepEqual(htmlActiveLines(htmlSecond), [7], '第二个 beat 高亮 7');
  assert.deepEqual(htmlActiveLines(htmlSecond), standardActiveLines(standardSecond), '第二个 beat 与 Standard 一致');
  assert.notDeepEqual(htmlActiveLines(htmlFirst), htmlActiveLines(htmlSecond), '跨 beat 高亮变化');

  // beat label 跟随当前 beat
  assert.ok(visibleText(htmlFirst).includes('命中后返回'), '第一个 frame 显示第一个 beat label');
  assert.equal(visibleText(htmlFirst).includes('回源请求'), false, '第一个 frame 不显示后续 beat label');
  assert.ok(visibleText(htmlSecond).includes('回源请求'), '第二个 frame 显示第二个 beat label');
  assert.equal(visibleText(htmlSecond).includes('命中后返回'), false, '第二个 frame 不显示前一 beat label');

  // 无 label 时不渲染空文本卡片
  const noLabel = sceneOf({ beats: [{ lines: [2] }, { lines: [7] }] });
  const noLabelInner = renderHtmlInner(noLabel);
  const labels = htmlBeatLabels(noLabelInner);
  assert.equal(labels.filter(text => text.length > 0).length, 0, `无 label 时不得渲染空文本 beat 卡：${JSON.stringify(labels)}`);
  assert.deepEqual(htmlActiveLines(noLabelInner), [2], '无 label 不影响 active 行');
});

// ═════════════════════════════ #21-4 viewport / 滚动 ═════════════════════════════

test('#21-4 viewport/滚动：translateY 随 frame 变化、跨区滚动、同区不滚动、首尾 clamp，且与 Standard 一致', () => {
  const scene = sceneOf({
    code: codeOf(60),
    language: 'typescript',
    beats: [{ lines: [2], label: '开头' }, { lines: [50], label: '末尾' }],
  });
  const timeline = timelineOf(scene);
  assert.equal(timeline.length, 2);
  const [first, second] = timeline;

  const frames = [0, first.startFrame, second.startFrame - 13, second.startFrame - 6, second.startFrame, second.endFrame - 1];
  for (const frame of frames) {
    const inner = renderHtmlInner(scene, { frame });
    const standardY = standardTranslateY(renderStandard(scene, { frame }));
    const trackY = htmlTrackTranslateY(inner);
    assert.ok(Number.isFinite(standardY), `frame ${frame}: Standard 有 translateY`);
    assert.ok(Number.isFinite(trackY), `frame ${frame}: HTML 轨道有 translateY`);
    assert.ok(Math.abs(trackY! - standardY!) <= 1, `frame ${frame}: HTML 轨道 ${trackY}px 与 Standard translateY ${standardY}px 一致`);
    assert.match(inner, /transform:\s*translateY\(/, '轨道使用受控 translateY');
  }

  // 跨区 beat：滚动位移变化；滚动完成帧与 beat.startFrame 对齐
  const startTrack = htmlTrackTranslateY(renderHtmlInner(scene, { frame: first.startFrame }));
  const endTrack = htmlTrackTranslateY(renderHtmlInner(scene, { frame: second.startFrame }));
  assert.ok(Math.abs(startTrack ?? Number.NaN) < 1, `首个 beat 在首行，translateY 应接近 0（实际 ${startTrack}）`);
  assert.notEqual(startTrack, endTrack, '跨区 beat 产生滚动');
  assert.ok((endTrack ?? 0) < 0, '滚动方向向上（translateY 为负）');
  const beforeSwitch = htmlTrackTranslateY(renderHtmlInner(scene, { frame: second.startFrame - 6 }));
  assert.notEqual(beforeSwitch, endTrack, '过渡帧内位移连续变化');
  assert.equal(standardTranslateY(renderStandard(scene, { frame: second.startFrame })), standardTranslateY(renderStandard(scene, { frame: second.startFrame })), '确定性');

  // 同区不滚动
  const sameArea = sceneOf({ code: codeOf(60), beats: [{ lines: [2], label: 'a' }, { lines: [3], label: 'b' }] });
  const sameTimeline = timelineOf(sameArea);
  const sameTrackA = htmlTrackTranslateY(renderHtmlInner(sameArea, { frame: sameTimeline[0].startFrame }));
  const sameTrackB = htmlTrackTranslateY(renderHtmlInner(sameArea, { frame: sameTimeline[1].startFrame }));
  assert.ok(Math.abs((sameTrackA ?? Number.NaN) - (sameTrackB ?? Number.NaN)) < 1e-9, `同一 viewport 内不滚动（${sameTrackA} vs ${sameTrackB}）`);
  assert.ok(Math.abs(sameTrackA ?? Number.NaN) < 1e-9, '起始位置 translateY 为 0');

  // 末尾 clamp：最后一个 beat 行仍可见且位移与 Standard 一致
  const lastFrame = second.endFrame - 1;
  const lastInner = renderHtmlInner(scene, { frame: lastFrame });
  assert.ok(htmlCodeLines(lastInner).some(line => line.lineNumber === 50 && line.classes.includes('active')), '末尾 beat 行可见且高亮');
  assert.ok(Math.abs((htmlTrackTranslateY(lastInner) ?? Number.NaN) - (standardTranslateY(renderStandard(scene, { frame: lastFrame })) ?? Number.NaN)) <= 1, '末尾 clamp 与 Standard 一致');

  // 布局函数口径（#19 回归）：可见行数固定，滚动完成帧 = beat.startFrame
  const layout = resolveCodeSceneLayout({ width: LANDSCAPE.width, height: LANDSCAPE.height, hasBeats: true, hasBeatCard: true, captionReservedPx: 0 });
  assert.ok(layout.visibleLineCount >= 12 && layout.visibleLineCount <= 16);
});

// ═════════════════════════════ #21-5 5 套 style ═════════════════════════════

test('#21-5 5 套 style：背景/前景色来自对应 palette，5 份输出互异且无 undefined/NaN', () => {
  const scene = highlightScene();
  const outputs = new Set<string>();
  for (const styleId of STYLE_IDS) {
    const palette = palettes[styleId];
    const inner = renderHtmlInner(scene, { styleId });
    const lower = inner.toLowerCase();
    assert.ok(lower.includes(palette.bg.toLowerCase()), `${styleId}: 背景色 ${palette.bg} 来自 palette`);
    assert.ok(lower.includes(palette.fg.toLowerCase()), `${styleId}: 前景色 ${palette.fg} 来自 palette`);
    assert.ok(lower.includes(palette.card.toLowerCase()), `${styleId}: 代码窗口背景 ${palette.card} 来自 palette`);
    // token 颜色来自该 style 的映射（样例含全部 8 类 token）
    const tokenColors = resolveCodeTokenColors(palette);
    const tokens = tokenSpans(inner);
    const presentTypes = new Set(tokens.map(token => token.type));
    for (const type of ['keyword', 'string', 'comment', 'number', 'function', 'variable', 'punctuation'] as const) {
      assert.ok(presentTypes.has(type), `${styleId}: 样例应出现 tok-${type}（实际：${[...presentTypes].join(',')}）`);
    }
    for (const token of tokens) {
      assert.equal(token.color.toLowerCase(), tokenColors[token.type as CodeTokenType].toLowerCase(), `${styleId}: tok-${token.type} 颜色 ${token.color} 来自映射`);
    }
    assert.doesNotMatch(inner, /undefined|NaN/, `${styleId}: 无 undefined/NaN`);
    for (const tag of openTags(inner)) {
      const style = styleOfTag(tag);
      if (/\bcolor:/.test(style)) {
        for (const match of style.matchAll(/color:\s*(#[0-9a-f]{3,8})/gi)) {
          assert.match(match[1], /^#[0-9a-f]{6}$/i, `${styleId}: 颜色必须合法 #rrggbb：${match[1]}`);
        }
      }
    }
    outputs.add(inner);
  }
  assert.equal(outputs.size, 5, '5 套 style 渲染结果互不相同');
});

// ═════════════════════════════ #21-6 SceneView 路由与 legacy ═════════════════════════════

test('#21-6 SceneView 路由：HTML 模式 code → CodeHtmlScene、Standard → CodeScene、legacy 保留，无 html-code 类型', () => {
  const indexPath = fileURLToPath(new URL('../src/index.tsx', import.meta.url));
  const source = readFileSync(indexPath, 'utf8');
  assert.match(source, /from ['"]\.\/code-html-scene['"]/, 'index.tsx 接入 code-html-scene');
  assert.match(source, /export \* from ['"]\.\/code-html-scene['"]/, '从 index.tsx re-export CodeHtmlScene');
  assert.match(source, /codeVisualOf/, '使用 codeVisualOf 判定合法 code visual');

  // HTML 覆盖条件必须同时考虑 visual.html 与合法 code visual，避免 code scene 走静态 HTML 分支
  assert.match(
    source,
    /visual\.html[\s\S]{0,260}codeVisualOf|codeVisualOf[\s\S]{0,260}visual\.html/,
    'HTML 分支条件必须排除合法 code visual（visual.html 仅作为 HTML 模式路由标记）',
  );

  const codeCaseIndex = source.indexOf("case 'code'");
  assert.ok(codeCaseIndex >= 0, '存在 case code');
  const nextCaseIndex = source.indexOf("case '", codeCaseIndex + "case 'code'".length);
  const branch = source.slice(codeCaseIndex, nextCaseIndex === -1 ? undefined : nextCaseIndex);
  assert.match(branch, /CodeHtmlScene/, 'HTML 模式 code 分支渲染 CodeHtmlScene');
  assert.match(branch, /CodeScene/, 'Standard 模式 code 分支渲染 CodeScene');
  assert.match(branch, /visual\.html/, '按 visual.html 区分 HTML/Standard 路径');
  assert.match(branch, /captionSafeArea/, '两条路径都传入真实字幕安全区');
  assert.doesNotMatch(branch, /FitContent/, 'code 分支不计入 FitContent 缩放');
  assert.match(branch, /explanation/, 'legacy explanation 路径保留');
  assert.match(branch, /steps/, 'legacy steps 路径保留');

  // SceneTypeSchema 不变
  assert.ok((SceneTypeSchema.options as string[]).includes('code'), 'SceneTypeSchema 仍含 code');
  assert.equal((SceneTypeSchema.options as string[]).includes('html-code'), false, '不新增 html-code 类型');
  assert.deepEqual([...SceneTypeSchema.options], ['title', 'text', 'bullets', 'diagram', 'comparison', 'chart', 'code', 'timeline', 'math', 'table', 'media', 'html'], 'SceneTypeSchema 顺序与取值不变');
  assert.doesNotMatch(source, /html-code/, '源码不引入 html-code');
});

// ═════════════════════════════ #21-7 源码转义与 sanitize ═════════════════════════════

test('#21-7 源码转义与 sanitize：源码含 </span><script>、a < b && c > d、&lt; 时仍显示原文且无可执行内容', () => {
  const evilLines = [
    'const safe = 1;',
    'const evil = "</span><script>alert(1)</script>";',
    'if (a < b && c > d) { return a; }',
    'const entity = "&lt;";',
  ];
  const scene = sceneOf({ code: evilLines.join('\n'), language: 'typescript', beats: [{ lines: [2], label: '恶意' }] });
  const inner = renderHtmlInner(scene);

  assert.doesNotMatch(inner, /<script\b/i, '不产生 script 标签');
  assert.doesNotMatch(inner, /<\/script/i, '不产生 script 闭合标签');
  for (const tag of openTags(inner)) assert.doesNotMatch(tag, /\bon[a-z]+\s*=/i, `不得有事件属性：${tag}`);
  assert.ok(inner.includes('&lt;script') || inner.includes('&lt;/span'), '源码尖括号被 HTML 转义');
  assert.ok(visibleText(inner).includes('alert(1)'), '脚本文本作为源码文本显示');

  // 原文逐行仍显示
  assert.deepEqual(htmlCodeLines(inner).map(line => line.text), evilLines, '转义后源码逐字显示');

  // 再经 sanitizer 后结构完整、内容不变、仍无可执行内容
  const sanitized = sanitizeSceneHtml(inner);
  assert.doesNotMatch(sanitized, /<script\b/i);
  for (const tag of openTags(sanitized)) assert.doesNotMatch(tag, /\bon[a-z]+\s*=/i);
  assert.deepEqual(htmlCodeLines(sanitized).map(line => line.text), evilLines, 'sanitizer 后源码逐字一致');
  assert.deepEqual(htmlCodeLines(sanitized).map(line => line.lineNumber), [1, 2, 3, 4]);

  // 外层包装也不产生可执行内容
  const wrapper = renderHtmlWrapper(scene);
  assert.doesNotMatch(wrapper, /<script\b/i);
  for (const tag of openTags(wrapper)) assert.doesNotMatch(tag, /\bon[a-z]+\s*=/i);
  assert.ok(visibleText(wrapper).includes('if (a < b && c > d) { return a; }'), '特殊字符源码在包装节点中可见');
});

// ═════════════════════════════ #21-8 header 与字幕安全区/横竖屏 ═════════════════════════════

test('#21-8 header 与字幕安全区/横竖屏：filename/language/title 渲染、说明卡不越过字幕区、9:16 上下 / 16:9 右侧', () => {
  const scene = beatsScene();
  for (const frame of [LANDSCAPE, PORTRAIT]) {
    const portrait = frame.height > frame.width;
    const scale = rendererScale(frame.width, frame.height);
    const reserved = captionSafeArea({ videoHeight: frame.height, fontSize: 30, scale }).total;
    const inner = renderHtmlInner(scene, { width: frame.width, height: frame.height, captionReservedPx: reserved });
    const standard = renderStandard(scene, { width: frame.width, height: frame.height, captionReservedPx: reserved });

    // header
    for (const className of ['code-header', 'code-filename', 'code-language', 'code-title']) assert.ok(classContains(inner, className), `header 结构 ${className}`);
    for (const value of ['cache.ts', 'typescript', '缓存逻辑']) assert.ok(visibleText(inner).includes(value), `header 含 ${value}`);

    // 横竖屏结构
    const body = tagWith(inner, /class="[^"]*\bcode-body\b/);
    assert.ok(body, '存在 code-body');
    assert.match(styleOfTag(body!), new RegExp(`flex-direction:\\s*${portrait ? 'column' : 'row'}`), `${portrait ? '9:16 上下' : '16:9 左右'}布局`);
    // 说明卡在代码窗口之后渲染（竖屏在下方、横屏在右列）
    assert.ok(inner.indexOf('beat-label') > inner.indexOf('code-window'), 'beat 卡位于代码窗口之后');

    // 与 Standard 一致：代码窗口/说明卡高度来自同一 layout
    const layout = resolveCodeSceneLayout({ width: frame.width, height: frame.height, hasBeats: true, hasBeatCard: true, captionReservedPx: reserved });
    assert.ok(layout.beatCard, '有说明卡布局');
    assert.ok(layout.beatCard!.topPx + layout.beatCard!.heightPx <= frame.height - reserved + 0.01, '说明卡底边不越过 height - captionReservedPx');

    const standardWindowHeight = standardCodeWindowHeight(standard);
    const htmlWindow = tagWith(inner, /class="[^"]*\bcode-window\b/);
    const htmlWindowHeight = htmlWindow ? pxValue(styleOfTag(htmlWindow), 'height') : undefined;
    assert.ok(Number.isFinite(standardWindowHeight), 'Standard 代码窗口有高度');
    assert.ok(Number.isFinite(htmlWindowHeight), 'HTML 代码窗口有高度');
    assert.ok(Math.abs(htmlWindowHeight! - standardWindowHeight!) <= 1, `代码窗口高度与 Standard 一致（HTML ${htmlWindowHeight} vs Standard ${standardWindowHeight}）`);

    const standardCardHeight = standardBeatCardHeight(standard);
    const htmlBeatTag = tagWith(inner, /class="beat-label"/);
    const htmlCardHeight = htmlBeatTag ? pxValue(styleOfTag(htmlBeatTag), 'height') : undefined;
    assert.ok(Number.isFinite(standardCardHeight), 'Standard 说明卡有高度');
    if (Number.isFinite(htmlCardHeight)) {
      assert.ok(Math.abs(htmlCardHeight! - standardCardHeight!) <= 1, `说明卡高度与 Standard 一致（HTML ${htmlCardHeight} vs Standard ${standardCardHeight}）`);
    }
    // 若内层显式给出 top/height，则直接验证不越过字幕安全区
    if (htmlBeatTag && pxValue(styleOfTag(htmlBeatTag), 'top') !== undefined && Number.isFinite(htmlCardHeight)) {
      const bottom = (pxValue(styleOfTag(htmlBeatTag), 'top') as number) + (htmlCardHeight as number);
      assert.ok(bottom <= frame.height - reserved + 0.01, `说明卡底边 ${bottom} ≤ ${frame.height - reserved}`);
    }
  }
});

function pxValue(style: string, property: string): number | undefined {
  const match = new RegExp(`(?:^|;)\\s*${property}:\\s*([\\d.]+)px`).exec(style);
  return match ? Number(match[1]) : undefined;
}

/** Standard 代码窗口高度：white-space:pre 且带 height 的容器。 */
function standardCodeWindowHeight(markup: string): number | undefined {
  for (const tag of openTags(markup)) {
    const style = styleOfTag(tag);
    if (/white-space:\s*pre/.test(style) && /height:\s*[\d.]+px/.test(style) && pxValue(style, 'height') !== undefined) {
      return pxValue(style, 'height');
    }
  }
  return undefined;
}

/** Standard 说明卡高度：data-beat-label 所在卡片。 */
function standardBeatCardHeight(markup: string): number | undefined {
  const tag = tagWith(markup, /data-beat-label="true"/);
  return tag ? pxValue(styleOfTag(tag), 'height') : undefined;
}

// ═════════════════════════════ #21-9 确定性与安全降级 ═════════════════════════════

test('#21-9 确定性与安全降级：重复渲染一致、无 beats 正常权重无滚动、无 NaN/undefined、缺失可选字段不报错', () => {
  const scene = beatsScene();
  assert.equal(renderHtmlInner(scene, { frame: 10 }), renderHtmlInner(scene, { frame: 10 }), '同输入重复渲染一致');
  assert.equal(renderHtmlWrapper(scene, { frame: 10 }), renderHtmlWrapper(scene, { frame: 10 }), '包装节点重复渲染一致');
  assert.doesNotMatch(renderHtmlInner(scene, { frame: 10 }), /NaN|undefined/);
  assert.doesNotMatch(renderHtmlWrapper(scene, { frame: 10 }), /NaN|undefined/);

  // 无 beats：全部行正常权重、无滚动
  const noBeats = sceneOf({ code: codeOf(8) }, { title: undefined });
  const noBeatsInner = renderHtmlInner(noBeats, { frame: 0 });
  const noBeatsLater = renderHtmlInner(noBeats, { frame: 120 });
  assert.equal(noBeatsInner, noBeatsLater, '无 beats 时不同 frame 渲染一致（无滚动）');
  const lines = htmlCodeLines(noBeatsInner);
  assert.deepEqual(lines.map(line => line.lineNumber), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const line of lines) {
    assert.equal(line.classes.includes('active') || line.classes.includes('dim'), false, `无 beats 时第 ${line.lineNumber} 行不应 active/dim：${line.classes.join(' ')}`);
  }
  assert.ok(Math.abs(htmlTrackTranslateY(noBeatsInner) ?? Number.NaN) < 1e-9, '无 beats 无滚动');
  assert.equal(standardActiveLines(renderStandard(noBeats)).length, 0, 'Standard 无 beats 同样无 active');
  assert.equal(standardDimmedLines(renderStandard(noBeats)).length, 0, 'Standard 无 beats 同样无 dim');
  assert.doesNotMatch(noBeatsInner, /NaN|undefined/);

  // 缺失 label/filename/language 不报错
  const bare = sceneOf({ beats: [{ lines: [2] }] }, { title: undefined });
  assert.doesNotThrow(() => renderHtmlInner(bare), '缺失可选字段不报错');
  const bareInner = renderHtmlInner(bare);
  assert.doesNotMatch(bareInner, /undefined|NaN/);
  assert.deepEqual(htmlCodeLines(bareInner).map(line => line.lineNumber), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(htmlActiveLines(bareInner), [2], '无 label 仍按 beats 高亮');
  assert.equal(htmlBeatLabels(bareInner).filter(text => text.length > 0).length, 0, '无 label 不渲染空文本');
});

// ═════════════════════════════ #23-7 Standard 渲染器 token span ═════════════════════════════

test('#23-7 Standard 渲染器：输出 tok-* span、文本逐字保留，行号/active/dim/滚动不回归，关闭高亮焦点/viewport 不变', () => {
  clearCodeTokenCache();
  const scene = highlightScene();
  const timeline = timelineOf(scene);
  const frame = timeline[0].startFrame + 1;
  const markup = renderStandard(scene, { frame });
  const tokens = tokenSpans(markup);
  assert.ok(tokens.length > 0, 'Standard 输出 token span');
  for (const token of tokens) assert.ok(TOKEN_TYPES.includes(token.type as CodeTokenType), `token 类型合法：${token.type}`);
  const types = new Set(tokens.map(token => token.type));
  for (const type of ['keyword', 'string', 'comment', 'number', 'function', 'variable', 'punctuation']) {
    assert.ok(types.has(type), `Standard 输出应含 tok-${type}（实际：${[...types].join(',')}）`);
  }
  // 文本逐字保留
  assert.deepEqual(standardCodeLines(markup).map(line => line.text), codeLines(HIGHLIGHT_CODE), 'token 化后源码逐字一致');
  // 行号/active/dim/滚动不回归
  const disabled = renderStandard(scene, { frame, syntaxHighlight: false });
  assert.deepEqual(standardLineNumbers(markup), standardLineNumbers(disabled), '行号不受高亮开关影响');
  assert.deepEqual(standardActiveLines(markup), standardActiveLines(disabled), 'active 行不受高亮开关影响');
  assert.deepEqual(standardDimmedLines(markup), standardDimmedLines(disabled), 'dim 行不受高亮开关影响');
  assert.equal(standardTranslateY(markup), standardTranslateY(disabled), 'viewport/滚动不受高亮开关影响');
  assert.deepEqual(standardActiveLines(markup), [2], '焦点行与 beats 一致');
  // 关闭高亮：纯文本（无语法类型 token），文本仍逐字
  for (const type of ['keyword', 'string', 'comment', 'number', 'function']) {
    assert.equal(tokenSpans(disabled).some(token => token.type === type), false, `syntaxHighlight=false 不应有 tok-${type}`);
  }
  assert.deepEqual(standardCodeLines(disabled).map(line => line.text), codeLines(HIGHLIGHT_CODE), '关闭高亮文本仍逐字一致');
  // 关闭高亮时焦点/viewport 仍随 frame 正常变化
  const laterFrame = timeline[1].startFrame + 1;
  const disabledLater = renderStandard(scene, { frame: laterFrame, syntaxHighlight: false });
  assert.deepEqual(standardActiveLines(disabledLater), [18], '关闭高亮仍切换 active beat');
  assert.notEqual(standardTranslateY(disabledLater), standardTranslateY(disabled), '关闭高亮仍有 viewport 滚动');
  // function token 加粗
  const functionTag = openTags(markup).find(tag => /class="[^"]*tok-function/.test(tag));
  assert.ok(functionTag, '存在 tok-function span');
  assert.match(styleOfTag(functionTag!), /font-weight:\s*(700|bold)/, 'function token 额外 font-weight:700');
  // token 颜色来自 resolveCodeTokenColors(palette)
  const colors = resolveCodeTokenColors(palettes['minimal-tech']);
  for (const token of tokens) {
    assert.equal(token.color.toLowerCase(), colors[token.type as CodeTokenType].toLowerCase(), `tok-${token.type} 使用主题颜色`);
  }
});

// ═════════════════════════════ #23-8 两渲染器一致 token 数据 ═════════════════════════════

test('#23-8 HTML 与 Standard 使用一致 token 数据：类型/文本序列一致，sanitizer 后仍保留', () => {
  clearCodeTokenCache();
  const scene = beatsScene();
  const frame = 0;
  const standard = renderStandard(scene, { frame });
  const inner = renderHtmlInner(scene, { frame });
  const standardTokens = tokenSpans(standard).map(token => [token.type, token.text] as const);
  const htmlTokens = tokenSpans(inner).map(token => [token.type, token.text] as const);
  assert.deepEqual(htmlTokens, standardTokens, '两渲染器 token 类型/文本序列必须一致');
  // 两渲染器的 token 结果 = 共享 tokenizer 对该 scene 源码的输出（同一份数据）
  const expected = tokenizeCode(CODE, 'typescript').flatMap(line => line.tokens.map(token => [token.type, token.text] as const));
  assert.deepEqual(standardTokens, expected, 'Standard token 序列来自 tokenizeCode');
  assert.deepEqual(htmlTokens, expected, 'HTML token 序列来自同一 tokenizeCode');
  // sanitizer 后 token span 与颜色仍保留
  const sanitized = sanitizeSceneHtml(inner);
  assert.deepEqual(tokenSpans(sanitized).map(token => [token.type, token.text] as const), expected, 'sanitizer 后 token 数据不变');
  const colors = resolveCodeTokenColors(palettes['minimal-tech']);
  for (const token of tokenSpans(sanitized)) {
    assert.equal(token.color.toLowerCase(), colors[token.type as CodeTokenType].toLowerCase(), `sanitizer 后 tok-${token.type} 颜色保留`);
  }
  // 每个 token span 有 class 与 color（可被 sanitize 白名单保留）
  assert.ok(tokenSpans(sanitized).every(token => /^#[0-9a-f]{6}$/i.test(token.color)), '所有 token 颜色为合法 #rrggbb');
});

// ═════════════════════════════ #22-8 CodeHtmlScene 集成 ═════════════════════════════

test('#22-8 CodeHtmlScene 集成：真实输出经 sanitizer 后行号/高亮/滚动/颜色仍在，恶意源码不产生可执行内容', () => {
  const evilLines = [
    'const safe = 1;',
    'const evil = "</span><script>alert(1)</script>";',
    'if (a < b && c > d) { return a; }',
    'const onerror = "x";',
    '// 注释 <img onerror=alert(1)>',
    '</div><iframe src="javascript:alert(1)"></iframe>',
  ];
  // 14 行普通代码 + 6 行恶意源码 = 20 行，超过 viewport 可见行数并把恶意源码放在第二个 beat。
  const longCode = [...Array.from({ length: 14 }, (_, index) => `const v${index + 1} = ${index + 1};`), ...evilLines].join('\n');
  const scene = sceneOf({
    code: longCode,
    language: 'typescript',
    filename: 'evil.ts',
    beats: [{ lines: [2], label: '开头' }, { lines: [20], label: '恶意输入' }],
  });
  const timeline = timelineOf(scene);
  const frame = timeline[1].startFrame + 1;
  const inner = renderHtmlInner(scene, { frame });
  const sanitized = sanitizeSceneHtml(inner);

  for (const [label, markup] of [['内层片段', inner], ['sanitizer 后', sanitized]] as const) {
    assert.doesNotMatch(markup, /<script\b/i, `${label}: 不得有 script`);
    assert.doesNotMatch(markup, /<\/script/i, `${label}: 不得有 script 闭合`);
    for (const tag of openTags(markup)) {
      assert.doesNotMatch(tag, /\bon[a-z]+\s*=/i, `${label}: 不得有事件属性：${tag}`);
      assert.doesNotMatch(tag, /javascript:/i, `${label}: 不得有 javascript: 属性：${tag}`);
    }
  }

  const lines = htmlCodeLines(sanitized);
  assert.deepEqual(lines.map(line => line.lineNumber), codeLines(longCode).map((_, index) => index + 1), '行号 1..N 保留');
  assert.deepEqual(lines.map(line => line.text), codeLines(longCode), '源码逐字保留（含恶意文本）');
  assert.ok(lines.some(line => line.classes.includes('active')), '高亮 active 保留');
  assert.ok(classContains(sanitized, 'code-track'), '滚动轨道保留');
  assert.match(sanitized, /transform:\s*translateY\(/, '滚动 translateY 保留');
  assert.ok((htmlTrackTranslateY(sanitized) ?? 0) < 0, '当前 frame 已产生滚动位移');

  // token 颜色保留
  const colors = resolveCodeTokenColors(palettes['minimal-tech']);
  const tokens = tokenSpans(sanitized);
  assert.ok(tokens.length > 0, 'token span 保留');
  for (const token of tokens) {
    assert.ok(TOKEN_TYPES.includes(token.type as CodeTokenType), `token 类型合法：${token.type}`);
    assert.equal(token.color.toLowerCase(), colors[token.type as CodeTokenType].toLowerCase(), `tok-${token.type} 颜色保留`);
  }
});

// ═════════════════════════════ #23-10 渲染层缓存复用 ═════════════════════════════

test('#23-10 同 scene 多帧 Standard+HTML 只 miss 1 次；不同 code/language 重新分词', () => {
  clearCodeTokenCache();
  const scene = beatsScene();
  for (const frame of [0, 1, 10, 25, 60]) {
    renderStandard(scene, { frame });
    renderHtmlInner(scene, { frame });
  }
  const stats = codeTokenCacheStats();
  assert.equal(stats.misses, 1, `同一 scene 多帧 + 两渲染器只做一次完整分词（实际 misses=${stats.misses}）`);
  assert.equal(stats.size, 1, '只缓存一条 token 结果');

  // 不同源码 → 重新分词
  const other = sceneOf({ code: 'const other = 2;', language: 'typescript', beats: [{ lines: [1] }] });
  renderHtmlInner(other, { frame: 0 });
  assert.equal(codeTokenCacheStats().misses, 2, '不同 code 重新分词');
  // 相同源码、不同语言 → 重新分词
  const python = sceneOf({ code: 'const other = 2;', language: 'python', beats: [{ lines: [1] }] });
  renderHtmlInner(python, { frame: 0 });
  assert.equal(codeTokenCacheStats().misses, 3, '不同 language 重新分词');
  // 再次渲染同一 scene 命中缓存
  renderStandard(scene, { frame: 90 });
  assert.equal(codeTokenCacheStats().misses, 3, '同 scene 再次渲染不再 miss');
});
