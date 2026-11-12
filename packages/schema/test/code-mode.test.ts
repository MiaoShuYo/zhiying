import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_SCENE_MODES,
  CodeVisualSchema,
  SceneSchema,
  SceneTypeSchema,
  codeLines,
  codeVisualOf,
  normalizeCodeVisualInput,
  resolveCodeBuildSteps,
  resolveCodeDiffView,
  resolveCodeSceneMode,
  resolveCodeTraceSteps,
  type CodeVisual,
} from '../src/index';

/**
 * #24 / #25 / #27 契约：code scene 模式解析、生成期归一化与结构化步骤校验
 * （doc/V1.7.0_issues.md §2.2 / §2.4）。
 */

const codeOf = (count: number) => Array.from({ length: count }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n');

const visual = (patch: Record<string, unknown> = {}): CodeVisual => ({ code: codeOf(8), ...patch }) as CodeVisual;

/** 覆盖 1..8 的合法 buildSteps（4 步，每步 2 行）。 */
const buildSteps = () => [
  { revealLines: [1, 2], label: '声明', narrationText: '先声明变量' },
  { revealLines: [3, 4], focusLines: [3], label: '判断', narrationText: '再写判断' },
  { revealLines: [5, 6], label: '循环', narrationText: '然后写循环' },
  { revealLines: [7, 8], label: '收尾', narrationText: '最后收尾' },
];

const traceSteps = () => [
  { lines: [2], label: '初始化', narrationText: '初始化变量', state: [{ name: 'sum', value: '0' }, { name: 'i', value: '0' }] },
  { lines: [4], label: '累加', narrationText: '累加当前元素', state: [{ name: 'sum', value: '3', changed: true }, { name: 'i', value: '1', changed: true }], output: '3', callDepth: 1 },
  { lines: [6], label: '返回', narrationText: '返回结果', state: [{ name: 'result', value: '3', changed: true }], output: '3', callDepth: 0 },
];

// ═════════════════════════════ #24 模式常量与解析 ═════════════════════════════

// ── #24-1 默认 focus ──────────────────────────────────────────────────────────
test('#24-1 resolveCodeSceneMode 缺省/null/仅 mode 时一律 focus，normalize 原样保留无高级字段的 visual', () => {
  assert.deepEqual([...CODE_SCENE_MODES], ['focus', 'build', 'diff', 'trace'], 'CODE_SCENE_MODES 固定四值');
  assert.equal(CODE_SCENE_MODES.length, 4);

  assert.equal(resolveCodeSceneMode(null), 'focus', 'null → focus');
  assert.equal(resolveCodeSceneMode({ code: codeOf(3) } as CodeVisual), 'focus', '无 mode → focus');
  assert.equal(resolveCodeSceneMode({ code: codeOf(3), mode: 'focus' } as CodeVisual), 'focus', 'mode=focus → focus');
  for (const mode of ['build', 'diff', 'trace'] as const) {
    assert.equal(resolveCodeSceneMode({ code: codeOf(3), mode } as CodeVisual), 'focus', `mode=${mode} 无对应数据 → focus`);
  }
  assert.equal(CodeVisualSchema.safeParse({ code: codeOf(3), mode: 'build' }).success, true, 'mode 单独出现仍通过 schema（#15-7 回归）');

  const plain = { code: codeOf(3), language: 'typescript', filename: 'a.ts' };
  const normalized = normalizeCodeVisualInput(plain);
  assert.deepEqual(normalized, plain, '无高级字段的 focus visual 原样返回（#16-3 回归）');
  assert.equal('mode' in normalized, false, '不额外注入 mode');

  const withBeats = { code: codeOf(3), mode: 'focus', beats: [{ lines: [2], label: 'B' }] };
  assert.deepEqual(normalizeCodeVisualInput(withBeats), withBeats, 'mode=focus + beats 原样保留');
});

// ── #24-2 build 归一化保留 ────────────────────────────────────────────────────
test('#24-2 合法 build visual：resolveCodeSceneMode=build，normalize 保留 mode/buildSteps 并去掉 beats', () => {
  const steps = buildSteps();
  const input = { code: codeOf(8), language: 'typescript', filename: 'a.ts', mode: 'build', buildSteps: steps, beats: [{ lines: [1] }] };
  assert.equal(CodeVisualSchema.safeParse(input).success, true, '合法 build visual 通过 schema');
  assert.equal(resolveCodeSceneMode({ ...input } as CodeVisual), 'build');
  const normalized = normalizeCodeVisualInput(input);
  assert.deepEqual(Object.keys(normalized).sort(), ['buildSteps', 'code', 'filename', 'language', 'mode'], 'build 归一化字段集合');
  assert.equal(normalized.mode, 'build');
  assert.deepEqual(normalized.buildSteps, steps, 'buildSteps 保留');
  assert.equal('beats' in normalized, false, '§2.4.2 build 归一化不携带 beats');

  // 生成期输入不被改写
  const snapshot = JSON.stringify(input);
  normalizeCodeVisualInput(input);
  assert.equal(JSON.stringify(input), snapshot, 'normalize 不修改输入对象');
});

// ── #24-3 diff 归一化保留 ─────────────────────────────────────────────────────
test('#24-3 合法 diff visual：code===afterCode 时 resolveCodeSceneMode=diff，normalize 保留 before/after/diffBeats', () => {
  const before = 'const value = 1;\nconsole.log(value);';
  const after = 'const value = 2;\nconsole.log(value);';
  const input = { code: after, mode: 'diff', beforeCode: before, afterCode: after, diffBeats: [{ hunkIds: ['h1'], label: '改值' }] };
  assert.equal(CodeVisualSchema.safeParse(input).success, true);
  assert.equal(resolveCodeSceneMode(input as CodeVisual), 'diff');
  const normalized = normalizeCodeVisualInput(input);
  assert.deepEqual(Object.keys(normalized).sort(), ['afterCode', 'beforeCode', 'code', 'diffBeats', 'mode']);
  assert.equal(normalized.mode, 'diff');
  assert.equal(normalized.code, after);
  assert.equal(normalized.beforeCode, before);
});

// ── #24-4 trace 归一化保留 ────────────────────────────────────────────────────
test('#24-4 合法 trace visual：resolveCodeSceneMode=trace，normalize 保留 traceSteps；resolver 升序去重', () => {
  const steps = traceSteps();
  const input = { code: codeOf(8), mode: 'trace', traceSteps: steps, beats: [{ lines: [1] }] };
  assert.equal(CodeVisualSchema.safeParse(input).success, true);
  assert.equal(resolveCodeSceneMode(input as CodeVisual), 'trace');
  const normalized = normalizeCodeVisualInput(input);
  assert.deepEqual(Object.keys(normalized).sort(), ['code', 'mode', 'traceSteps']);
  assert.equal(normalized.mode, 'trace');
  assert.deepEqual(normalized.traceSteps, steps);

  const resolved = resolveCodeTraceSteps({ ...input } as CodeVisual);
  assert.ok(resolved, 'trace steps 可解析');
  assert.deepEqual(resolved!.map(step => step.lines), [[2], [4], [6]], 'lines 升序');
  assert.equal(resolved![1].output, '3');
  assert.equal(resolved![1].callDepth, 1);
  assert.deepEqual(resolved![1].state, steps[1].state, 'state 原样保留');
});

// ── #24-5 / #24-6 非法高级数据稳定回退 focus（schema + normalize） ──────────────
test('#24-5 条件不足/结构非法的高级模式经 normalize 与 codeVisualOf 回退 focus，不抛错且 scene 仍有效', () => {
  const cases: { name: string; visual: Record<string, unknown> }[] = [
    { name: 'buildSteps 行号越界', visual: { code: codeOf(8), mode: 'build', buildSteps: [{ revealLines: [1, 99] }] } },
    { name: 'buildSteps 覆盖缺行', visual: { code: codeOf(8), mode: 'build', buildSteps: [{ revealLines: [1, 2] }, { revealLines: [5, 6, 7, 8] }] } },
    { name: 'traceSteps 行号越界', visual: { code: codeOf(8), mode: 'trace', traceSteps: [{ lines: [99] }] } },
    { name: 'traceSteps state 重名', visual: { code: codeOf(8), mode: 'trace', traceSteps: [{ lines: [1], state: [{ name: 'a', value: '1' }, { name: 'a', value: '2' }] }] } },
    { name: 'diffBeats 格式非法', visual: { code: codeOf(8), mode: 'diff', beforeCode: codeOf(8), afterCode: codeOf(8), diffBeats: [{ hunkIds: ['nope'] }] } },
    { name: 'diff 缺 afterCode', visual: { code: codeOf(8), mode: 'diff', beforeCode: codeOf(8) } },
    { name: 'diff 缺 beforeCode', visual: { code: codeOf(8), mode: 'diff', afterCode: codeOf(8) } },
  ];
  for (const entry of cases) {
    assert.doesNotThrow(() => normalizeCodeVisualInput(entry.visual), `${entry.name}: normalize 不抛错`);
    assert.doesNotThrow(() => codeVisualOf(entry.visual), `${entry.name}: codeVisualOf 不抛错`);
    const recovered = codeVisualOf(entry.visual);
    assert.ok(recovered, `${entry.name}: codeVisualOf 走 focus 恢复`);
    assert.equal(recovered!.mode, undefined, `${entry.name}: 恢复后不含 mode`);
    assert.equal(resolveCodeSceneMode(recovered), 'focus', `${entry.name}: 有效 mode 为 focus`);
    assert.equal('buildSteps' in recovered! || 'traceSteps' in recovered! || 'diffBeats' in recovered! || 'beforeCode' in recovered!, false, `${entry.name}: 恢复对象不含高级字段`);

    const normalized = normalizeCodeVisualInput(entry.visual);
    assert.equal((normalized as { mode?: unknown }).mode, 'focus', `${entry.name}: normalize → mode focus`);
    const scene = {
      id: 'code-invalid',
      type: 'code',
      narration: '这一页讲解代码里的缓存逻辑。',
      visual: normalized,
    };
    assert.equal(SceneSchema.safeParse(scene).success, true, `${entry.name}: 归一化后 scene 仍通过 SceneSchema`);
  }
  // 完全非法的输入原样返回，让 SceneSchema 报错
  for (const bad of [null, undefined, 42, 'code', [], { code: 42 }, { code: '' }]) {
    assert.doesNotThrow(() => normalizeCodeVisualInput(bad), `normalize(${JSON.stringify(bad)}) 不抛错`);
  }
});

// ── #24-6 diff 前后代码契约 ───────────────────────────────────────────────────
test('#24-6 beforeCode/afterCode 必须成对；mode=diff 时 code 必须等于 afterCode；无变更由 resolver 回退 focus', () => {
  const before = 'const value = 1;';
  const after = 'const value = 2;';
  const onlyAfter = { code: after, mode: 'diff', afterCode: after };
  const afterResult = CodeVisualSchema.safeParse(onlyAfter);
  assert.equal(afterResult.success, false, '只给 afterCode 被拒绝');
  assert.ok(!afterResult.success && afterResult.error.issues.some(issue => issue.path.join('.').includes('beforeCode')), 'issue 指向缺失的 beforeCode');

  const onlyBefore = { code: after, mode: 'diff', beforeCode: before };
  const beforeResult = CodeVisualSchema.safeParse(onlyBefore);
  assert.equal(beforeResult.success, false, '只给 beforeCode 被拒绝');
  assert.ok(!beforeResult.success && beforeResult.error.issues.some(issue => issue.path.join('.').includes('afterCode')), 'issue 指向缺失的 afterCode');

  const mismatched = { code: before, mode: 'diff', beforeCode: before, afterCode: after };
  const mismatchResult = CodeVisualSchema.safeParse(mismatched);
  assert.equal(mismatchResult.success, false, 'code !== afterCode 被拒绝');
  assert.ok(!mismatchResult.success && mismatchResult.error.issues.some(issue => issue.path.join('.') === 'code'), 'CodeVisualSchema 层路径 code');
  // SceneSchema 包装层路径为 visual.code（契约 §2.2.5）
  const sceneMismatch = SceneSchema.safeParse({ id: 'code-mismatch', type: 'code', narration: '代码讲解。', visual: mismatched });
  assert.equal(sceneMismatch.success, false);
  assert.ok(!sceneMismatch.success && sceneMismatch.error.issues.some(issue => issue.path.join('.') === 'visual.code'), 'issue 路径 visual.code');

  const noChanges = { code: after, mode: 'diff', beforeCode: after, afterCode: after };
  assert.equal(CodeVisualSchema.safeParse(noChanges).success, true, 'before===after 通过 schema');
  assert.equal(resolveCodeSceneMode(noChanges as CodeVisual), 'focus', '无实际变更 → resolver 回退 focus');
  assert.equal(resolveCodeDiffView(noChanges as CodeVisual), null, '无变更时 resolveCodeDiffView 为 null');
});

// ── #25-1 buildSteps schema 校验 ──────────────────────────────────────────────
test('#25-1 buildSteps：≤12 步、行号 1..N 且不重复、非空、label/narration 上限；mode=focus 时 normalize 降级 focus', () => {
  const code = codeOf(12);
  // 12 步覆盖 12 行合法；13 步非法
  const twelve = Array.from({ length: 12 }, (_, index) => ({ revealLines: [index + 1] }));
  assert.equal(CodeVisualSchema.safeParse({ code, buildSteps: twelve }).success, true, '12 步合法');
  const thirteen = [...twelve, { revealLines: [1] }];
  assert.equal(CodeVisualSchema.safeParse({ code, buildSteps: thirteen }).success, false, '13 步非法');

  const invalid: { name: string; steps: unknown[] }[] = [
    { name: '空数组 revealLines', steps: [{ revealLines: [] }] },
    { name: '行号 0', steps: [{ revealLines: [0] }] },
    { name: '行号负数', steps: [{ revealLines: [-2] }] },
    { name: '行号越界', steps: [{ revealLines: [13] }] },
    { name: '步内重复行', steps: [{ revealLines: [1, 1] }] },
    { name: 'focusLines 空', steps: [{ revealLines: [1], focusLines: [] }] },
    { name: 'focusLines 越界', steps: [{ revealLines: [1], focusLines: [99] }] },
    { name: 'focusLines 重复', steps: [{ revealLines: [1], focusLines: [2, 2] }] },
    { name: 'label 超长', steps: [{ revealLines: [1], label: '标'.repeat(31) }] },
    { name: 'label 空串', steps: [{ revealLines: [1], label: '' }] },
    { name: 'narrationText 超长', steps: [{ revealLines: [1], narrationText: '旁'.repeat(201) }] },
    { name: '未知字段仍 strip 但覆盖缺行', steps: [{ revealLines: [1], extra: true }] },
  ];
  for (const entry of invalid) {
    const result = CodeVisualSchema.safeParse({ code, buildSteps: entry.steps });
    if (entry.name === '未知字段仍 strip 但覆盖缺行') {
      assert.equal(result.success, false, `${entry.name}: 覆盖不完整导致失败`);
    } else {
      assert.equal(result.success, false, `${entry.name} 必须失败`);
    }
  }

  // 覆盖完整时 mode=build 才可解析；focusLines 缺省由 resolver 补 = revealLines
  const resolved = resolveCodeBuildSteps({ code, mode: 'build', buildSteps: [{ revealLines: [2, 1] }, ...twelve.slice(2)] } as unknown as CodeVisual);
  assert.ok(resolved);
  assert.deepEqual(resolved![0].revealLines, [1, 2], 'revealLines 升序去重');
  assert.deepEqual(resolved![0].focusLines, [1, 2], 'focusLines 缺省 = revealLines');
  assert.deepEqual(resolved![1].focusLines, [3], '显式 focusLines 保留');

  // mode=focus 但带 buildSteps → normalize 降级 focus（不抛错）
  const focusWithBuild = { code: codeOf(8), mode: 'focus', buildSteps: buildSteps() };
  assert.equal(CodeVisualSchema.safeParse(focusWithBuild).success, true, 'schema 允许 mode=focus 携带 buildSteps');
  const normalized = normalizeCodeVisualInput(focusWithBuild);
  assert.equal(normalized.mode, 'focus', 'normalize 降级 mode=focus');
  assert.equal('buildSteps' in normalized, false, '降级后不含 buildSteps');
});

// ── #25-2 reveal 并集覆盖完整源码 ────────────────────────────────────────────
test('#25-2 buildSteps 的 revealLines 并集必须恰好覆盖 1..总行数；缺行/越界 → resolver null + mode focus', () => {
  const code = codeOf(6);
  const valid = [
    { revealLines: [1, 2] },
    { revealLines: [3, 4] },
    { revealLines: [5, 6] },
  ];
  const resolved = resolveCodeBuildSteps({ code, mode: 'build', buildSteps: valid } as CodeVisual);
  assert.ok(resolved, '覆盖完整时返回步骤');
  assert.equal(resolved!.length, 3);
  assert.deepEqual(resolved!.flatMap(step => step.revealLines).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  assert.equal(resolveCodeSceneMode({ code, mode: 'build', buildSteps: valid } as CodeVisual), 'build');

  const missingLine = [{ revealLines: [1, 2] }, { revealLines: [4, 5, 6] }];
  assert.equal(CodeVisualSchema.safeParse({ code, buildSteps: missingLine }).success, false, 'schema 拒绝缺行覆盖');
  assert.equal(resolveCodeBuildSteps({ code, mode: 'build', buildSteps: missingLine } as CodeVisual), null, '缺行 → null');
  assert.equal(resolveCodeSceneMode({ code, mode: 'build', buildSteps: missingLine } as CodeVisual), 'focus', '缺行 → focus');

  const outOfRange = [{ revealLines: [1, 2] }, { revealLines: [3, 4, 5, 6, 7] }];
  assert.equal(CodeVisualSchema.safeParse({ code, buildSteps: outOfRange }).success, false, 'schema 拒绝越界');
  assert.equal(resolveCodeBuildSteps({ code, mode: 'build', buildSteps: outOfRange } as CodeVisual), null);
  assert.equal(resolveCodeSceneMode({ code, mode: 'build', buildSteps: outOfRange } as CodeVisual), 'focus');

  // 重复覆盖不算缺失，但 resolver 需要升序去重
  const overlapping = [{ revealLines: [2, 1] }, { revealLines: [1, 2, 3, 4, 5, 6] }];
  assert.equal(CodeVisualSchema.safeParse({ code, buildSteps: overlapping }).success, true, '重复覆盖仍合法');
  const deduped = resolveCodeBuildSteps({ code, mode: 'build', buildSteps: overlapping } as CodeVisual);
  assert.deepEqual(deduped!.map(step => step.revealLines), [[1, 2], [1, 2, 3, 4, 5, 6]], '升序且步内去重');

  // mode 不匹配 / 空数据 → null（不产生空步骤动画）
  assert.equal(resolveCodeBuildSteps({ code, buildSteps: valid } as CodeVisual), null, '无 mode=build → null');
  assert.equal(resolveCodeBuildSteps({ code, mode: 'build' } as CodeVisual), null, '无 buildSteps → null');
  assert.equal(resolveCodeBuildSteps({ code, mode: 'build', buildSteps: [] } as CodeVisual), null, '空 buildSteps → null');
  assert.equal(resolveCodeBuildSteps(null), null);
  assert.equal(resolveCodeSceneMode({ code, mode: 'build' } as CodeVisual), 'focus', '无步骤 → focus');
});

// ── #26-5（resolver 部分）diff beats/hunk 关联 ──────────────────────────────
test('#26-5 resolveCodeDiffView 过滤非法 beat、默认每 hunk 一条 beat、保序去重；mode≠diff → null', () => {
  const before = ['line a', 'line b', 'line c', 'line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line old', 'line z'].join('\n');
  const after = ['line a', 'line b', 'line c', 'line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line new', 'line z'].join('\n');
  const base = { code: after, mode: 'diff', beforeCode: before, afterCode: after };

  const view = resolveCodeDiffView(base as CodeVisual);
  assert.ok(view, '有变更时返回 diff 视图');
  assert.equal(view!.hunks.length, 1, '单处替换生成 1 个 hunk');
  assert.deepEqual(view!.beats.map(beat => beat.hunkIds), [['h1']], '缺省 diffBeats → 每 hunk 一条默认 beat');

  const withBeats = resolveCodeDiffView({ ...base, diffBeats: [{ hunkIds: ['h9'] }, { hunkIds: ['h1'], label: '改值' }] } as CodeVisual);
  assert.deepEqual(withBeats!.beats.map(beat => beat.hunkIds), [['h1']], '不存在 hunk 的 beat 被过滤');
  assert.equal(withBeats!.beats[0].label, '改值', 'label 保留');

  const allInvalid = resolveCodeDiffView({ ...base, diffBeats: [{ hunkIds: ['h9'] }] } as CodeVisual);
  assert.deepEqual(allInvalid!.beats.map(beat => beat.hunkIds), [['h1']], '全部非法 → 默认每 hunk 一条');

  const dedupe = resolveCodeDiffView({ ...base, diffBeats: [{ hunkIds: ['h1', 'h1', 'h1'] }] } as CodeVisual);
  assert.deepEqual(dedupe!.beats.map(beat => beat.hunkIds), [['h1']], 'hunkIds 去重');
  assert.deepEqual(dedupe!.beats[0], { hunkIds: ['h1'] }, '只保留契约字段');

  assert.equal(resolveCodeDiffView({ code: after, beforeCode: before, afterCode: after } as CodeVisual), null, 'mode≠diff → null');
  assert.equal(resolveCodeDiffView(null), null);
});

// ── #27-1 traceSteps schema 校验 ─────────────────────────────────────────────
test('#27-1 traceSteps：≤20、lines 1..N 不重复、state ≤12 且 name 不重复、value≤160、output≤200、callDepth 0..20', () => {
  const code = codeOf(20);
  const twenty = Array.from({ length: 20 }, (_, index) => ({ lines: [index + 1] }));
  assert.equal(CodeVisualSchema.safeParse({ code, traceSteps: twenty }).success, true, '20 步合法');
  assert.equal(CodeVisualSchema.safeParse({ code, traceSteps: [...twenty, { lines: [1] }] }).success, false, '21 步非法');

  const invalid: { name: string; steps: unknown[] }[] = [
    { name: 'lines 空', steps: [{ lines: [] }] },
    { name: 'lines 0', steps: [{ lines: [0] }] },
    { name: 'lines 越界', steps: [{ lines: [21] }] },
    { name: 'lines 重复', steps: [{ lines: [3, 3] }] },
    { name: 'state 13 项', steps: [{ lines: [1], state: Array.from({ length: 13 }, (_, index) => ({ name: `v${index}`, value: '0' })) }] },
    { name: 'state name 空', steps: [{ lines: [1], state: [{ name: '', value: '0' }] }] },
    { name: 'state name 超长', steps: [{ lines: [1], state: [{ name: 'n'.repeat(41), value: '0' }] }] },
    { name: 'state name 重复', steps: [{ lines: [1], state: [{ name: 'a', value: '1' }, { name: 'a', value: '2' }] }] },
    { name: 'state value 超长', steps: [{ lines: [1], state: [{ name: 'a', value: 'v'.repeat(161) }] }] },
    { name: 'changed 非布尔', steps: [{ lines: [1], state: [{ name: 'a', value: '1', changed: 'true' }] }] },
    { name: 'output 超长', steps: [{ lines: [1], output: 'o'.repeat(201) }] },
    { name: 'callDepth 负数', steps: [{ lines: [1], callDepth: -1 }] },
    { name: 'callDepth 超上限', steps: [{ lines: [1], callDepth: 21 }] },
    { name: 'callDepth 非整数', steps: [{ lines: [1], callDepth: 1.5 }] },
  ];
  for (const entry of invalid) {
    assert.equal(CodeVisualSchema.safeParse({ code, traceSteps: entry.steps }).success, false, `${entry.name} 必须失败`);
  }

  // 合法边界
  const boundary = {
    code,
    traceSteps: [{
      lines: [1, 20],
      label: '标',
      narrationText: '旁白',
      state: Array.from({ length: 12 }, (_, index) => ({ name: `v${index}`, value: '', changed: index % 2 === 0 })),
      output: '',
      callDepth: 20,
    }],
  };
  assert.equal(CodeVisualSchema.safeParse(boundary).success, true, '12 项 state / 空 value / callDepth=20 合法');
  const zeroDepth = { code, traceSteps: [{ lines: [1], callDepth: 0 }] };
  assert.equal(CodeVisualSchema.safeParse(zeroDepth).success, true, 'callDepth=0 合法');

  // 非法 trace data → normalize 回退 focus
  const normalized = normalizeCodeVisualInput({ code, mode: 'trace', traceSteps: [{ lines: [99] }] });
  assert.equal(normalized.mode, 'focus');
  assert.equal('traceSteps' in normalized, false);
  assert.equal(resolveCodeTraceSteps({ code, mode: 'trace', traceSteps: [{ lines: [99] }] } as CodeVisual), null);
});

// ── #27-11（schema 健壮性）空 value / 空 state 不崩溃 ──────────────────────────
test('#27-11 trace state 空字符串 value 合法、空 state 与空 output 组合不崩溃；resolver 稳定', () => {
  const sceneVisual = {
    code: codeOf(4),
    mode: 'trace',
    traceSteps: [
      { lines: [1], state: [{ name: 'a', value: '' }] },
      { lines: [2], state: [], output: '' },
      { lines: [3], state: [{ name: 'b', value: '0', changed: false }, { name: 'c', value: '1', changed: true }] },
    ],
  };
  assert.equal(CodeVisualSchema.safeParse(sceneVisual).success, true, '空 value/空 state/空 output 通过 schema');
  const steps = resolveCodeTraceSteps(sceneVisual as unknown as CodeVisual);
  assert.ok(steps);
  assert.deepEqual(steps![0].state, [{ name: 'a', value: '' }]);
  assert.deepEqual(steps![2].state, [{ name: 'b', value: '0', changed: false }, { name: 'c', value: '1', changed: true }], 'changed:false 原样保留');
  assert.equal(steps![1].output, '');

  const normalized = normalizeCodeVisualInput(sceneVisual);
  assert.equal(normalized.mode, 'trace');
  assert.doesNotThrow(() => JSON.stringify(normalized));
  assert.doesNotMatch(JSON.stringify(normalized), /NaN|undefined/, '归一化结果无 NaN/undefined');

  // resolveCodeSceneMode 不因空 state 崩溃
  assert.equal(resolveCodeSceneMode(sceneVisual as unknown as CodeVisual), 'trace');
});

// ── #25-8（schema 部分）SceneSchema 接受合法 build scene、SceneTypeSchema 不变 ─
test('#25-8 SceneSchema 接受合法 build/trace/diff scene；SceneTypeSchema 保持 12 值无 html-code', () => {
  const sceneOf = (visual: Record<string, unknown>) => ({ id: 'code-scene', type: 'code', narration: '这一页讲解代码逻辑。', visual });
  assert.equal(SceneSchema.safeParse(sceneOf({ code: codeOf(8), mode: 'build', buildSteps: buildSteps() })).success, true, 'build scene 合法');
  assert.equal(SceneSchema.safeParse(sceneOf({ code: codeOf(8), mode: 'trace', traceSteps: traceSteps() })).success, true, 'trace scene 合法');
  const before = 'const value = 1;';
  const after = 'const value = 2;';
  assert.equal(SceneSchema.safeParse(sceneOf({ code: after, mode: 'diff', beforeCode: before, afterCode: after })).success, true, 'diff scene 合法');

  assert.deepEqual(
    [...SceneTypeSchema.options],
    ['title', 'text', 'bullets', 'diagram', 'comparison', 'chart', 'code', 'timeline', 'math', 'table', 'media', 'html'],
    'SceneTypeSchema 不变',
  );
  assert.equal((SceneTypeSchema.options as string[]).includes('html-code'), false);
  // codeLines 语义不回归
  assert.deepEqual(codeLines('a\r\nb\r\n'), ['a', 'b'], 'CRLF + 末尾换行不多出行');
});

// ── #24-6（codeVisualOf lenient 恢复）非法高级数据返回 focus 最小对象 ──────────
test('#24-6 codeVisualOf 对非法高级数据做 focus 恢复（保留 code/language/filename/beats，去掉 mode 与高级字段）', () => {
  const evil = { code: codeOf(5), language: 'typescript', filename: 'a.ts', mode: 'build', buildSteps: [{ revealLines: [99] }] };
  const recovered = codeVisualOf(evil);
  assert.ok(recovered);
  assert.deepEqual(recovered, { code: evil.code, language: 'typescript', filename: 'a.ts' }, 'focus 恢复只保留基础字段');
  assert.equal(resolveCodeSceneMode(recovered), 'focus');
  const withBeats = { code: codeOf(5), mode: 'trace', traceSteps: [{ lines: [99] }], beats: [{ lines: [2] }] };
  assert.deepEqual(codeVisualOf(withBeats), { code: codeOf(5), beats: [{ lines: [2] }] }, 'beats 保留在恢复对象中');
  assert.equal(codeVisualOf({ code: codeOf(5), mode: 'diff', beforeCode: 'x', afterCode: codeOf(5), code2: 1 })?.mode, 'diff', '合法 diff 直接返回 parsed（未知字段 strip）');
});
