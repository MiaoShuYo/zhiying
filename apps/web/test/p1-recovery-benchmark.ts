/** Real production storyboard/recovery comparison; no mocked model responses.
 * node node_modules/tsx/dist/cli.mjs apps/web/test/p1-recovery-benchmark.ts
 * Temporary instrumented modules only export the private generator and count
 * fallbackChapter calls. Prompts, parsing, validation and recovery stay intact.
 * Set P1_RECOVERY_OUTPUT to a fresh directory for another run.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, unlink, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SceneSchema, type Scene } from '@m2v/schema';
import { readOllamaChatResponse, type Chapter } from '../src/lib/pipeline';

const root = resolve(import.meta.dirname, '../../..');
const output = resolve(root, process.env.P1_RECOVERY_OUTPUT ?? 'outputs/p1-recovery-benchmark');
const baselineRef = process.env.P1_BASELINE_REF ?? 'b809bb9';
const sourcePath = 'apps/web/src/lib/pipeline.ts';
const realFetch = globalThis.fetch;
const chapters: Chapter[] = Array.from({ length: 20 }, (_, index) => ({
  title: `第 ${index + 1} 章：阶段${index + 1}`,
  text: `阶段${index + 1}的核心事实是项目采用可验证的处理流程。首先，输入经过规范化并保留来源信息；随后系统根据规则完成排序、校验与记录。第${index + 1}阶段需要关注稳定性、准确率与处理成本之间的平衡。实测数据表明，完成校验后再提交结果可以避免不完整状态。该阶段的结论是保留确定性数据，并对模型负责的内容进行有限生成。`,
}));
type Pipeline = typeof import('../src/lib/pipeline') & {
  ollamaChapters: (title: string, chapters: Chapter[], styleId: string) => Promise<Scene[]>;
  benchmarkFallbacks: number;
  resetBenchmarkFallbacks: () => void;
};
type Row = Record<string, any>;
const temporary: string[] = [];
const summaries: Row[] = [];
let context: Row = {};
let rows: Row[] = [];
let pending: Promise<void>[] = [];
let request = 0;

async function loadPipeline(name: string, source: string): Promise<Pipeline> {
  const signature = 'export function fallbackChapter(chapter: Chapter): Scene {';
  assert.equal(source.split(signature).length, 2);
  assert.equal(source.split('async function ollamaChapters(').length, 2);
  const instrumented = source.replace(/(?<!export )function groupChapters\(/, 'export function groupChapters(')
    .replace('async function ollamaChapters(', 'export async function ollamaChapters(')
    .replace(signature, `${signature}\n benchmarkFallbacks += 1;`)
    + '\nexport let benchmarkFallbacks = 0;\nexport function resetBenchmarkFallbacks() { benchmarkFallbacks = 0; }\n';
  const path = resolve(root, `apps/web/src/lib/.p1-benchmark-${process.pid}-${name}.ts`);
  await writeFile(path, instrumented);
  temporary.push(path);
  const loaded = await import(pathToFileURL(path).href);
  return (loaded.default ?? loaded) as Pipeline;
}

async function main() {
  await mkdir(output, { recursive: true });
  // Never mix a repeated/partial run with earlier evidence.
  await writeFile(resolve(output, 'requests.jsonl'), '', { flag: 'wx' });
  const baseline = execFileSync('git', ['show', `${baselineRef}:${sourcePath}`], { cwd: root, encoding: 'utf8' });
  const current = await readFile(resolve(root, sourcePath), 'utf8');
  const modules = { baseline: await loadPipeline('baseline', baseline), current: await loadPipeline('current', current) };
  const base = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = process.env.OLLAMA_MODEL ?? 'qwen3:4b';
  const metadata = {
    startedAt: new Date().toISOString(), baselineRef,
    currentRef: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceHashes: { baseline: createHash('sha256').update(baseline).digest('hex'), current: createHash('sha256').update(current).digest('hex') },
    model, version: await (await realFetch(`${base}/api/version`)).json(),
    models: await (await realFetch(`${base}/api/tags`)).json(),
    preferLocalAI: false, chapters, trials: 3,
    scope: 'Production ollamaChapters + recoverAndCommitStoryboardBatch + local validation + file checkpoints; excludes extraction, database/UI, TTS/render.',
  };
  await writeFile(resolve(output, 'metadata.json'), JSON.stringify(metadata, null, 2));
  const warm = await realFetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true, think: false, format: 'json', options: { num_predict: 64 }, messages: [{ role: 'user', content: '只返回 JSON：{"ok":true}' }] }) });
  assert.ok(warm.ok);
  await readOllamaChatResponse(warm, Date.now());
  globalThis.fetch = async (url, init) => {
    const started = Date.now();
    const info = { ...context, request: ++request };
    const payload = JSON.parse(String(init?.body));
    const response = await realFetch(url, init);
    // Capture the unmodified response including metrics from failed/retried output.
    pending.push((async () => {
      const result = await readOllamaChatResponse(response.clone(), started);
      assert.equal(typeof result.metrics.eval_count, 'number', 'missing eval_count must not silently count as zero');
      const row = { ...info, httpStatus: response.status, payload, ...result };
      rows.push(row);
      await appendFile(resolve(output, 'requests.jsonl'), JSON.stringify(row) + '\n');
      console.log(JSON.stringify({ ...info, eval_count: result.metrics.eval_count, done_reason: result.done_reason, wall_ms: result.wall_ms }));
    })());
    return response;
  };
  for (let trial = 1; trial <= 3; trial++) {
    for (const variant of (trial % 2 ? ['baseline', 'current'] : ['current', 'baseline']) as ('baseline' | 'current')[]) {
      const pipeline = modules[variant];
      pipeline.resetBenchmarkFallbacks();
      rows = []; pending = []; request = 0;
      const scenes: Scene[] = [];
      const errors: Row[] = [];
      let retryRequests = 0;
      let retryBatches = 0;
      let commits = 0;
      const started = Date.now();
      const batches = pipeline.groupChapters(chapters, 3, 1200);
      for (const [batchIndex, batch] of batches.entries()) {
        let calls = 0;
        await pipeline.recoverAndCommitStoryboardBatch({
          batch, preferLocalAI: false,
          generate: async input => {
            const retry = calls++ > 0;
            if (retry) retryRequests++;
            context = { trial, variant, batch: batchIndex + 1, retry, chapters: input.map(c => c.title) };
            try { return await pipeline.ollamaChapters('V1.6.3 20 章性能样本', input, 'default'); }
            catch (error) {
              errors.push({ ...context, kind: error instanceof pipeline.OllamaStoryboardOutputError ? error.kind : 'other', message: String(error) });
              throw error;
            }
          },
          fallback: pipeline.fallbackChapter,
          commit: async result => {
            scenes.push(...result.scenes);
            commits++;
            const target = resolve(output, `${variant}-${trial}-checkpoint.json`);
            await writeFile(`${target}.tmp`, JSON.stringify({ completedChapters: scenes.length, scenes }, null, 2));
            await rename(`${target}.tmp`, target);
          },
        });
        if (calls > 1) retryBatches++;
      }
      await Promise.all(pending);
      assert.equal(scenes.length, 20);
      for (const scene of scenes) SceneSchema.parse(scene);
      const total = (key: string) => rows.reduce((sum, row) => sum + (row.metrics[key] ?? 0), 0);
      const summary = { trial, variant, requests: rows.length, retryRequests, retryBatches, commits,
        scenes: scenes.length, fallbackScenes: pipeline.benchmarkFallbacks,
        eval_count: total('eval_count'), prompt_eval_count: total('prompt_eval_count'),
        eval_duration: total('eval_duration'), wall_ms: Date.now() - started,
        done_reason_length: rows.filter(row => row.done_reason === 'length').length,
        narration_characters: scenes.reduce((sum, scene) => sum + [...scene.narration].length, 0),
        errors,
      };
      summaries.push(summary);
      await writeFile(resolve(output, 'summary.json'), JSON.stringify(summaries, null, 2));
      console.log(JSON.stringify({ summary }));
    }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  globalThis.fetch = realFetch;
  await Promise.allSettled(pending);
  for (const path of temporary) await unlink(path);
});
