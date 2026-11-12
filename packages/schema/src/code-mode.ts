import {
  CodeVisualSchema,
  codeLines,
  codeVisualOf,
  type CodeTraceStateEntry,
  type CodeVisual,
} from './code-visual';
import {
  computeCodeDiffView,
  type CodeDiffHunk,
  type CodeDiffLine,
} from './code-diff';

/**
 * Renderable code scene modes (#24).
 *
 * `focus` is the V1.6.x default; `build` (#25), `diff` (#26) and `trace` (#27) only render when
 * their structured data is complete and verifiable. Everything in this module is pure and
 * synchronous and may be called every frame — invalid data always falls back to `focus`.
 */

export type CodeSceneMode = 'focus' | 'build' | 'diff' | 'trace';

/** Fixed mode order shared by tests/prompt rules. */
export const CODE_SCENE_MODES: readonly CodeSceneMode[] = ['focus', 'build', 'diff', 'trace'];

export type ResolvedCodeBuildStep = {
  revealLines: number[];
  focusLines: number[];
  label?: string;
  narrationText?: string;
};

export type ResolvedCodeTraceStep = {
  lines: number[];
  label?: string;
  narrationText?: string;
  state?: CodeTraceStateEntry[];
  output?: string;
  callDepth?: number;
};

export type ResolvedCodeDiffBeat = { hunkIds: string[]; label?: string; narrationText?: string };

export type ResolvedCodeDiffView = {
  lines: CodeDiffLine[];
  hunks: CodeDiffHunk[];
  beats: ResolvedCodeDiffBeat[];
};

/** Advanced visual fields that only make sense for build/diff/trace. */
const ADVANCED_VISUAL_KEYS = ['beforeCode', 'afterCode', 'buildSteps', 'diffBeats', 'traceSteps'] as const;

function hasAdvancedFields(visual: Record<string, unknown>): boolean {
  return ADVANCED_VISUAL_KEYS.some(key => Object.hasOwn(visual, key));
}

/** Ascending, de-duplicated valid line numbers; null when any entry is not a 1..total line. */
function normalizeLines(lines: unknown, totalLines: number): number[] | null {
  if (!Array.isArray(lines) || !lines.length) return null;
  const seen = new Set<number>();
  for (const line of lines) {
    if (!Number.isInteger(line) || (line as number) < 1 || (line as number) > totalLines) return null;
    seen.add(line as number);
  }
  return [...seen].sort((a, b) => a - b);
}

function includeIfDefined<T>(record: Record<string, T>, key: string, value: T | undefined): void {
  if (value !== undefined) record[key] = value;
}

/**
 * Resolve the *renderable* mode of a code visual.
 *
 * `null`/missing/`focus` → `focus`; an advanced mode only stays selected when its data is complete
 * (`build` needs full reveal coverage, `diff` needs real before/after with actual changes and
 * `code === afterCode`, `trace` needs valid trace steps). Never throws.
 */
export function resolveCodeSceneMode(visual: CodeVisual | null): CodeSceneMode {
  if (!visual || typeof visual !== 'object') return 'focus';
  switch (visual.mode) {
    case 'build': return resolveCodeBuildSteps(visual) ? 'build' : 'focus';
    case 'trace': return resolveCodeTraceSteps(visual) ? 'trace' : 'focus';
    case 'diff': return resolveCodeDiffView(visual) ? 'diff' : 'focus';
    default: return 'focus';
  }
}

/**
 * Normalise build steps for rendering.
 *
 * Requires `mode === 'build'`, 1..12 steps whose `revealLines` are valid 1..N lines and whose union
 * covers the whole source; otherwise null (the caller then renders `focus`). `revealLines`/
 * `focusLines` are returned ascending and de-duplicated, and a missing `focusLines` defaults to
 * that step's `revealLines` (the schema never rewrites data — this resolver does).
 */
export function resolveCodeBuildSteps(visual: CodeVisual | null): ResolvedCodeBuildStep[] | null {
  if (!visual || typeof visual !== 'object' || visual.mode !== 'build') return null;
  const steps = visual.buildSteps;
  if (!Array.isArray(steps) || !steps.length || steps.length > 12) return null;
  const totalLines = codeLines(typeof visual.code === 'string' ? visual.code : '').length;
  if (!totalLines) return null;
  const covered = new Set<number>();
  const resolved: ResolvedCodeBuildStep[] = [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') return null;
    const revealLines = normalizeLines(step.revealLines, totalLines);
    if (!revealLines) return null;
    const focusLines = step.focusLines === undefined ? [...revealLines] : normalizeLines(step.focusLines, totalLines);
    if (!focusLines) return null;
    for (const line of revealLines) covered.add(line);
    const entry: ResolvedCodeBuildStep = { revealLines, focusLines };
    if (step.label) entry.label = step.label;
    if (step.narrationText) entry.narrationText = step.narrationText;
    resolved.push(entry);
  }
  if (covered.size !== totalLines) return null;
  return resolved;
}

/**
 * Normalise trace steps for rendering.
 *
 * Requires `mode === 'trace'` and 1..20 steps with valid 1..N lines; `lines` are ascending and
 * de-duplicated, `state`/`output`/`callDepth` are copied as provided (they are facts of the source
 * material, never invented here). Invalid data returns null → `focus`.
 */
export function resolveCodeTraceSteps(visual: CodeVisual | null): ResolvedCodeTraceStep[] | null {
  if (!visual || typeof visual !== 'object' || visual.mode !== 'trace') return null;
  const steps = visual.traceSteps;
  if (!Array.isArray(steps) || !steps.length || steps.length > 20) return null;
  const totalLines = codeLines(typeof visual.code === 'string' ? visual.code : '').length;
  if (!totalLines) return null;
  const resolved: ResolvedCodeTraceStep[] = [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') return null;
    const lines = normalizeLines(step.lines, totalLines);
    if (!lines) return null;
    const entry: ResolvedCodeTraceStep = { lines };
    if (step.label) entry.label = step.label;
    if (step.narrationText) entry.narrationText = step.narrationText;
    if (Array.isArray(step.state)) {
      entry.state = step.state
        .filter(item => Boolean(item) && typeof item.name === 'string' && item.name.length > 0 && typeof item.value === 'string')
        .map(item => {
          const state: CodeTraceStateEntry = { name: item.name, value: item.value };
          if (typeof item.changed === 'boolean') state.changed = item.changed;
          return state;
        });
    }
    if (typeof step.output === 'string') entry.output = step.output;
    if (typeof step.callDepth === 'number' && Number.isInteger(step.callDepth) && step.callDepth >= 0 && step.callDepth <= 20) entry.callDepth = step.callDepth;
    resolved.push(entry);
  }
  return resolved;
}

/**
 * Resolve the diff view of a `mode: 'diff'` visual.
 *
 * Requires real `beforeCode`/`afterCode`, `code === afterCode` and at least one change. Beats come
 * from `diffBeats`, keeping only entries whose every hunk id exists (de-duplicated, in order); when
 * no entry survives (or `diffBeats` is absent) every hunk gets one default beat `h1..hN`.
 */
export function resolveCodeDiffView(visual: CodeVisual | null): ResolvedCodeDiffView | null {
  if (!visual || typeof visual !== 'object' || visual.mode !== 'diff') return null;
  const beforeCode = visual.beforeCode;
  const afterCode = visual.afterCode;
  if (typeof beforeCode !== 'string' || !beforeCode || typeof afterCode !== 'string' || !afterCode) return null;
  if (visual.code !== afterCode) return null;
  const view = computeCodeDiffView(beforeCode, afterCode);
  if (!view.hasChanges) return null;
  const hunkIds = new Set(view.hunks.map(hunk => hunk.id));
  const rawBeats = Array.isArray(visual.diffBeats) ? visual.diffBeats : [];
  const beats: ResolvedCodeDiffBeat[] = [];
  for (const beat of rawBeats) {
    if (!beat || typeof beat !== 'object' || !Array.isArray(beat.hunkIds)) continue;
    const selected = [...new Set(beat.hunkIds.filter((id): id is string => typeof id === 'string' && hunkIds.has(id)))];
    if (!selected.length) continue;
    const entry: ResolvedCodeDiffBeat = { hunkIds: selected };
    if (beat.label) entry.label = beat.label;
    if (beat.narrationText) entry.narrationText = beat.narrationText;
    beats.push(entry);
  }
  const resolvedBeats = beats.length ? beats : view.hunks.map(hunk => ({ hunkIds: [hunk.id] }));
  return { lines: view.lines, hunks: view.hunks, beats: resolvedBeats };
}

function focusVisualOf(visual: CodeVisual): Record<string, unknown> {
  const output: Record<string, unknown> = { code: visual.code };
  includeIfDefined(output, 'language', visual.language);
  includeIfDefined(output, 'filename', visual.filename);
  if (visual.beats !== undefined) output.beats = visual.beats;
  output.mode = 'focus';
  return output;
}

/**
 * Generation-time normalisation for the pipeline (#24).
 *
 * Returns an object that can be written straight into `scene.visual`; it never throws and never
 * mutates its input. Strictly valid focus data without advanced fields is returned *as-is* so
 * existing behaviour (`#16-3`: "visual 完整保留") is untouched. Invalid advanced data degrades to a
 * `focus` object without `mode`/advanced fields, and data whose basic fields are invalid is returned
 * unchanged so `SceneSchema` reports the real problem.
 */
export function normalizeCodeVisualInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input as Record<string, unknown>;
  const record = input as Record<string, unknown>;
  if (typeof record.code !== 'string' || !record.code) return input as Record<string, unknown>;

  // A model may redundantly repeat the post-change source; repair it before validation so the
  // `code === afterCode` contract holds and the rendered scene matches the diff.
  let source: Record<string, unknown> = record;
  if (
    record.mode === 'diff'
    && typeof record.afterCode === 'string'
    && record.afterCode.length > 0
    && record.code !== record.afterCode
  ) {
    source = { ...record, code: record.afterCode };
  }

  const parsed = CodeVisualSchema.safeParse(source);
  if (parsed.success) {
    const visual = parsed.data;
    const mode = resolveCodeSceneMode(visual);
    if (mode === 'focus') {
      const noMode = record.mode === undefined || record.mode === 'focus';
      if (noMode && !hasAdvancedFields(record)) return record;
      return focusVisualOf(visual);
    }
    if (mode === 'build') {
      const output: Record<string, unknown> = { code: visual.code };
      includeIfDefined(output, 'language', visual.language);
      includeIfDefined(output, 'filename', visual.filename);
      output.mode = 'build';
      output.buildSteps = visual.buildSteps;
      return output;
    }
    if (mode === 'diff') {
      const output: Record<string, unknown> = { code: visual.code };
      includeIfDefined(output, 'language', visual.language);
      includeIfDefined(output, 'filename', visual.filename);
      output.mode = 'diff';
      output.beforeCode = visual.beforeCode;
      output.afterCode = visual.afterCode;
      if (visual.diffBeats !== undefined) output.diffBeats = visual.diffBeats;
      return output;
    }
    const output: Record<string, unknown> = { code: visual.code };
    includeIfDefined(output, 'language', visual.language);
    includeIfDefined(output, 'filename', visual.filename);
    output.mode = 'trace';
    output.traceSteps = visual.traceSteps;
    return output;
  }

  // Strict parse failed: recover the V1.6.8 focus shape when the basic fields are still valid.
  const recovered = codeVisualOf(source);
  if (recovered) return { ...recovered, mode: 'focus' };
  return input as Record<string, unknown>;
}
