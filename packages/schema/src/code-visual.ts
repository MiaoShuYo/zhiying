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

/** Structured payload of a `type: 'code'` scene, shared by the Standard and HTML renderers. */
export const CodeVisualSchema = z.object({
  code: z.string().min(1).max(8000),
  language: z.string().min(1).max(30).optional(),
  filename: z.string().min(1).max(100).optional(),
  mode: z.enum(['focus', 'build', 'diff', 'trace']).optional(),
  beats: z.array(CodeBeatSchema).max(10).optional(),
}).superRefine((visual, ctx) => {
  const totalLines = codeLines(visual.code).length;
  for (const [beatIndex, beat] of (visual.beats ?? []).entries()) {
    const seen = new Set<number>();
    for (const [lineIndex, line] of beat.lines.entries()) {
      if (line > totalLines) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['beats', beatIndex, 'lines', lineIndex],
          message: `代码行号 ${line} 超出代码总行数 ${totalLines}`,
        });
      }
      if (seen.has(line)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['beats', beatIndex, 'lines', lineIndex],
          message: `代码行号 ${line} 重复`,
        });
      }
      seen.add(line);
    }
  }
});

export type CodeBeat = z.infer<typeof CodeBeatSchema>;
export type CodeVisual = z.infer<typeof CodeVisualSchema>;

/** Line numbers are 1-based; `\r\n?` is normalised and a trailing newline adds no empty line. */
export function codeLines(code: string): string[] {
  if (typeof code !== 'string' || !code.length) return [];
  const lines = code.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Safely read the code structure out of a generic scene visual; invalid payloads return null. */
export function codeVisualOf(visual: Record<string, unknown> | undefined): CodeVisual | null {
  if (!visual || typeof visual !== 'object' || Array.isArray(visual)) return null;
  const parsed = CodeVisualSchema.safeParse(visual);
  return parsed.success ? parsed.data : null;
}
