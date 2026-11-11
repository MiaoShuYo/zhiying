import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSceneHtml, SceneSchema } from '../src/index';
import { structuredSceneHtml } from '../../../apps/web/src/lib/pipeline';

/**
 * #22 契约：扩展后的 `sanitizeSceneHtml` 代码布局样式白名单（doc/V1.6.9_issues.md §2.4）。
 * 覆盖 #22-1..7；#22-8 的 CodeHtmlScene 集成在 packages/video/test/code-html-scene.test.ts。
 */

type Declaration = { property: string; value: string };

/** 按 `;` 拆分声明，但不拆 HTML 实体（如 `&quot;`）里的分号。 */
function splitDeclarations(style: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (const char of style) {
    if (char === ';' && !/&[a-z0-9]+$/i.test(current)) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** 读取 sanitize 输出里全部 style 声明（属性小写、值空白折叠），用于逐属性断言。 */
function declarations(html: string): Declaration[] {
  const result: Declaration[] = [];
  for (const match of html.matchAll(/style="([^"]*)"/g)) {
    for (const part of splitDeclarations(match[1])) {
      const colon = part.indexOf(':');
      if (colon < 1) continue;
      result.push({
        property: part.slice(0, colon).trim().toLowerCase(),
        value: part.slice(colon + 1).replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return result;
}

/** 输入单引号 style 属性（便于在值里使用双引号），返回整理后的声明表。 */
function styleMap(style: string): Map<string, string> {
  const output = sanitizeSceneHtml(`<div style='${style}'>x</div>`);
  assert.match(output, /^<div\b[^>]*>/i, `sanitizer 应保留 div 标签：${output}`);
  const map = new Map<string, string>();
  for (const declaration of declarations(output)) map.set(declaration.property, declaration.value);
  return map;
}

function sanitizedTagAttrs(input: string): string[] {
  return [...input.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)].map(match => `${match[1].toLowerCase()} ${match[2]}`);
}

const FORBIDDEN_TAGS = /<(script|style|iframe|object|embed|form|video|audio|svg|math)\b/i;

// ═════════════════════════════ #22-1 新属性保留 ═════════════════════════════

test('#22-1 font-family/white-space/overflow/overflow-x/overflow-y/opacity/transform/transform-origin 经 sanitizer 后均保留', () => {
  const map = styleMap(
    'font-family:Consolas, monospace;white-space:pre;overflow:hidden;overflow-x:auto;overflow-y:visible;opacity:0.62;transform:translateY(-24px);transform-origin:left top;color:#f3f7ff',
  );
  assert.equal(map.get('font-family'), 'Consolas, monospace');
  assert.equal(map.get('white-space'), 'pre');
  assert.equal(map.get('overflow'), 'hidden');
  assert.equal(map.get('overflow-x'), 'auto');
  assert.equal(map.get('overflow-y'), 'visible');
  assert.equal(map.get('opacity'), '0.62');
  assert.equal(map.get('transform'), 'translateY(-24px)');
  assert.equal(map.get('transform-origin'), 'left top');
  assert.equal(map.get('color'), '#f3f7ff', '既有 color 属性仍保留');
  // CodeScene 布局另需的既有属性（§2.4：min-height / margin-left 沿用通用字符白名单）
  const layoutAttributes = styleMap('min-height:74px;margin-left:auto');
  assert.equal(layoutAttributes.get('min-height'), '74px', 'min-height 保留');
  assert.equal(layoutAttributes.get('margin-left'), 'auto', 'margin-left 保留');
  // 单引号等宽字体栈（HTML CodeScene 的 font-family）保留且 style 属性仍合法
  const monoFont = sanitizeSceneHtml(`<div style="font-family:'JetBrains Mono', SFMono-Regular, Consolas, Menlo, monospace">x</div>`);
  assert.match(monoFont, /font-family:'JetBrains Mono', SFMono-Regular, Consolas, Menlo, monospace/, '单引号等宽字体栈保留');
});

// ═════════════════════════════ #22-2 安全值校验 ═════════════════════════════

test('#22-2 逐属性安全值校验：opacity 0-1、overflow/white-space 枚举、transform translate/scale、transform-origin 受限 token、font-family 安全名', () => {
  const matrix: { property: string; allowed: string[]; rejected: string[] }[] = [
    {
      property: 'opacity',
      allowed: ['0', '1', '0.55'],
      rejected: ['1.5', '-0.1', 'abc', '0.5x', '1e2', '0.5 0.5'],
    },
    {
      property: 'overflow',
      allowed: ['visible', 'hidden', 'auto', 'scroll', 'clip'],
      rejected: ['overlay', 'hidden auto', 'scroll !important', 'inherit', 'none'],
    },
    {
      property: 'white-space',
      allowed: ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces'],
      rejected: ['pre-wrap-x', 'inherit', 'pre wrap', 'preserve'],
    },
    {
      property: 'transform',
      allowed: [
        'translateX(10px)',
        'translateY(-24px)',
        'translate(10px, 20px)',
        'translate(10px 20px)',
        'translate(0, 12px)',
        'scale(1.05)',
        'scale(1.2 0.8)',
        'scaleX(2)',
        'translateY(-10px) scale(1.02)',
        'translate(1px) translate(2px) scale(1.1)',
      ],
      rejected: ['matrix(1,0,0,1,0,0)', 'rotate(45deg)', 'skew(10deg)', 'perspective(100px)', 'calc(10px + 1px)', 'var(--x)'],
    },
    {
      property: 'transform-origin',
      allowed: ['left', 'center', '50% 50%', 'top right', '10px 20px'],
      rejected: ['left top center', '50% 50% 50%', 'left top right', '10 20 30', 'x'.repeat(45)],
    },
    {
      property: 'font-family',
      allowed: ['Consolas', 'JetBrains Mono, Consolas, monospace', '思源黑体', 'Font_1-x, serif'],
      rejected: ['Arial (fallback)', 'Arial < 12', 'Arial\\65', 'x'.repeat(130), 'url(font.woff)'],
    },
  ];
  for (const { property, allowed, rejected } of matrix) {
    for (const value of allowed) {
      const map = styleMap(`${property}:${value}`);
      assert.equal(map.get(property), value.replace(/\s+/g, ' ').trim(), `${property}:${value} 应保留`);
    }
    for (const value of rejected) {
      const map = styleMap(`${property}:${value}`);
      assert.equal(map.has(property), false, `${property}:${value} 应被丢弃（实际 ${String(map.get(property))}）`);
    }
  }
});

// ═════════════════════════════ #22-3 恶意 transform 拒绝 ═════════════════════════════

test('#22-3 恶意 transform：matrix/rotate/skew/calc/url/expression/嵌套函数/超长/超函数数全部丢弃', () => {
  const malicious = [
    'matrix(1,0,0,1,0,0)',
    'rotate(45deg)',
    'skew(10deg, 5deg)',
    'perspective(100px)',
    'calc(10px + 1px)',
    'var(--offset)',
    'translate(scale(1.1))',
    'translate(calc(10px))',
    'translate(1px) rotate(2deg)',
    'translateZ(10px)',
    'scale(1.1) scale(1.2) scale(1.3) scale(1.4)',
    `translate(${'9'.repeat(120)}px)`,
    'url(https://evil.test/x.png)',
    'expression(alert(1))',
  ];
  for (const value of malicious) {
    const map = styleMap(`transform:${value}`);
    assert.equal(map.has('transform'), false, `恶意 transform 应被丢弃：${value}`);
  }
  const safe = styleMap('transform:translateY(-24px) scale(1.02)');
  assert.equal(safe.get('transform'), 'translateY(-24px) scale(1.02)', '合法 transform 仍保留');
  // 分号注入：transform 值只保留合法函数，注入的其它声明按各自白名单独立校验
  const injected = styleMap('transform:translate(10px);background:red;color:#fff');
  assert.equal(injected.get('transform'), 'translate(10px)', 'transform 值不含注入内容');
  assert.equal(injected.get('color'), '#fff', '后续合法声明独立生效');
});

// ═════════════════════════════ #22-4 恶意 font-family 拒绝 ═════════════════════════════

test('#22-4 恶意 font-family：url/expression/分号注入/尖括号/反斜杠/超长全部丢弃或安全隔离', () => {
  for (const value of ['url(evil.woff)', 'expression(alert(1))', 'Arial < 12', 'Arial\\2f', 'x'.repeat(130)]) {
    const map = styleMap(`font-family:${value}`);
    assert.equal(map.has('font-family'), false, `恶意 font-family 应被丢弃：${value}`);
  }
  // 分号注入：font-family 值只保留合法部分，注入的其它声明按各自白名单独立校验
  const injected = styleMap('font-family:Arial;position:fixed;background:url(https://evil.test/x)');
  assert.equal(injected.get('font-family'), 'Arial');
  assert.equal(injected.has('position'), false, '非白名单 position 被丢弃');
  assert.equal(injected.has('background'), false, 'url(...) 注入被丢弃');
  // 双引号输出转义，保证 style 属性合法
  const quoted = sanitizeSceneHtml(`<div style='font-family:Foo "Bar", monospace'>x</div>`);
  const styleValue = /style="([^"]*)"/.exec(quoted)?.[1];
  assert.ok(styleValue, `font-family 引号转义后仍应有 style 属性：${quoted}`);
  assert.equal(styleValue!.includes('"'), false, 'style 属性值内不得包含裸双引号');
  const quotedDeclarations = declarations(quoted);
  assert.equal(quotedDeclarations.find(declaration => declaration.property === 'font-family')?.value, 'Foo &quot;Bar&quot;, monospace', '双引号转义为 &quot;');
});

// ═════════════════════════════ #22-5 URL/expression 全局拒绝 ═════════════════════════════

test('#22-5 全局拒绝 url(/URL(/data:/javascript:/vbscript:/behavior:/-moz-binding/expression/反斜杠/控制字符/引号注入', () => {
  const forbidden: { property: string; style: string }[] = [
    { property: 'background', style: 'background:url(http://evil.test/x)' },
    { property: 'background', style: 'background:URL(HTTP://EVIL.TEST/X)' },
    { property: 'background', style: 'background:data:image/png;base64,AAAA' },
    { property: 'background', style: 'background:javascript:alert(1)' },
    { property: 'background', style: 'background:vbscript:msgbox(1)' },
    { property: 'color', style: 'color:expression(alert(1))' },
    { property: 'border', style: 'border:1px solid behavior:url(x)' },
    { property: 'color', style: 'color:-moz-binding' },
    { property: 'color', style: 'color:red\\65' },
    { property: 'color', style: 'color:red\u0001' },
  ];
  for (const { property, style } of forbidden) {
    const map = styleMap(style);
    assert.equal(map.has(property), false, `全局拒绝应丢弃：${style}`);
  }
  // 混合输入：坏声明丢弃，好声明保留
  const mixed = styleMap('background:url(http://evil.test/x);color:#f3f7ff;opacity:0.5');
  assert.equal(mixed.has('background'), false);
  assert.equal(mixed.get('color'), '#f3f7ff');
  assert.equal(mixed.get('opacity'), '0.5');

  // style 引号注入：不允许逃逸出 style 属性生成事件属性
  for (const input of [
    `<div style="color:red' onmouseover='alert(1)">x</div>`,
    `<div style="color:red&quot; onmouseover=&quot;alert(1)">x</div>`,
    `<div style='color:red" onmouseover="alert(1)'>x</div>`,
  ]) {
    const output = sanitizeSceneHtml(input);
    assert.doesNotMatch(output, /\bon[a-z]+\s*=/i, `不得生成事件属性：${output}`);
    assert.doesNotMatch(output, /alert\(1\)/i, `不得保留注入脚本：${output}`);
    for (const attrs of sanitizedTagAttrs(output)) {
      assert.match(attrs.trim(), /^(div)\s*$|^(div)\s+(class="[^"]*"|style="[^"]*")/, `只允许 class/style 属性：${attrs}`);
    }
  }
});

// ═════════════════════════════ #22-6 既有安全边界不回归 ═════════════════════════════

test('#22-6 既有安全边界：可执行/外部标签、事件属性、未知标签、class 规则、20000 截断均保持', () => {
  const input = [
    '<div>安全内容</div>',
    '<script>alert(1)</script>',
    '<SCRIPT>alert(2)</SCRIPT>',
    '<iframe src="https://evil.test"></iframe>',
    '<object data="x"></object>',
    '<embed src="x">',
    '<form action="x"><input></form>',
    '<video src="x"></video>',
    '<audio src="x"></audio>',
    '<svg><circle cx="1" cy="1"></circle></svg>',
    '<math><mi>x</mi></math>',
    '<style>.x{color:red}</style>',
  ].join('');
  const output = sanitizeSceneHtml(input);
  assert.doesNotMatch(output, FORBIDDEN_TAGS, `可执行/外部标签必须移除：${output}`);
  assert.ok(output.includes('安全内容'), '普通文本保留');

  const attrs = sanitizeSceneHtml('<div onclick="alert(1)" onerror="x" onmouseover="y" class="ok">t</div>');
  assert.doesNotMatch(attrs, /\bon[a-z]+\s*=/i, '事件属性必须移除');
  assert.match(attrs, /class="ok"/, '合法 class 保留');

  const unknown = sanitizeSceneHtml('<my-widget data-x="1">保留文本</my-widget><custom-tag></custom-tag>');
  assert.doesNotMatch(unknown, /my-widget|custom-tag/i, '未知标签被移除');
  assert.ok(unknown.includes('保留文本'), '未知标签内的文本保留');

  assert.match(sanitizeSceneHtml('<div class="a b-c">x</div>'), /class="a b-c"/, '合法 class 保留');
  assert.doesNotMatch(sanitizeSceneHtml('<div class="a b!">x</div>'), /class=/, '非法字符 class 移除');
  assert.doesNotMatch(sanitizeSceneHtml(`<div class="${'a'.repeat(121)}">x</div>`), /class=/, '超长 class 移除');
  assert.doesNotMatch(sanitizeSceneHtml('<div class="中文">x</div>'), /class=/, '非 \\w 字符 class 移除');

  // 20000 字符截断
  const long = `<div>${'a'.repeat(19980)}</div><span>TAIL_MARKER</span>`;
  const truncated = sanitizeSceneHtml(long);
  assert.ok(truncated.length <= 20000, `输出不得超过 20000 字符，实际 ${truncated.length}`);
  assert.equal(truncated.includes('TAIL_MARKER'), false, '20000 之后的输入被截断');
});

// ═════════════════════════════ #22-7 既有安全样式保留 + 普通 HTML 不回归 ═════════════════════════════

const OLD_ALLOWED_PROPERTIES = new Set([
  'color', 'background', 'background-color', 'font-size', 'font-weight', 'text-align', 'line-height',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin', 'border',
  'border-top', 'border-radius', 'display', 'flex', 'flex-direction', 'flex-wrap', 'gap', 'align-items',
  'justify-content', 'width', 'min-width', 'max-width', 'height', 'grid-template-columns', 'box-shadow',
  'box-sizing', 'border-collapse', 'font-family', 'white-space', 'opacity', 'overflow', 'letter-spacing',
  'text-overflow',
]);
const OLD_SAFE_VALUE = /^[\w\s#(),.%/-]+$/;
const GLOBAL_REJECT = /url\(|expression\(|@import|javascript:|vbscript:|data:|behavior:|-moz-binding|[\\<>]/i;

/** V1.6.8 版 sanitizer 会保留的声明（旧属性白名单 + 旧字符白名单 + 长度上限 + 无全局拒绝词）。 */
function oldSafeDeclarations(html: string): Declaration[] {
  return declarations(html).filter(declaration =>
    OLD_ALLOWED_PROPERTIES.has(declaration.property)
    && declaration.value.length > 0
    && declaration.value.length <= 100
    && OLD_SAFE_VALUE.test(declaration.value)
    && !GLOBAL_REJECT.test(declaration.value));
}

test('#22-7 既有安全样式（color/flex/padding/gradient/font-size/…）保留，structuredSceneHtml 旧输出不回归', () => {
  const legacyStyle = [
    'color:#ff0000', 'background:linear-gradient(90deg,#ffffff,#000000)', 'background-color:#111111',
    'font-size:20px', 'font-weight:700', 'text-align:center', 'line-height:1.5', 'padding:16px',
    'border:1px solid #333333', 'border-radius:8px', 'display:flex', 'flex-direction:column', 'gap:12px',
    'align-items:center', 'justify-content:space-between', 'width:100%', 'max-width:800px', 'height:320px',
    'box-shadow:0 2px 4px #00000055', 'box-sizing:border-box', 'letter-spacing:1px', 'text-overflow:ellipsis',
  ].join(';');
  const map = styleMap(legacyStyle);
  for (const property of ['color', 'background', 'font-size', 'font-weight', 'display', 'flex-direction', 'gap', 'padding', 'border-radius', 'box-shadow', 'letter-spacing', 'text-overflow']) {
    assert.ok(map.has(property), `既有安全属性 ${property} 应保留（实际：${[...map.keys()].join(',')}）`);
  }
  assert.match(map.get('background') ?? '', /linear-gradient\(90deg,#ffffff,#000000\)/, '渐变背景保留');
  assert.equal(map.get('font-size'), '20px');

  // structuredSceneHtml 真实旧输出：关键文本/样式不得回归
  const scenes = [
    SceneSchema.parse({ id: 's-text', type: 'text', title: '缓存核心', narration: '缓存把结果放在内存里。', visual: { text: '第一行\n第二行' } }),
    SceneSchema.parse({ id: 's-bullets', type: 'bullets', title: '关键要点', narration: '要点说明。', visual: { items: ['先查缓存', '命中即返回'] } }),
    SceneSchema.parse({
      id: 's-code', type: 'code', title: '缓存实现', narration: '代码说明。',
      visual: { code: 'const cache = new Map();\nif (cache.has(id)) {\n  return cache.get(id);\n}', language: 'typescript', filename: 'cache.ts', beats: [{ lines: [2], label: '命中' }] },
    }),
  ];
  for (const [index, scene] of scenes.entries()) {
    const rawHtml = structuredSceneHtml(scene, index);
    const sanitized = sanitizeSceneHtml(rawHtml);
    assert.ok(sanitized.includes(scene.title!), `structuredSceneHtml 标题文本保留：${scene.id}`);
    assert.ok(sanitized.includes('display:flex'), `structuredSceneHtml 布局样式保留：${scene.id}`);
    assert.doesNotMatch(sanitized, FORBIDDEN_TAGS, `structuredSceneHtml 不含危险标签：${scene.id}`);
    const sanitizedDeclarations = declarations(sanitized);
    for (const declaration of oldSafeDeclarations(rawHtml)) {
      assert.ok(
        sanitizedDeclarations.some(candidate => candidate.property === declaration.property && candidate.value === declaration.value),
        `V1.6.8 可保留的声明不得丢失：${scene.id} ${declaration.property}:${declaration.value}`,
      );
    }
  }

  // 代码场景旧输出的行号/源码/等宽字体经 sanitizer 后仍保留
  const codeHtml = structuredSceneHtml(scenes[2], 2);
  const sanitizedCode = sanitizeSceneHtml(codeHtml);
  assert.ok(sanitizedCode.includes('const cache = new Map();'), '源码文本保留');
  assert.match(sanitizedCode, /class="code-line[^"]*"/, 'code-line class 保留');
  assert.match(sanitizedCode, /font-family:[^;"]*monospace/, '等宽字体族保留');
  for (const lineNumber of ['1', '2', '3']) assert.ok(sanitizedCode.includes(`>${lineNumber}<`), `行号 ${lineNumber} 保留`);
});
