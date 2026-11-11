import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import {
  captionSafeArea,
  rendererScale,
  resolveCodeBeatTimeline,
  resolveCodeScrollKeyframes,
  type Scene,
} from '@m2v/schema';
import { palettes } from '@m2v/styles';
import { CodeScene, CodeSceneView, CODE_DIM_OPACITY, resolveCodeSceneLayout } from '../src/code-scene';

/**
 * #18 / #19（渲染部分）/ #20 契约：CodeScene 聚焦渲染、viewport 滚动与横竖屏布局。
 * 无 jsdom：CodeSceneView 是无 Remotion hook 的确定性视图，直接 renderToStaticMarkup。
 */

// packages/video 没有 react-dom 依赖；从已安装 react-dom 的 apps/web 解析（等价 runner/tsx 均可用）。
const webRequire = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const { renderToStaticMarkup } = webRequire('react-dom/server') as { renderToStaticMarkup: (element: unknown) => string };

const STYLE_IDS = ['minimal-tech', 'clean-light', 'academic', 'social-short', 'whiteboard'] as const;
const LANDSCAPE = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };

const codeOf = (count: number) => Array.from({ length: count }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n');

function sceneOf(visual: Record<string, unknown>, patch: Record<string, unknown> = {}): Scene {
  return {
    id: 'code-scene',
    type: 'code',
    title: '缓存逻辑',
    narration: '这一页讲解缓存命中后的处理流程。',
    duration: 6,
    ...patch,
    visual: { code: codeOf(8), ...visual },
  } as Scene;
}

function render(scene: Scene, options: { frame?: number; width?: number; height?: number; styleId?: string } = {}): string {
  return renderToStaticMarkup(createElement(CodeSceneView, {
    scene,
    styleId: (options.styleId ?? 'minimal-tech') as never,
    frame: options.frame ?? 0,
    width: options.width ?? LANDSCAPE.width,
    height: options.height ?? LANDSCAPE.height,
  }));
}

/** 拆出全部开始标签（markup 里没有带 > 的文本，代码样例均安全）。 */
function openTags(markup: string): string[] {
  return markup.split('<').slice(1).map(chunk => {
    const end = chunk.indexOf('>');
    return end === -1 ? '' : chunk.slice(0, end);
  }).filter(tag => /^[a-zA-Z]/.test(tag));
}

/**
 * 去标签 + 解码实体，得到用户实际看到的文本。
 * V1.6.9 起每行源码由多个 tok-* span 拼接，不能再断言源码连续字符串直接出现在 markup 里。
 */
function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * 按 data-line-number div 的开/闭标签边界截取某一行的可见源码文本。
 * V1.6.9 起源码被拆成多个 tok-* span，不能再用固定字符窗口（会跨行命中、弱化断言）。
 */
function lineVisibleText(markup: string, lineNumber: number): string | undefined {
  const match = new RegExp(`<div[^>]*\\bdata-line-number="${lineNumber}"[^>]*>`).exec(markup);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  const end = markup.indexOf('</div>', start);
  const region = markup.slice(start, end === -1 ? undefined : end);
  // 行号 span 在前、源码 span 在后：去掉第一个 span（行号）后取可见文本。
  const firstSpanClose = region.indexOf('</span>');
  return visibleText(firstSpanClose === -1 ? region : region.slice(firstSpanClose + '</span>'.length));
}

const lineNumberTags = (markup: string) => openTags(markup).filter(tag => /data-line-number="/.test(tag));
const lineNumbers = (markup: string) => lineNumberTags(markup).map(tag => Number(/data-line-number="(\d+)"/.exec(tag)![1]));
const activeTags = (markup: string) => openTags(markup).filter(tag => /data-active="true"/.test(tag));
const activeLines = (markup: string) => activeTags(markup).map(tag => {
  const match = /data-line-number="(\d+)"/.exec(tag);
  return match ? Number(match[1]) : Number.NaN;
});
const dimmedTags = (markup: string) => openTags(markup).filter(tag => /data-dimmed="true"/.test(tag));
const styleOf = (tag: string) => /style="([^"]*)"/.exec(tag)?.[1] ?? '';
const opacityOf = (tag: string) => {
  const match = /opacity:\s*([\d.]+)/.exec(styleOf(tag));
  return match ? Number(match[1]) : undefined;
};
const tagContaining = (markup: string, pattern: RegExp): string | undefined => openTags(markup).find(tag => pattern.test(tag));
const textAfterTag = (markup: string, tag: string, radius = 240) => markup.slice(markup.indexOf(tag), markup.indexOf(tag) + radius);

// ═════════════════════════════ #18 ═════════════════════════════

// ── #18-1 visual.code 每一行渲染进 markup，根节点 data-code-scene ────────────────
test('#18-1 CodeSceneView 渲染 visual.code 的每一行且根节点含 data-code-scene', () => {
  const scene = sceneOf({ beats: [{ lines: [2], label: '命中' }] });
  const markup = render(scene);
  assert.match(markup, /data-code-scene="true"/, '根节点标记');
  for (let index = 1; index <= 8; index += 1) {
    assert.ok(visibleText(markup).includes(`const line${index} = ${index};`), `第 ${index} 行源码出现在可见文本中`);
  }
  const numbers = lineNumbers(markup);
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8], '8 行全部渲染且行号连续');
});

// ── #18-2 行号连续且始终是源文件行号 ────────────────────────────────────────────
test('#18-2 data-line-number 为 1..N 连续且与源码行序一致，滚动窗口内仍是源行号', () => {
  const small = render(sceneOf({ beats: [{ lines: [2] }] }));
  assert.deepEqual(lineNumbers(small), [1, 2, 3, 4, 5, 6, 7, 8], '全量可见时 1..N 连续');
  for (const number of [1, 5, 8]) {
    assert.equal(lineVisibleText(small, number), `const line${number} = ${number};`, `行号 ${number} 区域对应源码第 ${number} 行（按行边界截取，不跨行）`);
  }

  // 30 行代码、beat 在 20 行：渲染窗口/全量都必须是源行号，不能重新从 1 编号。
  const scene = sceneOf({ code: codeOf(30), beats: [{ lines: [20], label: '请求数据' }] });
  const markup = render(scene);
  const numbers = lineNumbers(markup);
  assert.ok(numbers.includes(20), '当前 beat 行渲染');
  for (let index = 1; index < numbers.length; index += 1) {
    assert.equal(numbers[index], numbers[index - 1] + 1, `行号连续：${numbers.join(',')}`);
  }
  for (const number of numbers) {
    assert.ok(number >= 1 && number <= 30, `源行号范围 1..30，实际 ${number}`);
    assert.equal(lineVisibleText(markup, number), `const line${number} = ${number};`, `行号 ${number} 与该行区域源码逐字一致`);
  }
  assert.ok(numbers.length === 30 || numbers.length <= 16, '要么全量渲染，要么是可见窗口');
});

// ── #18-3 高亮随 frame 按 resolveCodeBeatTimeline 切换 ──────────────────────────
test('#18-3 data-active 行集合随 frame 切换：同一 beat 内稳定、跨 beat 变化', () => {
  const scene = sceneOf({
    code: codeOf(12),
    beats: [
      { lines: [2, 3], label: '命中后返回' },
      { lines: [9, 10], label: '回源请求' },
    ],
  });
  const timeline = resolveCodeBeatTimeline(scene, 30);
  assert.equal(timeline.length, 2);
  const [first, second] = timeline;
  const firstMarkup = render(scene, { frame: first.startFrame + 1 });
  const firstStable = render(scene, { frame: Math.floor((first.startFrame + first.endFrame) / 2) });
  const secondMarkup = render(scene, { frame: second.startFrame + 1 });

  assert.deepEqual(activeLines(firstMarkup).sort((a, b) => a - b), [2, 3], '第一个 beat 高亮 2,3');
  assert.deepEqual(activeLines(firstStable).sort((a, b) => a - b), [2, 3], '同一 beat 内高亮稳定');
  assert.deepEqual(activeLines(secondMarkup).sort((a, b) => a - b), [9, 10], '第二个 beat 高亮 9,10');
  assert.notDeepEqual(activeLines(firstMarkup), activeLines(secondMarkup), '跨 beat 高亮变化');
});

// ── #18-4 非重点行降低 opacity 但仍可辨认 ───────────────────────────────────────
test('#18-4 非当前行 data-dimmed 且 opacity === CODE_DIM_OPACITY（<1 且 ≥0.35）', () => {
  assert.ok(CODE_DIM_OPACITY < 1, 'dim 不是完全透明');
  assert.ok(CODE_DIM_OPACITY >= 0.35, 'dim 后仍可辨认');
  const markup = render(sceneOf({ code: codeOf(12), beats: [{ lines: [2, 3], label: '命中' }] }));
  const dimmed = dimmedTags(markup);
  assert.ok(dimmed.length > 0, '存在弱化的非重点行');
  for (const tag of dimmed) {
    assert.equal(opacityOf(tag), CODE_DIM_OPACITY, `dimmed 行 opacity 应为 ${CODE_DIM_OPACITY}：${tag}`);
  }
  const dimmedNumbers = new Set(dimmed.map(tag => Number(/data-line-number="(\d+)"/.exec(tag)?.[1] ?? Number.NaN)));
  for (const active of activeLines(markup)) assert.equal(dimmedNumbers.has(active), false, `高亮行 ${active} 不应被弱化`);
  assert.ok(dimmedNumbers.size > 0, '弱化行带源行号');
});

// ── #18-5 filename/language 缺失时正常降级 ─────────────────────────────────────
test('#18-5 filename/language 缺失时布局正常，存在时 header 同时包含两者', () => {
  const missing = render(sceneOf({ beats: [{ lines: [2] }] }));
  assert.match(missing, /data-code-scene="true"/);
  assert.doesNotMatch(missing, /undefined/, '缺失字段不渲染 undefined');
  assert.deepEqual(lineNumbers(missing), [1, 2, 3, 4, 5, 6, 7, 8]);

  const withHeader = render(sceneOf({ language: 'typescript', filename: 'cache.ts', beats: [{ lines: [2] }] }));
  const header = tagContaining(withHeader, /data-code-header/);
  assert.ok(header, '存在 data-code-header');
  const headerRegion = textAfterTag(withHeader, header!, 400);
  assert.ok(headerRegion.includes('cache.ts'), 'header 含 filename');
  assert.ok(headerRegion.includes('typescript'), 'header 含 language');
  assert.doesNotMatch(withHeader, /undefined/);
});

// ── #18-6 5 套 style 均可读 ─────────────────────────────────────────────────────
test('#18-6 5 套 style 下 CodeSceneView 均输出代码文本与有效配色', () => {
  const scene = sceneOf({ language: 'typescript', filename: 'cache.ts', beats: [{ lines: [2], label: '命中' }] });
  const markups = new Set<string>();
  for (const styleId of STYLE_IDS) {
    const markup = render(scene, { styleId });
    assert.ok(visibleText(markup).includes('const line1 = 1;'), `${styleId} 输出代码文本`);
    assert.ok(markup.toLowerCase().includes(palettes[styleId].bg.toLowerCase()), `${styleId} 使用该 style 背景色 ${palettes[styleId].bg}`);
    assert.doesNotMatch(markup, /undefined/, `${styleId} 无 undefined`);
    assert.match(markup, /#[0-9a-f]{3,8}/i, `${styleId} 有合法色值`);
    markups.add(markup);
  }
  assert.equal(markups.size, 5, '5 套 style 的渲染结果互不相同');
});

// ── #18-7 无 beats 的静态 fallback ──────────────────────────────────────────────
test('#18-7 无 beats 时全部行正常权重、无滚动、静态渲染稳定', () => {
  const scene = sceneOf({ code: codeOf(8) });
  const markup = render(scene, { frame: 0 });
  assert.match(markup, /data-code-scene="true"/);
  assert.deepEqual(lineNumbers(markup), [1, 2, 3, 4, 5, 6, 7, 8], 'visibleLineCount 填满可见行');
  assert.equal(dimmedTags(markup).length, 0, '无 beats 不弱化任何行');
  assert.equal(activeTags(markup).length, 0, '无 beats 不标记高亮行');
  assert.equal(render(scene, { frame: 120 }), markup, '无 beats 时不同 frame 渲染一致（无滚动）');
});

// ── #18-8 SceneView 集成路径（源码形状断言）─────────────────────────────────────
test('#18-8 index.tsx 的 case code 走 CodeScene 并绕过 FitContent，legacy explanation/steps 路径保留', () => {
  const indexPath = fileURLToPath(new URL('../src/index.tsx', import.meta.url));
  const source = readFileSync(indexPath, 'utf8');
  assert.match(source, /from ['"]\.\/code-scene['"]/, 'index.tsx 接入 code-scene');
  assert.match(source, /codeVisualOf/, '使用 codeVisualOf 判定 visual.code');
  const codeCaseIndex = source.indexOf("case 'code'");
  assert.ok(codeCaseIndex >= 0, '存在 case code');
  const nextCaseIndex = source.indexOf("case '", codeCaseIndex + "case 'code'".length);
  const branch = source.slice(codeCaseIndex, nextCaseIndex === -1 ? undefined : nextCaseIndex);
  assert.match(branch, /CodeScene/, 'code 分支渲染 CodeScene');
  assert.doesNotMatch(branch, /FitContent/, 'code 分支不计入 FitContent 缩放');
  assert.match(source, /explanation/, 'legacy explanation 渲染仍保留');
  assert.match(source, /steps/, 'legacy steps 渲染仍保留');
  assert.equal(typeof CodeScene, 'function', 'CodeScene 渲染器入口可用');

  // 渲染器源码不包含 FitContent 缩放路径。
  const codeSceneSource = readFileSync(fileURLToPath(new URL('../src/code-scene.tsx', import.meta.url)), 'utf8');
  assert.doesNotMatch(codeSceneSource, /FitContent/);
});

// ═════════════════════════════ #19（渲染部分）════════════════════════════════════

// ── #19-1 50+ 行可读字号保护、不走 FitContent ───────────────────────────────────
test('#19-1 55 行代码可见行数受保护、字号 ≥ 16*scale 且 code 渲染不经过 FitContent', () => {
  const scene = sceneOf({ code: codeOf(55), beats: [{ lines: [50], label: '末尾逻辑' }] });
  for (const frame of [LANDSCAPE, PORTRAIT]) {
    const layout = resolveCodeSceneLayout({
      width: frame.width,
      height: frame.height,
      hasBeats: true,
      hasBeatCard: true,
      captionReservedPx: 0,
    });
    const scale = rendererScale(frame.width, frame.height);
    const portrait = frame.height > frame.width;
    const minimum = portrait ? 7 : 12;
    const maximum = portrait ? 11 : 16;
    assert.ok(layout.visibleLineCount >= minimum && layout.visibleLineCount <= maximum, `可见行数 ${layout.visibleLineCount} 在 ${minimum}..${maximum}`);
    assert.ok(layout.fontSizePx >= 16 * scale, `字号 ${layout.fontSizePx} ≥ ${16 * scale}`);
  }
  const markup = render(scene, { frame: 0 });
  assert.ok(activeLines(markup).includes(50), '当前 beat 行（50）渲染并可高亮');
  const fontSizes = [...markup.matchAll(/font-size:([\d.]+)px/g)].map(match => Number(match[1]));
  assert.ok(Math.max(...fontSizes) >= 16, `代码字号 ≥16px，实际 ${Math.max(...fontSizes)}`);
});

// ── #19-8 超长单行不折行、横向溢出裁剪 ─────────────────────────────────────────
test('#19-8 代码容器 whiteSpace=pre + overflow=hidden，超长单行不撑破布局', () => {
  const longLine = `const veryLong = "${'x'.repeat(180)}";`;
  const scene = sceneOf({ code: `const short = 1;\n${longLine}\nconst tail = 2;`, beats: [{ lines: [2] }] });
  const markup = render(scene);
  const tags = openTags(markup);
  const preTag = tags.find(tag => /white-space:\s*pre(?![\w-])/.test(styleOf(tag)));
  assert.ok(preTag, '代码容器使用 white-space: pre（不自动折行）');
  assert.ok(tags.some(tag => /overflow:\s*hidden/.test(styleOf(tag))), '代码容器 overflow: hidden（横向裁剪）');
  assert.ok(visibleText(markup).includes(longLine), '超长行原样输出');
  const layout = resolveCodeSceneLayout({ width: LANDSCAPE.width, height: LANDSCAPE.height, hasBeats: true, hasBeatCard: true, captionReservedPx: 0 });
  assert.ok(layout.maxTextWidthPx > 0 && layout.maxTextWidthPx <= LANDSCAPE.width, 'maxTextWidthPx 生效且不超过画幅');
});

// ── #19-7 高亮与滚动同步：滚动在 beat.startFrame 前完成 ─────────────────────────
test('#19-7 滚动完成帧与高亮切换帧一致（transition ≤15 帧且不先高亮屏幕外代码）', () => {
  const scene = sceneOf({
    code: codeOf(60),
    beats: [
      { lines: [2], label: '开头' },
      { lines: [50], label: '末尾' },
    ],
  });
  const timeline = resolveCodeBeatTimeline(scene, 30);
  assert.equal(timeline.length, 2);
  const [first, second] = timeline;
  const layout = resolveCodeSceneLayout({ width: LANDSCAPE.width, height: LANDSCAPE.height, hasBeats: true, hasBeatCard: true, captionReservedPx: 0 });
  const keyframes = resolveCodeScrollKeyframes({ beats: timeline, totalLines: 60, visibleLineCount: layout.visibleLineCount });
  assert.equal(keyframes[keyframes.length - 1].frame, second.startFrame, '滚动在 beat.startFrame 完成');
  assert.ok(keyframes[keyframes.length - 1].frame - keyframes[keyframes.length - 2].frame <= 15, '过渡 ≤15 帧');

  // 滚动开始前（默认 12 帧过渡：startFrame-13）仍高亮旧 beat；切换帧起高亮新 beat。
  const beforeSwitch = render(scene, { frame: second.startFrame - 13 });
  const atSwitch = render(scene, { frame: second.startFrame });
  assert.deepEqual(activeLines(beforeSwitch).sort((a, b) => a - b), [2], '切换前仍高亮旧 beat');
  assert.deepEqual(activeLines(atSwitch).sort((a, b) => a - b), [50], '切换帧高亮新 beat');
  assert.ok(activeLines(atSwitch).every(line => !activeLines(beforeSwitch).includes(line)));
  assert.ok(first.endFrame <= second.startFrame, '时间轴连续覆盖');
});

// ═════════════════════════════ #20 ═════════════════════════════

const layoutOf = (patch: Record<string, unknown> = {}) => resolveCodeSceneLayout({
  width: LANDSCAPE.width,
  height: LANDSCAPE.height,
  hasBeats: true,
  hasBeatCard: true,
  captionReservedPx: 0,
  ...patch,
});

// ── #20-1 横屏代码区宽度 ≥ 68%，说明卡 ≤ 32% ───────────────────────────────────
test('#20-1 16:9 有说明卡时代码区宽度 ≥ 68%，说明卡宽 24%–32%；无说明卡时代码区 100%', () => {
  const layout = layoutOf();
  assert.equal(layout.stacked, false, '横屏不上下堆叠');
  assert.ok(layout.beatCard, '有说明卡');
  assert.notEqual(layout.beatCard!.placement, 'below', '横屏说明卡在右侧而不是下方');
  assert.ok(layout.codeArea.widthPx >= LANDSCAPE.width * 0.68, `代码区宽 ${layout.codeArea.widthPx} ≥ 68%*1920`);
  assert.ok(layout.codeArea.widthPx <= LANDSCAPE.width);
  const cardRatio = layout.beatCard!.widthPx / LANDSCAPE.width;
  assert.ok(cardRatio >= 0.24 && cardRatio <= 0.32, `说明卡宽度占比 ${cardRatio} 在 24%..32%`);
  assert.ok(layout.beatCard!.topPx >= 0, '说明卡 top 合法');

  const withoutCard = layoutOf({ hasBeatCard: false });
  assert.equal(withoutCard.beatCard, null);
  assert.equal(withoutCard.codeArea.widthPx, LANDSCAPE.width, '无说明卡时代码区 100% 宽');

  const noCurrentBeat = layoutOf({ hasBeats: false, hasBeatCard: true });
  assert.equal(noCurrentBeat.beatCard, null, '无 beats 时不显示说明卡');
});

// ── #20-2 竖屏上下布局 ─────────────────────────────────────────────────────────
test('#20-2 9:16 使用上下布局：stacked=true、说明卡 placement=below、不做左右分栏', () => {
  const layout = layoutOf({ width: PORTRAIT.width, height: PORTRAIT.height });
  assert.equal(layout.stacked, true);
  assert.ok(layout.beatCard, '竖屏有说明卡');
  assert.equal(layout.beatCard!.placement, 'below');
  assert.ok(layout.codeArea.widthPx >= PORTRAIT.width * 0.9, `代码区宽 ${layout.codeArea.widthPx} 接近整幅宽度（不做窄左右栏）`);
  assert.ok(layout.beatCard!.topPx > 0, '说明卡在代码下方而不是顶部');
  assert.ok(layout.beatCard!.topPx + layout.beatCard!.heightPx <= PORTRAIT.height, '说明卡不超出画幅');
});

// ── #20-3 说明卡不遮挡字幕 ────────────────────────────────────────────────────
test('#20-3 两种画幅下 beat 说明卡底边不超过 height - captionReservedPx', () => {
  for (const frame of [LANDSCAPE, PORTRAIT]) {
    for (const captionReservedPx of [0, 100, 240]) {
      const layout = resolveCodeSceneLayout({ width: frame.width, height: frame.height, hasBeats: true, hasBeatCard: true, captionReservedPx });
      assert.ok(layout.beatCard, `${frame.width}x${frame.height} reserved=${captionReservedPx}`);
      const bottom = layout.beatCard!.topPx + layout.beatCard!.heightPx;
      assert.ok(bottom <= frame.height - captionReservedPx + 0.01, `card bottom ${bottom} ≤ ${frame.height - captionReservedPx}`);
      assert.ok(layout.beatCard!.topPx >= 0);
    }
    // 用真实 captionSafeArea 计算字幕保留高度
    const scale = rendererScale(frame.width, frame.height);
    const reserved = captionSafeArea({ videoHeight: frame.height, fontSize: 30, scale }).total;
    const layout = resolveCodeSceneLayout({ width: frame.width, height: frame.height, hasBeats: true, hasBeatCard: true, captionReservedPx: reserved });
    assert.ok(layout.beatCard!.topPx + layout.beatCard!.heightPx <= frame.height - reserved + 0.01, '真实字幕安全区');
  }
});

// ── #20-4 title/filename/language 长文本收缩/省略 ─────────────────────────────
test('#20-4 maxTextWidthPx 有限且小于画幅，header 使用 ellipsis + nowrap + maxWidth', () => {
  const layout = layoutOf();
  assert.ok(Number.isFinite(layout.maxTextWidthPx));
  assert.ok(layout.maxTextWidthPx > 0 && layout.maxTextWidthPx < LANDSCAPE.width, '有限且小于布局宽度');
  const longFilename = `${'very-long-filename-'.repeat(5)}cache.ts`.slice(0, 100);
  const longTitle = '这是一个很长很长的代码场景标题用于检验标题收缩行为是否正确';
  const scene = sceneOf({ language: 'x'.repeat(30), filename: longFilename, beats: [{ lines: [2], label: '命中' }] }, { title: longTitle });
  const markup = render(scene);
  assert.ok(markup.includes(longFilename), '超长 filename 仍在 DOM 中并被 CSS 省略');
  assert.match(markup, /text-overflow:\s*ellipsis/);
  assert.match(markup, /white-space:\s*nowrap/);
  assert.match(markup, /max-width:\s*[\d.]+px/);
  const header = tagContaining(markup, /data-code-header/);
  assert.ok(header, 'header 存在');
  const headerStyle = styleOf(header!);
  assert.ok(/text-overflow:\s*ellipsis/.test(headerStyle) || openTags(markup).some(tag => /text-overflow:\s*ellipsis/.test(styleOf(tag))));
});

// ── #20-5 画幅切换 viewport 行数自动调整 ─────────────────────────────────────
test('#20-5 同一 scene 在 16:9 与 9:16 下 visibleLineCount 分别落在 12..16 / 7..11 且不同', () => {
  const scene = sceneOf({ code: codeOf(80), beats: [{ lines: [40] }] });
  const landscape = resolveCodeSceneLayout({ width: LANDSCAPE.width, height: LANDSCAPE.height, hasBeats: true, hasBeatCard: true, captionReservedPx: 0 });
  const portrait = resolveCodeSceneLayout({ width: PORTRAIT.width, height: PORTRAIT.height, hasBeats: true, hasBeatCard: true, captionReservedPx: 0 });
  assert.ok(landscape.visibleLineCount >= 12 && landscape.visibleLineCount <= 16, `landscape ${landscape.visibleLineCount}`);
  assert.ok(portrait.visibleLineCount >= 7 && portrait.visibleLineCount <= 11, `portrait ${portrait.visibleLineCount}`);
  assert.notEqual(landscape.visibleLineCount, portrait.visibleLineCount, '画幅切换后可见行数自动调整');
  // 渲染两侧都仍包含当前 beat 行
  for (const frame of [LANDSCAPE, PORTRAIT]) {
    const markup = render(scene, { frame: 0, width: frame.width, height: frame.height });
    assert.ok(activeLines(markup).includes(40), `${frame.width}x${frame.height} 当前 beat 可见`);
  }
});

// ── #20-6 5 style × 2 画幅可读 ────────────────────────────────────────────────
test('#20-6 5 套 style × 横竖屏的 CodeSceneView 均可读：代码文本、有效配色、字号下限', () => {
  const scene = sceneOf({ language: 'typescript', filename: 'cache.ts', beats: [{ lines: [2], label: '命中' }] });
  for (const frame of [LANDSCAPE, PORTRAIT]) {
    const scale = rendererScale(frame.width, frame.height);
    const layout = resolveCodeSceneLayout({ width: frame.width, height: frame.height, hasBeats: true, hasBeatCard: true, captionReservedPx: 0 });
    assert.ok(layout.fontSizePx >= 16 * scale, `字号受保护 ${layout.fontSizePx} ≥ ${16 * scale}`);
    for (const styleId of STYLE_IDS) {
      const markup = render(scene, { width: frame.width, height: frame.height, styleId });
      assert.ok(visibleText(markup).includes('const line1 = 1;'), `${frame.width}x${frame.height} ${styleId} 输出代码`);
      assert.match(markup, /#[0-9a-f]{3,8}/i, `${styleId} 有效色值`);
      assert.doesNotMatch(markup, /undefined|NaN/, `${styleId} 无 undefined/NaN`);
    }
  }
});

// ── #20-7 布局纯函数确定性 + 非法尺寸回退 ─────────────────────────────────────
test('#20-7 resolveCodeSceneLayout 相同输入 deepEqual，非法尺寸安全回退为有限非负数值', () => {
  const input = { width: LANDSCAPE.width, height: LANDSCAPE.height, hasBeats: true, hasBeatCard: true, captionReservedPx: 120 };
  assert.deepEqual(resolveCodeSceneLayout(input), resolveCodeSceneLayout({ ...input }), '纯函数确定性');
  const invalidCases = [
    { width: 0, height: 0 },
    { width: -1920, height: -1080 },
    { width: Number.NaN, height: LANDSCAPE.height },
    { width: LANDSCAPE.width, height: 0 },
  ];
  for (const invalid of invalidCases) {
    const layout = resolveCodeSceneLayout({ ...invalid, hasBeats: true, hasBeatCard: true, captionReservedPx: 0 });
    const numbers = [layout.codeArea.widthPx, layout.codeArea.heightPx, layout.fontSizePx, layout.lineHeightPx, layout.visibleLineCount, layout.maxTextWidthPx];
    if (layout.beatCard) numbers.push(layout.beatCard.widthPx, layout.beatCard.heightPx, layout.beatCard.topPx);
    for (const value of numbers) {
      assert.ok(Number.isFinite(value) && value >= 0, `${JSON.stringify(invalid)} 的布局数值 ${value} 有限非负`);
    }
    assert.ok(layout.codeArea.widthPx > 0, '非法尺寸回退到正数画幅');
    assert.ok(Number.isInteger(layout.visibleLineCount) && layout.visibleLineCount >= 1);
  }
});

// ── #20-8 title/filename/language 缺失或超长时布局数值有限 ─────────────────────
test('#20-8 标题/文件名/语言缺失或超长时布局与渲染数值有限非负，无 NaN/undefined', () => {
  const variants = [
    sceneOf({ beats: [{ lines: [2] }] }, { title: undefined }),
    sceneOf({ language: 'x'.repeat(30), filename: `${'f'.repeat(96)}.ts`, beats: [{ lines: [2] }] }, { title: '超长标题'.repeat(10).slice(0, 50) }),
  ];
  for (const scene of variants) {
    for (const frame of [LANDSCAPE, PORTRAIT]) {
      const layout = resolveCodeSceneLayout({ width: frame.width, height: frame.height, hasBeats: true, hasBeatCard: true, captionReservedPx: 0 });
      assert.ok(Number.isFinite(layout.codeArea.widthPx) && layout.codeArea.widthPx >= 0);
      assert.ok(Number.isFinite(layout.beatCard!.topPx) && layout.beatCard!.topPx >= 0);
      assert.ok(Number.isFinite(layout.beatCard!.heightPx) && layout.beatCard!.heightPx >= 0);
      const markup = render(scene, { width: frame.width, height: frame.height });
      assert.doesNotMatch(markup, /NaN|undefined/, '渲染结果无 NaN/undefined');
      assert.match(markup, /data-code-scene="true"/);
    }
  }
});
