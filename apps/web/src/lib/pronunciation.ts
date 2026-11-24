import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PronunciationRuleSchema } from '@m2v/schema';

export const GlobalPronunciationSchema = z.array(PronunciationRuleSchema.refine(rule => rule.occurrence === undefined, '通用规则不能指定出现位置')).max(200);
const file = () => resolve(process.cwd(), '../..', 'data/settings/pronunciation.json');
export async function readPronunciationRules() {
  try { return GlobalPronunciationSchema.parse(JSON.parse(await readFile(file(), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export class PronunciationValidationError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/**
 * #316: the schema only checks pinyin syntax, so 行 → ma3 used to be saved. Every synthesis
 * request sends the global dictionary, and the Python service rejects such a reading, so one bad
 * global rule blocked speech generation in every project. The reading is checked against the
 * character's real readings by the same validator synthesis uses, before anything is persisted.
 */
export async function assertReadingsValid(rules: unknown[]) {
  if (!rules.length) return;
  const service = process.env.PYTHON_SERVICE_URL ?? 'http://127.0.0.1:8000';
  let response: Response;
  try {
    response = await fetch(`${service.replace(/\/$/, '')}/pronunciation/validate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rules }), signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new PronunciationValidationError('无法连接本地 Python 服务校验读音，规则未保存；请启动服务后重试', 503);
  }
  if (response.ok) return;
  const body = await response.json().catch(() => ({})) as { detail?: unknown };
  throw new PronunciationValidationError(typeof body.detail === 'string' ? body.detail : '读音校验未通过，规则未保存');
}

export async function writePronunciationRules(value: unknown) {
  const rules = GlobalPronunciationSchema.parse(value);
  await assertReadingsValid(rules);
  await mkdir(dirname(file()), { recursive: true });
  const temporary = `${file()}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(rules, null, 2), 'utf8');
  await rename(temporary, file());
  return rules;
}
