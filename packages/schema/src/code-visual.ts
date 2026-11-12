import { z } from 'zod';

/**
 * One narrated focus window inside a code scene.
 *
 * `lines` are 1-based source line numbers of `visual.code`; absolute frame times are
 * deliberately NOT stored here so that regenerating audio or changing the speech speed
 * re-derives the timeline instead of invalidating the model output (see `code-timeline.ts`).
 */
export const CodeBeatSchema = z.object({
  lines: z.array(z.number().int().positive()).min(1).max(200),
  label: z.string().min(1).max(30).optional(),
  narrationText: z.string().min(1).max(200).optional(),
});

/**
 * One semantic build step of `mode: 'build'`.
 *
 * `revealLines` are the 1-based lines of `visual.code` that become visible in this step;
 * `focusLines` are the lines the narration talks about (defaults to `revealLines` in the
 * resolver layer — the schema never rewrites data). The union of every step's `revealLines`
 * must cover every source line, so the final frame always shows the complete source.
 */
export const CodeBuildStepSchema = z.object({
  revealLines: z.array(z.number().int().positive()).min(1).max(200),
  focusLines: z.array(z.number().int().positive()).min(1).max(200).optional(),
  label: z.string().min(1).max(30).optional(),
  narrationText: z.string().min(1).max(200).optional(),
});

/** One execution-state entry of a trace step; `changed` marks a value updated by this step. */
export const CodeTraceStateEntrySchema = z.object({
  name: z.string().min(1).max(40),
  value: z.string().max(160),
  changed: z.boolean().optional(),
});

/**
 * One semantic execution step of `mode: 'trace'`.
 *
 * `lines` are the 1-based source lines being executed, `state`/`output` are the verified
 * variables/output of the source material (never guessed by the model) and `callDepth`
 * only labels the current recursion depth in this MVP.
 */
export const CodeTraceStepSchema = z.object({
  lines: z.array(z.number().int().positive()).min(1).max(200),
  label: z.string().min(1).max(30).optional(),
  narrationText: z.string().min(1).max(200).optional(),
  state: z.array(CodeTraceStateEntrySchema).max(12).optional(),
  output: z.string().max(200).optional(),
  callDepth: z.number().int().min(0).max(20).optional(),
});

/** One narration-anchored diff beat selecting the hunks the model wants to explain. */
export const CodeDiffBeatSchema = z.object({
  hunkIds: z.array(z.string().regex(/^h[1-9][0-9]*$/)).min(1).max(10),
  label: z.string().min(1).max(30).optional(),
  narrationText: z.string().min(1).max(200).optional(),
});

const CodeVisualObjectSchema = z.object({
  code: z.string().min(1).max(8000),
  language: z.string().min(1).max(30).optional(),
  filename: z.string().min(1).max(100).optional(),
  mode: z.enum(['focus', 'build', 'diff', 'trace']).optional(),
  beats: z.array(CodeBeatSchema).max(10).optional(),
  /** Only `mode: 'diff'`: the real pre-change source; the system computes the diff itself. */
  beforeCode: z.string().min(1).max(8000).optional(),
  /** Only `mode: 'diff'`: the real post-change source; must equal `code`. */
  afterCode: z.string().min(1).max(8000).optional(),
  buildSteps: z.array(CodeBuildStepSchema).max(12).optional(),
  diffBeats: z.array(CodeDiffBeatSchema).max(10).optional(),
  traceSteps: z.array(CodeTraceStepSchema).max(20).optional(),
});

/**
 * Structured payload of a `type: 'code'` scene, shared by the Standard and HTML renderers.
 *
 * The advanced fields are validated whenever they are present: `mode` alone (without its
 * matching data) must stay valid so V1.6.8 scenes and model outputs that only set `mode`
 * keep parsing — the resolver (`code-mode.ts`) is responsible for falling back to `focus`.
 */
export const CodeVisualSchema = CodeVisualObjectSchema.superRefine((visual, ctx) => {
  const totalLines = codeLines(visual.code).length;
  const outOfRange = (line: number) => line > totalLines;
  const duplicateIssue = (line: number) => `代码行号 ${line} 重复`;
  const rangeIssue = (line: number) => `代码行号 ${line} 超出代码总行数 ${totalLines}`;

  for (const [beatIndex, beat] of (visual.beats ?? []).entries()) {
    const seen = new Set<number>();
    for (const [lineIndex, line] of beat.lines.entries()) {
      if (outOfRange(line)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['beats', beatIndex, 'lines', lineIndex],
          message: rangeIssue(line),
        });
      }
      if (seen.has(line)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['beats', beatIndex, 'lines', lineIndex],
          message: duplicateIssue(line),
        });
      }
      seen.add(line);
    }
  }

  if (visual.buildSteps) {
    const covered = new Set<number>();
    for (const [stepIndex, step] of visual.buildSteps.entries()) {
      for (const key of ['revealLines', 'focusLines'] as const) {
        const lines = step[key];
        if (!lines) continue;
        const seen = new Set<number>();
        for (const [lineIndex, line] of lines.entries()) {
          if (outOfRange(line)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['buildSteps', stepIndex, key, lineIndex],
              message: rangeIssue(line),
            });
          } else if (key === 'revealLines') {
            covered.add(line);
          }
          if (seen.has(line)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['buildSteps', stepIndex, key, lineIndex],
              message: duplicateIssue(line),
            });
          }
          seen.add(line);
        }
      }
    }
    // Every source line must be revealed by some step, otherwise the final frame is incomplete.
    const missing: number[] = [];
    for (let line = 1; line <= totalLines; line += 1) {
      if (!covered.has(line)) missing.push(line);
    }
    if (missing.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['buildSteps'],
        message: `buildSteps 的 revealLines 未覆盖代码行：${missing.slice(0, 10).join('、')}${missing.length > 10 ? ' 等' : ''}（共 ${totalLines} 行）`,
      });
    }
  }

  if (visual.traceSteps) {
    for (const [stepIndex, step] of visual.traceSteps.entries()) {
      const seen = new Set<number>();
      for (const [lineIndex, line] of step.lines.entries()) {
        if (outOfRange(line)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['traceSteps', stepIndex, 'lines', lineIndex],
            message: rangeIssue(line),
          });
        }
        if (seen.has(line)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['traceSteps', stepIndex, 'lines', lineIndex],
            message: duplicateIssue(line),
          });
        }
        seen.add(line);
      }
      const stateNames = new Set<string>();
      for (const [stateIndex, entry] of (step.state ?? []).entries()) {
        if (stateNames.has(entry.name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['traceSteps', stepIndex, 'state', stateIndex, 'name'],
            message: `状态变量 ${entry.name} 重复`,
          });
        }
        stateNames.add(entry.name);
      }
    }
  }

  // `beforeCode`/`afterCode` are only meaningful as a pair, and the final source must be the
  // post-change source so a scene can never show a diff for code that is not rendered.
  const hasBefore = visual.beforeCode !== undefined;
  const hasAfter = visual.afterCode !== undefined;
  if (hasBefore !== hasAfter) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasBefore ? 'afterCode' : 'beforeCode'],
      message: hasBefore ? 'beforeCode 与 afterCode 必须同时提供（缺少 afterCode）' : 'beforeCode 与 afterCode 必须同时提供（缺少 beforeCode）',
    });
  }
  if (visual.mode === 'diff' && hasBefore && hasAfter && visual.code !== visual.afterCode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['code'],
      message: 'diff 模式下 visual.code 必须等于 afterCode',
    });
  }
});

export type CodeBeat = z.infer<typeof CodeBeatSchema>;
export type CodeBuildStep = z.infer<typeof CodeBuildStepSchema>;
export type CodeTraceStateEntry = z.infer<typeof CodeTraceStateEntrySchema>;
export type CodeTraceStep = z.infer<typeof CodeTraceStepSchema>;
export type CodeDiffBeat = z.infer<typeof CodeDiffBeatSchema>;
export type CodeVisual = z.infer<typeof CodeVisualSchema>;

/** Line numbers are 1-based; `\r\n?` is normalised and a trailing newline adds no empty line. */
export function codeLines(code: string): string[] {
  if (typeof code !== 'string' || !code.length) return [];
  const lines = code.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Safely read the code structure out of a generic scene visual.
 *
 * A fully valid payload is returned as parsed (including `mode` and the advanced data). When the
 * strict parse fails, the payload is *reduced* to the V1.6.8 focus shape (`code/language/filename/
 * beats`, no `mode`, no advanced fields) and re-validated: a scene with broken advanced data then
 * degrades to a plain focus scene instead of disappearing. A payload whose basic code/beat data is
 * itself invalid still returns null. This function never throws — renderers call it every frame.
 */
export function codeVisualOf(visual: Record<string, unknown> | undefined): CodeVisual | null {
  if (!visual || typeof visual !== 'object' || Array.isArray(visual)) return null;
  const parsed = CodeVisualSchema.safeParse(visual);
  if (parsed.success) return parsed.data;
  // Focus recovery: only the original V1.6.8 fields survive, so an invalid `mode`/`beforeCode`/
  // `buildSteps`/… can never leak into the fallback object.
  const focused: Record<string, unknown> = { code: (visual as Record<string, unknown>).code };
  for (const key of ['language', 'filename', 'beats'] as const) {
    if (Object.hasOwn(visual, key)) focused[key] = (visual as Record<string, unknown>)[key];
  }
  const recovered = CodeVisualSchema.safeParse(focused);
  return recovered.success ? recovered.data : null;
}
