import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildStoryboardRequestPayload, readOllamaChatResponse, type Chapter } from '../src/lib/pipeline';
import { readLocalLlmConfig, withLocalLlmSlot } from '../src/lib/local-llm-config';

const exec = promisify(execFile);
const chapter: Chapter = {
  title: 'CPU 推理性能基准',
  text: '本章节介绍本地大模型在纯 CPU 环境下生成知识视频分镜的运行表现。输入资料包含一个明确概念、两个原因和三个有序步骤，要求模型准确组织为旁白和视觉结构。配置对比使用相同提示、模型和输出预算，并记录 prompt 处理、生成速度、模型加载时间、请求墙钟时间与错误率。',
};
const model = process.env.OLLAMA_MODEL ?? 'qwen3:4b';
const baseUrl = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
const rows: Array<{ experiment: string; setting: string; repetition: number; wallMs: number; loadMs: number; promptTokens: number; promptMs: number; outputTokens: number; decodeMs: number; decodeTokensPerSecond: number; ollamaRssMb: number; reportedContext?: number; error?: string }> = [];
const pings: number[] = [];
const pingsByConcurrency = new Map<string, number[]>();
let peakOllamaRssMb = 0;
let sampleRss = false;

async function sampleMemory(): Promise<number> {
  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', '$p=Get-Process | Where-Object {$_.ProcessName -match "ollama|llama"}; if ($p) { [math]::Round((($p | Measure-Object -Property WorkingSet64 -Sum).Sum / 1MB), 1) } else { "0" }'], { windowsHide: true, timeout: 5000 });
    const value = Number(stdout.trim());
    if (Number.isFinite(value)) peakOllamaRssMb = Math.max(peakOllamaRssMb, value);
    return Number.isFinite(value) ? value : 0;
  } catch { /* RSS sampling is best-effort; endpoint telemetry remains authoritative. */ return 0; }
}

async function call(experiment: string, setting: string, repetition: number, options: { stream: boolean; keepAlive: string | null; numCtx: number }) {
  const config = readLocalLlmConfig();
  const payload = buildStoryboardRequestPayload('本地 CPU 推理性能验证', [chapter], 'standard', model);
  payload.stream = options.stream;
  if (options.keepAlive === null) delete (payload as unknown as Record<string, unknown>).keep_alive;
  else payload.keep_alive = options.keepAlive;
  payload.options.num_ctx = options.numCtx;
  payload.options.num_predict = 768;
  Object.assign(payload.options, { temperature: 0 });
  const startedAt = Date.now();
  let requestPeakRssMb = 0;
  let rssTimer: ReturnType<typeof setInterval> | undefined;
  try {
    requestPeakRssMb = await sampleMemory();
    rssTimer = setInterval(() => { void sampleMemory().then(value => { requestPeakRssMb = Math.max(requestPeakRssMb, value); }); }, 1000);
    const result = await withLocalLlmSlot(async () => {
      const response = await fetch(`${config.baseUrl}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(600_000) });
      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      return readOllamaChatResponse(response, startedAt);
    }, config);
    const metrics = result.metrics;
    JSON.parse(result.message?.content ?? '');
    const psResponse = await fetch(`${config.baseUrl}/api/ps`, { signal: AbortSignal.timeout(5000) });
    const ps = psResponse.ok ? await psResponse.json() as { models?: Array<{ name: string; context_length?: number }> } : {};
    requestPeakRssMb = Math.max(requestPeakRssMb, await sampleMemory());
    rows.push({
      experiment, setting, repetition, wallMs: result.wall_ms,
      loadMs: (metrics.load_duration ?? 0) / 1e6,
      promptTokens: metrics.prompt_eval_count ?? 0,
      promptMs: (metrics.prompt_eval_duration ?? 0) / 1e6,
      outputTokens: metrics.eval_count ?? 0,
      decodeMs: (metrics.eval_duration ?? 0) / 1e6,
      decodeTokensPerSecond: (metrics.eval_duration ?? 0) > 0 ? (metrics.eval_count ?? 0) / ((metrics.eval_duration ?? 1) / 1e9) : 0,
      ollamaRssMb: requestPeakRssMb,
      ...(ps.models?.find(item => item.name === model)?.context_length === undefined ? {} : { reportedContext: ps.models.find(item => item.name === model)!.context_length }),
    });
  } catch (error) {
    rows.push({ experiment, setting, repetition, wallMs: Date.now() - startedAt, loadMs: 0, promptTokens: 0, promptMs: 0, outputTokens: 0, decodeMs: 0, decodeTokensPerSecond: 0, ollamaRssMb: requestPeakRssMb, error: String(error) });
  } finally {
    if (rssTimer) clearInterval(rssTimer);
  }
}

async function unload() {
  const response = await fetch(`${baseUrl}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Unable to unload model before cold trial: HTTP ${response.status}`);
  await response.arrayBuffer();
}

function startSystemProbe(concurrency: string) {
  sampleRss = true;
  const timer = setInterval(() => {
    const started = Date.now();
    void fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) }).then(response => {
      if (response.ok) {
        const elapsed = Date.now() - started;
        pings.push(elapsed);
        const samples = pingsByConcurrency.get(concurrency) ?? [];
        samples.push(elapsed);
        pingsByConcurrency.set(concurrency, samples);
      }
    }).catch(() => {});
    if (sampleRss) void sampleMemory();
  }, 500);
  return () => { sampleRss = false; clearInterval(timer); };
}

async function main() {
  const concurrencyOnly = process.env.BENCH_CONCURRENCY_ONLY === '1';
  const tags = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!tags.ok) throw new Error(`Ollama unavailable: HTTP ${tags.status}`);

  if (!concurrencyOnly) {
    // Warm once, then measure Ollama defaults versus explicit residency.
    await call('warmup', 'warmup', 0, { stream: true, keepAlive: '30m', numCtx: 4096 });
    await unload();
    for (const keepAlive of [null, '30m'] as const) {
      const setting = keepAlive ?? 'ollama-default';
      await unload();
      for (let repetition = 1; repetition <= 3; repetition += 1) {
        await call('keep_alive', setting, repetition, { stream: true, keepAlive, numCtx: 4096 });
      }
    }

    // Alternate order to reduce warm-cache and thermal-order bias.
    await call('warmup', 'stream', 0, { stream: true, keepAlive: '30m', numCtx: 4096 });
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      const order = repetition % 2 ? [true, false] : [false, true];
      for (const stream of order) await call('stream', String(stream), repetition, { stream, keepAlive: '30m', numCtx: 4096 });
    }

    for (let repetition = 1; repetition <= 3; repetition += 1) {
      for (const numCtx of repetition % 2 ? [4096, 8192] : [8192, 4096]) await call('context', String(numCtx), repetition, { stream: true, keepAlive: '30m', numCtx });
    }
  }

  for (let repetition = 1; repetition <= 2; repetition += 1) {
    const order = repetition % 2 ? [1, 2] : [2, 1];
    for (const concurrency of order) {
      process.env.LLM_MAX_CONCURRENCY = String(concurrency);
      await call('warmup', `concurrency-${concurrency}`, repetition, { stream: true, keepAlive: '30m', numCtx: 4096 });
      const stopProbe = startSystemProbe(String(concurrency));
      const started = Date.now();
      await Promise.all([1, 2].map(index => call('concurrency', String(concurrency), (repetition - 1) * 2 + index, { stream: true, keepAlive: '30m', numCtx: 4096 })));
      const wallMs = Date.now() - started;
      stopProbe();
      rows.push({ experiment: 'concurrency_total', setting: String(concurrency), repetition, wallMs, loadMs: 0, promptTokens: 0, promptMs: 0, outputTokens: 0, decodeMs: 0, decodeTokensPerSecond: 0, ollamaRssMb: peakOllamaRssMb });
    }
  }

  const pingP95ByConcurrency = Object.fromEntries([...pingsByConcurrency.entries()].map(([key, samples]) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return [key, { count: sorted.length, p95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)] : null }];
  }));
  const sortedPings = [...pings].sort((a, b) => a - b);
  const pingP95 = sortedPings.length ? sortedPings[Math.min(sortedPings.length - 1, Math.ceil(sortedPings.length * .95) - 1)] : null;
  const successful = rows.filter(row => !row.error);
  const summary = new Map<string, { n: number; wallMs: number; loadMs: number; promptMs: number; decodeMs: number; tokps: number; rssMb: number; contexts: string; errors: number }>();
  for (const row of rows) {
    const key = `${row.experiment}=${row.setting}`;
    const current = summary.get(key) ?? { n: 0, wallMs: 0, loadMs: 0, promptMs: 0, decodeMs: 0, tokps: 0, rssMb: 0, contexts: '', errors: 0 };
    current.n += 1; current.wallMs += row.wallMs; current.loadMs += row.loadMs; current.promptMs += row.promptMs; current.decodeMs += row.decodeMs; current.tokps += row.decodeTokensPerSecond; current.rssMb = Math.max(current.rssMb, row.ollamaRssMb); current.contexts += row.reportedContext ? `${row.reportedContext},` : ''; current.errors += Number(Boolean(row.error));
    summary.set(key, current);
  }
  const detail = [...summary.entries()].map(([key, value]) => `| ${key} | ${value.n} | ${(value.wallMs / value.n).toFixed(0)} | ${(value.loadMs / value.n).toFixed(0)} | ${(value.promptMs / value.n).toFixed(0)} | ${(value.decodeMs / value.n).toFixed(0)} | ${(value.tokps / value.n).toFixed(2)} | ${value.rssMb.toFixed(0)} | ${value.contexts || 'n/a'} | ${value.errors} |`).join('\n');
  const report = `# 本地 Ollama CPU 配置性能验证${concurrencyOnly ? '（并发专项复测）' : ''}\n\n- 日期：${new Date().toISOString()}\n- 模型：${model}\n- 请求使用生产 storyboard builder、固定章节、temperature=0 和输出上限 768 tokens；完整配置对比每项 3 轮；并发交错顺序、每档两轮并预热。\n- Ollama/llama-server 进程峰值工作集：${peakOllamaRssMb.toFixed(1)} MB\n- generation 期间 /api/tags 响应：总体 ${pings.length} 样本、P95 ${pingP95 ?? 'n/a'} ms；并发分档：${JSON.stringify(pingP95ByConcurrency)}\n- 成功请求：${successful.length}/${rows.length}\n\n| 实验 | 配置 | 样本数 | 平均 wall ms | 平均 load ms | 平均 prompt ms | 平均 decode ms | 平均 decode tok/s | 峰值工作集 MB | Ollama context_length 样本 | 错误数 |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |\n${detail}\n\n## 原始样本\n\n\`\`\`json\n${JSON.stringify({ rows, pingMs: pings, pingP95ByConcurrency, peakOllamaRssMb }, null, 2)}\n\`\`\`\n`;
  await writeFile(resolve(process.cwd(), `test/local-llm-${concurrencyOnly ? 'concurrency' : 'profile'}-results.md`), report, 'utf8');
  process.stdout.write(report);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
