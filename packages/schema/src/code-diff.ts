import { codeLines } from './code-visual';

/**
 * Deterministic unified-diff computation for `mode: 'diff'` code scenes (#26).
 *
 * The model never produces `+`/`-` text: it returns the real `beforeCode`/`afterCode` sources and
 * this module derives the line-level diff. Same input ⇒ same output (no randomness, no libraries),
 * so a scene renders identically on every frame and in both the Standard and HTML renderers.
 */

export type CodeDiffLineKind = 'context' | 'add' | 'remove';

export type CodeDiffLine = {
  kind: CodeDiffLineKind;
  /** Present for `context` and `remove` lines (1-based line number in `beforeCode`). */
  oldLine?: number;
  /** Present for `context` and `add` lines (1-based line number in `afterCode`). */
  newLine?: number;
  /** The raw source line, without a trailing newline. */
  text: string;
};

export type CodeDiffHunk = {
  /** `h1`, `h2`, … in document order. */
  id: string;
  /** Inclusive start index into the full `CodeDiffLine[]`. */
  startIndex: number;
  /** Inclusive end index into the full `CodeDiffLine[]`. */
  endIndex: number;
  /** Old-side line number of the hunk's first old-side line; 0 when the hunk has no old side. */
  oldStart: number;
  /** New-side line number of the hunk's first new-side line; 0 when the hunk has no new side. */
  newStart: number;
  addCount: number;
  removeCount: number;
  lines: CodeDiffLine[];
};

const DEFAULT_CONTEXT = 3;
const MAX_CONTEXT = 10;
/** 32 views is far more than one code scene needs (one view per distinct before/after pair). */
const CACHE_CAPACITY = 32;
/** Above this many DP cells the deterministic prefix/suffix fallback is used instead. */
const MAX_DP_CELLS = 4_000_000;

type CodeDiffView = { lines: CodeDiffLine[]; hunks: CodeDiffHunk[]; hasChanges: boolean };

const cache = new Map<string, CodeDiffView>();
let cacheHits = 0;
let cacheMisses = 0;

function safeLines(value: unknown): string[] {
  return codeLines(typeof value === 'string' ? value : '');
}

function resolveContext(context: number | undefined): number {
  if (typeof context !== 'number' || !Number.isInteger(context)) return DEFAULT_CONTEXT;
  return context >= 0 && context <= MAX_CONTEXT ? context : DEFAULT_CONTEXT;
}

function contextLine(text: string, oldLine: number, newLine: number): CodeDiffLine {
  return { kind: 'context', oldLine, newLine, text };
}

function removeLine(text: string, oldLine: number): CodeDiffLine {
  return { kind: 'remove', oldLine, text };
}

function addLine(text: string, newLine: number): CodeDiffLine {
  return { kind: 'add', newLine, text };
}

/** Longest-common-subsequence walk over one changed block; removals come before additions. */
function diffMiddle(before: string[], after: string[], oldBase: number, newBase: number): CodeDiffLine[] {
  const beforeLines = before;
  const afterLines = after;
  const rows = beforeLines.length;
  const columns = afterLines.length;
  const lines: CodeDiffLine[] = [];
  if (!rows && !columns) return lines;
  if (rows * columns > MAX_DP_CELLS) {
    // Defensive fallback for pathological inputs: the whole block is a replacement.
    for (let index = 0; index < rows; index += 1) lines.push(removeLine(beforeLines[index], oldBase + index + 1));
    for (let index = 0; index < columns; index += 1) lines.push(addLine(afterLines[index], newBase + index + 1));
    return lines;
  }
  const dp: Int32Array[] = Array.from({ length: rows + 1 }, () => new Int32Array(columns + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      dp[i][j] = beforeLines[i] === afterLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (beforeLines[i] === afterLines[j]) {
      lines.push(contextLine(beforeLines[i], oldBase + i + 1, newBase + j + 1));
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(removeLine(beforeLines[i], oldBase + i + 1));
      i += 1;
    } else {
      lines.push(addLine(afterLines[j], newBase + j + 1));
      j += 1;
    }
  }
  for (; i < rows; i += 1) lines.push(removeLine(beforeLines[i], oldBase + i + 1));
  for (; j < columns; j += 1) lines.push(addLine(afterLines[j], newBase + j + 1));
  return lines;
}

/**
 * Compute the complete unified line sequence of `before` → `after`.
 *
 * Unchanged lines are `context` (both line numbers), lines only in `after` are `add` (new line
 * number only) and lines only in `before` are `remove` (old line number only). Removals keep the
 * natural unified-diff placement (before the matching additions) and every line number is 1-based
 * and continuous on its own side. Non-string inputs are treated as empty strings — never throws.
 */
export function computeCodeDiff(before: string, after: string): CodeDiffLine[] {
  const beforeLines = safeLines(before);
  const afterLines = safeLines(after);
  // A shared prefix/suffix is always context; trimming it keeps the LCS table small and makes the
  // common "one small change in a long file" case cheap.
  let prefix = 0;
  while (
    prefix < beforeLines.length
    && prefix < afterLines.length
    && beforeLines[prefix] === afterLines[prefix]
  ) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix += 1;
  const lines: CodeDiffLine[] = [];
  for (let index = 0; index < prefix; index += 1) lines.push(contextLine(beforeLines[index], index + 1, index + 1));
  lines.push(...diffMiddle(
    beforeLines.slice(prefix, beforeLines.length - suffix),
    afterLines.slice(prefix, afterLines.length - suffix),
    prefix,
    prefix,
  ));
  const beforeSuffixStart = beforeLines.length - suffix;
  const afterSuffixStart = afterLines.length - suffix;
  for (let index = 0; index < suffix; index += 1) {
    lines.push(contextLine(beforeLines[beforeSuffixStart + index], beforeSuffixStart + index + 1, afterSuffixStart + index + 1));
  }
  return lines;
}

/**
 * Group a diff line sequence into unified hunks.
 *
 * `context` is the number of unchanged lines kept on each side of a change block (default 3,
 * clamped to 0..10). Two adjacent change blocks merge unless more than `2 × context` unchanged
 * lines separate them; each hunk keeps at most `context` lines around its first/last change.
 * Ids are `h1..hN` in order and `startIndex`/`endIndex` are inclusive indices into `lines`.
 */
export function groupCodeDiffHunks(lines: CodeDiffLine[], context?: number): CodeDiffHunk[] {
  if (!Array.isArray(lines) || !lines.length) return [];
  const resolvedContext = resolveContext(context);
  const changeIndices: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (line && line.kind !== 'context') changeIndices.push(index);
  }
  if (!changeIndices.length) return [];
  const blocks: Array<[number, number]> = [];
  let blockStart = changeIndices[0];
  let previous = changeIndices[0];
  for (const index of changeIndices.slice(1)) {
    // Split only when more than `2 × context` unchanged lines sit between the two change blocks.
    if (index - previous - 1 > resolvedContext * 2) {
      blocks.push([blockStart, previous]);
      blockStart = index;
    }
    previous = index;
  }
  blocks.push([blockStart, previous]);
  const lastIndex = lines.length - 1;
  return blocks.map(([firstChange, lastChange], blockIndex) => {
    const startIndex = Math.max(0, firstChange - resolvedContext);
    const endIndex = Math.min(lastIndex, lastChange + resolvedContext);
    const hunkLines = lines.slice(startIndex, endIndex + 1);
    let oldStart = 0;
    let newStart = 0;
    let addCount = 0;
    let removeCount = 0;
    for (const line of hunkLines) {
      if (line.kind === 'add') addCount += 1;
      if (line.kind === 'remove') removeCount += 1;
      if (!oldStart && line.oldLine !== undefined) oldStart = line.oldLine;
      if (!newStart && line.newLine !== undefined) newStart = line.newLine;
    }
    return {
      id: `h${blockIndex + 1}`,
      startIndex,
      endIndex,
      oldStart,
      newStart,
      addCount,
      removeCount,
      lines: hunkLines,
    };
  });
}

function cacheKey(before: string, after: string, context: number): string {
  return `${before}\u0000${after}\u0000${context}`;
}

/**
 * Cached diff view for one renderer frame.
 *
 * The cache is a 32-entry FIFO map keyed by `before\0after\0context`, so both renderers and every
 * frame of one scene reuse a single computation. `clearCodeDiffCache()` empties it and resets the
 * hit/miss counters; `codeDiffCacheStats()` reports them (size never exceeds capacity).
 */
export function computeCodeDiffView(before: string, after: string, context?: number): CodeDiffView {
  const safeBefore = typeof before === 'string' ? before : '';
  const safeAfter = typeof after === 'string' ? after : '';
  const resolvedContext = resolveContext(context);
  const key = cacheKey(safeBefore, safeAfter, resolvedContext);
  const cached = cache.get(key);
  if (cached) {
    cacheHits += 1;
    return cached;
  }
  cacheMisses += 1;
  const lines = computeCodeDiff(safeBefore, safeAfter);
  const view: CodeDiffView = {
    lines,
    hunks: groupCodeDiffHunks(lines, resolvedContext),
    hasChanges: lines.some(line => line.kind !== 'context'),
  };
  cache.set(key, view);
  while (cache.size > CACHE_CAPACITY) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return view;
}

/** Drop every cached diff view and reset the statistics. */
export function clearCodeDiffCache(): void {
  cache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

/** Current cache counters; `size <= capacity` always holds. */
export function codeDiffCacheStats(): { hits: number; misses: number; size: number; capacity: number } {
  return { hits: cacheHits, misses: cacheMisses, size: cache.size, capacity: CACHE_CAPACITY };
}
