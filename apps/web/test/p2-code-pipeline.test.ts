/**
 * P2 code-scene regressions (pipeline side): #155 numeric evidence, #159 untrimmed traceability,
 * #160 nested fences, #161 literal excerpts, #163 valid code fallbacks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StoryboardSchema } from '@m2v/schema';
import { buildStoryboardSceneOrFallback, codeTraceableToSource, fallbackChapter, modelChapterExcerpt, normalizeMarkdown } from '../src/lib/pipeline';

test('[#159] invented leading indentation is not traceable', () => {
  const blocks = [{ code: 'def f():\n    return 1', language: 'python' }];
  assert.equal(codeTraceableToSource('def f():\n    return 1', blocks), true);
  assert.equal(codeTraceableToSource('    def f():\n    return 1', blocks), false);
});

test('[#161] long code excerpts stay literal slices of the source', () => {
  const code = Array.from({ length: 400 }, (_, index) => `const value${index} = ${index};`).join('\n');
  const excerpt = modelChapterExcerpt({ title: '长代码', text: '说明。', codeBlocks: [{ code, language: 'js' }] });
  const block = excerpt.codeBlocks![0];
  assert.ok(block.code.length <= 3000);
  assert.equal(block.truncated, true);
  assert.doesNotMatch(block.code, /代码已截断/);
  assert.ok(codeTraceableToSource(block.code, [{ code }]));
});

test('[#160] a three-backtick example inside a four-backtick block stays code', () => {
  const markdown = '````md\n# 示例\n```js\nconst a = 1;\n```\n\n\n- 不是列表\n````\n\n正文 **加粗**';
  const normalized = normalizeMarkdown(markdown);
  assert.match(normalized, /^- 不是列表$/m, '代码内的行保持原样');
  assert.match(normalized, /```js\nconst a = 1;\n```\n\n\n- 不是列表/, '代码内空行不被压缩');
  assert.match(normalized, /正文 加粗/, '代码块之后恢复正文处理');
});

test('[#163] an unrenderable code block falls back to a valid prose scene', () => {
  const huge = 'x'.repeat(9000);
  for (const codeBlocks of [[{ code: '   ' }], [{ code: huge }], [{ code: 'print(1)', language: 'l'.repeat(40) }]]) {
    const scene = fallbackChapter({ title: '示例', text: '这一章讲解打印函数。', codeBlocks });
    assert.doesNotThrow(() => StoryboardSchema.parse({ title: '示例', styleId: 'minimal-tech', scenes: [scene] }));
  }
  const kept = fallbackChapter({ title: '示例', text: '这一章讲解打印函数。', codeBlocks: [{ code: 'print(1)', language: 'l'.repeat(40) }] });
  assert.equal(kept.type, 'code', '语言标记过长时去掉标记，仍保留代码场景');
});

test('[#155] numbers that only appear in code blocks are accepted in narration', () => {
  const code = 'const maxRetries = 3;';
  const chapter = { title: '重试', text: '配置请求的重试次数。', codeBlocks: [{ code, language: 'js' }] };
  const built = buildStoryboardSceneOrFallback(chapter, { type: 'code', narration: '请求最多重试 3 次，超过之后直接报告失败。', visual: { code, language: 'js' } });
  assert.equal(built.fallbackUsed, false, built.validationError);
});

test('[#154] ISO dates in the source ground naturally written dates', () => {
  const chapter = { title: '发布', text: '发布日期是 2026-11-09，届时正式上线。' };
  const built = buildStoryboardSceneOrFallback(chapter, { type: 'text', narration: '发布日期是2026年11月9日，届时正式上线。', visual: { text: '发布日期是 2026-11-09，届时正式上线。' } });
  assert.equal(built.fallbackUsed, false, built.validationError);
});

test('[#153] factual prose ending in 等信息 stays in the narration source', () => {
  const chapter = { title: '日志', text: '日志记录请求方法、路径和状态码等信息。排查问题时先看状态码。' };
  const scene = fallbackChapter(chapter);
  assert.match(scene.narration, /状态码等信息/);
});
