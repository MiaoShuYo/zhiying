import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codeVisualOf,
  normalizeCodeVisualInput,
  resolveCodeSceneMode,
  SceneSchema,
  SceneTypeSchema,
  type Scene,
} from '@m2v/schema';
import {
  buildRegenerateScenePrompt,
  buildStoryboardPrompt,
  buildStoryboardSceneOrFallback,
  codeTraceableToSource,
  modelVisualSchema,
  regenerateOutputSchema,
  storyboardOutputSchema,
  type Chapter,
} from '../src/lib/pipeline';

/**
 * #24 / #25 / #26 / #27 契约：生成链路的 mode 选择策略、prompt/模型 schema、归一化、
 * 来源守卫与 Standard/HTML 同源（doc/V1.7.0_issues.md §2.11）。
 */

const CACHE_CODE = [
  'const cache = new Map();',
  'function getUser(id) {',
  '  if (cache.has(id)) {',
  '    return cache.get(id);',
  '  }',
  '  return fetchUser(id);',
  '}',
].join('\n');
const CACHE_CODE_V2 = CACHE_CODE.replace('return cache.get(id);', 'return cache.get(id) ?? null;');

const NARRATION = '这段代码先创建缓存，命中时直接返回，否则请求数据。';
const DIFF_NARRATION = '这次修改让命中缓存时返回的内容更完整。';
const BUILD_STEPS = [
  { revealLines: [1, 2], label: '声明' },
  { revealLines: [3, 4, 5], focusLines: [3], label: '命中' },
  { revealLines: [6, 7], label: '回源' },
];
const TRACE_STEPS = [
  { lines: [2], label: '初始化', state: [{ name: 'cache', value: '空' }] },
  { lines: [3], label: '命中', state: [{ name: 'cache', value: '有值', changed: true }], output: '有值' },
];

const codeChapter = (patch: Record<string, unknown> = {}): Chapter => ({
  title: '缓存实现',
  text: '本章说明缓存命中后的直接返回流程。',
  codeBlocks: [{ language: 'typescript', code: CACHE_CODE }],
  ...patch,
});

const diffChapter = (): Chapter => ({
  title: '缓存优化',
  text: '本次修改调整了缓存命中时返回的内容。',
  codeBlocks: [
    { language: 'typescript', code: CACHE_CODE },
    { language: 'typescript', code: CACHE_CODE_V2 },
  ],
});

const rawCode = (visual: Record<string, unknown>, narration = NARRATION) => ({
  type: 'code',
  narration,
  visual: { code: CACHE_CODE, language: 'typescript', filename: 'cache.ts', ...visual },
});

const rawBuild = (patch: Record<string, unknown> = {}) => rawCode({ mode: 'build', buildSteps: BUILD_STEPS, ...patch });
const rawDiff = (patch: Record<string, unknown> = {}) => ({
  type: 'code',
  narration: DIFF_NARRATION,
  visual: { code: CACHE_CODE_V2, language: 'typescript', filename: 'cache.ts', mode: 'diff', beforeCode: CACHE_CODE, afterCode: CACHE_CODE_V2, diffBeats: [{ hunkIds: ['h1'], label: '改返回值' }], ...patch },
});
const rawTrace = (patch: Record<string, unknown> = {}) => rawCode({ mode: 'trace', traceSteps: TRACE_STEPS, ...patch });

const visualOf = (scene: Scene) => scene.visual as Record<string, unknown>;
const modeOf = (scene: Scene) => resolveCodeSceneMode(codeVisualOf(scene.visual));

function assertFocusScene(scene: Scene, label: string): void {
  const visual = visualOf(scene);
  assert.ok(visual.mode === undefined || visual.mode === 'focus', `${label}: mode 为 focus/缺省（实际 ${String(visual.mode)}）`);
  for (const key of ['buildSteps', 'traceSteps', 'diffBeats', 'beforeCode', 'afterCode']) {
    assert.equal(key in visual, false, `${label}: 不含 ${key}`);
  }
  assert.equal(modeOf(scene), 'focus', `${label}: 实际渲染 mode=focus`);
  assert.equal(SceneSchema.safeParse(scene).success, true, `${label}: scene 仍通过 SceneSchema`);
}

const allSubstrings = (value: string, fragments: string[], label: string) => {
  for (const fragment of fragments) assert.ok(value.includes(fragment), `${label}: 应包含 ${fragment}`);
};

// ═════════════════════════════ #24-1 普通代码讲解默认 focus ═════════════════════

test('#24-1 普通代码讲解默认 focus：prompt 默认规则、无 mode 输出不被改写、resolve/normalize 均为 focus', () => {
  const prompt = buildStoryboardPrompt('项目', [codeChapter()]);
  assert.match(prompt, /code\.mode/, 'prompt 提到 code.mode');
  assert.match(prompt, /默认[^。；]{0,16}focus/, 'prompt 声明默认 focus');
  assert.match(prompt, /条件不足[^。；]{0,24}focus|无法验证[^。；]{0,24}focus/, 'prompt 声明条件不足必须 focus');

  const raw = rawCode({ beats: [{ lines: [2, 3], label: '命中' }] });
  const built = buildStoryboardSceneOrFallback(codeChapter(), raw);
  assert.equal(built.fallbackUsed, false);
  assert.equal(built.validationError, undefined);
  assert.equal(built.modeFallback, undefined, '普通 focus 不产生 modeFallback');
  assert.equal(built.scene.type, 'code');
  assert.deepEqual(built.scene.visual, raw.visual, 'focus visual 原样保留（#16-3 回归）');
  assert.equal(modeOf(built.scene), 'focus');
  assert.deepEqual(normalizeCodeVisualInput(built.scene.visual), built.scene.visual, 'normalize 对 focus visual 原样返回');
  assert.deepEqual(resolveCodeSceneMode(codeVisualOf(built.scene.visual)), 'focus');
});

// ═════════════════════════════ #24-2 build 生成链路 ════════════════════════════

test('#24-2 教程式逐步编码：pipeline 保留 mode=build 与 buildSteps，standard/html 同 mode', () => {
  const raw = rawBuild();
  const built = buildStoryboardSceneOrFallback(codeChapter(), raw);
  assert.equal(built.fallbackUsed, false);
  assert.equal(built.scene.type, 'code');
  assert.equal(visualOf(built.scene).mode, 'build', 'pipeline 保留 mode=build');
  assert.deepEqual(visualOf(built.scene).buildSteps, BUILD_STEPS, 'buildSteps 保留');
  assert.deepEqual(visualOf(built.scene).beats, undefined, 'build 归一化不携带 beats');
  assert.equal(modeOf(built.scene), 'build');
  assert.equal(normalizeCodeVisualInput(built.scene.visual).mode, 'build');
  assert.equal(SceneSchema.safeParse(built.scene).success, true);

  const standard = buildStoryboardSceneOrFallback(codeChapter(), raw, false, 'standard');
  const html = buildStoryboardSceneOrFallback(codeChapter(), raw, false, 'html');
  assert.equal(visualOf(standard.scene).mode, visualOf(html.scene).mode, 'standard/html 同 mode');
  assert.deepEqual(visualOf(standard.scene).buildSteps, visualOf(html.scene).buildSteps, '步骤数据一致');
});

// ═════════════════════════════ #24-3 diff 生成链路 ═════════════════════════════

test('#24-3 明确 before/after：beforeCode/afterCode 逐字来自 codeBlocks、code===afterCode → 保留 diff', () => {
  const chapter = diffChapter();
  assert.equal(codeTraceableToSource(CACHE_CODE, chapter.codeBlocks!), true, 'beforeCode 可追溯');
  assert.equal(codeTraceableToSource(CACHE_CODE_V2, chapter.codeBlocks!), true, 'afterCode 可追溯');
  const raw = rawDiff();
  const built = buildStoryboardSceneOrFallback(chapter, raw);
  assert.equal(built.fallbackUsed, false);
  assert.equal(built.modeFallback, undefined);
  const visual = visualOf(built.scene);
  assert.equal(visual.mode, 'diff', 'pipeline 保留 diff');
  assert.equal(visual.code, CACHE_CODE_V2, 'code = afterCode');
  assert.equal(visual.beforeCode, CACHE_CODE, 'beforeCode 逐字保留');
  assert.equal(visual.afterCode, CACHE_CODE_V2, 'afterCode 逐字保留');
  assert.equal(modeOf(built.scene), 'diff');
  assert.equal(SceneSchema.safeParse(built.scene).success, true);
});

// ═════════════════════════════ #24-4 trace 生成链路 ═════════════════════════════

test('#24-4 有执行状态变化：pipeline 保留 trace 与 traceSteps（含 state/output）', () => {
  const raw = rawTrace();
  // #142: trace 的变量值与输出必须在资料里有依据，所以这里的章节正文写明了「空」「有值」。
  const traceChapter = () => codeChapter({ text: '本章说明缓存命中后的直接返回流程：初始化时 cache 为空，命中后 cache 有值并直接返回有值。' });
  const unbacked = buildStoryboardSceneOrFallback(codeChapter(), raw);
  assert.equal(visualOf(unbacked.scene).mode, 'focus', '资料里找不到的状态值不保留 trace（#142）');
  const built = buildStoryboardSceneOrFallback(traceChapter(), raw);
  assert.equal(built.fallbackUsed, false);
  assert.equal(visualOf(built.scene).mode, 'trace', 'pipeline 保留 trace');
  assert.deepEqual(visualOf(built.scene).traceSteps, TRACE_STEPS, 'traceSteps 保留');
  assert.equal(modeOf(built.scene), 'trace');
  assert.equal(SceneSchema.safeParse(built.scene).success, true);

  const standard = buildStoryboardSceneOrFallback(traceChapter(), raw, false, 'standard');
  const html = buildStoryboardSceneOrFallback(traceChapter(), raw, false, 'html');
  assert.equal(visualOf(standard.scene).mode, 'trace');
  assert.equal(visualOf(html.scene).mode, 'trace');
  assert.deepEqual(visualOf(standard.scene).traceSteps, visualOf(html.scene).traceSteps);
});

// ═════════════════════════════ #24-5 / #25-9 / #27-10 条件不足不臆造 ═════════════

test('#24-5 条件不足不臆造：单一代码版本时不可追溯 beforeCode 降级 focus + modeFallback；无步骤数据同样 focus', () => {
  // 只有单一最终代码时，raw diff 的 beforeCode 不可追溯 → 降级 focus，narration 保留、scene 有效
  const singleChapter = codeChapter();
  const untraceableBefore = 'const legacy = 1;\nreturn legacy;';
  const raw = {
    type: 'code',
    narration: NARRATION,
    visual: { code: CACHE_CODE, language: 'typescript', filename: 'cache.ts', mode: 'diff', beforeCode: untraceableBefore, afterCode: CACHE_CODE },
  };
  const built = buildStoryboardSceneOrFallback(singleChapter, raw);
  assert.equal(built.fallbackUsed, false, '降级仍返回有效场景（fallbackUsed=false）');
  assert.equal(typeof built.modeFallback, 'string', 'modeFallback 原因字符串');
  assert.ok((built.modeFallback ?? '').length > 0);
  assert.equal(built.scene.type, 'code');
  assert.equal(built.scene.narration, NARRATION, 'narration 保留');
  assertFocusScene(built.scene, '不可追溯 beforeCode');

  // raw trace 无 traceSteps → focus（不产生空步骤动画）
  const traceNoSteps = buildStoryboardSceneOrFallback(singleChapter, rawCode({ mode: 'trace' }));
  assert.equal(traceNoSteps.fallbackUsed, false);
  assertFocusScene(traceNoSteps.scene, 'trace 无步骤');

  // raw build 无 buildSteps → focus
  const buildNoSteps = buildStoryboardSceneOrFallback(singleChapter, rawCode({ mode: 'build' }));
  assert.equal(buildNoSteps.fallbackUsed, false);
  assertFocusScene(buildNoSteps.scene, 'build 无步骤');
});

test('#25-9 无法验证 buildSteps 回退 focus（生成链路）：越界/缺行/非数组 → scene 有效、mode focus、narration 保留、fallbackUsed=false', () => {
  const invalidStepsList: unknown[] = [
    [{ revealLines: [999] }],
    [{ revealLines: [1, 2] }],
    'not-an-array',
    [],
    [{ revealLines: [] }],
  ];
  for (const [index, buildSteps] of invalidStepsList.entries()) {
    const raw = rawCode({ mode: 'build', buildSteps });
    const built = buildStoryboardSceneOrFallback(codeChapter(), raw);
    assert.equal(built.fallbackUsed, false, `case ${index}: scene 仍有效`);
    assert.equal(built.scene.narration, NARRATION, `case ${index}: narration 保留`);
    assertFocusScene(built.scene, `case ${index}`);
    assert.equal(SceneSchema.safeParse(built.scene).success, true, `case ${index}: SceneSchema 通过`);
  }
});

test('#27-10 无验证状态不臆造 trace（生成链路）：无 traceSteps/行号越界 → focus；scene 有效、narration 保留', () => {
  const cases: { name: string; visual: Record<string, unknown> }[] = [
    { name: '无 traceSteps', visual: { mode: 'trace' } },
    { name: 'traceSteps 行号越界', visual: { mode: 'trace', traceSteps: [{ lines: [999] }] } },
    { name: 'traceSteps 非数组', visual: { mode: 'trace', traceSteps: 'guess' } },
    { name: 'trace mode 空 state 无状态变化', visual: { mode: 'trace', traceSteps: [] } },
  ];
  for (const entry of cases) {
    const raw = rawCode(entry.visual);
    const built = buildStoryboardSceneOrFallback(codeChapter(), raw);
    assert.equal(built.fallbackUsed, false, `${entry.name}: scene 有效`);
    assert.equal(built.scene.narration, NARRATION, `${entry.name}: narration 保留`);
    assertFocusScene(built.scene, entry.name);
    assert.equal(SceneSchema.safeParse(built.scene).success, true);
  }
});

// ═════════════════════════════ #24-6 高级模式结构非法稳定回退 focus ═════════════

test('#24-6 高级模式结构非法经 normalize/codeVisualOf 回退 focus 且不抛错；scene 通过 SceneSchema、narration 不丢失', () => {
  const cases: { name: string; raw: ReturnType<typeof rawCode> }[] = [
    { name: 'buildSteps 越界', raw: rawCode({ mode: 'build', buildSteps: [{ revealLines: [999] }] }) },
    { name: 'buildSteps 覆盖缺行', raw: rawCode({ mode: 'build', buildSteps: [{ revealLines: [1, 2] }, { revealLines: [5, 6, 7] }] }) },
    { name: 'traceSteps 行号越界', raw: rawCode({ mode: 'trace', traceSteps: [{ lines: [999] }] }) },
    { name: 'diff 缺 afterCode', raw: rawCode({ mode: 'diff', beforeCode: CACHE_CODE }) },
    { name: 'diffBeats 格式非法', raw: { ...rawDiff({ diffBeats: [{ hunkIds: ['nope'] }] }) } },
  ];
  for (const entry of cases) {
    const chapter = entry.name === 'diffBeats 格式非法' ? diffChapter() : codeChapter();
    assert.doesNotThrow(() => normalizeCodeVisualInput((entry.raw as { visual: unknown }).visual), `${entry.name}: normalize 不抛错`);
    const built = buildStoryboardSceneOrFallback(chapter, entry.raw);
    assert.equal(built.fallbackUsed, false, `${entry.name}: scene 有效`);
    assert.equal(built.scene.narration, entry.raw.narration, `${entry.name}: narration 不丢失`);
    assertFocusScene(built.scene, entry.name);
  }
});

// ═════════════════════════════ #24-7 Standard/HTML 同源 ════════════════════════

test('#24-7 Standard/HTML 同一章节 mode 一致：visual.mode 与 buildSteps/traceSteps/beforeCode/afterCode/beats 完全一致；两模式 prompt 都含 mode 规则', () => {
  const fixtures: { name: string; chapter: Chapter; raw: Record<string, unknown> }[] = [
    { name: 'build', chapter: codeChapter(), raw: rawBuild({ beats: [{ lines: [1] }] }) },
    { name: 'diff', chapter: diffChapter(), raw: rawDiff() },
    { name: 'trace', chapter: codeChapter(), raw: rawTrace() },
  ];
  for (const fixture of fixtures) {
    const standard = buildStoryboardSceneOrFallback(fixture.chapter, fixture.raw, false, 'standard');
    const html = buildStoryboardSceneOrFallback(fixture.chapter, fixture.raw, false, 'html');
    assert.equal(standard.fallbackUsed, false, `${fixture.name}: standard 有效`);
    assert.equal(html.fallbackUsed, false, `${fixture.name}: html 有效`);
    const standardVisual = visualOf(standard.scene);
    const htmlVisual = visualOf(html.scene);
    const { html: _standardHtml, ...standardWithoutHtml } = standardVisual;
    const { html: _htmlHtml, ...htmlWithoutHtml } = htmlVisual;
    assert.deepEqual(htmlWithoutHtml, standardWithoutHtml, `${fixture.name}: 两种模式 structured visual 完全一致（HTML 只额外加 html）`);
    assert.equal(resolveCodeSceneMode(codeVisualOf(standard.scene.visual)), resolveCodeSceneMode(codeVisualOf(html.scene.visual)), `${fixture.name}: mode 一致`);
    assert.deepEqual(codeVisualOf(standard.scene.visual)?.mode, codeVisualOf(html.scene.visual)?.mode);
  }

  // 两种 generation mode 的 prompt 都包含相同的 mode 规则
  const chapters = [codeChapter(), diffChapter()];
  const standardPrompt = buildStoryboardPrompt('项目', chapters, 'standard');
  const htmlPrompt = buildStoryboardPrompt('项目', chapters, 'html');
  for (const fragment of ['code.mode', 'focus', 'build', 'diff', 'trace', 'buildSteps', 'beforeCode', 'afterCode', 'traceSteps']) {
    assert.ok(standardPrompt.includes(fragment), `standard prompt 含 ${fragment}`);
    assert.ok(htmlPrompt.includes(fragment), `html prompt 含 ${fragment}`);
  }
});

// ═════════════════════════════ #24-8 prompt 模式选择契约 ═════════════════════════

test('#24-8 prompt 模式选择契约 + 模型 JSON schema 新字段（additionalProperties=false）', () => {
  const chapters = [codeChapter(), diffChapter(), codeChapter()];
  const prompt = buildStoryboardPrompt('项目', chapters);

  // 默认 focus + 三种高级模式触发条件
  assert.match(prompt, /默认[^。；]{0,16}focus/);
  assert.match(prompt, /逐步构建/, 'build 触发条件');
  assert.ok(prompt.includes('buildSteps'), 'buildSteps');
  assert.ok(prompt.includes('revealLines'), 'revealLines');
  assert.ok(prompt.includes('beforeCode'), 'beforeCode');
  assert.ok(prompt.includes('afterCode'), 'afterCode');
  assert.ok(prompt.includes('diffBeats') || prompt.includes('hunkIds'), 'diff 结构化数据');
  assert.ok(prompt.includes('traceSteps'), 'traceSteps');
  assert.match(prompt, /traceSteps[^。；]{0,80}state/, 'trace state 约束');
  assert.match(prompt, /逐字符|typing/, '禁止逐字符 typing');
  assert.match(prompt, /不得|禁止|不允许/, '禁止臆造');
  assert.match(prompt, /逐字/, 'before/after 与 code 逐字约束');
  assert.match(prompt, /(?:standard|Standard)[^。]{0,24}(?:HTML|html)|(?:HTML|html)[^。]{0,24}(?:standard|Standard)/, 'Standard/HTML 相同 mode');
  // V1.6.8 #16-1 既有回归子串全部保留
  allSubstrings(prompt, ['type=code', 'codeBlocks', 'beats', 'narrationText', 'visual.code', '每项只含 type,narration,visual', '不含 id/title/duration'], '#16-1 回归');

  // modelVisualSchema('code') 新字段 + additionalProperties=false
  type JsonObject = { [key: string]: any };
  const visual = modelVisualSchema('code') as JsonObject;
  assert.equal(visual.additionalProperties, false);
  assert.deepEqual(
    Object.keys(visual.properties as JsonObject).sort(),
    ['afterCode', 'beats', 'beforeCode', 'buildSteps', 'code', 'diffBeats', 'filename', 'language', 'mode', 'traceSteps'],
    'code 模型 schema 字段集合',
  );
  assert.deepEqual(visual.required, ['code'], '仅 code 必填');
  assert.deepEqual(visual.properties.mode.enum, ['focus', 'build', 'diff', 'trace']);
  for (const key of ['beforeCode', 'afterCode']) {
    assert.equal(visual.properties[key].type, 'string', `${key} string`);
    assert.equal(visual.properties[key].minLength, 1);
    assert.equal(visual.properties[key].maxLength, 8000);
  }

  const buildSteps = visual.properties.buildSteps as JsonObject;
  assert.equal(buildSteps.type, 'array');
  assert.equal(buildSteps.minItems, 1);
  assert.equal(buildSteps.maxItems, 12);
  assert.equal(buildSteps.items.additionalProperties, false);
  assert.deepEqual(Object.keys(buildSteps.items.properties).sort(), ['focusLines', 'label', 'narrationText', 'revealLines']);
  assert.equal(buildSteps.items.required.includes('revealLines'), true);
  assert.equal(buildSteps.items.properties.revealLines.maxItems, 200);
  assert.equal(buildSteps.items.properties.revealLines.minItems, 1);
  assert.equal(buildSteps.items.properties.revealLines.items.minimum, 1);
  assert.equal(buildSteps.items.properties.label.maxLength, 30);
  assert.equal(buildSteps.items.properties.narrationText.maxLength, 200);

  const diffBeats = visual.properties.diffBeats as JsonObject;
  assert.equal(diffBeats.type, 'array');
  assert.equal(diffBeats.maxItems, 10);
  assert.equal(diffBeats.items.additionalProperties, false);
  assert.deepEqual(Object.keys(diffBeats.items.properties).sort(), ['hunkIds', 'label', 'narrationText']);
  assert.equal(diffBeats.items.required.includes('hunkIds'), true);
  assert.equal(diffBeats.items.properties.hunkIds.minItems, 1);
  assert.equal(diffBeats.items.properties.hunkIds.maxItems, 10);

  const traceSteps = visual.properties.traceSteps as JsonObject;
  assert.equal(traceSteps.type, 'array');
  assert.equal(traceSteps.maxItems, 20);
  assert.equal(traceSteps.items.additionalProperties, false);
  assert.deepEqual(Object.keys(traceSteps.items.properties).sort(), ['callDepth', 'label', 'lines', 'narrationText', 'output', 'state']);
  assert.equal(traceSteps.items.required.includes('lines'), true);
  assert.equal(traceSteps.items.properties.lines.minItems, 1);
  assert.equal(traceSteps.items.properties.lines.maxItems, 200);
  assert.equal(traceSteps.items.properties.output.maxLength, 200);
  assert.equal(traceSteps.items.properties.callDepth.minimum, 0);
  assert.equal(traceSteps.items.properties.callDepth.maximum, 20);
  const state = traceSteps.items.properties.state as JsonObject;
  assert.equal(state.type, 'array');
  assert.equal(state.maxItems, 12);
  assert.equal(state.items.additionalProperties, false);
  assert.deepEqual(Object.keys(state.items.properties).sort(), ['changed', 'name', 'value']);
  assert.equal(state.items.required.includes('name'), true);
  assert.equal(state.items.required.includes('value'), true);
  assert.equal(state.items.properties.name.maxLength, 40);
  assert.equal(state.items.properties.value.maxLength, 160);
  assert.equal(state.items.properties.changed.type, 'boolean');

  // beats 既有结构不变
  const beats = visual.properties.beats as JsonObject;
  assert.equal(beats.maxItems, 10);
  assert.deepEqual(Object.keys(beats.items.properties).sort(), ['label', 'lines', 'narrationText']);

  // storyboard/regenerate 输出 schema 都使用同一份 modelVisualSchema('code')
  const oneOf = (storyboardOutputSchema(1) as JsonObject).properties.scenes.items.oneOf as JsonObject[];
  const codeEntry = oneOf.find((entry: JsonObject) => entry.properties.type.enum[0] === 'code');
  assert.ok(codeEntry, 'storyboard schema 含 code');
  assert.deepEqual(Object.keys(codeEntry.properties.visual.properties as JsonObject).sort(), Object.keys(visual.properties as JsonObject).sort(), 'storyboard schema 含新字段');
  const regenerate = regenerateOutputSchema({ htmlMode: false, sceneType: 'code' }) as JsonObject;
  assert.equal(regenerate.additionalProperties, false);
  assert.deepEqual(Object.keys(regenerate.properties.visual.properties as JsonObject).sort(), Object.keys(visual.properties as JsonObject).sort(), 'regenerate schema 含新字段');

  // 重新生成 prompt 追加 mode 规则
  const scene = { id: 's1', type: 'code', narration: NARRATION, visual: { code: CACHE_CODE } } as Scene;
  const regeneratePrompt = buildRegenerateScenePrompt({
    scene,
    sceneTypeRule: 'type=code',
    htmlRequirement: '',
    sourceContext: { text: '本章说明缓存。', strategy: 'content_anchor', codeBlocks: [{ language: 'typescript', code: CACHE_CODE }] },
  });
  for (const fragment of ['code.mode', '默认', 'focus', 'buildSteps', 'beforeCode', 'afterCode', 'traceSteps']) {
    assert.ok(regeneratePrompt.includes(fragment), `regenerate prompt 含 ${fragment}`);
  }
});

// ═════════════════════════════ #26-10 单一版本不臆造 diff（生成链路） ═══════════

test('#26-10 单一版本不臆造 diff（生成链路）：beforeCode 不可追溯 → 降级 focus + modeFallback；code≠afterCode 由归一化修复后保留 diff', () => {
  // 单一代码版本 + 不可追溯 beforeCode → 降级 focus
  const invented = 'const legacy = 0;\nreturn legacy;';
  const raw = {
    type: 'code',
    narration: NARRATION,
    visual: { code: CACHE_CODE, language: 'typescript', filename: 'cache.ts', mode: 'diff', beforeCode: invented, afterCode: CACHE_CODE },
  };
  const built = buildStoryboardSceneOrFallback(codeChapter(), raw);
  assert.equal(built.fallbackUsed, false);
  assert.ok((built.modeFallback ?? '').length > 0, 'modeFallback 非空');
  assert.equal(built.scene.narration, NARRATION, 'narration 保留');
  assertFocusScene(built.scene, '不可追溯 beforeCode');

  const standard = buildStoryboardSceneOrFallback(codeChapter(), raw, false, 'standard');
  const html = buildStoryboardSceneOrFallback(codeChapter(), raw, false, 'html');
  assert.equal(modeOf(standard.scene), modeOf(html.scene), 'standard/html 同 mode');
  assert.equal(SceneSchema.safeParse(html.scene).success, true, 'HTML 模式不因 diff 数据非法而崩溃');

  // code 与 afterCode 不一致但 afterCode 可追溯 → 归一化修复 code=afterCode，保留 diff
  const repaired = {
    type: 'code',
    narration: DIFF_NARRATION,
    visual: { code: CACHE_CODE, language: 'typescript', filename: 'cache.ts', mode: 'diff', beforeCode: CACHE_CODE, afterCode: CACHE_CODE_V2 },
  };
  const repairedBuilt = buildStoryboardSceneOrFallback(diffChapter(), repaired);
  assert.equal(repairedBuilt.fallbackUsed, false);
  assert.equal(visualOf(repairedBuilt.scene).mode, 'diff', '归一化修复后保留 diff');
  assert.equal(visualOf(repairedBuilt.scene).code, CACHE_CODE_V2, 'code 被修复为 afterCode');
  assert.equal(modeOf(repairedBuilt.scene), 'diff');
});

// ═════════════════════════════ #25-8 / #21-6 回归（SceneTypeSchema） ══════════

test('#24/#25 回归：SceneTypeSchema 保持 12 值无 html-code；合法高级 scene 均通过 SceneSchema', () => {
  assert.deepEqual(
    [...SceneTypeSchema.options],
    ['title', 'text', 'bullets', 'diagram', 'comparison', 'chart', 'code', 'timeline', 'math', 'table', 'media', 'html'],
  );
  assert.equal((SceneTypeSchema.options as string[]).includes('html-code'), false);
  for (const raw of [rawBuild(), rawTrace()]) {
    const built = buildStoryboardSceneOrFallback(codeChapter(), raw);
    assert.equal(SceneSchema.safeParse(built.scene).success, true);
  }
  const diffBuilt = buildStoryboardSceneOrFallback(diffChapter(), rawDiff());
  assert.equal(SceneSchema.safeParse(diffBuilt.scene).success, true);
});
