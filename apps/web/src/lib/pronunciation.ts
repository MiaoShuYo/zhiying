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
export async function writePronunciationRules(value: unknown) {
  const rules = GlobalPronunciationSchema.parse(value);
  await mkdir(dirname(file()), { recursive: true });
  const temporary = `${file()}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(rules, null, 2), 'utf8');
  await rename(temporary, file());
  return rules;
}
