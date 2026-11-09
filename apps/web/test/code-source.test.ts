import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneSchema } from '@m2v/schema';
import {
  buildRegenerateScenePrompt,
  buildStoryboardPrompt,
  buildStoryboardSceneOrFallback,
  codeTraceableToSource,
  fallbackChapter,
  normalizeMarkdown,
  resolveSceneSourceContext,
  splitIntoChapters,
  structuredSceneHtml,
  storyboardOutputSchema,
} from '../src/lib/pipeline';

/** #14 / #16 契约：Markdown fenced code 结构化 + Ollama code scene（doc/V1.6.8_issues.md §2.5）。 */

const CACHE_CODE = [
  'const cache = new Map();',
  'function getUser(id) {',
  '  if (cache.has(id)) {',
  '    return cache.get(id);',
  '  }',
  '  return fetchUser(id);',
  '}',
].join('\n');

const codeChapter = (patch: Record<string, unknown> = {}) => ({
  title: '缓存实现',
  text: '本章说明缓存命中后的直接返回流程。',
  codeBlocks: [{ language: 'typescript', code: CACHE_CODE }],
  ...patch,
});

// ═════════════════════════════ #14 ═════════════════════════════

// ── #14-1 不再生成 代码示例/代码： 行 ────────────────────────────────────────────
test('#14-1 normalizeMarkdown 保留 fenced code 原文，不再输出「代码示例/代码：」行', () => {
  const markdown = [
    '# 缓存设计',
    '',
    '本段说明 **缓存** 与 `getUser` 的配合。',
    '',
    '```ts',
    'const value = 1;',
    'console.log(value);',
    '```',
    '',
    '结尾段落。',
  ].join('\n');
  const normalized = normalizeMarkdown(markdown);
  assert.doesNotMatch(normalized, /代码示例/, '不再生成「代码示例（ts）：」标记');
  assert.doesNotMatch(normalized, /代码：/, '不再生成「代码：」逐行标记');
  assert.match(normalized, /const value = 1;/, 'fenced code 内容原样保留');
  assert.match(normalized, /console\.log\(value\);/, 'fenced code 多行保留');
  assert.match(normalized, /# 缓存设计/, '标题清洗行为不变');
  assert.match(normalized, /本段说明 缓存 与 getUser 的配合。/, '行内 Markdown 清洗行为不变');
  assert.match(normalized, /结尾段落。/, '代码块之后的正文保留');
});

// ── #14-2 ~~~ 与 ``` 等价，language 保留 ────────────────────────────────────────
test('#14-2 ~~~ fence 与 ``` fence 等价支持且保留 language', () => {
  const backtick = normalizeMarkdown('```python\nprint("hi")\n```');
  const tilde = normalizeMarkdown('~~~python\nprint("hi")\n~~~');
  for (const normalized of [backtick, tilde]) {
    assert.match(normalized, /python/, 'fence 后的语言标识保留');
    assert.match(normalized, /print\("hi"\)/, '源码保留');
    assert.doesNotMatch(normalized, /代码示例|代码：/);
  }
  const backtickChapters = splitIntoChapters('项目', '```python\nprint("hi")\n```');
  const tildeChapters = splitIntoChapters('项目', '~~~python\nprint("hi")\n~~~');
  assert.deepEqual(tildeChapters[0].codeBlocks, backtickChapters[0].codeBlocks, '两种 fence 解析结果等价');
  assert.deepEqual(backtickChapters[0].codeBlocks, [{ language: 'python', code: 'print("hi")' }]);
});

// ── #14-3 单代码块进入 chapter.codeBlocks，正文不含源码 ───────────────────────────
test('#14-3 splitIntoChapters 单代码块：正文剥离源码、language/code 原样（内部缩进不改写）', () => {
  const markdown = [
    '## 缓存实现',
    '',
    '正文说明这段代码的用途。',
    '',
    '```ts',
    'const cache = new Map();',
    '  if (cache.has(id)) {',
    '    return cache.get(id);',
    '  }',
    '```',
    '',
    '结尾补充。',
  ].join('\n');
  const chapters = splitIntoChapters('项目', markdown);
  assert.equal(chapters.length, 1);
  const [chapter] = chapters;
  assert.equal(chapter.title, '缓存实现');
  assert.doesNotMatch(chapter.text, /const cache = new Map/, 'chapter.text 不含源码');
  assert.doesNotMatch(chapter.text, /代码示例|代码：/, 'chapter.text 不含旧代码标记');
  assert.match(chapter.text, /正文说明这段代码的用途。/);
  assert.match(chapter.text, /结尾补充。/);
  assert.equal(chapter.codeBlocks?.length, 1);
  assert.equal(chapter.codeBlocks?.[0].language, 'ts');
  assert.equal(
    chapter.codeBlocks?.[0].code,
    'const cache = new Map();\n  if (cache.has(id)) {\n    return cache.get(id);\n  }',
    '源码逐字保留，内部缩进不被改写',
  );
});

// ── #14-4 多代码块 + 无 language ─────────────────────────────────────────────────
test('#14-4 一个章节可含多个代码块，顺序/内容正确，无 language 的 fence 的 language 缺省', () => {
  const markdown = [
    '## 多段代码',
    '',
    '先看第一段。',
    '',
    '```ts',
    'const a = 1;',
    '```',
    '',
    '中间说明。',
    '',
    '~~~python',
    'def run():',
    '    return 1',
    '~~~',
    '',
    '```',
    'raw text',
    '```',
  ].join('\n');
  const chapters = splitIntoChapters('项目', markdown);
  assert.equal(chapters.length, 1);
  const blocks = chapters[0].codeBlocks ?? [];
  assert.equal(blocks.length, 3, '同一章节的三个代码块都保留');
  assert.equal(blocks[0].language, 'ts');
  assert.equal(blocks[1].language, 'python');
  assert.equal(blocks[2].language, undefined, '无 language fence 的 language 缺省');
  assert.equal(blocks[0].code, 'const a = 1;');
  assert.equal(blocks[1].code, 'def run():\n    return 1', '内部缩进和换行保持');
  assert.equal(blocks[2].code, 'raw text');
  assert.match(chapters[0].text, /先看第一段。/);
  assert.match(chapters[0].text, /中间说明。/);
  assert.doesNotMatch(chapters[0].text, /const a = 1|raw text/);
});

// ── #14-5 无代码块 Markdown 行为与旧实现一致（基线）──────────────────────────────
// 基线由 V1.6.7 HEAD（677d1bf）的 normalizeMarkdown/splitIntoChapters 在等价输入上捕获。
const BASELINE_MIXED_INPUT = [
  '# 缓存设计',
  '',
  '本段说明**缓存**与 `getUser` 的配合，详见[文档](https://example.com/doc)。',
  '',
  '- 第一项要点',
  '- 第二项要点',
  '',
  '> 引用：一句结论',
  '',
  '| 指标 | 数值 |',
  '| --- | --- |',
  '| 命中率 | 98% |',
].join('\n');
const BASELINE_MIXED_NORMALIZED = '# 缓存设计\n\n本段说明缓存与 getUser 的配合，详见文档。\n\n• 第一项要点\n\n• 第二项要点\n\n引用：引用：一句结论\n\n| 指标 | 数值 |\n| --- | --- |\n| 命中率 | 98% |';
const BASELINE_MIXED_CHAPTERS = [{
  title: '缓存设计',
  text: '本段说明缓存与 getUser 的配合，详见文档。\n\n• 第一项要点\n\n• 第二项要点\n\n引用：引用：一句结论\n\n| 指标 | 数值 |\n| --- | --- |\n| 命中率 | 98% |',
}];
const BASELINE_NUMBERED_INPUT = ['## 步骤', '', '1. 读取数据', '2. 处理数据', '', '### 小节', '', '结束。'].join('\n');
const BASELINE_NUMBERED_NORMALIZED = '# 步骤\n\n• 读取数据\n\n• 处理数据\n\n# 小节\n\n结束。';
const BASELINE_NUMBERED_CHAPTERS = [
  { title: '步骤', text: '• 读取数据\n\n• 处理数据' },
  { title: '小节', text: '结束。' },
];

test('#14-5 无代码块 Markdown 的 normalizeMarkdown/splitIntoChapters 输出与旧实现逐字节一致', () => {
  assert.equal(normalizeMarkdown(BASELINE_MIXED_INPUT), BASELINE_MIXED_NORMALIZED, '混合 Markdown 基线');
  assert.deepEqual(splitIntoChapters('项目', BASELINE_MIXED_NORMALIZED), BASELINE_MIXED_CHAPTERS, '章节基线');
  assert.equal(normalizeMarkdown(BASELINE_NUMBERED_INPUT), BASELINE_NUMBERED_NORMALIZED, '编号列表基线');
  assert.deepEqual(splitIntoChapters('项目', BASELINE_NUMBERED_NORMALIZED), BASELINE_NUMBERED_CHAPTERS, '编号章节基线');
  assert.deepEqual(splitIntoChapters('项目', BASELINE_MIXED_NORMALIZED)[0].codeBlocks, undefined, '无代码块时 chapter 不新增 codeBlocks');
});

// ── #14-6 storyboard/regenerate 章节输入含 codeBlocks ────────────────────────────
test('#14-6 buildStoryboardPrompt 章节输入含 codeBlocks 且无 containsCodeExample；regenerate 参考资料含 codeBlocks', () => {
  const chapter = codeChapter();
  const prompt = buildStoryboardPrompt('项目', [chapter]);
  assert.doesNotMatch(prompt, /containsCodeExample/, '不再使用 containsCodeExample 标志');
  const chapterInputJson = /章节资料：(\[.*\])\n\/no_think/s.exec(prompt)?.[1];
  assert.ok(chapterInputJson, 'prompt 含章节资料 JSON');
  const chapterInput = JSON.parse(chapterInputJson) as Record<string, unknown>[];
  assert.deepEqual(chapterInput[0].codeBlocks, [{ language: 'typescript', code: CACHE_CODE }], '章节输入保留 language/code');
  assert.equal('containsCodeExample' in chapterInput[0], false);

  // 从真实 Markdown 切分出的章节同样保留 codeBlocks
  const chapters = splitIntoChapters('项目', '## 缓存实现\n\n正文说明。\n\n```ts\nconst cache = 1;\n```\n');
  const realPrompt = buildStoryboardPrompt('项目', chapters);
  const realInput = JSON.parse(/章节资料：(\[.*\])\n\/no_think/s.exec(realPrompt)![1]) as Record<string, unknown>[];
  assert.deepEqual(realInput[0].codeBlocks, [{ language: 'ts', code: 'const cache = 1;' }]);

  const sourceText = '## 缓存实现\n\n正文说明。\n\n```ts\nconst cache = 1;\n```\n';
  const sourceContext = resolveSceneSourceContext({
    sourceText,
    projectTitle: '项目',
    scene: { title: '缓存实现', narration: '讲解缓存。' },
    sceneIndex: 0,
    sceneCount: 1,
  });
  assert.deepEqual(sourceContext.codeBlocks, [{ language: 'ts', code: 'const cache = 1;' }], 'sceneSourceContext 带 codeBlocks');
  const regeneratePrompt = buildRegenerateScenePrompt({
    scene: { id: 'scene-code', type: 'code', narration: '旧旁白。', visual: { code: 'const cache = 1;' } },
    sceneTypeRule: '类型固定为 code',
    htmlRequirement: '',
    sourceContext,
  });
  assert.match(regeneratePrompt, /"codeBlocks":\[/, '参考资料 JSON 包含 codeBlocks');
  assert.match(regeneratePrompt, /"language":"ts"/);
  assert.match(regeneratePrompt, /const cache = 1;/);
});

// ── #14-7 legacy 代码标记仍可识别、不误判普通正文 ────────────────────────────────
test('#14-7 legacy「代码示例（ts）：/代码：」文本仍被识别，源码不进入旁白，普通正文不误判', () => {
  const legacy = fallbackChapter({ title: '旧代码章节', text: '正文说明这段代码的用途。\n代码示例（ts）：\n代码：const a = 1;\n代码：return a;' });
  assert.notEqual(legacy.type, 'code');
  assert.equal(legacy.narration, '正文说明这段代码的用途。', 'legacy 文本剥离代码后按旧行为回退');
  assert.doesNotMatch(legacy.narration, /const a = 1|return a/);

  const bareMarker = fallbackChapter({ title: '旧代码章节二', text: '正文说明。\n代码：const b = 2;' });
  assert.notEqual(bareMarker.type, 'code');
  assert.doesNotMatch(bareMarker.narration, /const b = 2/, '裸「代码：」标记也被识别');
  assert.match(bareMarker.narration, /正文说明/);

  const ordinary = fallbackChapter({ title: '普通章节', text: '这段普通正文讨论代码：可读性优先。' });
  assert.equal(ordinary.narration, '这段普通正文讨论代码：可读性优先。', '正文中的「代码：」不被当成代码块标记');
});

// ═════════════════════════════ #16 ═════════════════════════════

// ── #16-1 prompt 允许 code 且含保真约束，保留回归子串 ───────────────────────────
test('#16-1 buildStoryboardPrompt 允许 type=code 并含保真约束，保留原有回归子串', () => {
  const prompt = buildStoryboardPrompt('项目', [codeChapter()]);
  for (const fragment of ['type=code', 'codeBlocks', 'beats', 'narrationText', 'visual.code']) {
    assert.ok(prompt.includes(fragment), `prompt 应包含 ${fragment}`);
  }
  assert.match(prompt, /逐字|原样|原封不动/, '要求 code 逐字来自输入');
  assert.match(prompt, /不得(改写|补全|优化|创造)|不能(改写|补全|优化|创造)/, '禁止模型改写源码');
  assert.match(prompt, /每项只含 type,narration,visual/, '既有契约子串保留');
  assert.match(prompt, /不含 id\/title\/duration/, '既有契约子串保留');
  assert.doesNotMatch(prompt, /containsCodeExample/);
  assert.doesNotMatch(prompt, /含代码示例时只说明用途和步骤/, '旧的禁止 code 规则已删除');
  assert.match(prompt, /朗读|复述/, 'prompt 明确旁白不得朗读/复述源码');
  assert.match(prompt, /源码|代码原文/, 'prompt 提到源码边界');
});

// ── #16-2 modelVisualSchema('code') 结构 ────────────────────────────────────────
test('#16-2 modelVisualSchema(code) 输出 code/language/filename/mode/beats 且 additionalProperties=false', () => {
  type JsonObject = { [key: string]: any };
  const schema = storyboardOutputSchema(1) as JsonObject;
  const oneOf = schema.properties.scenes.items.oneOf as JsonObject[];
  assert.equal(oneOf.length, 10, 'MODEL_SCENE_TYPES 包含独立的 diagram 类型');
  const codeScene = oneOf.find(entry => entry.properties.type.enum[0] === 'code');
  assert.ok(codeScene, '9 类中含 code');
  const visual = codeScene!.properties.visual as JsonObject;
  assert.equal(visual.additionalProperties, false);
  assert.deepEqual(Object.keys(visual.properties).sort(), ['beats', 'code', 'filename', 'language', 'mode']);
  assert.equal(visual.properties.code.type, 'string');
  const required: string[] = visual.required ?? [];
  assert.ok(required.includes('code'), 'code 必填');
  for (const optional of ['language', 'filename', 'mode', 'beats']) {
    assert.equal(required.includes(optional), false, `${optional} 可选`);
  }
  assert.deepEqual(visual.properties.mode.enum, ['focus', 'build', 'diff', 'trace']);
  const beats = visual.properties.beats as JsonObject;
  assert.equal(beats.type, 'array');
  assert.equal(beats.maxItems, 10);
  const beat = beats.items as JsonObject;
  assert.equal(beat.additionalProperties, false);
  assert.deepEqual(Object.keys(beat.properties).sort(), ['label', 'lines', 'narrationText']);
  assert.equal(beat.properties.lines.type, 'array');
  assert.equal(beat.properties.lines.minItems, 1);
  assert.equal(beat.properties.lines.maxItems, 200);
  assert.equal(beat.properties.lines.items.type, 'integer');
  assert.equal(beat.properties.label.maxLength, 30);
  assert.equal(beat.properties.narrationText.maxLength, 200);
});

// ── #16-3 合法 code 输出保留完整 visual ──────────────────────────────────────────
test('#16-3 code 输出可追溯至章节 codeBlocks 时保留 type=code 与完整 visual', () => {
  const chapter = codeChapter();
  const raw = {
    type: 'code',
    narration: '这段代码先创建缓存，命中时直接返回，否则请求数据。',
    visual: {
      code: CACHE_CODE,
      language: 'typescript',
      filename: 'cache.ts',
      mode: 'focus',
      beats: [
        { lines: [3, 4], label: '命中后返回', narrationText: '直接返回' },
        { lines: [6], label: '请求数据', narrationText: '请求数据' },
      ],
    },
  };
  const built = buildStoryboardSceneOrFallback(chapter, raw);
  assert.equal(built.fallbackUsed, false);
  assert.equal(built.validationError, undefined);
  assert.equal(built.scene.type, 'code');
  assert.equal(built.scene.title, '缓存实现');
  assert.deepEqual(built.scene.visual, raw.visual, 'visual 完整保留');
  assert.match(built.scene.narration, /创建缓存/);
  assert.equal(SceneSchema.safeParse(built.scene).success, true);

  assert.equal(codeTraceableToSource(CACHE_CODE, chapter.codeBlocks), true, '逐字来自 codeBlock');
  assert.equal(codeTraceableToSource('const cache = new Map();', chapter.codeBlocks), true, '允许选择代码片段');
  assert.equal(codeTraceableToSource('const improved = cache.optimize();', chapter.codeBlocks), false);
  assert.equal(codeTraceableToSource(CACHE_CODE, []), false);
  assert.equal(codeTraceableToSource('', chapter.codeBlocks), false);
});

// ── #16-4 幻觉代码 → fallback + validationError ────────────────────────────────
test('#16-4 无法追溯到输入 codeBlock 的代码触发 fallback，不接受改写后的源码', () => {
  const chapter = codeChapter();
  const raw = {
    type: 'code',
    narration: '这段代码优化了缓存并直接返回。',
    visual: {
      code: 'const cache = new Map();\nconst optimized = cache.optimize();\nreturn optimized;',
      language: 'typescript',
      filename: 'cache.ts',
      beats: [{ lines: [1], label: '优化' }],
    },
  };
  const built = buildStoryboardSceneOrFallback(chapter, raw);
  assert.equal(built.fallbackUsed, true);
  assert.match(built.validationError ?? '', /code|源码|追溯|来源|codeBlocks/i, `validationError: ${built.validationError}`);
  assert.equal(built.scene.type, 'code', '按契约回退到含 codeBlocks 的安全 code 场景');
  assert.equal(built.scene.visual.code, CACHE_CODE, '回退使用输入首块源码而不是幻觉代码');
  assert.doesNotMatch(built.scene.narration, /optimize\(\)|return optimized/, '旁白不含幻觉源码');
  assert.equal(SceneSchema.safeParse(built.scene).success, true);
});

// ── #16-5 非法 beats → 校验失败 + fallback ──────────────────────────────────────
test('#16-5 beat 行号越界或重复导致校验失败并 fallback', () => {
  const chapter = codeChapter();
  const rawOf = (beats: unknown[]) => ({
    type: 'code',
    narration: '这段代码说明缓存命中后的处理。',
    visual: { code: CACHE_CODE, language: 'typescript', beats },
  });
  const invalidBeats: { name: string; beats: unknown[] }[] = [
    { name: 'out of range', beats: [{ lines: [999] }] },
    { name: 'zero line', beats: [{ lines: [0] }] },
    { name: 'duplicated lines', beats: [{ lines: [2, 2] }] },
  ];
  for (const { name, beats } of invalidBeats) {
    const built = buildStoryboardSceneOrFallback(chapter, rawOf(beats));
    assert.equal(built.fallbackUsed, true, `${name} must fall back`);
    assert.match(built.validationError ?? '', /visual\.beats|行号|行数|重复/, `${name} validationError: ${built.validationError}`);
    assert.equal(built.scene.visual.code, CACHE_CODE, `${name} fallback keeps source code`);
  }
});

// ── #16-6 narration 复述源码被拦截 ──────────────────────────────────────────────
test('#16-6 narration 复述完整源码行时被拦截回退，narration 不包含源码', () => {
  const chapter = codeChapter();
  for (const narration of [
    'const cache = new Map();\nfunction getUser(id) {',
    '逻辑是：if (cache.has(id)) { return cache.get(id); } 然后返回。',
  ]) {
    const built = buildStoryboardSceneOrFallback(chapter, {
      type: 'code',
      narration,
      visual: { code: CACHE_CODE, language: 'typescript', beats: [{ lines: [1], label: '缓存' }] },
    });
    assert.equal(built.fallbackUsed, true, `narration 复述源码必须回退：${narration.slice(0, 20)}`);
    for (const sourceLine of ['const cache = new Map();', 'function getUser(id) {', 'if (cache.has(id)) {', 'return cache.get(id);']) {
      assert.equal(built.scene.narration.includes(sourceLine), false, '回退旁白不含源码行');
    }
  }
  // 正常旁白（只描述意图）不被误杀
  const normal = buildStoryboardSceneOrFallback(chapter, {
    type: 'code',
    narration: '这段代码先创建缓存，命中时直接返回，否则重新请求数据。',
    visual: { code: CACHE_CODE, language: 'typescript', beats: [{ lines: [1], label: '缓存' }] },
  });
  assert.equal(normal.fallbackUsed, false);
  assert.equal(normal.scene.type, 'code');
});

// ── #16-7 代码不重要章节仍可生成 text/bullets/chart ─────────────────────────────
test('#16-7 含 codeBlocks 但代码不重要的章节仍可按模型输出生成 text/bullets/chart', () => {
  const chapter = codeChapter();
  const fixtures = [
    { type: 'text', visual: { text: '缓存的核心是更快返回结果。' } },
    { type: 'bullets', visual: { items: ['先查缓存', '命中即返回'] } },
    { type: 'chart', visual: { data: [{ label: '命中率', value: 98 }] } },
  ];
  for (const fixture of fixtures) {
    const built = buildStoryboardSceneOrFallback(chapter, { type: fixture.type, narration: '本章重点说明缓存的收益。', visual: fixture.visual });
    assert.equal(built.fallbackUsed, false, `${fixture.type} 不应被强制改成 code`);
    assert.equal(built.scene.type, fixture.type);
    assert.deepEqual(built.scene.visual, fixture.visual);
  }
});

// ── #16-8 fallbackChapter 含 codeBlocks → code 场景；无 codeBlocks 行为不变 ──────
test('#16-8 fallbackChapter 对含 codeBlocks 章节返回 code + 首块源码 + 安全旁白，无 codeBlocks 行为不变', () => {
  const withBlocks = fallbackChapter(codeChapter());
  assert.equal(withBlocks.type, 'code');
  assert.equal(withBlocks.visual.code, CACHE_CODE);
  assert.equal(withBlocks.visual.language, 'typescript');
  assert.equal(withBlocks.narration.includes('const cache = new Map();'), false, '安全旁白不含源码行');
  assert.equal(withBlocks.title, '缓存实现');
  assert.equal(SceneSchema.safeParse(withBlocks).success, true);

  const withoutBlocks = fallbackChapter({ title: '普通章节', text: '第一句。第二句。' });
  assert.equal(withoutBlocks.type, 'bullets');
  assert.equal(withoutBlocks.narration, '第一句。第二句。', '无 codeBlocks 行为与旧实现一致');
  assert.deepEqual((withoutBlocks.visual.items as unknown[]).length, 2);

  const noLanguage = fallbackChapter({ title: '无语言代码', text: '正文说明。', codeBlocks: [{ code: 'const x = 1;' }] });
  assert.equal(noLanguage.type, 'code');
  assert.equal(noLanguage.visual.code, 'const x = 1;');
  assert.equal('language' in noLanguage.visual, false, '无 language 时不写 language 字段');
});

// ── #16-9 HTML 模式 code 场景渲染结构化代码视图 ─────────────────────────────────
test('#16-9 structuredSceneHtml 的 code 场景含源码/行号/文件名/语言/高亮，且与 Standard 共享 visual', () => {
  const chapter = codeChapter();
  const raw = {
    type: 'code',
    narration: '这段代码说明缓存命中与回源。',
    visual: {
      code: CACHE_CODE,
      language: 'typescript',
      filename: 'cache.ts',
      beats: [{ lines: [3, 4], label: '命中后返回' }],
    },
  };
  const standard = buildStoryboardSceneOrFallback(chapter, raw, false, 'standard');
  const htmlMode = buildStoryboardSceneOrFallback(chapter, raw, false, 'html');
  assert.equal(standard.fallbackUsed, false);
  assert.equal(htmlMode.fallbackUsed, false);
  assert.deepEqual(htmlMode.scene.visual.code, standard.scene.visual.code, '两种模式消费同一份 visual.code');
  assert.deepEqual(htmlMode.scene.visual.beats, standard.scene.visual.beats, '两种模式消费同一份 beats');

  const html = structuredSceneHtml(SceneSchema.parse(standard.scene), 0);
  assert.match(html, /<pre/, '使用等宽 pre 代码视图');
  assert.match(html, /mono/i, '等宽字体栈');
  assert.ok(html.includes('const cache = new Map();'), '源码进入 HTML');
  assert.ok(html.includes('cache.ts'), 'filename 头部');
  assert.match(html, /typescript/i, 'language 头部');
  for (const lineNumber of ['1', '2', '3', '4', '5', '6', '7']) {
    assert.ok(html.includes(lineNumber), `行号 ${lineNumber} 出现`);
  }
  assert.match(html, /opacity|background|outline|border/, 'beat 行高亮/弱化样式');
  const noBeatsHtml = structuredSceneHtml(SceneSchema.parse({ ...standard.scene, visual: { ...standard.scene.visual, beats: undefined } }), 0);
  assert.notEqual(html, noBeatsHtml, '有 beats 时 HTML 的高亮结构不同');

  assert.equal(structuredSceneHtml(htmlMode.scene, 0), html, 'HTML 模式与 Standard 模式的 code HTML 一致');
});

// ── #16-10 旧 containsCodeExample 规则已移除 + legacy 识别仍可用 ─────────────────
test('#16-10 旧 containsCodeExample 限制已移除，legacy 代码标记识别仍可用', () => {
  const legacyChapter = { title: '旧代码章节', text: '正文说明。\n代码示例（ts）：\n代码：const a = 1;\n代码：return a;' };
  const prompt = buildStoryboardPrompt('项目', [legacyChapter]);
  assert.doesNotMatch(prompt, /containsCodeExample/);
  const chapterInput = JSON.parse(/章节资料：(\[.*\])\n\/no_think/s.exec(prompt)![1]) as Record<string, unknown>[];
  assert.equal('containsCodeExample' in chapterInput[0], false, '新流程不再输出 containsCodeExample 标志');

  // 含关键代码章节的合法 code 输出不再被强制改成 bullets。
  const built = buildStoryboardSceneOrFallback(codeChapter(), {
    type: 'code',
    narration: '这段代码展示缓存命中的直接返回。',
    visual: { code: CACHE_CODE, beats: [{ lines: [3], label: '命中' }] },
  });
  assert.equal(built.fallbackUsed, false);
  assert.equal(built.scene.type, 'code', 'code 场景不被旧规则强制改写为 bullets');

  // legacy 文本识别仍然可用（fallback 不泄漏源码）。
  const legacy = fallbackChapter(legacyChapter);
  assert.notEqual(legacy.type, 'code');
  assert.doesNotMatch(legacy.narration, /const a = 1|return a/);
  assert.equal(legacy.narration, '正文说明。');
});
