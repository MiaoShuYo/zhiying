import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CodeVisualSchema,
  SceneSchema,
  SceneTypeSchema,
  StoryboardSchema,
  codeLines,
  codeVisualOf,
} from '../src/index';

/** #15 契约：code 场景结构化 visual 与校验规则（doc/V1.6.8_issues.md §2.1）。 */

const codeOf = (count: number) => Array.from({ length: count }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n');

function codeScene(visual: Record<string, unknown> | undefined, patch: Record<string, unknown> = {}) {
  return {
    id: 'code-scene',
    type: 'code',
    narration: '这一页讲解代码里的缓存命中逻辑。',
    ...(visual === undefined ? {} : { visual }),
    ...patch,
  };
}

function issuePaths(result: { success: true } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } }): string[] {
  return result.success ? [] : result.error.issues.map(issue => issue.path.join('.'));
}

function issueMessages(result: { success: true } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } }): string {
  return result.success ? '' : result.error.issues.map(issue => issue.message).join(' | ');
}

// ── #15-1 缺少/为空/非字符串 visual.code 必须失败，路径指向 visual.code ──────────────
test('#15-1 type=code 缺少、为空或非字符串的 visual.code 被 SceneSchema 拒绝且路径为 visual.code', () => {
  const cases: { name: string; scene: Record<string, unknown> }[] = [
    { name: 'missing visual', scene: codeScene(undefined) },
    { name: 'empty visual', scene: codeScene({}) },
    { name: 'empty code', scene: codeScene({ code: '' }) },
    { name: 'non-string code', scene: codeScene({ code: 42 }) },
    { name: 'null code', scene: codeScene({ code: null }) },
    { name: 'object code', scene: codeScene({ code: { text: 'const a = 1;' } }) },
  ];
  for (const entry of cases) {
    const result = SceneSchema.safeParse(entry.scene);
    assert.equal(result.success, false, `${entry.name} must fail`);
    assert.ok(
      issuePaths(result).some(path => path === 'visual.code'),
      `${entry.name} issue path should point at visual.code, got ${issuePaths(result).join(',')}`,
    );
  }
  // 正例：非空 code 通过，证明失败来自 code 本身而不是 code 场景被整体禁用。
  assert.equal(SceneSchema.safeParse(codeScene({ code: 'const a = 1;' })).success, true);
});

// ── #15-2 code 长度上限 8000 ───────────────────────────────────────────────────────
test('#15-2 code 恰好 8000 字符通过，8001 字符失败', () => {
  assert.equal(SceneSchema.safeParse(codeScene({ code: 'a'.repeat(8000) })).success, true);
  const tooLong = SceneSchema.safeParse(codeScene({ code: 'a'.repeat(8001) }));
  assert.equal(tooLong.success, false);
  assert.ok(issuePaths(tooLong).some(path => path === 'visual.code'), 'over-long code reports visual.code');
});

// ── #15-3 language / filename 长度边界 ────────────────────────────────────────────
test('#15-3 language 最长 30、filename 最长 100；缺省通过', () => {
  const base = { code: codeOf(3) };
  assert.equal(SceneSchema.safeParse(codeScene({ ...base })).success, true, 'language/filename optional');
  assert.equal(SceneSchema.safeParse(codeScene({ ...base, language: 'x'.repeat(30) })).success, true);
  assert.equal(SceneSchema.safeParse(codeScene({ ...base, filename: 'f'.repeat(100) })).success, true);
  const longLanguage = SceneSchema.safeParse(codeScene({ ...base, language: 'x'.repeat(31) }));
  const longFilename = SceneSchema.safeParse(codeScene({ ...base, filename: 'f'.repeat(101) }));
  assert.equal(longLanguage.success, false);
  assert.equal(longFilename.success, false);
  assert.ok(issuePaths(longLanguage).includes('visual.language'));
  assert.ok(issuePaths(longFilename).includes('visual.filename'));
  assert.equal(SceneSchema.safeParse(codeScene({ ...base, language: '' })).success, false, 'language 出现时必须非空');
});

// ── #15-4 beats 数量与 lines 非空 ─────────────────────────────────────────────────
test('#15-4 beats 最多 10 个、beat.lines 不得为空且最多 200 项', () => {
  const code = codeOf(12);
  const tenBeats = Array.from({ length: 10 }, (_, index) => ({ lines: [index + 1], label: `区域${index + 1}` }));
  assert.equal(SceneSchema.safeParse(codeScene({ code, beats: tenBeats })).success, true);
  const elevenBeats = [...tenBeats, { lines: [11] }];
  assert.equal(SceneSchema.safeParse(codeScene({ code, beats: elevenBeats })).success, false);
  const emptyLines = SceneSchema.safeParse(codeScene({ code, beats: [{ lines: [] }] }));
  assert.equal(emptyLines.success, false);
  assert.ok(issuePaths(emptyLines).some(path => path.startsWith('visual.beats')), 'empty lines issue is under visual.beats');

  const longCode = codeOf(201);
  const tooManyLines = SceneSchema.safeParse(codeScene({ code: longCode, beats: [{ lines: Array.from({ length: 201 }, (_, index) => index + 1) }] }));
  assert.equal(tooManyLines.success, false, 'beat.lines 上限 200');
});

// ── #15-5 非法行号（0/负数/超出总行数）────────────────────────────────────────────
test('#15-5 beat.lines 的 0、负数、超出总行数被拒绝且信息指出行号/总行数', () => {
  const code = codeOf(5);
  for (const line of [0, -1, -99, 6, 999]) {
    const result = SceneSchema.safeParse(codeScene({ code, beats: [{ lines: [line] }] }));
    assert.equal(result.success, false, `line ${line} must be rejected`);
    assert.ok(issuePaths(result).some(path => path.startsWith('visual.beats.0.lines')), `line ${line} path`);
    if (line >= 1) assert.match(issueMessages(result), /行号|总行数|行数/, `line ${line} message should mention lines: ${issueMessages(result)}`);
  }
  assert.equal(SceneSchema.safeParse(codeScene({ code, beats: [{ lines: [1, 5] }] })).success, true, '1..总行数 内合法');
});

// ── #15-6 beat.lines 重复行号 ─────────────────────────────────────────────────────
test('#15-6 同一 beat 内重复行号被 schema 拒绝', () => {
  const code = codeOf(6);
  for (const lines of [[2, 2], [1, 3, 1], [6, 6, 6]]) {
    const result = SceneSchema.safeParse(codeScene({ code, beats: [{ lines }] }));
    assert.equal(result.success, false, `duplicated [${lines}] must be rejected`);
    assert.ok(issuePaths(result).some(path => path.startsWith('visual.beats.0.lines')));
    assert.match(issueMessages(result), /重复|去重|唯一/);
  }
  assert.equal(SceneSchema.safeParse(codeScene({ code, beats: [{ lines: [1, 2, 3] }] })).success, true);
});

// ── #15-7 label / narrationText / mode 枚举 ───────────────────────────────────────
test('#15-7 beat.label 最长 30、narrationText 边界、mode 四个枚举值', () => {
  const code = codeOf(4);
  const beat = (patch: Record<string, unknown>) => ({ lines: [1], ...patch });
  assert.equal(SceneSchema.safeParse(codeScene({ code, beats: [beat({ label: '标'.repeat(30) })] })).success, true);
  assert.equal(SceneSchema.safeParse(codeScene({ code, beats: [beat({ label: '标'.repeat(31) })] })).success, false);
  assert.equal(SceneSchema.safeParse(codeScene({ code, beats: [beat({ narrationText: '旁'.repeat(200) })] })).success, true);
  const longNarration = SceneSchema.safeParse(codeScene({ code, beats: [beat({ narrationText: '旁'.repeat(201) })] }));
  assert.equal(longNarration.success, false);
  assert.ok(issuePaths(longNarration).some(path => path.startsWith('visual.beats')));
  for (const mode of ['focus', 'build', 'diff', 'trace']) {
    assert.equal(SceneSchema.safeParse(codeScene({ code, mode })).success, true, `mode=${mode}`);
  }
  assert.equal(SceneSchema.safeParse(codeScene({ code, mode: 'explain' })).success, false, 'unknown mode rejected');
  assert.equal(SceneSchema.safeParse(codeScene({ code, mode: 42 })).success, false);
});

// ── #15-8 合法 code scene 字段保持 + 旧场景回归 ────────────────────────────────────
test('#15-8 合法 code scene 通过 parse 并保持字段；旧非 code 场景不受影响', () => {
  const visual = {
    code: codeOf(6),
    language: 'typescript',
    filename: 'cache.ts',
    mode: 'focus',
    beats: [
      { lines: [2, 3], label: '命中缓存', narrationText: '直接返回' },
      { lines: [5], label: '回源请求', narrationText: '请求数据' },
    ],
  };
  const parsed = SceneSchema.parse(codeScene(visual, { title: '缓存逻辑' }));
  assert.equal(parsed.type, 'code');
  assert.deepEqual(parsed.visual, visual, 'visual 字段原样保留');
  assert.equal((parsed.visual as typeof visual).beats?.[0].lines[0], 2);

  const storyboard = StoryboardSchema.parse({
    title: '代码讲解',
    styleId: 'minimal-tech',
    scenes: [codeScene(visual)],
  });
  assert.equal(storyboard.scenes[0].type, 'code');

  const legacyScenes: Record<string, Record<string, unknown>> = {
    text: { type: 'text', narration: '正文。', visual: { text: '核心内容' } },
    bullets: { type: 'bullets', narration: '要点。', visual: { items: ['一', '二'] } },
    chart: { type: 'chart', narration: '图表。', visual: { data: [{ label: '甲', value: 1 }] } },
    table: { type: 'table', narration: '表格。', visual: { headers: ['列'], rows: [['值']] } },
    math: { type: 'math', narration: '公式。', visual: { formula: 'E=mc^2' } },
    media: { type: 'media', narration: '图片。', visual: { src: 'projects/demo/assets/cover.png' } },
    timeline: { type: 'timeline', narration: '时间线。', visual: { items: [{ date: '2020', label: '开始' }, { date: '2024', label: '现在' }] } },
  };
  for (const [name, scene] of Object.entries(legacyScenes)) {
    assert.equal(SceneSchema.safeParse({ id: `legacy-${name}`, ...scene }).success, true, `${name} 旧场景仍通过`);
  }

  assert.ok(SceneTypeSchema.options.includes('code'));
  assert.equal(SceneTypeSchema.options.includes('html-code' as never), false, '不新增 html-code 场景类型');
  assert.deepEqual(
    [...SceneTypeSchema.options],
    ['title', 'text', 'bullets', 'diagram', 'comparison', 'chart', 'code', 'timeline', 'math', 'table', 'media', 'html'],
    'SceneTypeSchema 类型集合保持不变',
  );
});

// ── #15-9 codeLines / codeVisualOf 纯函数 ────────────────────────────────────────
test('#15-9 codeLines 处理换行/末尾换行，codeVisualOf 安全解析非法 visual', () => {
  assert.deepEqual(codeLines('a\nb\nc'), ['a', 'b', 'c']);
  assert.deepEqual(codeLines('a\r\nb\r\nc'), ['a', 'b', 'c'], 'CRLF 按行切分');
  assert.deepEqual(codeLines('a\nb\n'), ['a', 'b'], '末尾换行不额外产生空行');
  assert.deepEqual(codeLines('a'), ['a']);
  assert.deepEqual(codeLines('第一行\n  缩进行  '), ['第一行', '  缩进行  '], '缩进原样保留');

  const visual = { code: 'a\nb\nc', language: 'ts', filename: 'x.ts', mode: 'build', beats: [{ lines: [2], label: 'B' }] };
  const parsed = codeVisualOf(visual);
  assert.ok(parsed);
  assert.equal(parsed?.code, 'a\nb\nc');
  assert.equal(parsed?.language, 'ts');
  assert.equal(parsed?.filename, 'x.ts');
  assert.equal(parsed?.mode, 'build');
  assert.deepEqual(parsed?.beats, [{ lines: [2], label: 'B' }]);

  assert.equal(codeVisualOf(undefined), null);
  assert.equal(codeVisualOf({}), null, '缺 code');
  assert.equal(codeVisualOf({ code: '' }), null, '空 code');
  assert.equal(codeVisualOf({ code: 1 } as unknown as Record<string, unknown>), null, '非字符串 code');
  assert.equal(codeVisualOf({ code: 'a', beats: [{ lines: [0] }] }), null, '非法行号');
  assert.equal(codeVisualOf({ code: 'a\nb', beats: [{ lines: [2, 2] }] }), null, '重复行号');
  assert.equal(codeVisualOf({ code: 'a', language: 'x'.repeat(31) }), null, '超长 language');
  assert.deepEqual(codeVisualOf({ code: 'a', beats: [] })?.beats, [], 'beats 显式空数组是合法可选值');
  assert.equal(CodeVisualSchema.safeParse({ code: 'a' }).success, true, 'CodeVisualSchema 直接可用');
  assert.equal(CodeVisualSchema.safeParse({}).success, false);
});
