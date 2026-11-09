import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModelStoryboardScene,
  buildPreserveNarrationPrompt,
  buildPreserveNarrationRequestPayload,
  buildPreservedSlideScene,
  buildStoryboardSceneOrFallback,
  buildRegenerateScenePrompt,
  buildStoryboardPrompt,
  buildStoryboardRequestPayload,
  createOllamaTelemetrySummary,
  deriveOllamaMetricRates,
  groupChapters,
  logOllamaJobSummary,
  logOllamaMetricLine,
  markdownTableData,
  OllamaStoryboardOutputError,
  readOllamaChatResponse,
  recoverStoryboardBatch,
  reusableStoryboardCheckpointScenes,
  regenerateOutputSchema,
  storyboardNumPredict,
  storyboardOutputSchema,
  structuredSceneHtml,
  splitIntoChapters,
} from '../src/lib/pipeline';

test('storyboard model contract omits id, title and duration and local assembly fills them', () => {
  const chapter = { title: '标题由章节确定', text: '正文中的关键事实。' };
  const prompt = buildStoryboardPrompt('项目', [chapter]);
  assert.match(prompt, /每项只含 type,narration,visual/);
  assert.match(prompt, /不含 id\/title\/duration/);

  const parsed = buildModelStoryboardScene(chapter, {
    type: 'text', narration: '本章重点说明了关键事实。', visual: { text: '关键事实' },
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.title, chapter.title);
    assert.equal(parsed.data.duration, Math.max(12, [...parsed.data.narration].length / 5));
    assert.equal(parsed.data.type, 'text');
    assert.ok(parsed.data.id.length > 0);
  }
});

test('legacy extra system fields are ignored and invalid visual shape reaches local validation', () => {
  const chapter = { title: '本地标题', text: '正文。' };
  const legacy = buildModelStoryboardScene(chapter, {
    id: 'model-id', title: '模型标题', duration: 999, type: 'text', narration: '保留核心事实。', visual: { text: '核心事实' },
  });
  assert.equal(legacy.success, true);
  if (legacy.success) {
    assert.notEqual(legacy.data.id, 'model-id');
    assert.equal(legacy.data.title, '本地标题');
    assert.notEqual(legacy.data.duration, 999);
  }
  const invalid = buildModelStoryboardScene(chapter, { type: 'text', narration: '正文' });
  assert.equal(invalid.success, false, 'missing visual.text is rejected by the existing scene business schema');
  const fallback = buildStoryboardSceneOrFallback(chapter, { type: 'text', narration: '正文' });
  assert.equal(fallback.fallbackUsed, true);
  assert.match(fallback.validationError ?? '', /visual.text/);
  assert.equal(fallback.scene.type, 'bullets');
  const invalidType = buildStoryboardSceneOrFallback(chapter, { type: 'made-up-type', narration: '正文', visual: {} });
  assert.equal(invalidType.fallbackUsed, true, 'illegal scene types are rejected by local validation');
});

test('scene generation preserves common text, bullets, chart, timeline, math and table structures', () => {
  const fixtures = [
    { type: 'text', visual: { text: '正文' } },
    { type: 'bullets', visual: { items: ['要点一', '要点二'] } },
    { type: 'chart', visual: { data: [{ label: '甲', value: 1 }] } },
    { type: 'timeline', visual: { items: [{ date: '2024', label: '事件一' }, { date: '2025', label: '事件二' }] } },
    { type: 'math', visual: { formula: 'x = y' } },
    { type: 'table', visual: { headers: ['项目'], rows: [['值']] } },
  ];
  for (const fixture of fixtures) {
    const parsed = buildModelStoryboardScene({ title: fixture.type, text: '章节正文。' }, { ...fixture, narration: '说明章节中的核心内容。' });
    assert.equal(parsed.success, true, `${fixture.type} remains valid`);
  }
});

test('output token budget scales with scene count and contract size', () => {
  assert.deepEqual([1, 2, 3].map(count => storyboardNumPredict(count)), [1536, 2304, 3072]);
  assert.deepEqual([1, 2, 3].map(count => storyboardNumPredict(count, true)), [1024, 1536, 2048]);
});

test('storyboard requests apply the explicit local Ollama runtime profile', () => {
  const names = ['OLLAMA_KEEP_ALIVE', 'OLLAMA_NUM_CTX', 'OLLAMA_STREAM', 'LLM_MAX_CONCURRENCY'] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const payload = buildStoryboardRequestPayload('主题', [{ title: '一章', text: '这是用于检验本地模型请求配置的章节资料。' }]);
    assert.equal(payload.stream, true);
    assert.equal(payload.keep_alive, '30m');
    assert.equal(payload.options.num_ctx, 4096);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('PPT preserve requests only per-slide narration and prioritize speaker notes', () => {
  const chapters = [
    { title: '第 1 页：标题', text: '页面正文：页面正文内容。\n演讲者备注（优先作为旁白依据）：备注里的重点。', page: 1 },
    { title: '第 2 页：数据', text: '页面正文：第二页正文。', page: 2 },
  ];
  const payload = buildPreserveNarrationRequestPayload('演示主题', chapters, 'qwen3:4b-test');
  const prompt = buildPreserveNarrationPrompt('演示主题', chapters);
  const format = payload.format as { properties: { scenes: { items: { properties: Record<string, unknown>; additionalProperties?: boolean } } } };
  assert.deepEqual(format.properties.scenes.items.properties, { narration: { type: 'string' } });
  assert.match(prompt, /按输入顺序每页生成且仅生成一段旁白/);
  assert.match(prompt, /优先遵循演讲者备注/);
  assert.match(prompt, /不要输出 type、visual、id、title、duration/);
  assert.match(prompt, /备注里的重点/);
  assert.equal(payload.model, 'qwen3:4b-test');
  assert.equal(payload.options.num_predict, 1536);
});

test('PPT preserve locally assembles media scene and falls back only for invalid narration', () => {
  const chapter = { title: '幻灯片标题', text: '本页讲解输入、处理步骤和结果。', page: 3 };
  const generated = buildPreservedSlideScene(chapter, { narration: '旁白说明本页的核心内容。', visual: { text: '模型生成的视觉内容应被忽略。' }, type: 'text' }, 'projects/demo/assets/slide-3.png');
  assert.equal(generated.fallbackUsed, false);
  assert.equal(generated.scene.type, 'media');
  assert.equal(generated.scene.title, '幻灯片标题');
  assert.equal(generated.scene.narration, '旁白说明本页的核心内容。');
  assert.deepEqual(generated.scene.visual, { src: 'projects/demo/assets/slide-3.png', fullBleed: true });
  assert.equal(generated.scene.sourcePage, 3);
  assert.equal(generated.scene.duration, Math.max(12, [...generated.scene.narration].length / 5));

  for (const invalid of [undefined, null, {}, { narration: '   ' }, { narration: 42 }]) {
    const fallback = buildPreservedSlideScene(chapter, invalid, 'projects/demo/assets/slide-3.png');
    assert.equal(fallback.fallbackUsed, true);
    assert.equal(fallback.scene.type, 'media');
    assert.equal(fallback.scene.visual.src, 'projects/demo/assets/slide-3.png');
    assert.ok(fallback.scene.narration.length > 0);
  }
});

test('PPT preserve checkpoints reuse complete media pages and reject stale or old-shape scenes', () => {
  const chapters = [
    { title: '第 1 页', text: '第一页内容。', page: 1 },
    { title: '第 2 页', text: '第二页内容。', page: 2 },
  ];
  const cachedScenes = chapters.map((chapter, index) => buildPreservedSlideScene(chapter, { narration: `第 ${index + 1} 页旁白。` }, `projects/demo/assets/slide-${index + 1}.png`).scene);
  const cached = { key: 'preserve-key', completedChapters: 2, scenes: cachedScenes };
  const reused = reusableStoryboardCheckpointScenes(cached, 'preserve-key', [2, 4], 'html', true);
  assert.deepEqual(reused.map(scene => scene.visual.src), ['projects/demo/assets/slide-1.png', 'projects/demo/assets/slide-2.png']);
  assert.equal(reusableStoryboardCheckpointScenes(cached, 'changed-key', [2, 4], 'html', true).length, 0);
  assert.equal(reusableStoryboardCheckpointScenes({ ...cached, scenes: [cachedScenes[0], { ...cachedScenes[1], type: 'text', visual: { text: '旧的完整场景缓存' } }] }, 'preserve-key', [2, 4], 'html', true).length, 0);
  assert.equal(reusableStoryboardCheckpointScenes({ ...cached, completedChapters: 1 }, 'preserve-key', [2, 4], 'html', true).length, 0);
});

test('table chapters are grouped separately for the narration-only contract', () => {
  const chapters = [
    { title: '正文一', text: '这是一章有解释内容的正文。' },
    { title: '表格一', text: '| 名称 | 数值 |\n| --- | --- |\n| 甲 | 1 |' },
    { title: '表格二', text: '| 名称 | 数值 |\n| --- | --- |\n| 乙 | 2 |' },
    { title: '正文二', text: '这又是一章非表格正文。' },
  ];
  assert.deepEqual(groupChapters(chapters, 3, 1200), [[chapters[0]], [chapters[1], chapters[2]], [chapters[3]]]);
  const large = { title: '大表', text: `| 项目 | 数量 |\n| --- | --- |\n${Array.from({ length: 31 }, (_, index) => `| 项目${index + 1} | ${index + 100} |`).join('\n')}` };
  assert.deepEqual(groupChapters([large, { ...large, title: '大表二' }], 3, 1200).map(batch => batch.length), [1, 1], 'full table data contributes to the batch input budget');
  const payload = buildStoryboardRequestPayload('项目', [chapters[1], chapters[2]]);
  assert.equal(typeof payload.format, 'object');
  assert.deepEqual(payload.format.properties && (payload.format.properties as Record<string, { items: { properties: Record<string, unknown> } }>).scenes.items.properties, { narration: { type: 'string' } });
  assert.equal(payload.options.num_predict, 1536);
});

function markdownTable(headers: string[], rows: string[][], before = '', after = '') {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [before, line(headers), line(headers.map(() => '---')), ...rows.map(line), after].filter(Boolean).join('\n');
}

test('3x3, 10x5, 31x4, bilingual, decimal and surrounding-text tables are injected verbatim', () => {
  const fixtures = [
    { name: '3x3 small', headers: ['指标', '甲', '乙'], rows: [['延迟', '12', '15'], ['成功率', '98%', '96%'], ['成本', '1.2', '1.4']] },
    { name: '10x5 medium', headers: ['指标', 'Q1', 'Q2', 'Q3', 'Q4'], rows: Array.from({ length: 10 }, (_, row) => [`指标${row + 1}`, '10.5', '20%', '$3.25', '15.75']) },
    { name: '31x4 large', headers: ['Name 名称', 'Count 数量', 'Rate 比率', 'Cost 金额'], rows: Array.from({ length: 31 }, (_, row) => [`Item ${row + 1} 项目`, `${row + 1}.25`, `${row + 2}%`, `$${(row + 0.75).toFixed(2)}`]) },
    { name: 'mixed language', headers: ['Feature 功能', '支持 Support'], rows: [['缓存 cache', '是 yes'], ['并发 concurrency', '否 no'], ['Latency 延迟', '4.25 ms']] },
    { name: 'percent currency decimals', headers: ['方案', '提升', '价格'], rows: [['A', '12.5%', '$3.50'], ['B', '10.25%', '$2.75']] },
    { name: 'text before and after', headers: ['方式', '结果'], rows: [['本地注入', '数据准确'], ['模型复制', '可能改写']], before: '背景说明：比较两种处理方式。', after: '结论：数据保真优先。' },
  ];
  for (const fixture of fixtures) {
    const text = markdownTable(fixture.headers, fixture.rows, fixture.before, fixture.after);
    const chapter = { title: fixture.name, text };
    const localTable = markdownTableData(text);
    assert.deepEqual(localTable, { headers: fixture.headers, rows: fixture.rows }, `${fixture.name} parses correctly`);
    const prompt = buildStoryboardPrompt('项目', [chapter]);
    assert.match(prompt, /每个对象只包含 narration/);
    assert.match(prompt, /不得输出 type、visual、headers、rows/);
    const result = buildModelStoryboardScene(chapter, {
      narration: '表格对比了方案差异，A 的提升更高但价格也更高。',
      type: 'bullets',
      visual: { headers: ['伪造列'], rows: [['伪造数值']] },
    }, true);
    assert.equal(result.success, true, fixture.name);
    if (result.success) {
      assert.equal(result.data.type, 'table');
      assert.deepEqual(result.data.visual, localTable, `${fixture.name} uses exact local data`);
      assert.equal(result.data.title, fixture.name);
      assert.notDeepEqual(result.data.visual, { headers: ['伪造列'], rows: [['伪造数值']] });
    }
  }
  const markdownNarration = buildModelStoryboardScene(
    { title: 'Markdown 表格', text: markdownTable(['名称', '数值'], [['甲', '1']]) },
    { narration: '| 名称 | 数值 |\n| --- | --- |\n| 甲 | 1 |' }, true,
  );
  assert.equal(markdownNarration.success, true);
  if (markdownNarration.success) {
    assert.doesNotMatch(markdownNarration.data.narration, /\|/);
    assert.match(markdownNarration.data.narration, /甲.*数值.*1/);
  }
  const grounded = buildModelStoryboardScene(
    { title: '数值校验', text: markdownTable(['指标', '方案甲', '方案乙'], [['耗时', '12.5 ms', '15.0 ms'], ['准确率', '98%', '96%'], ['成本', '$1.25', '$1.50']]) },
    { narration: '表格有 3 项指标，甲方案耗时 12.5 ms，乙方案耗时 15.0 ms。' }, true,
  );
  assert.equal(grounded.success, true);
  if (grounded.success) assert.match(grounded.data.narration, /12\.5 ms/);

  const invented = buildModelStoryboardScene(
    { title: '数值校验', text: markdownTable(['指标', '方案甲', '方案乙'], [['耗时', '12.5 ms', '15.0 ms'], ['准确率', '98%', '96%'], ['成本', '$1.25', '$1.50']]) },
    { narration: '方案甲把耗时降低到 16.7 ms，成本下降 10 元。' }, true,
  );
  assert.equal(invented.success, true);
  if (invented.success) {
    assert.doesNotMatch(invented.data.narration, /16\.7|10 元/);
    assert.match(invented.data.narration, /耗时.*方案甲.*12\.5 ms.*方案乙.*15\.0 ms/);
  }
});

test('strict model schemas cover single/batch, narration-only, fixed-type regenerate, and HTML regenerate', () => {
  const single = storyboardOutputSchema(1);
  const batch = storyboardOutputSchema(3);
  const table = storyboardOutputSchema(1, true);
  const scenes = (schema: Record<string, unknown>) => (schema.properties as Record<string, { minItems: number; maxItems: number; items: { oneOf?: Record<string, unknown>[]; properties?: Record<string, unknown>; additionalProperties: boolean } }>).scenes;
  assert.equal(scenes(single).minItems, 1);
  assert.equal(scenes(single).maxItems, 1);
  assert.equal(scenes(batch).minItems, 3);
  assert.equal(scenes(batch).maxItems, 3);
  assert.equal(scenes(batch).items.oneOf?.length, 10);
  assert.ok(scenes(batch).items.oneOf?.every(schema => schema.additionalProperties === false));
  assert.equal(scenes(batch).items.oneOf?.[0].properties && Object.keys(scenes(batch).items.oneOf![0].properties!).sort().join(','), 'narration,type,visual');
  assert.equal(scenes(table).items.properties && Object.keys(scenes(table).items.properties!).join(','), 'narration');
  assert.equal(scenes(table).items.additionalProperties, false);

  const fixed = regenerateOutputSchema({ htmlMode: false, sceneType: 'bullets' });
  assert.deepEqual(Object.keys(fixed.properties as Record<string, unknown>).sort(), ['narration', 'visual']);
  const html = regenerateOutputSchema({ htmlMode: true, sceneType: 'html' });
  assert.equal((html.oneOf as unknown[]).length, 10);
  const request = buildStoryboardRequestPayload('项目', [{ title: '章', text: '内容。' }]);
  assert.equal(typeof request.format, 'object', 'the production request sends a JSON Schema format object, not the string json');
  assert.equal((request.format as Record<string, unknown>).type, 'object');
});

test('production directions are rejected while diagrams and narrated comparisons render from actual data', () => {
  const chapter = { title: '两种发电方式', text: '水力发电由水流推动涡轮。风力发电由气流推动叶片。' };
  const direction = '左侧展示水力发电原理图。右侧展示风力发电原理图。中间以箭头连接。背景使用蓝色。';
  const narration = '水流推动涡轮，气流推动叶片，两种方式都将流体的运动用于发电。';
  const rejected = buildStoryboardSceneOrFallback(chapter, { type: 'text', visual: { text: direction }, narration }, false, 'html');
  assert.equal(rejected.fallbackUsed, true);
  assert.equal(rejected.scene.narration, narration);
  assert.doesNotMatch(String(rejected.scene.visual.html), /左侧展示|背景使用/);
  const rejectedNarration = buildStoryboardSceneOrFallback(chapter, { type: 'text', visual: { text: '风力与水力' }, narration: '本节我们将介绍两种发电方式。' });
  assert.equal(rejectedNarration.fallbackUsed, true);
  assert.match(rejectedNarration.scene.narration, /水流推动涡轮/);

  const comparison = buildStoryboardSceneOrFallback(chapter, { type: 'comparison', narration, visual: {
    layout: 'diagram',
    columns: [{ title: '水力发电', items: ['水流', '涡轮'] }, { title: '风力发电', items: ['气流', '叶片'] }],
  } });
  assert.equal(comparison.fallbackUsed, false);
  assert.match(structuredSceneHtml(comparison.scene, 0), /水流.*涡轮.*↔.*气流.*叶片/);
  const diagram = buildStoryboardSceneOrFallback(chapter, { type: 'diagram', narration, visual: { nodes: [{ id: 'a', label: '水流' }, { id: 'b', label: '涡轮' }] } });
  assert.equal(diagram.fallbackUsed, false);
  assert.match(structuredSceneHtml(diagram.scene, 0), /水流.*→.*涡轮/);
});

test('regenerate asks only for model-owned fields and preserves the same source context', () => {
  const scene = { id: 'scene-1', type: 'bullets' as const, title: '旧标题', narration: '旧旁白', duration: 99, visual: { items: ['旧要点'] } };
  const sourceContext = { text: '当前章节事实。', strategy: 'title' as const };
  const prompt = buildRegenerateScenePrompt({ scene, sceneTypeRule: '类型固定为 bullets', htmlRequirement: '', sourceContext });
  const retry = buildRegenerateScenePrompt({ scene, sceneTypeRule: '类型固定为 bullets', htmlRequirement: '', sourceContext, retry: true });
  assert.match(prompt, /只包含 narration,visual/);
  assert.match(prompt, /不要输出 id、title、duration/);
  assert.doesNotMatch(retry.slice(0, retry.indexOf('旧场景')), /必须包含 id,type,title,narration,duration,visual/);
  assert.equal(prompt.slice(prompt.indexOf('对应章节参考资料')), retry.slice(retry.indexOf('对应章节参考资料')));

  const tableScene = { id: 'table-scene', type: 'table' as const, title: '数据表', narration: '旧旁白', visual: { headers: ['保密表头'], rows: [['999999']] } };
  const tablePrompt = buildRegenerateScenePrompt({ scene: tableScene, sceneTypeRule: '类型固定为 table', htmlRequirement: '', sourceContext });
  assert.match(tablePrompt, /只包含 narration/);
  assert.match(tablePrompt, /表格 visual 由系统从原表格准确保留/);
  assert.doesNotMatch(tablePrompt, /保密表头|999999/);
  assert.deepEqual(Object.keys(regenerateOutputSchema({ htmlMode: false, sceneType: 'table' }).properties as Record<string, unknown>), ['narration']);
});

function responseStream(chunks: Record<string, unknown>[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
      controller.close();
    },
  }));
}

test('stream reader collects final-chunk metrics and supports older responses without them', async () => {
  const result = await readOllamaChatResponse(responseStream([
    { message: { content: '{"scenes":[' }, done: false },
    { message: { content: '{"narration":"secret document text"}]} ' }, done: true, done_reason: 'stop', total_duration: 2_000_000_000, load_duration: 100_000_000, prompt_eval_count: 50, prompt_eval_cached_count: 20, prompt_eval_duration: 30_000_000, eval_count: 10, eval_duration: 500_000_000 },
  ]), Date.now() - 40);
  assert.match(result.message?.content ?? '', /secret document text/);
  assert.equal(result.done_reason, 'stop');
  assert.deepEqual(result.metrics, { total_duration: 2_000_000_000, load_duration: 100_000_000, prompt_eval_count: 50, prompt_eval_cached_count: 20, prompt_eval_duration: 30_000_000, eval_count: 10, eval_duration: 500_000_000 });
  assert.ok((result.first_token_ms ?? 0) >= 40, 'first token timing starts at request start and includes response wait');
  assert.ok(result.wall_ms >= 40);

  const older = await readOllamaChatResponse(responseStream([{ message: { content: 'ok' }, done: true }]))
  assert.deepEqual(older.metrics, {});
  assert.equal(older.message?.content, 'ok');
  assert.ok(older.first_token_ms !== undefined);

  const nonStreaming = await readOllamaChatResponse(new Response(JSON.stringify({ message: { content: '{"scenes":[]}' }, done: true, done_reason: 'stop', total_duration: 12_000_000, prompt_eval_count: 4, eval_count: 3, eval_duration: 5_000_000 })));
  assert.equal(nonStreaming.message?.content, '{"scenes":[]}');
  assert.equal(nonStreaming.done_reason, 'stop');
  assert.deepEqual(nonStreaming.metrics, { total_duration: 12_000_000, prompt_eval_count: 4, eval_count: 3, eval_duration: 5_000_000 });
});

test('metrics convert ns to ms and tok/s, and zero durations never produce non-finite rates', () => {
  assert.deepEqual(deriveOllamaMetricRates({ load_duration: 1_500_000, prompt_eval_count: 50, prompt_eval_cached_count: 10, prompt_eval_duration: 2_000_000_000, eval_count: 20, eval_duration: 1_000_000_000 }), {
    load_ms: 1.5, prompt_tokens_per_second: 20, decode_tokens_per_second: 20,
  });
  const zero = deriveOllamaMetricRates({ prompt_eval_count: 10, prompt_eval_duration: 0, eval_count: 5, eval_duration: 0 });
  assert.deepEqual(zero, {});
  assert.ok(Object.values(zero).every(value => Number.isFinite(value)));
});

test('telemetry logs contain request sizes and metrics but never user prompt or response text', () => {
  const lines: string[] = [];
  logOllamaMetricLine({ kind: 'regenerate', model: 'qwen3:4b', metrics: { total_duration: 45_000_000, prompt_eval_count: 12, eval_count: 3, prompt_eval_duration: 10_000_000, eval_duration: 20_000_000 }, firstTokenMs: 7, doneReason: 'stop', wallMs: 50, sceneId: 'scene-id', promptChars: 200, sourceStrategy: 'source_ref', log: line => lines.push(line) });
  assert.match(lines[0], /prompt=12 tokens/);
  assert.match(lines[0], /decode_tok_s=150.0/);
  assert.match(lines[0], /source_strategy=source_ref prompt_chars=200/);
  assert.match(lines[0], /first_token_ms=7 .*ollama_total_ms=45.0 reason=stop wall_ms=50/);
  assert.doesNotMatch(lines.join('\n'), /secret document text|full narration body/);
});

test('job telemetry aggregates counts and emits per-chapter retry reason without exposing content', async () => {
  const summary = createOllamaTelemetrySummary();
  summary.fallbackScenes = 1;
  let retry: { reason: string; chapterCount: number } | undefined;
  const recovered = await recoverStoryboardBatch({
    batch: ['一', '二'],
    generate: async batch => {
      if (batch.length > 1) throw new OllamaStoryboardOutputError('truncated', 'secret response');
      return [`scene-${batch[0]}`];
    },
    fallback: chapter => `fallback-${chapter}`,
    preferLocalAI: false,
    onRetry: event => { summary.retries += 1; retry = event; },
  });
  assert.deepEqual(recovered.scenes, ['scene-一', 'scene-二']);
  assert.deepEqual(retry, { reason: 'truncated', chapterCount: 2 });
  summary.requests = 3;
  summary.promptTokens = 90;
  summary.cachedPromptTokens = 10;
  summary.decodeTokens = 30;
  summary.promptDurationNs = 2_000_000_000;
  summary.decodeDurationNs = 1_000_000_000;
  summary.ollamaDurationNs = 3_000_000_000;
  summary.modelLoadCount = 1;
  summary.firstTokenTotalMs = 120;
  summary.firstTokenSamples = 3;
  const logs: string[] = [];
  logOllamaJobSummary(summary, line => logs.push(line));
  assert.match(logs[0], /requests=3 retries=1 prompt_tokens_total=90 prompt_cached_tokens_total=10 decode_tokens_total=30/);
  assert.match(logs[0], /average_decode_tok_s=30.0 .*model_load_count=1 fallback_scenes=1/);
  assert.match(logs[0], /ollama_seconds_total=3.000/);
  assert.match(logs[0], /average_first_token_ms=40.0/);
  assert.doesNotMatch(logs[0], /secret response/);
});

test('20 chapter long-form source generates seven bounded batches and keeps order', () => {
  const source = Array.from({ length: 20 }, (_, index) => `## 章节${index + 1}\nCHAPTER_${index + 1} ${'这里提供用于性能测量和章节定位的确定性中文资料。'.repeat(10)}`).join('\n\n');
  const chapters = splitIntoChapters('性能样本', source);
  const batches = groupChapters(chapters, 3, 1200);
  assert.equal(chapters.length, 20);
  assert.equal(batches.length, 7);
  assert.deepEqual(batches.flat().map(chapter => chapter.title), chapters.map(chapter => chapter.title));
});
