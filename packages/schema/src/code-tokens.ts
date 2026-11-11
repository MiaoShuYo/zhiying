import { codeLines } from './code-visual';

/**
 * Deterministic, dependency-free code tokenizer.
 *
 * The Standard and the HTML CodeScene renderers both ask for the same source tokens every frame,
 * so the result is cached per (normalized language, source). The tokenizer itself is deliberately
 * small and offline: it does not aim at full language grammars, only at the token classes the
 * theme needs (keyword / string / comment / number / function / variable / punctuation), and it
 * must never throw — a broken input simply degrades to plain text.
 */

export type CodeTokenType =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'function'
  | 'variable'
  | 'punctuation';

export type CodeToken = { text: string; type: CodeTokenType };
export type CodeLineTokens = { lineNumber: number; tokens: CodeToken[] };

type LanguageKind = 'js' | 'python' | 'json' | 'plain';

type LineMode =
  | { kind: 'code' }
  | { kind: 'comment' }
  | { kind: 'template' }
  | { kind: 'triple'; quote: string };

const CACHE_CAPACITY = 64;
const cache = new Map<string, CodeLineTokens[]>();
const counters = { hits: 0, misses: 0 };

const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'class', 'extends', 'implements', 'interface', 'type', 'enum', 'namespace', 'declare', 'abstract', 'readonly',
  'import', 'export', 'from', 'as', 'satisfies', 'keyof', 'async', 'await', 'new', 'try', 'catch', 'finally',
  'throw', 'typeof', 'instanceof', 'in', 'of', 'this', 'super', 'void', 'delete', 'yield', 'break', 'continue',
  'public', 'private', 'protected', 'static', 'get', 'set', 'null', 'undefined', 'true', 'false',
]);

const PYTHON_KEYWORDS = new Set([
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'with', 'try',
  'except', 'finally', 'raise', 'pass', 'break', 'continue', 'lambda', 'None', 'True', 'False', 'and', 'or',
  'not', 'in', 'is', 'yield', 'global', 'nonlocal', 'del', 'assert', 'async', 'await',
]);

const JSON_KEYWORDS = new Set(['true', 'false', 'null']);

const IDENTIFIER_START = /[\p{L}_$]/u;
const IDENTIFIER_PART = /[\p{L}\p{N}_$]/u;
const NUMBER_PATTERN = /^(?:0[xX][0-9a-fA-F]+n?|0[bB][01]+n?|0[oO][0-7]+n?|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?n?)/;
const PUNCTUATION = new Set(['{', '}', '[', ']', '(', ')', ':', ';', ',', '.', '<', '>', '=', '+', '-', '*', '/', '%', '!', '&', '|', '?', '~', '^', '@', '#']);

/** Normalize the model-provided language name to the tokenizer subset; unknown means plain text. */
function languageOf(language?: string): LanguageKind {
  const key = typeof language === 'string' ? language.trim().toLowerCase() : '';
  if (key === 'ts' || key === 'typescript' || key === 'tsx' || key === 'js' || key === 'javascript' || key === 'jsx' || key === 'mjs' || key === 'cjs') return 'js';
  if (key === 'python' || key === 'py') return 'python';
  if (key === 'json') return 'json';
  return 'plain';
}

/** Index of the next unescaped `quote` at or after `start`, or -1 when the literal stays open. */
function findClosingQuote(line: string, start: number, quote: string): number {
  let index = start;
  while (index < line.length) {
    if (line[index] === '\\') {
      index += 2;
      continue;
    }
    if (line.startsWith(quote, index)) return index;
    index += 1;
  }
  return -1;
}

function pushToken(tokens: CodeToken[], text: string, type: CodeTokenType): void {
  if (text) tokens.push({ text, type });
}

function lexLine(
  line: string,
  kind: LanguageKind,
  keywords: Set<string> | null,
  state: { mode: LineMode },
): CodeToken[] {
  const tokens: CodeToken[] = [];
  let index = 0;
  while (index < line.length) {
    const mode = state.mode;
    if (mode.kind === 'comment') {
      const end = line.indexOf('*/', index);
      if (end === -1) {
        pushToken(tokens, line.slice(index), 'comment');
        index = line.length;
        continue;
      }
      pushToken(tokens, line.slice(index, end + 2), 'comment');
      index = end + 2;
      state.mode = { kind: 'code' };
      continue;
    }
    if (mode.kind === 'template') {
      const end = findClosingQuote(line, index, '`');
      if (end === -1) {
        pushToken(tokens, line.slice(index), 'string');
        index = line.length;
        continue;
      }
      pushToken(tokens, line.slice(index, end + 1), 'string');
      index = end + 1;
      state.mode = { kind: 'code' };
      continue;
    }
    if (mode.kind === 'triple') {
      const end = findClosingQuote(line, index, mode.quote);
      if (end === -1) {
        pushToken(tokens, line.slice(index), 'string');
        index = line.length;
        continue;
      }
      pushToken(tokens, line.slice(index, end + mode.quote.length), 'string');
      index = end + mode.quote.length;
      state.mode = { kind: 'code' };
      continue;
    }

    const char = line[index];
    // Whitespace (never includes a line break: the input is already split into lines).
    if (/\s/.test(char)) {
      let end = index + 1;
      while (end < line.length && /\s/.test(line[end])) end += 1;
      pushToken(tokens, line.slice(index, end), 'plain');
      index = end;
      continue;
    }
    // Line comments.
    if (kind === 'js' && char === '/' && line[index + 1] === '/') {
      pushToken(tokens, line.slice(index), 'comment');
      index = line.length;
      continue;
    }
    // Block comments: emit the visible part, remember the open state for the next line.
    if (kind === 'js' && char === '/' && line[index + 1] === '*') {
      const end = line.indexOf('*/', index + 2);
      if (end === -1) {
        pushToken(tokens, line.slice(index), 'comment');
        state.mode = { kind: 'comment' };
        index = line.length;
        continue;
      }
      pushToken(tokens, line.slice(index, end + 2), 'comment');
      index = end + 2;
      continue;
    }
    if (kind === 'python' && char === '#') {
      pushToken(tokens, line.slice(index), 'comment');
      index = line.length;
      continue;
    }
    // Python triple-quoted strings (may span lines).
    if (kind === 'python' && (line.startsWith('"""', index) || line.startsWith("'''", index))) {
      const quote = line.startsWith('"""', index) ? '"""' : "'''";
      const end = findClosingQuote(line, index + 3, quote);
      if (end === -1) {
        pushToken(tokens, line.slice(index), 'string');
        state.mode = { kind: 'triple', quote };
        index = line.length;
        continue;
      }
      pushToken(tokens, line.slice(index, end + quote.length), 'string');
      index = end + quote.length;
      continue;
    }
    // JS/TS template strings (may span lines).
    if (kind === 'js' && char === '`') {
      const end = findClosingQuote(line, index + 1, '`');
      if (end === -1) {
        pushToken(tokens, line.slice(index), 'string');
        state.mode = { kind: 'template' };
        index = line.length;
        continue;
      }
      pushToken(tokens, line.slice(index, end + 1), 'string');
      index = end + 1;
      continue;
    }
    // Single/double-quoted strings (JSON keys included).
    if (char === "'" || char === '"') {
      const end = findClosingQuote(line, index + 1, char);
      if (end === -1) {
        pushToken(tokens, line.slice(index), 'string');
        index = line.length;
        continue;
      }
      pushToken(tokens, line.slice(index, end + 1), 'string');
      index = end + 1;
      continue;
    }
    // Numbers: decimal, float, hex, binary, octal and scientific notation.
    if (/\d/.test(char) || (char === '.' && /\d/.test(line[index + 1] ?? ''))) {
      const match = NUMBER_PATTERN.exec(line.slice(index));
      if (match) {
        pushToken(tokens, match[0], 'number');
        index += match[0].length;
        continue;
      }
    }
    // Identifiers: keyword, call/definition name, or plain variable.
    if (IDENTIFIER_START.test(char)) {
      let end = index + 1;
      while (end < line.length && IDENTIFIER_PART.test(line[end])) end += 1;
      const word = line.slice(index, end);
      if (keywords && keywords.has(word)) {
        pushToken(tokens, word, 'keyword');
        index = end;
        continue;
      }
      let probe = end;
      while (probe < line.length && /[ \t]/.test(line[probe])) probe += 1;
      pushToken(tokens, word, line[probe] === '(' ? 'function' : 'variable');
      index = end;
      continue;
    }
    if (PUNCTUATION.has(char)) {
      pushToken(tokens, char, 'punctuation');
      index += 1;
      continue;
    }
    pushToken(tokens, char, 'plain');
    index += 1;
  }
  return tokens;
}

function tokenizeCodeUncached(code: string, kind: LanguageKind): CodeLineTokens[] {
  const sourceLines = codeLines(code);
  const keywords = kind === 'js' ? JS_KEYWORDS : kind === 'python' ? PYTHON_KEYWORDS : kind === 'json' ? JSON_KEYWORDS : null;
  const state: { mode: LineMode } = { mode: { kind: 'code' } };
  return sourceLines.map((line, index) => ({
    lineNumber: index + 1,
    tokens: line.length ? lexLine(line, kind, keywords, state) : [],
  }));
}

/** Plain-text tokens for one code block; never cached (used for the disabled/broken fallback). */
export function plainCodeTokens(code: string): CodeLineTokens[] {
  if (typeof code !== 'string' || !code.length) return [];
  return codeLines(code).map((line, index) => ({
    lineNumber: index + 1,
    tokens: line.length ? [{ text: line, type: 'plain' as const }] : [],
  }));
}

/**
 * Tokenize a code block, memoized per normalized language + source.
 *
 * The cache is a 64-entry FIFO: one full tokenization per scene (shared by both renderers and all
 * frames), evicted oldest-first so a long-running process cannot grow without bound. Any internal
 * failure falls back to `plainCodeTokens` and still satisfies every line invariant.
 */
export function tokenizeCode(code: string, language?: string): CodeLineTokens[] {
  try {
    if (typeof code !== 'string') return [];
    const kind = languageOf(language);
    const key = `${kind}\u0000${code}`;
    const cached = cache.get(key);
    if (cached) {
      counters.hits += 1;
      return cached;
    }
    counters.misses += 1;
    const result = kind === 'plain' ? plainCodeTokens(code) : tokenizeCodeUncached(code, kind);
    cache.set(key, result);
    while (cache.size > CACHE_CAPACITY) {
      const oldest = cache.keys().next().value;
      if (typeof oldest !== 'string') break;
      cache.delete(oldest);
    }
    return result;
  } catch {
    return plainCodeTokens(code);
  }
}

/** Drop every cached tokenization and reset the hit/miss counters (test isolation, hot reload). */
export function clearCodeTokenCache(): void {
  cache.clear();
  counters.hits = 0;
  counters.misses = 0;
}

/** Cache observability for tests and diagnostics; `size` never exceeds `capacity`. */
export function codeTokenCacheStats(): { hits: number; misses: number; size: number; capacity: number } {
  return { hits: counters.hits, misses: counters.misses, size: cache.size, capacity: CACHE_CAPACITY };
}
