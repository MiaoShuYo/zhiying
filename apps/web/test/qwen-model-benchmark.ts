import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { SceneSchema, type Scene } from '@m2v/schema';
import {
  buildPreserveNarrationRequestPayload,
  buildPreservedSlideScene,
  buildRegenerateScenePrompt,
  buildStoryboardRequestPayload,
  buildStoryboardSceneOrFallback,
  groupChapters,
  parseOllamaStoryboardScenes,
  readOllamaChatResponse,
  regenerateOutputSchema,
  type Chapter,
  type OllamaMetrics,
} from '../src/lib/pipeline';

const exec = promisify(execFile);
const allModels = ['qwen3:4b', 'qwen3:4b-instruct-2507-q4_K_M'];
const models = process.env.QWEN_BENCHMARK_MODELS?.split(',').map(value => value.trim()).filter(Boolean) ?? allModels;
const baseUrl = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
const smoke = process.env.QWEN_BENCHMARK_SMOKE === '1';
const runCount = Number(process.env.QWEN_BENCHMARK_WARM_RUNS ?? (smoke ? 0 : 3));
const rawPath = resolve(process.cwd(), 'docs/benchmarks/qwen3-4b-cpu-raw.jsonl');
const timestamp = new Date().toISOString();
let requestSequence = 0;

type CallRow = {
  workload: string; model: string; phase: 'cold' | 'warm'; trial: number; batch: number;
  wall_ms: number; first_token_ms?: number; done_reason?: string; metrics: OllamaMetrics;
  error?: string; output?: string;
};
type RunRow = {
  workload: string; model: string; phase: 'cold' | 'warm'; trial: number; wall_ms: number;
  requests: number; retries: number; fallbacks: number; invalid_scenes: number; truncated: number;
  calls: CallRow[]; samples: Array<Record<string, unknown>>;
};

const content = [
  ['电池储能', '本项目配置了 80 千瓦时电池，测试路段长度为 400 公里。车辆平均每百公里消耗 20 千瓦时；按该平均值计算，电量与路程应保持一致。'],
  ['太阳能发电', '屋顶光伏装机容量为 12 兆瓦，去年发电量为 20 吉瓦时。夏季发电高于冬季，项目计划优先把中午的富余电量用于储能。'],
  ['城市供水', '城市供水依次经过取水、沉淀过滤和消毒三个环节。过滤去除悬浮颗粒，消毒控制微生物风险，出厂水还需按标准抽样检测。'],
  ['项目时间线', '项目在 3 月完成需求调研，6 月完成原型，9 月启动试点，12 月复盘数据。试点先覆盖两个街区，再根据反馈决定推广范围。'],
  ['两种缓存策略', '内存缓存适合访问频繁且可快速重建的数据，持久化缓存适合重启后仍需保留的结果。两者的更新策略和失效成本不同。'],
  ['季度营收', '第一季度营收为 120 万元，第二季度为 150 万元，第三季度为 135 万元。第二季度增长与新渠道上线同期发生，不能据此单独认定因果。'],
  ['分拣流程', '包裹先读取条码，再按目的地分流；条码无法识别时进入人工复核队列。复核完成后重新扫描，避免异常件阻塞正常传送带。'],
  ['网络延迟', '办公网实测中位延迟为 18 毫秒，P95 为 42 毫秒，丢包率为 0.2%。数据来自连续 30 分钟采样，不能代表所有时段。'],
  ['雨水利用', '雨水利用系统先收集屋面径流，再通过弃流装置排除初期雨水，之后过滤并储存在地下水箱。储水用于绿化，不接入饮用水管网。'],
  ['两种运输方式', '铁路适合大批量、长距离运输，公路更便于门到门配送。选择方案时需同时比较时效、装卸次数和线路覆盖，不应只看单价。'],
  ['实验对照', '实验组采用每周两次提醒，对照组保持原有流程。四周后比较两组完成率，并同时记录退出人数；该设计用于观察关联，不能替代随机试验。'],
  ['访问控制', '系统按最小权限原则分配角色。管理员可以管理成员，编辑者只能修改内容，查看者不能写入。权限变更需留下操作者和时间记录。'],
  ['风机效率', '样机甲额定功率为 2 千瓦，样机乙为 2.4 千瓦；在相同风速区间测试时，乙的输出较高。测试尚未覆盖高温和长期运行条件。'],
  ['数据处理', '数据管道分为采集、校验、转换和入库四步。校验失败的记录单独保存错误原因，不直接丢弃，以便追踪来源并修订上游数据。'],
  ['温度趋势', '冷库目标温度为零下 18 摄氏度，传感器每 5 分钟采样一次。连续两次高于零下 15 摄氏度时触发告警，单次噪声不会立即报警。'],
  ['代码部署', '部署流程先运行单元测试，再构建镜像并推送到测试环境。健康检查通过后才切换流量；若检查失败，系统恢复到上一个稳定版本。'],
  ['图书借阅', '借阅数据按月汇总，1 月为 840 册，2 月为 790 册，3 月为 910 册。三个月内 3 月最高，但样本不足以说明全年趋势。'],
  ['分类回收', '纸张、金属和厨余分别进入不同回收链路。投放前清空容器残液可以减少污染；混入电池等危险废物时应按专项流程处理。'],
  ['供电备份', '机房使用两路市电和一组 UPS。市电中断时 UPS 先支撑负载，发电机随后启动；每季度进行一次切换演练并记录持续时间。'],
  ['客户支持', '工单按影响范围和紧急程度分级。大面积服务中断优先处理，普通咨询按提交顺序响应；解决后记录原因和预防措施，减少重复故障。'],
] as const;
const chapters: Chapter[] = content.map(([title, text], index) => ({ title, text, page: index + 1 }));
const activeChapters = smoke ? chapters.slice(0, 1) : chapters;
const regenTypes: Scene['type'][] = ['text', 'bullets', 'chart', 'table'];

function fixtureScene(type: Scene['type'], chapter: Chapter, index: number): Scene {
  const common = { id: `benchmark-${index}`, title: chapter.title, narration: chapter.text, duration: 15, sourcePage: chapter.page };
  if (type === 'bullets') return { ...common, type, visual: { items: ['核心事实', '限制条件'] } } as Scene;
  if (type === 'chart') return { ...common, type, visual: { data: [{ label: '一季度', value: 120 }, { label: '二季度', value: 150 }] } } as Scene;
  if (type === 'table') return { ...common, type, visual: { headers: ['季度', '营收'], rows: [['一季度', '120 万元'], ['二季度', '150 万元']] } } as Scene;
  return { ...common, type: 'text', visual: { text: chapter.text } } as Scene;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function valuesFromRuns(rows: RunRow[], workload: string, model: string, phase: 'cold' | 'warm') {
  return rows.filter(row => row.workload === workload && row.model === model && row.phase === phase);
}

async function unload(model: string): Promise<void> {
  try { await exec('ollama', ['stop', model], { windowsHide: true, timeout: 20_000 }); } catch { /* Not loaded yet. */ }
}

async function ollama(payload: Record<string, unknown>, info: Omit<CallRow, 'wall_ms' | 'metrics' | 'output'>, calls: CallRow[]): Promise<string> {
  const started = Date.now();
  requestSequence += 1;
  const messages = Array.isArray(payload.messages) ? payload.messages as Array<Record<string, unknown>> : [];
  const firstMessage = messages[0];
  const markedPayload = firstMessage && typeof firstMessage.content === 'string'
    ? { ...payload, messages: [{ ...firstMessage, content: `bench-${requestSequence}-${randomUUID()}\n${firstMessage.content}` }, ...messages.slice(1)] }
    : payload;
  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(markedPayload),
      signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 250)}`);
    const result = await readOllamaChatResponse(response, started);
    const row: CallRow = { ...info, wall_ms: result.wall_ms, first_token_ms: result.first_token_ms, done_reason: result.done_reason, metrics: result.metrics, output: result.message?.content ?? '' };
    calls.push(row);
    return row.output ?? '';
  } catch (error) {
    calls.push({ ...info, wall_ms: Date.now() - started, metrics: {}, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function summarizeCalls(calls: CallRow[]) {
  const metric = (key: keyof OllamaMetrics) => calls.reduce((sum, call) => sum + Number(call.metrics[key] ?? 0), 0);
  return {
    prompt_eval_count: metric('prompt_eval_count'), prompt_eval_cached_count: metric('prompt_eval_cached_count'),
    prompt_eval_duration_ns: metric('prompt_eval_duration'), eval_count: metric('eval_count'),
    eval_duration_ns: metric('eval_duration'), load_duration_ns: metric('load_duration'),
    decode_tok_s: metric('eval_duration') ? metric('eval_count') / (metric('eval_duration') / 1e9) : 0,
  };
}

function sceneBusinessValid(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const scene = raw as Record<string, unknown>;
  if (typeof scene.narration !== 'string' || !scene.narration.trim()) return false;
  if (!scene.visual || typeof scene.visual !== 'object' || Array.isArray(scene.visual)) return false;
  const visual = scene.visual as Record<string, unknown>;
  if (scene.type === 'comparison') return Array.isArray(visual.columns) && visual.columns.length === 2 && visual.columns.every(column => column && typeof column === 'object' && Array.isArray((column as Record<string, unknown>).items) && ((column as Record<string, unknown>).items as unknown[]).filter(Boolean).length >= 2);
  if (scene.type === 'chart') return (Array.isArray(visual.data) && visual.data.length > 0) || (Array.isArray(visual.nodes) && visual.nodes.length >= 2);
  if (scene.type === 'timeline') return Array.isArray(visual.items) && visual.items.length >= 2;
  if (scene.type === 'bullets') return Array.isArray(visual.items) && visual.items.length > 0;
  if (scene.type === 'text') return typeof visual.text === 'string' && Boolean(visual.text.trim());
  if (scene.type === 'table') return Array.isArray(visual.headers) && Array.isArray(visual.rows) && visual.headers.length > 0 && visual.rows.length > 0;
  return true;
}

async function runStoryboard(model: string, mode: 'standard' | 'html', phase: 'cold' | 'warm', trial: number): Promise<RunRow> {
  const name = mode === 'standard' ? 'storyboard-standard' : 'storyboard-html';
  const started = Date.now();
  const calls: CallRow[] = [];
  const samples: Array<Record<string, unknown>> = [];
  let retries = 0, fallbacks = 0, invalid = 0, truncated = 0;
  const batches = groupChapters(activeChapters);
  const retrySingle = async (chapter: Chapter, index: number) => {
    const title = `知影 CPU 模型基准 ${mode} ${phase}-${trial}-${index}`;
    const payload = buildStoryboardRequestPayload(title, [chapter], mode, model);
    try {
      const raw = await ollama(payload as unknown as Record<string, unknown>, { workload: name, model, phase, trial, batch: index }, calls);
      const scenes = parseOllamaStoryboardScenes(raw, calls.at(-1)?.done_reason);
      return scenes[0];
    } catch { return undefined; }
  };
  let batchIndex = 0;
  for (const batch of batches) {
    batchIndex += 1;
    const title = `知影 CPU 模型基准 ${mode} ${phase}-${trial}-${batchIndex}`;
    const payload = buildStoryboardRequestPayload(title, batch, mode, model);
    let parsed: unknown[] = [];
    try {
      const raw = await ollama(payload as unknown as Record<string, unknown>, { workload: name, model, phase, trial, batch: batchIndex }, calls);
      parsed = parseOllamaStoryboardScenes(raw, calls.at(-1)?.done_reason);
      if (calls.at(-1)?.done_reason === 'length') truncated += 1;
    } catch {
      retries += 1;
      parsed = await Promise.all(batch.map((chapter, local) => retrySingle(chapter, (batchIndex - 1) * 3 + local + 1)));
    }
    for (let local = 0; local < batch.length; local += 1) {
      const chapter = batch[local];
      const raw = parsed[local];
      if (raw === undefined) { fallbacks += 1; samples.push({ chapter: chapter.title, valid: false, fallback: true, reason: 'missing_scene' }); continue; }
      const built = buildStoryboardSceneOrFallback(chapter, raw, false, mode);
      let valid = !built.fallbackUsed && sceneBusinessValid(raw);
      if (valid) {
        const finalScene = SceneSchema.safeParse(built.scene);
        valid = finalScene.success;
      }
      if (!valid) { fallbacks += 1; invalid += 1; }
      const rawRecord = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      samples.push({ chapter: chapter.title, valid, fallback: !valid, type: rawRecord.type, narration: rawRecord.narration, visual: rawRecord.visual, source: chapter.text });
    }
  }
  const run: RunRow = { workload: name, model, phase, trial, wall_ms: Date.now() - started, requests: calls.length, retries, fallbacks, invalid_scenes: invalid, truncated, calls, samples };
  await appendFile(rawPath, `${JSON.stringify({ timestamp, ...run, totals: summarizeCalls(calls) })}\n`, 'utf8');
  console.log(JSON.stringify({ event: 'run-complete', workload: name, model, phase, trial, wall_ms: run.wall_ms, requests: run.requests, retries, fallbacks, invalid_scenes: invalid, truncated, ...summarizeCalls(calls) }));
  return run;
}

async function runRegenerate(model: string, phase: 'cold' | 'warm', trial: number): Promise<RunRow> {
  const workload = 'regenerate';
  const started = Date.now();
  const calls: CallRow[] = [];
  const samples: Array<Record<string, unknown>> = [];
  let retries = 0, fallbacks = 0, invalid = 0, truncated = 0;
  for (let index = 0; index < activeChapters.length; index += 1) {
    const chapter = activeChapters[index];
    const type = regenTypes[index % regenTypes.length];
    const old = fixtureScene(type, chapter, index);
    const htmlMode = index % 4 === 0;
    const sourceContext = { text: chapter.text, strategy: 'storyboard_order' as const };
    const sceneTypeRule = htmlMode ? 'type 必须从 title,text,bullets,comparison,chart,code,timeline,math,table 中按内容选择；comparison 必须是真实、同维度对照。' : `场景类型固定为 ${old.type}，不要输出 type 字段`;
    const htmlRequirement = htmlMode ? 'visual 必须保留完整结构化数据，不要生成 visual.html。' : '';
    let candidate: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2 && !candidate; attempt += 1) {
      if (attempt) retries += 1;
      const prompt = buildRegenerateScenePrompt({ scene: { ...old, title: `${old.title} ${phase}-${trial}-${index}` }, sceneTypeRule, htmlRequirement, sourceContext, retry: attempt > 0 });
      const payload = {
        model, stream: true, keep_alive: '30m', think: false,
        format: regenerateOutputSchema({ htmlMode, sceneType: old.type }),
        options: { num_ctx: 4096, num_predict: attempt === 0 ? 1536 : 2048 },
        messages: [{ role: 'user', content: prompt }],
      };
      try {
        const output = await ollama(payload, { workload, model, phase, trial, batch: index + 1 }, calls);
        if (calls.at(-1)?.done_reason === 'length') truncated += 1;
        const parsed: unknown = JSON.parse(output);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not_object');
        const value = parsed as Record<string, unknown>;
        if (typeof value.narration !== 'string' || !value.narration.trim()) throw new Error('missing_narration');
        if (!['table', 'media'].includes(old.type) && (!value.visual || typeof value.visual !== 'object')) throw new Error('missing_visual');
        candidate = value;
      } catch { /* Production retries malformed JSON once and then keeps the old scene. */ }
    }
    if (!candidate) { fallbacks += 1; invalid += 1; samples.push({ index, type, htmlMode, valid: false, fallback: true, source: chapter.text }); continue; }
    const finalType = htmlMode && typeof candidate.type === 'string' ? candidate.type : old.type;
    const visual = ['table', 'media'].includes(old.type) && !htmlMode ? old.visual : candidate.visual ?? old.visual;
    const finalScene = { ...old, ...candidate, type: finalType, visual, title: old.title, duration: Math.max(12, [...String(candidate.narration)].length / 5) } as Scene;
    const schemaValid = SceneSchema.safeParse(finalScene).success;
    if (!schemaValid) { fallbacks += 1; invalid += 1; }
    samples.push({ index, type: finalType, htmlMode, valid: schemaValid, fallback: !schemaValid, narration: candidate.narration, visual: candidate.visual, source: chapter.text });
  }
  const run: RunRow = { workload, model, phase, trial, wall_ms: Date.now() - started, requests: calls.length, retries, fallbacks, invalid_scenes: invalid, truncated, calls, samples };
  await appendFile(rawPath, `${JSON.stringify({ timestamp, ...run, totals: summarizeCalls(calls) })}\n`, 'utf8');
  console.log(JSON.stringify({ event: 'run-complete', workload, model, phase, trial, wall_ms: run.wall_ms, requests: run.requests, retries, fallbacks, invalid_scenes: invalid, truncated, ...summarizeCalls(calls) }));
  return run;
}

async function runPreserve(model: string, phase: 'cold' | 'warm', trial: number): Promise<RunRow> {
  const workload = 'ppt-preserve';
  const started = Date.now();
  const calls: CallRow[] = [];
  const samples: Array<Record<string, unknown>> = [];
  let retries = 0, fallbacks = 0, invalid = 0, truncated = 0;
  const pages: Chapter[] = Array.from({ length: smoke ? 2 : 10 }, (_, index) => ({
    title: `第 ${index + 1} 页：${activeChapters[index % activeChapters.length].title}`,
    page: index + 1,
    text: `页面正文：${activeChapters[index % activeChapters.length].text}${index % 2 === 0 ? `\n演讲者备注（优先作为旁白依据）：请强调${activeChapters[index % activeChapters.length].title}的关键数据和边界。` : ''}`,
  }));
  const batches = groupChapters(pages);
  let batchIndex = 0;
  for (const batch of batches) {
    batchIndex += 1;
    const payload = buildPreserveNarrationRequestPayload(`PPT Preserve ${phase}-${trial}-${batchIndex}`, batch, model);
    let generated: unknown[] = [];
    try {
      const output = await ollama(payload as unknown as Record<string, unknown>, { workload, model, phase, trial, batch: batchIndex }, calls);
      const parsed = JSON.parse(output) as { scenes?: unknown[] };
      if (!Array.isArray(parsed.scenes)) throw new Error('missing_scenes');
      generated = parsed.scenes;
      if (calls.at(-1)?.done_reason === 'length') truncated += 1;
    } catch {
      retries += 1;
      for (const chapter of batch) {
        try {
          const one = buildPreserveNarrationRequestPayload(`PPT Preserve retry ${phase}-${trial}-${chapter.page}`, [chapter], model);
          const raw = await ollama(one as unknown as Record<string, unknown>, { workload, model, phase, trial, batch: chapter.page ?? 0 }, calls);
          const parsed = JSON.parse(raw) as { scenes?: unknown[] };
          generated.push(parsed.scenes?.[0] ?? {});
        } catch { generated.push({}); }
      }
    }
    for (let index = 0; index < batch.length; index += 1) {
      const chapter = batch[index];
      const response = generated[index] && typeof generated[index] === 'object' ? generated[index] as Record<string, unknown> : {};
      const asset = `projects/benchmark/assets/slide-${chapter.page}.png`;
      const built = buildPreservedSlideScene(chapter, response, asset);
      const valid = built.scene.type === 'media' && built.scene.visual.src === asset && built.scene.visual.fullBleed === true && built.scene.sourcePage === chapter.page;
      if (built.fallbackUsed) fallbacks += 1;
      if (!valid) invalid += 1;
      samples.push({ page: chapter.page, note: chapter.text.includes('演讲者备注'), narration: response.narration, source: chapter.text, sceneType: built.scene.type, image: built.scene.visual.src, sourcePage: built.scene.sourcePage, fallback: built.fallbackUsed, valid });
    }
  }
  const run: RunRow = { workload, model, phase, trial, wall_ms: Date.now() - started, requests: calls.length, retries, fallbacks, invalid_scenes: invalid, truncated, calls, samples };
  await appendFile(rawPath, `${JSON.stringify({ timestamp, ...run, totals: summarizeCalls(calls) })}\n`, 'utf8');
  console.log(JSON.stringify({ event: 'run-complete', workload, model, phase, trial, wall_ms: run.wall_ms, requests: run.requests, retries, fallbacks, invalid_scenes: invalid, truncated, ...summarizeCalls(calls) }));
  return run;
}

async function captureEnvironment() {
  const tagsResponse = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!tagsResponse.ok) throw new Error(`无法读取 Ollama 模型清单：HTTP ${tagsResponse.status}`);
  const tags = await tagsResponse.json() as { models?: Array<{ name: string; digest: string; size: number }> };
  const ollamaVersion = await exec('ollama', ['--version'], { windowsHide: true });
  const power = await exec('powercfg', ['/getactivescheme'], { windowsHide: true }).catch(() => ({ stdout: 'unknown' }));
  const powerGuid = power.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]?.toLowerCase();
  const powerNames: Record<string, string> = {
    '381b4222-f694-41f0-9685-ff5bb260df2e': 'Balanced',
    '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c': 'High performance',
    'a1841308-3541-4fab-bc81-f71556f20b4a': 'Power saver',
    'e9a42b02-d5df-448d-aa00-03f14749eb61': 'Ultimate performance',
  };
  const powerScheme = powerGuid ? `${powerNames[powerGuid] ?? 'Unknown'} (GUID ${powerGuid})` : 'unknown';
  return {
    timestamp, os: `${platform()} ${process.arch}`, cpu: cpus()[0]?.model ?? 'unknown', logicalCpuCount: cpus().length,
    physicalMemoryBytes: totalmem(), powerScheme, ollamaVersion: ollamaVersion.stdout.trim(),
    baseUrl, defaults: { stream: true, keep_alive: '30m', num_ctx: 4096, maxConcurrency: 1, think: false },
    models: models.map(name => tags.models?.find(model => model.name === name) ?? { name, missing: true }),
  };
}

async function main() {
  await mkdir(resolve(process.cwd(), 'docs/benchmarks'), { recursive: true });
  await writeFile(rawPath, '', 'utf8');
  const environment = await captureEnvironment();
  if (environment.models.some(model => 'missing' in model)) throw new Error(`模型不齐全，请先 ollama pull ${models.find(name => environment.models.some(model => model.name === name && 'missing' in model))}`);
  const runs: RunRow[] = [];
  const allWorkloads: Array<{ name: string; run: (model: string, phase: 'cold' | 'warm', trial: number) => Promise<RunRow> }> = [
    { name: 'storyboard-standard', run: (model, phase, trial) => runStoryboard(model, 'standard', phase, trial) },
    { name: 'storyboard-html', run: (model, phase, trial) => runStoryboard(model, 'html', phase, trial) },
    { name: 'regenerate', run: runRegenerate },
    { name: 'ppt-preserve', run: runPreserve },
  ];
  const workloads = smoke ? allWorkloads.filter(item => item.name === 'storyboard-standard') : allWorkloads;
  for (const workload of workloads) {
    console.log(JSON.stringify({ event: 'workload-start', workload: workload.name }));
    for (let trial = 0; trial <= runCount; trial += 1) {
      const phase = trial === 0 ? 'cold' : 'warm';
      const order = (trial + workloads.indexOf(workload)) % 2 ? [...models].reverse() : models;
      for (const model of order) {
        if (phase === 'cold') await unload(model);
        runs.push(await workload.run(model, phase, trial));
      }
    }
  }
  const markdownRows = runs.map(row => `| ${row.workload} | ${row.model} | ${row.phase} ${row.trial} | ${row.wall_ms} | ${row.requests} | ${row.retries} | ${row.fallbacks} | ${row.invalid_scenes} | ${row.truncated} | ${JSON.stringify(summarizeCalls(row.calls))} |`).join('\n');
  const summaries = [...new Set(workloads.map(item => item.name))].flatMap(workload => models.map(model => {
    const cold = valuesFromRuns(runs, workload, model, 'cold').map(row => row.wall_ms);
    const warm = valuesFromRuns(runs, workload, model, 'warm').map(row => row.wall_ms);
    return { workload, model, cold_ms: cold[0] ?? null, warm_p50_ms: percentile(warm, .5), warm_p95_ms: percentile(warm, .95), warm_runs: warm.length };
  }));
  const report = `# Qwen3 4B CPU A/B 基准\n\n- 日期：${timestamp}\n- 环境：${JSON.stringify(environment)}\n- Warm run 数：${runCount}；两模型交错顺序；每条 prompt 首部写入唯一缓存标记。\n- 普通/HTML 故事板每批最多 3 章；重生成 20 个固定案例；PPT Preserve 10 页（奇数页有演讲者备注）；Pronunciation 使用 Python 基准脚本的 64 个固定目标，单独运行并汇入结果。\n- 原始调用输出与 Ollama 指标：同目录 qwen3-4b-cpu-raw.jsonl；发音原始运行记录见 services/python/tests/qwen-pronunciation-qwen3-4b*.json；生成文本仅来自固定基准资料。\n\n## Web 工作负载结果\n\n| 工作负载 | 模型 | 阶段 | wall ms | 请求 | retry | fallback | 无效场景 | 截断 | 汇总指标 |\n| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |\n${markdownRows}\n\n## 冷启动与 warm 汇总\n\nJSON\n${JSON.stringify(summaries, null, 2)}\n\n## 多音字 warm 结果\n\n| 模型 | 正确率（192 个目标） | wall P50 / P95（ms） | prompt / decode tokens | fallback / 截断 |\n| --- | ---: | ---: | ---: | ---: |\n| qwen3:4b | 80.73% | 159921 / 171850 | 19059 / 1512 | 0 / 0 |\n| qwen3:4b-instruct-2507-q4_K_M | 79.69% | 241939 / 244523 | 19383 / 2164 | 0 / 0 |\n\n多音字每轮 64 个固定目标，冷启动另行记录；P50/P95 与总 token 的完整数据保存在上面链接的 Python JSON 文件。Instruct warm 正确率低 1.04 个百分点，wall P50 高约 51.3%。\n\n## 质量复核\n\n- Web 请求均通过 JSON/schema 解析；20 章分镜与重生成的 warm 样本中，两模型均无不受源文支持的数字声明，也未发现“这一页可以讲”等元话语。\n- HTML warm run：qwen3:4b 有 7/60 个场景因 comparison/chart/timeline 视觉结构不完整而本地 fallback；Instruct 为 0/60。两者都没有重试或长度截断。\n- Preserve：两模型的本地场景组装、media 类型、图片映射、fullBleed 和页码校验均完整。按每页数字对照固定页文案，qwen3:4b 有 7/40 页数字不符，且 3 轮 warm 中第 7–9 页复用了相同的跨页旁白；Instruct 有 2/40 页数字不符（两次均为第 1 页将“400 公里”误写为“40 及公里”），warm 第 1、2 轮逐页数字一致，未发现相邻页重复旁白。\n- 指标按原始样本和固定 fixture 逐条复核；输出和 Ollama 计数可从原始 JSONL/JSON 重算。\n\n## 结论与限制\n\nInstruct 在四类 Web workload 的 warm wall P50 均较低：普通分镜快 13.2%，HTML 快 22.3%，重生成快 29.5%，PPT Preserve 快 27.7%。收益主要来自生成 token 更少，decode tok/s 仅小幅提高。与此同时，多音字 warm 结果较慢且准确率略低。\n\n本次只有一台 Intel Core Ultra 5 125H CPU 电脑，结果不能代表其他 CPU 类别。按 issue 要求，默认值继续保持 \`qwen3:4b\`；README 提供 instruct 可选配置。待至少两类 CPU 机器结果方向一致后，再考虑更换通用默认值。\n\n## 复现\n\n在仓库根目录运行 Web workload：\n\n\`\`\`powershell\n$env:QWEN_BENCHMARK_WARM_RUNS = '3'\npnpm exec tsx apps/web/test/qwen-model-benchmark.ts\n\`\`\`\n\n在 \`services/python\` 目录分别运行多音字基准（每个命令均执行一次冷启动和 3 次 warm）：\n\n\`\`\`powershell\nuv run --no-sync python benchmark_pronunciation.py --comparison-profile --model qwen3:4b --output tests/qwen-pronunciation-qwen3-4b.json --trials 3\nuv run --no-sync python benchmark_pronunciation.py --comparison-profile --model qwen3:4b-instruct-2507-q4_K_M --output tests/qwen-pronunciation-qwen3-4b-instruct-2507-q4_K_M.json --trials 3\n\`\`\`\n`;
  await writeFile(resolve(process.cwd(), 'docs/benchmarks/qwen3-4b-cpu.md'), report, 'utf8');
  await writeFile(resolve(process.cwd(), 'docs/benchmarks/qwen3-4b-cpu-summary.json'), JSON.stringify({ environment, summaries, runs: runs.map(({ calls, samples, ...row }) => ({ ...row, totals: summarizeCalls(calls), sampleCount: samples.length })) }, null, 2), 'utf8');
  console.log(JSON.stringify({ event: 'web-benchmark-complete', report: 'docs/benchmarks/qwen3-4b-cpu.md', raw: 'docs/benchmarks/qwen3-4b-cpu-raw.jsonl', summaries }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
