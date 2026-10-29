import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildRegenerateScenePrompt, OllamaHttpError, OllamaStoryboardOutputError, parseOllamaStoryboardScenes, recoverAndCommitStoryboardBatch, recoverStoryboardBatch, requireOllamaResponseOk, resolveSceneSourceContext, logSceneSourceResolution, splitIntoChapters } from '../src/lib/pipeline';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

test('truncated and invalid-shape model output is classified for batch recovery', () => {
  assert.throws(() => parseOllamaStoryboardScenes('{"scenes":[{"narration":"截断"}'), error => error instanceof OllamaStoryboardOutputError && error.kind === 'malformed_json');
  assert.throws(() => parseOllamaStoryboardScenes('{"scenes":[{"narration":"截断"}', 'length'), error => error instanceof OllamaStoryboardOutputError && error.kind === 'truncated');
  assert.throws(() => parseOllamaStoryboardScenes('{"result":[]}'), error => error instanceof OllamaStoryboardOutputError && error.kind === 'invalid_shape');
  assert.deepEqual(parseOllamaStoryboardScenes('{"scenes":[{"narration":"ok"}]}'), [{ narration: 'ok' }]);
});

test('done_reason=length plus truncated JSON triggers chapter retries', async () => {
  const calls: string[][] = [];
  const result = await recoverStoryboardBatch({
    batch: ['one', 'two', 'three'],
    generate: async batch => {
      calls.push(batch);
      if (batch.length > 1) parseOllamaStoryboardScenes('{"scenes":[', 'length');
      return parseOllamaStoryboardScenes('{"scenes":[{"narration":"ok"}]}').map(() => `scene:${batch[0]}`);
    },
    fallback: value => `fallback:${value}`,
    preferLocalAI: false,
  });
  assert.deepEqual(calls, [['one', 'two', 'three'], ['one'], ['two'], ['three']]);
  assert.deepEqual(result.scenes, ['scene:one', 'scene:two', 'scene:three']);
});

test('valid batch response is kept without per-chapter retry', async () => {
  let calls = 0;
  const result = await recoverStoryboardBatch({
    batch: ['one', 'two', 'three'],
    generate: async batch => { calls += 1; return batch.map(value => `scene:${value}`); },
    fallback: value => `fallback:${value}`,
    preferLocalAI: false,
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { scenes: ['scene:one', 'scene:two', 'scene:three'], fallbackUsed: false });
});

test('malformed batch output retries each chapter and falls back only for a failed chapter', async () => {
  const calls: string[][] = [];
  const result = await recoverStoryboardBatch({
    batch: ['one', 'two', 'three'],
    generate: async batch => {
      calls.push(batch);
      if (batch.length > 1) throw new OllamaStoryboardOutputError('malformed_json', 'truncated');
      if (batch[0] === 'two') throw new OllamaStoryboardOutputError('malformed_json', 'still truncated');
      return [`scene:${batch[0]}`];
    },
    fallback: value => `fallback:${value}`,
    preferLocalAI: false,
  });
  assert.deepEqual(calls, [['one', 'two', 'three'], ['one'], ['two'], ['three']]);
  assert.deepEqual(result, { scenes: ['scene:one', 'fallback:two', 'scene:three'], fallbackUsed: true });
});

test('transport errors do not trigger per-chapter retry', async () => {
  let calls = 0;
  const result = await recoverStoryboardBatch({
    batch: ['one', 'two'],
    generate: async () => { calls += 1; throw new Error('connection failed'); },
    fallback: value => `fallback:${value}`,
    preferLocalAI: false,
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { scenes: ['fallback:one', 'fallback:two'], fallbackUsed: true });
});

test('HTTP 500 is a request error and obeys preferLocalAI without per-chapter retries', async () => {
  let calls = 0;
  const responseError = await requireOllamaResponseOk(new Response('server failure', { status: 500 })).catch(error => error);
  assert.ok(responseError instanceof OllamaHttpError);
  assert.equal(responseError.status, 500);
  const normalMode = await recoverStoryboardBatch({
    batch: ['one', 'two'],
    generate: async () => { calls += 1; throw responseError; },
    fallback: value => `fallback:${value}`,
    preferLocalAI: false,
  });
  assert.equal(calls, 1);
  assert.deepEqual(normalMode.scenes, ['fallback:one', 'fallback:two']);
  await assert.rejects(recoverStoryboardBatch({
    batch: ['one', 'two'],
    generate: async () => { calls += 1; throw responseError; },
    fallback: value => `fallback:${value}`,
    preferLocalAI: true,
  }), error => error instanceof OllamaHttpError && error.status === 500);
  assert.equal(calls, 2);
});

test('a single chapter with invalid shape falls back once or throws in required local-AI mode', async () => {
  let calls = 0;
  const input = {
    batch: ['one'],
    generate: async () => { calls += 1; return parseOllamaStoryboardScenes('{"result":[]}').map(() => 'unreachable'); },
    fallback: (chapter: string) => `fallback:${chapter}`,
    preferLocalAI: false,
  };
  const result = await recoverStoryboardBatch(input);
  assert.deepEqual(result, { scenes: ['fallback:one'], fallbackUsed: true });
  assert.equal(calls, 1, 'single-chapter errors are not retried indefinitely');
  await assert.rejects(recoverStoryboardBatch({ ...input, preferLocalAI: true }), error => error instanceof OllamaStoryboardOutputError && error.kind === 'invalid_shape');
  assert.equal(calls, 2);
});

test('required local AI preserves failure behavior on individual retries', async () => {
  await assert.rejects(recoverStoryboardBatch({
    batch: ['one', 'two'],
    generate: async batch => {
      if (batch.length > 1) throw new OllamaStoryboardOutputError('invalid_shape', 'no scenes');
      if (batch[0] === 'two') throw new Error('chapter two failed');
      return [`scene:${batch[0]}`];
    },
    fallback: value => `fallback:${value}`,
    preferLocalAI: true,
  }), /chapter two failed/);
});

test('checkpoint commit runs only after all chapters are recovered', async () => {
  let commits = 0;
  const base = {
    batch: ['one', 'two', 'three'],
    generate: async (batch: string[]) => {
      if (batch.length > 1) throw new OllamaStoryboardOutputError('malformed_json', 'truncated');
      if (batch[0] === 'two') throw new Error('chapter two failed');
      return [`scene:${batch[0]}`];
    },
    fallback: (chapter: string) => `fallback:${chapter}`,
    commit: async (completed: { scenes: string[]; fallbackUsed: boolean }) => {
      commits += 1;
      assert.deepEqual(completed.scenes, ['scene:one', 'fallback:two', 'scene:three']);
      assert.equal(completed.fallbackUsed, true);
    },
  };
  await recoverAndCommitStoryboardBatch({ ...base, preferLocalAI: false });
  assert.equal(commits, 1);
  await assert.rejects(recoverAndCommitStoryboardBatch({ ...base, preferLocalAI: true }), /chapter two failed/);
  assert.equal(commits, 1, 'failed recovery must not checkpoint an incomplete batch');
});

test('source reference resolves the original chapter after storyboard reordering', () => {
  const sourceText = '## 第一章\n开头内容 Alpha。\n\n## 第二章\n后半部分专属标记 Zeta。';
  const result = resolveSceneSourceContext({
    sourceText,
    projectTitle: '项目',
    scene: { title: '重排后的标题', narration: '无关的人工改写。', sourceRef: { chapterIndex: 1, contentHash: hash('后半部分专属标记 Zeta。') } },
    sceneIndex: 0,
    sceneCount: 2,
  });
  assert.equal(result.strategy, 'source_ref');
  assert.match(result.text, /后半部分专属标记 Zeta/);
  assert.doesNotMatch(result.text, /开头内容 Alpha/);
});

test('a 50-chapter source reference regenerates chapter 40 without chapter 1 context', () => {
  const sourceText = Array.from({ length: 50 }, (_, index) => `## Section ${index + 1}\nCHAPTER_${String(index + 1).padStart(2, '0')}_UNIQUE ${'该章节描述上下文和处理步骤。'.repeat(120)}`).join('\n\n');
  const chapters = splitIntoChapters('Long document', sourceText);
  assert.equal(chapters.length, 50);
  const selected = chapters[39];
  const result = resolveSceneSourceContext({
    sourceText,
    projectTitle: 'Long document',
    scene: { title: selected.title, narration: '请重生成当前场景。', sourceRef: { chapterIndex: 39, contentHash: hash(selected.text) } },
    sceneIndex: 0,
    sceneCount: 50,
  });
  assert.equal(result.strategy, 'source_ref');
  assert.match(result.text, /CHAPTER_40_UNIQUE/);
  assert.doesNotMatch(result.text, /CHAPTER_01_UNIQUE/);
  assert.ok([...result.text].length <= 1501);
});

test('initial and retry regeneration prompts reuse the identical chapter-40 context', () => {
  const sourceText = Array.from({ length: 50 }, (_, index) => `## Section ${index + 1}\nCHAPTER_${String(index + 1).padStart(2, '0')}_UNIQUE ${'本章资料事实。'.repeat(30)}`).join('\n\n');
  const chapters = splitIntoChapters('Long document', sourceText);
  const target = chapters[39];
  const scene = { id: 'scene-40', type: 'bullets' as const, title: target.title, narration: '第 40 章旁白。', visual: { items: ['内容'] }, sourceRef: { chapterIndex: 39, contentHash: hash(target.text) } };
  const sourceContext = resolveSceneSourceContext({ sourceText, projectTitle: 'Long document', scene, sceneIndex: 0, sceneCount: 50 });
  const common = { scene, sceneTypeRule: 'type=bullets', htmlRequirement: '', sourceContext };
  const initialPrompt = buildRegenerateScenePrompt(common);
  const retryPrompt = buildRegenerateScenePrompt({ ...common, retry: true });
  for (const prompt of [initialPrompt, retryPrompt]) {
    assert.match(prompt, /CHAPTER_40_UNIQUE/);
    assert.doesNotMatch(prompt, /CHAPTER_01_UNIQUE/);
  }
  assert.equal(initialPrompt.slice(initialPrompt.indexOf('对应章节参考资料')), retryPrompt.slice(retryPrompt.indexOf('对应章节参考资料')));
  assert.doesNotMatch(initialPrompt + retryPrompt, /sourceText\.slice\(0, 2500\)/);
});

test('changed source reference falls through to a unique title match', () => {
  const sourceText = '## 第一章\n开头。\n\n## 目标章节\n当前章节的最新内容。';
  const result = resolveSceneSourceContext({
    sourceText,
    projectTitle: '项目',
    scene: { title: '目标章节', narration: '旧旁白', sourceRef: { chapterIndex: 1, contentHash: hash('旧章节内容') } },
    sceneIndex: 0,
    sceneCount: 1,
  });
  assert.equal(result.strategy, 'title');
  assert.match(result.text, /当前章节的最新内容/);
});

test('PDF page context uses the selected page instead of source prefix', () => {
  const sourceText = '## 第 1 页\n第一页独有内容。\n\n## 第 12 页\n## 页内小节 A\n第十二页第一段。\n\n## 页内小节 B\n第十二页第二段。';
  const result = resolveSceneSourceContext({
    sourceText,
    projectTitle: '项目',
    scene: { title: '同名页', narration: '旁白', sourcePage: 12 },
    sceneIndex: 0,
    sceneCount: 1,
  });
  assert.equal(result.strategy, 'page');
  assert.match(result.text, /第十二页第一段/);
  assert.match(result.text, /第十二页第二段/);
  assert.doesNotMatch(result.text, /第一页独有内容/);
});

test('page markers create separately addressable chapters', () => {
  const chapters = splitIntoChapters('项目', '## 第 1 页\n第一页内容。\n\n## 第 12 页\n第十二页内容。');
  assert.deepEqual(chapters.map(chapter => chapter.page), [1, 12]);
  assert.deepEqual(chapters.map(chapter => chapter.text), ['第一页内容。', '第十二页内容。']);
});

test('PPT slide context resolves by slide number', () => {
  const sourceText = '## 幻灯片 1\n标题和正文：\n第一页标记\n\n## 幻灯片 12\n标题和正文：\n第十二页正文标记\n演讲者备注（优先作为旁白依据）：\n第十二页备注标记';
  const result = resolveSceneSourceContext({
    sourceText,
    projectTitle: '项目',
    sourcePath: 'data/projects/demo/source.pptx',
    scene: { title: '幻灯片 12', narration: '旧旁白', sourcePage: 12 },
    sceneIndex: 0,
    sceneCount: 2,
  });
  assert.equal(result.strategy, 'page');
  assert.match(result.text, /第十二页正文标记/);
  assert.match(result.text, /第十二页备注标记/);
  assert.doesNotMatch(result.text, /第一页标记/);
});

test('plain text with slide-like headings is not reinterpreted as an uploaded PPTX', () => {
  const sourceText = '## 幻灯片 1\n第一页原始内容\n\n## 幻灯片 12\n第十二页原始内容';
  const result = resolveSceneSourceContext({
    sourceText,
    projectTitle: '项目',
    sourcePath: null,
    scene: { title: '幻灯片 12', narration: '旧旁白' },
    sceneIndex: 0,
    sceneCount: 2,
  });
  assert.equal(result.strategy, 'title');
  assert.match(result.text, /第十二页原始内容/);
  assert.doesNotMatch(result.text, /第一页原始内容/);
});

test('duplicate titles are disambiguated by content anchors', () => {
  const sourceText = '## 概述\n甲方案采用蓝色密钥进行签名验证。\n\n## 概述\n乙方案使用量子校验码进行传输。';
  const result = resolveSceneSourceContext({
    sourceText,
    projectTitle: '项目',
    scene: { title: '概述', narration: '量子校验码用于安全传输。' },
    sceneIndex: 0,
    sceneCount: 2,
  });
  assert.equal(result.strategy, 'content_anchor');
  assert.match(result.text, /量子校验码/);
});

test('unresolved source falls back to a bounded excerpt away from the fixed beginning', () => {
  const sourceText = `第一段${'X'.repeat(2000)} 最后一段独有。`;
  const result = resolveSceneSourceContext({
    sourceText,
    projectTitle: '项目',
    scene: { title: '无法匹配', narration: '无对应锚点。' },
    sceneIndex: 1,
    sceneCount: 2,
    limit: 100,
  });
  assert.equal(result.strategy, 'excerpt_fallback');
  assert.ok([...result.text].length <= 102);
  assert.doesNotMatch(result.text, /^第一段/);
  const logs: string[] = [];
  logSceneSourceResolution('legacy-scene', result, message => logs.push(message));
  assert.match(logs[0], /source_strategy=excerpt_fallback/);
  assert.match(logs[0], /source_chars=\d+/);
});
