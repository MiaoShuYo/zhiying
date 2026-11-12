import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import {
  codeLines,
  codeVisualOf,
  plainCodeTokens,
  resolveCodeBeatTimeline,
  resolveCodeBuildStepTimeline,
  resolveCodeBuildSteps,
  resolveCodeDiffBeatTimeline,
  resolveCodeDiffView,
  resolveCodeSceneMode,
  resolveCodeScrollKeyframes,
  resolveCodeTraceStepTimeline,
  resolveCodeTraceSteps,
  resolveCodeVisibleLineCount,
  tokenizeCode,
  type CodeBeat,
  type CodeBeatFrame,
  type CodeBuildStepFrame,
  type CodeDiffBeatFrame,
  type CodeDiffHunk,
  type CodeDiffLine,
  type CodeLineTokens,
  type CodeSceneMode,
  type CodeScrollKeyframe,
  type CodeTraceStateEntry,
  type CodeVisual,
  type ResolvedCodeBuildStep,
  type ResolvedCodeDiffBeat,
  type ResolvedCodeTraceStep,
  type Scene,
  type Storyboard,
  type StyleId,
} from '@m2v/schema';
import { resolveCodeDiffColors, resolveCodeTokenColors } from '@m2v/styles';
import { resolveSceneTheme } from './theme';
import { CAPTION_EDGE_RATIO, CAPTION_LINE_HEIGHT, rendererScale } from './safe-area';

/** Non-focus code lines stay readable while receding behind the current beat. */
export const CODE_DIM_OPACITY = 0.38;

/** Monospace stack shared by the Standard renderer and the HTML renderer's font-family. */
export const CODE_MONO_FONT = '"JetBrains Mono", "SFMono-Regular", Consolas, Menlo, monospace';

/** The same stack with single-quoted names: safe inside a sanitized HTML `style` attribute. */
export const CODE_MONO_FONT_CSS = "'JetBrains Mono', SFMono-Regular, Consolas, Menlo, monospace";

const CODE_LINE_HEIGHT_RATIO = 1.5;
const LANDSCAPE_CODE_FONT = 26;
const PORTRAIT_CODE_FONT = 26;
const BEAT_CARD_HEIGHT = 132;
const LANDSCAPE_GEOMETRY = { outer: 44, header: 74, gap: 18 };
const PORTRAIT_GEOMETRY = { outer: 40, header: 84, gap: 16 };

/** The trace state panel (right on landscape, below the code on portrait). */
export type CodeTracePanelLayout = {
  placement: 'right' | 'below';
  widthPx: number;
  heightPx: number;
  topPx: number;
};

export type CodeSceneLayout = {
  stacked: boolean;
  codeArea: { widthPx: number; heightPx: number };
  beatCard: { placement: 'right' | 'bottom-right' | 'below'; widthPx: number; heightPx: number; topPx: number } | null;
  fontSizePx: number;
  lineHeightPx: number;
  visibleLineCount: number;
  maxTextWidthPx: number;
  /** Non-null only for `mode: 'trace'` with a visible state panel; `null` for every other mode. */
  tracePanel: CodeTracePanelLayout | null;
};

function safeDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Portrait/landscape specific code layout.
 *
 * Landscape keeps the beat card in a right-hand column capped at 32% so the code area never drops
 * below 68% of the frame; portrait stacks the header, code window and beat card so the code keeps
 * the full frame width. The card always stops above the caption safe area.
 *
 * `tracePanel` reserves the execution-state panel required by `mode: 'trace'`: a right-hand column
 * (width 28–34% of the frame) on landscape, a full-width row below the code window on portrait. It
 * is `null` in every other mode, so focus/build/diff numbers are byte-for-byte unchanged.
 */
export function resolveCodeSceneLayout(input: {
  width: number;
  height: number;
  hasBeats: boolean;
  hasBeatCard: boolean;
  captionReservedPx?: number;
  tracePanel?: boolean;
}): CodeSceneLayout {
  const valid = Number.isFinite(input.width) && input.width > 0 && Number.isFinite(input.height) && input.height > 0;
  const width = valid ? input.width : 1920;
  const height = valid ? input.height : 1080;
  const portrait = height > width;
  const scale = rendererScale(width, height) || (portrait ? width / 1080 : width / 1920);
  const geometry = portrait ? PORTRAIT_GEOMETRY : LANDSCAPE_GEOMETRY;
  const outer = geometry.outer * scale;
  const headerHeight = geometry.header * scale;
  const gap = geometry.gap * scale;
  const requestedReserved = input.captionReservedPx;
  const captionReservedPx = Number.isFinite(requestedReserved) ? Math.max(0, requestedReserved as number) : 0;
  const fontSizePx = Math.max(16 * scale, (portrait ? PORTRAIT_CODE_FONT : LANDSCAPE_CODE_FONT) * scale);
  const lineHeightPx = fontSizePx * CODE_LINE_HEIGHT_RATIO;
  const hasBeats = input.hasBeats === true;
  const showCard = hasBeats && input.hasBeatCard === true;
  const availableForCard = Math.max(0, height - captionReservedPx);
  const cardHeightPx = showCard ? Math.min(BEAT_CARD_HEIGHT * scale, availableForCard) : 0;
  const availableHeight = Math.max(0, height - outer * 2 - headerHeight - gap - captionReservedPx);
  const cardWidthPx = showCard && !portrait ? Math.min(0.32 * width, Math.max(0.24 * width, 0.28 * width)) : 0;
  let codeWidthPx = showCard && !portrait ? width - cardWidthPx : width;
  let codeHeightPx = portrait
    ? Math.max(1, availableHeight - (showCard ? cardHeightPx + gap : 0))
    : Math.max(1, availableHeight);
  const wantsTracePanel = input.tracePanel === true;
  let tracePanel: CodeTracePanelLayout | null = null;
  let beatCard: CodeSceneLayout['beatCard'] = null;
  if (wantsTracePanel) {
    if (portrait) {
      const panelHeightPx = Math.max(1, Math.min(0.34 * availableHeight, 0.34 * height));
      codeHeightPx = Math.max(1, availableHeight - (showCard ? cardHeightPx + gap : 0) - panelHeightPx - gap);
      const panelTopPx = outer + headerHeight + gap + codeHeightPx + gap;
      tracePanel = { placement: 'below', widthPx: width, heightPx: panelHeightPx, topPx: panelTopPx };
      if (showCard) {
        const rawTop = panelTopPx + panelHeightPx + gap;
        const topPx = Math.max(0, Math.min(rawTop, Math.max(0, availableForCard - cardHeightPx)));
        beatCard = { placement: 'below', widthPx: width, heightPx: cardHeightPx, topPx };
      }
    } else {
      // 0.32 × width is already inside [0.28, 0.34]; clamp keeps the contract explicit.
      const panelWidthPx = clamp(0.32 * width, 0.28 * width, 0.34 * width);
      codeWidthPx = Math.max(1, width - panelWidthPx - gap);
      codeHeightPx = Math.max(1, availableHeight - (showCard ? cardHeightPx + gap : 0));
      tracePanel = { placement: 'right', widthPx: panelWidthPx, heightPx: codeHeightPx, topPx: outer + headerHeight + gap };
      if (showCard) {
        const rawTop = outer + headerHeight + gap + codeHeightPx + gap;
        const topPx = Math.max(0, Math.min(rawTop, Math.max(0, availableForCard - cardHeightPx)));
        beatCard = { placement: 'below', widthPx: codeWidthPx, heightPx: cardHeightPx, topPx };
      }
    }
  } else {
    if (showCard) {
      const rawTop = portrait ? outer + headerHeight + gap + codeHeightPx + gap : outer + headerHeight + gap;
      const topPx = Math.max(0, Math.min(rawTop, Math.max(0, availableForCard - cardHeightPx)));
      beatCard = {
        placement: portrait ? 'below' : 'right',
        widthPx: portrait ? codeWidthPx : cardWidthPx,
        heightPx: cardHeightPx,
        topPx,
      };
    }
  }
  const visibleLineCount = resolveCodeVisibleLineCount({
    heightPx: codeHeightPx,
    fontSizePx,
    lineHeightRatio: CODE_LINE_HEIGHT_RATIO,
    portrait,
  });
  const maxTextWidthPx = Math.max(0, codeWidthPx - outer * 2);
  return {
    stacked: portrait,
    codeArea: { widthPx: codeWidthPx, heightPx: codeHeightPx },
    beatCard,
    fontSizePx,
    lineHeightPx,
    visibleLineCount,
    maxTextWidthPx,
    tracePanel,
  };
}

/** Token data shared by both code renderers, memoized by `tokenizeCode` per language + source. */
export function codeTokensFor(code: string, language: string | undefined, syntaxHighlight = true): CodeLineTokens[] {
  if (syntaxHighlight) {
    try {
      const tokenized = tokenizeCode(code, language);
      if (tokenized.length === codeLines(code).length) return tokenized;
    } catch {
      // Highlighting must never break a code scene: fall through to plain tokens.
    }
  }
  return plainCodeTokens(code);
}

/**
 * Token data of a scene's final source.
 *
 * Syntax highlighting defaults to on; when it is disabled, when the language is unknown or when the
 * tokenizer degrades, the renderer uses plain-text tokens. Line focus, the viewport window and the
 * line numbers never depend on this choice, so highlighting can never change scene timing.
 */
export function codeLineTokensFor(visual: CodeVisual | null, syntaxHighlight = true): CodeLineTokens[] {
  if (!visual) return [];
  return codeTokensFor(visual.code, visual.language, syntaxHighlight);
}

/** Fractional start line for smooth viewport scrolling (consumes `resolveCodeScrollKeyframes`). */
function scrolledStartLine(keyframes: CodeScrollKeyframe[], frame: number, totalLines: number): number {
  const clampLine = (value: number) => Math.min(Math.max(1, value), Math.max(1, totalLines));
  if (!keyframes.length) return 1;
  if (frame <= keyframes[0].frame) return clampLine(keyframes[0].startLine);
  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const from = keyframes[index];
    const to = keyframes[index + 1];
    if (frame >= from.frame && frame < to.frame) {
      if (to.frame === from.frame) return clampLine(to.startLine);
      const ratio = (frame - from.frame) / (to.frame - from.frame);
      return clampLine(from.startLine + (to.startLine - from.startLine) * ratio);
    }
  }
  return clampLine(keyframes[keyframes.length - 1].startLine);
}

/** Index of the step active at `frame`; before the first step it is 0, after the last it is N-1. */
function stepIndexAt(frames: Array<{ startFrame: number; endFrame: number }>, frame: number): number {
  if (!frames.length) return -1;
  const found = frames.findIndex(step => frame >= step.startFrame && frame < step.endFrame);
  if (found >= 0) return found;
  return frame < frames[0].startFrame ? 0 : frames.length - 1;
}

/** 0-based diff row indices covered by the given hunk ids, ascending and de-duplicated. */
function rowsForHunks(hunkIds: string[], hunks: CodeDiffHunk[]): number[] {
  const rows = new Set<number>();
  for (const id of hunkIds) {
    const hunk = hunks.find(candidate => candidate.id === id);
    if (!hunk) continue;
    for (let index = hunk.startIndex; index <= hunk.endIndex; index += 1) rows.add(index);
  }
  return [...rows].sort((a, b) => a - b);
}

export type CodeSceneDisplayRow = {
  /** 1-based display row (viewport coordinate): source line for focus/build/trace, diff row + 1 for diff. */
  rowNumber: number;
  text: string;
  active: boolean;
  dimmed: boolean;
  /** false for build rows that have not been revealed yet; always true in the other modes. */
  revealed: boolean;
  /** diff only. */
  kind?: 'context' | 'add' | 'remove';
  /** diff only. */
  oldLineNumber?: number;
  /** diff only. */
  newLineNumber?: number;
};

export type CodeSceneFrameStateInput = {
  scene: Scene;
  frame: number;
  width: number;
  height: number;
  /** Render fps; defaults to 30 so the deterministic view needs no Remotion context. */
  fps?: number;
  captionReservedPx?: number;
};

/**
 * Everything both code renderers derive for one frame.
 *
 * The Standard (`code-scene.tsx`) and HTML (`code-html-scene.tsx`) renderers consume this exact
 * structure, so the active mode, the step, the visible line window, the scroll offset, the diff
 * rows and the execution state can never drift between the two rendering modes.
 */
export type CodeSceneFrameState = {
  frame: number;
  width: number;
  height: number;
  portrait: boolean;
  scale: number;
  visual: CodeVisual | null;
  sourceLines: string[];
  totalLines: number;
  beats: CodeBeat[];
  hasBeats: boolean;
  hasBeatCard: boolean;
  captionReservedPx: number;
  layout: CodeSceneLayout;
  timeline: CodeBeatFrame[];
  keyframes: CodeScrollKeyframe[];
  currentBeat: CodeBeatFrame | undefined;
  activeLines: number[];
  startLine: number;
  translatePx: number;
  visibleLineCount: number;
  geometry: { outer: number; header: number; gap: number };
  filename: string | undefined;
  language: string | undefined;
  title: string | undefined;
  headerVisible: boolean;
  /** Mode actually rendered; never `build`/`diff`/`trace` without valid data. */
  mode: CodeSceneMode;
  /** Current step index; -1 for focus or when there is no step data. */
  stepIndex: number;
  /** Number of steps of the current mode; 0 for focus. */
  stepCount: number;
  /** Current step label (focus: the current beat's label). */
  stepLabel?: string;
  build: { steps: ResolvedCodeBuildStep[]; revealedLines: number[] } | null;
  trace: {
    steps: ResolvedCodeTraceStep[];
    state: CodeTraceStateEntry[];
    output?: string;
    callDepth?: number;
    panelVisible: boolean;
  } | null;
  diff: {
    lines: CodeDiffLine[];
    hunks: CodeDiffHunk[];
    beats: ResolvedCodeDiffBeat[];
    activeHunkIds: string[];
    activeRows: number[];
  } | null;
  displayRows: CodeSceneDisplayRow[];
  rowCount: number;
};

/** Hook-free frame resolution shared by the Standard and HTML code renderers. */
export function resolveCodeSceneFrameState(input: CodeSceneFrameStateInput): CodeSceneFrameState {
  const frame = Number.isFinite(input.frame) ? Math.max(0, input.frame) : 0;
  const width = safeDimension(input.width, 1920);
  const height = safeDimension(input.height, 1080);
  const portrait = height > width;
  const scale = rendererScale(width, height) || (portrait ? width / 1080 : width / 1920);
  const visual = codeVisualOf(input.scene.visual);
  const sourceLines = visual ? codeLines(visual.code) : [];
  const totalLines = Math.max(1, sourceLines.length);
  const beats = visual?.beats ?? [];
  const hasBeats = beats.length > 0;
  const sceneRecord = input.scene as unknown as Record<string, unknown>;
  const fps = Number.isFinite(input.fps) && (input.fps as number) > 0 ? (input.fps as number) : 30;
  const timeline: CodeBeatFrame[] = resolveCodeBeatTimeline(sceneRecord, fps);
  const currentBeat = timeline.find(beat => frame >= beat.startFrame && frame < beat.endFrame)
    ?? (timeline.length ? (frame < timeline[0].startFrame ? timeline[0] : timeline[timeline.length - 1]) : undefined);

  const mode = resolveCodeSceneMode(visual);
  const buildSteps = mode === 'build' ? resolveCodeBuildSteps(visual) : null;
  const traceSteps = mode === 'trace' ? resolveCodeTraceSteps(visual) : null;
  const diffView = mode === 'diff' ? resolveCodeDiffView(visual) : null;
  const buildTimeline: CodeBuildStepFrame[] = buildSteps ? resolveCodeBuildStepTimeline(sceneRecord, fps) : [];
  const traceTimeline = traceSteps ? resolveCodeTraceStepTimeline(sceneRecord, fps) : [];
  const diffTimeline: CodeDiffBeatFrame[] = diffView?.beats.length ? resolveCodeDiffBeatTimeline(sceneRecord, fps) : [];
  const stepIndex = mode === 'build'
    ? stepIndexAt(buildTimeline, frame)
    : mode === 'trace'
      ? stepIndexAt(traceTimeline, frame)
      : mode === 'diff'
        ? stepIndexAt(diffTimeline, frame)
        : -1;
  const stepCount = mode === 'build'
    ? (buildSteps?.length ?? 0)
    : mode === 'trace'
      ? (traceSteps?.length ?? 0)
      : mode === 'diff'
        ? (diffView?.beats.length ?? 0)
        : 0;
  const buildStep = stepIndex >= 0 ? buildSteps?.[stepIndex] : undefined;
  const traceStep = stepIndex >= 0 ? traceSteps?.[stepIndex] : undefined;
  const diffBeat = stepIndex >= 0 ? diffView?.beats[stepIndex] : undefined;
  const traceState: CodeTraceStateEntry[] = traceStep?.state ?? [];
  const traceOutput = traceStep?.output;
  const traceCallDepth = traceStep?.callDepth;
  const tracePanelVisible = traceState.length > 0 || Boolean(traceOutput && traceOutput.length) || traceCallDepth !== undefined;
  const stepLabel = mode === 'focus'
    ? currentBeat?.label
    : mode === 'build'
      ? buildStep?.label
      : mode === 'trace'
        ? traceStep?.label
        : diffBeat?.label;
  const hasBeatCard = mode === 'focus'
    ? hasBeats && beats.some(beat => Boolean(beat.label))
    : mode === 'build'
      ? (buildSteps ?? []).some(step => Boolean(step.label))
      : mode === 'trace'
        ? (traceSteps ?? []).some(step => Boolean(step.label))
        : (diffView?.beats ?? []).some(beat => Boolean(beat.label));
  // Reserve the caption band so the beat label never covers the subtitles. The live subtitle
  // settings win; the estimate only keeps the standalone view safe without them.
  const captionReservedPx = Number.isFinite(input.captionReservedPx) && (input.captionReservedPx as number) >= 0
    ? (input.captionReservedPx as number)
    : Math.round(height * CAPTION_EDGE_RATIO) + Math.round(2 * 30 * scale * CAPTION_LINE_HEIGHT) + Math.round(20 * scale);
  const layoutHasBeats = mode === 'focus' ? hasBeats : stepCount > 0;
  const layout = resolveCodeSceneLayout({
    width,
    height,
    hasBeats: layoutHasBeats,
    hasBeatCard,
    captionReservedPx,
    tracePanel: mode === 'trace' && tracePanelVisible,
  });

  // Build/only revealed lines exist; the current step's focus lines carry the highlight.
  const revealedSet = new Set<number>();
  if (mode === 'build') {
    for (let index = 0; index <= stepIndex; index += 1) {
      const step = buildSteps?.[index];
      if (!step) continue;
      for (const line of step.revealLines) revealedSet.add(line);
    }
  }
  const revealedLines = [...revealedSet].sort((a, b) => a - b);
  const focusLinesSet = new Set(buildStep?.focusLines ?? []);
  const traceLinesSet = new Set(traceStep?.lines ?? []);
  const currentBeatLines = new Set(currentBeat?.lines ?? []);
  const diffActiveRows = diffBeat ? rowsForHunks(diffBeat.hunkIds, diffView?.hunks ?? []) : [];
  const diffActiveRowSet = new Set(diffActiveRows);

  const rowCount = mode === 'diff' ? (diffView?.lines.length ?? 0) : sourceLines.length;
  const viewportSteps: CodeBeatFrame[] = mode === 'build'
    ? buildTimeline.map(step => ({ startFrame: step.startFrame, endFrame: step.endFrame, lines: step.focusLines, ...(step.label ? { label: step.label } : {}) }))
    : mode === 'trace'
      ? traceTimeline.map(step => ({ startFrame: step.startFrame, endFrame: step.endFrame, lines: step.lines, ...(step.label ? { label: step.label } : {}) }))
      : mode === 'diff'
        ? diffTimeline.map(step => ({
            startFrame: step.startFrame,
            endFrame: step.endFrame,
            lines: rowsForHunks(step.hunkIds, diffView?.hunks ?? []).map(index => index + 1),
            ...(step.label ? { label: step.label } : {}),
          }))
        : timeline;
  const viewportTotalLines = Math.max(1, rowCount);
  const keyframes = resolveCodeScrollKeyframes({ beats: viewportSteps, totalLines: viewportTotalLines, visibleLineCount: layout.visibleLineCount });
  const startLine = scrolledStartLine(keyframes, frame, viewportTotalLines);
  const translatePx = (1 - startLine) * layout.lineHeightPx;
  const activeLines = mode === 'build'
    ? [...(buildStep?.focusLines ?? [])]
    : mode === 'trace'
      ? [...(traceStep?.lines ?? [])]
      : mode === 'diff'
        ? []
        : [...(currentBeat?.lines ?? [])];
  const visibleLineCount = Math.min(layout.visibleLineCount, viewportTotalLines);

  const displayRows: CodeSceneDisplayRow[] = mode === 'diff'
    ? (diffView?.lines ?? []).map((line, index) => ({
        rowNumber: index + 1,
        text: line.text,
        active: diffActiveRowSet.has(index),
        dimmed: !diffActiveRowSet.has(index),
        revealed: true,
        kind: line.kind,
        ...(line.oldLine !== undefined ? { oldLineNumber: line.oldLine } : {}),
        ...(line.newLine !== undefined ? { newLineNumber: line.newLine } : {}),
      }))
    : sourceLines.map((text, index) => {
        const rowNumber = index + 1;
        if (mode === 'build') {
          const revealed = revealedSet.has(rowNumber);
          const active = revealed && focusLinesSet.has(rowNumber);
          return { rowNumber, text, active, dimmed: revealed && !active, revealed };
        }
        if (mode === 'trace') {
          const active = traceLinesSet.has(rowNumber);
          return { rowNumber, text, active, dimmed: !active, revealed: true };
        }
        const active = currentBeatLines.has(rowNumber);
        return { rowNumber, text, active, dimmed: hasBeats && !active, revealed: true };
      });

  const geometry = portrait ? PORTRAIT_GEOMETRY : LANDSCAPE_GEOMETRY;
  const filename = visual?.filename?.trim() || undefined;
  const language = visual?.language?.trim() || undefined;
  const title = input.scene.title?.trim() || undefined;
  return {
    frame,
    width,
    height,
    portrait,
    scale,
    visual,
    sourceLines,
    totalLines,
    beats,
    hasBeats,
    hasBeatCard,
    captionReservedPx,
    layout,
    timeline,
    keyframes,
    currentBeat,
    activeLines,
    startLine,
    translatePx,
    visibleLineCount,
    geometry: { outer: geometry.outer * scale, header: geometry.header * scale, gap: geometry.gap * scale },
    filename,
    language,
    title,
    headerVisible: Boolean(filename || language || title),
    mode,
    stepIndex,
    stepCount,
    ...(stepLabel ? { stepLabel } : {}),
    build: mode === 'build'
      ? { steps: buildSteps ?? [], revealedLines }
      : null,
    trace: mode === 'trace'
      ? {
          steps: traceSteps ?? [],
          state: traceState,
          ...(traceOutput !== undefined ? { output: traceOutput } : {}),
          ...(traceCallDepth !== undefined ? { callDepth: traceCallDepth } : {}),
          panelVisible: tracePanelVisible,
        }
      : null,
    diff: mode === 'diff' && diffView
      ? {
          lines: diffView.lines,
          hunks: diffView.hunks,
          beats: diffView.beats,
          activeHunkIds: [...(diffBeat?.hunkIds ?? [])],
          activeRows: diffActiveRows,
        }
      : null,
    displayRows,
    rowCount,
  };
}

export type CodeSceneViewProps = {
  scene: Scene;
  styleId: StyleId;
  brand?: Storyboard['brand'];
  frame: number;
  width: number;
  height: number;
  /** Render fps; defaults to 30 so the deterministic view needs no Remotion context. */
  fps?: number;
  /**
   * Caption band reserved at the bottom of the frame (renderer px). Callers pass
   * `captionSafeArea(...).total` from the live subtitle settings; without it the view falls back to
   * a conservative estimate so the beat card still never covers the captions.
   */
  captionReservedPx?: number;
  /** Default true; false renders plain-text tokens without touching line focus or the viewport. */
  syntaxHighlight?: boolean;
};

/** Syntax-token spans of one source line; source text is only ever escaped text, never raw HTML. */
function tokenSpans(tokens: CodeLineTokens['tokens'], tokenColors: Record<string, string>): React.ReactNode {
  return tokens.map((token, index) => (
    <span
      key={index}
      className={`tok-${token.type}`}
      style={{ color: tokenColors[token.type], ...(token.type === 'function' ? { fontWeight: 700 } : {}) }}
    >{token.text}</span>
  ));
}

/** Deterministic (hook-free) code scene view, directly renderable with `renderToStaticMarkup`. */
export function CodeSceneView(props: CodeSceneViewProps): React.ReactElement {
  const { scene, styleId, brand } = props;
  const state = resolveCodeSceneFrameState(props);
  const { layout, scale } = state;
  const theme = resolveSceneTheme({ styleId, brand }, scene);
  const colors = theme.colors;
  const tokenColors = resolveCodeTokenColors(colors) as unknown as Record<string, string>;
  const diffColors = resolveCodeDiffColors(colors);
  const syntaxHighlight = props.syntaxHighlight !== false;
  const sourceTokens = codeTokensFor(state.visual?.code ?? '', state.visual?.language, syntaxHighlight);
  const beforeTokens = state.mode === 'diff'
    ? codeTokensFor(state.visual?.beforeCode ?? '', state.visual?.language, syntaxHighlight)
    : [];
  const tokenLinesOf = (index: number): CodeLineTokens['tokens'] => sourceTokens[index]?.tokens
    ?? [{ text: state.displayRows[index]?.text ?? '', type: 'plain' as const }];
  const beforeTokensOf = (index: number): CodeLineTokens['tokens'] => beforeTokens[index]?.tokens
    ?? [{ text: state.diff?.lines[index]?.text ?? '', type: 'plain' as const }];

  const cardStyle: React.CSSProperties = {
    flexShrink: 0,
    width: layout.stacked ? '100%' : layout.beatCard?.widthPx,
    maxWidth: '100%',
    height: layout.beatCard?.heightPx,
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: 10 * scale,
    padding: `${12 * scale}px ${16 * scale}px`,
    background: colors.card,
    border: `1px solid ${colors.accent}66`,
    borderRadius: 16 * scale,
    color: colors.fg,
    fontSize: 24 * scale,
    fontWeight: 700,
    lineHeight: 1.3,
    overflow: 'hidden',
  };

  const codeWindow = <div style={{
    position: 'relative',
    flex: layout.stacked ? '0 0 auto' : 1,
    width: layout.stacked ? '100%' : undefined,
    minWidth: 0,
    height: Math.max(1, state.visibleLineCount * layout.lineHeightPx),
    background: colors.card,
    border: `1px solid ${colors.accent}44`,
    borderRadius: 14 * scale,
    overflow: 'hidden',
    boxSizing: 'border-box',
    fontSize: layout.fontSizePx,
    lineHeight: `${layout.lineHeightPx}px`,
    color: colors.fg,
    whiteSpace: 'pre',
  }}>
    <div style={{ transform: `translateY(${state.translatePx}px)`, willChange: 'transform' }}>
      {state.mode === 'diff'
        ? (state.diff?.lines ?? []).map((line, index) => {
            const active = state.diff?.activeRows.includes(index) ?? false;
            const kind = line.kind;
            const background = kind === 'add' ? diffColors.add.bg : kind === 'remove' ? diffColors.remove.bg : 'transparent';
            const markerColor = kind === 'add' ? diffColors.add.fg : kind === 'remove' ? diffColors.remove.fg : diffColors.context.fg;
            const lineTokens = kind === 'remove'
              ? beforeTokensOf((line.oldLine ?? 1) - 1)
              : tokenLinesOf((line.newLine ?? 1) - 1);
            return <div
              key={index}
              className={`diff-line ${kind} diff-${kind}${active ? ' diff-active' : ''}`}
              data-diff-kind={kind}
              {...(active ? { 'data-diff-active': 'true' } : {})}
              style={{ height: layout.lineHeightPx, opacity: active ? 1 : CODE_DIM_OPACITY, background }}
            >
              <span className="diff-marker" style={{ display: 'inline-block', minWidth: 20 * scale, color: markerColor }}>{kind === 'add' ? '+' : kind === 'remove' ? '-' : ' '}</span>
              <span className="diff-old-line-number" {...(line.oldLine !== undefined ? { 'data-old-line': String(line.oldLine) } : {})} style={{ display: 'inline-block', minWidth: 44 * scale, color: colors.muted }}>{line.oldLine !== undefined ? line.oldLine : ''}</span>
              <span className="diff-new-line-number" {...(line.newLine !== undefined ? { 'data-new-line': String(line.newLine) } : {})} style={{ display: 'inline-block', minWidth: 44 * scale, color: colors.muted }}>{line.newLine !== undefined ? line.newLine : ''}</span>
              <span className="diff-content" style={{ whiteSpace: 'pre' }}>{tokenSpans(lineTokens, tokenColors)}</span>
            </div>;
          })
        : state.displayRows.map(row => {
            const index = row.rowNumber - 1;
            const lineTokens = tokenLinesOf(index);
            return <div
              key={row.rowNumber}
              data-line-number={row.rowNumber}
              {...(row.active ? { 'data-active': 'true' } : row.dimmed ? { 'data-dimmed': 'true' } : {})}
              {...(state.mode === 'build' ? { 'data-revealed': row.revealed ? 'true' : 'false' } : {})}
              style={{
                height: layout.lineHeightPx,
                opacity: row.dimmed ? CODE_DIM_OPACITY : 1,
                background: row.active ? `${colors.accent}22` : 'transparent',
                ...(state.mode === 'build' && !row.revealed ? { visibility: 'hidden' as const } : {}),
              }}
            >
              <span style={{ minWidth: 44 * scale, color: colors.muted }}>{row.rowNumber}</span>
              <span style={{ whiteSpace: 'pre' }}>{tokenSpans(lineTokens, tokenColors)}</span>
            </div>;
          })}
    </div>
  </div>;

  const cardLabel = state.stepLabel;
  const card = layout.beatCard
    ? (cardLabel
      ? <div data-beat-label="true" style={cardStyle}>{cardLabel}</div>
      : <div aria-hidden="true" style={cardStyle} />)
    : null;

  const tracePanelLayout = state.mode === 'trace' && state.trace?.panelVisible ? layout.tracePanel : null;
  const tracePanel = tracePanelLayout ? <div
    data-trace-panel="true"
    style={{
      flexShrink: 0,
      width: tracePanelLayout.placement === 'right' ? tracePanelLayout.widthPx : '100%',
      maxWidth: '100%',
      height: tracePanelLayout.heightPx,
      boxSizing: 'border-box',
      background: colors.card,
      border: `1px solid ${colors.accent}66`,
      borderRadius: 14 * scale,
      padding: `${12 * scale}px ${14 * scale}px`,
      overflow: 'hidden',
      whiteSpace: 'normal',
      color: colors.fg,
      fontSize: 22 * scale,
      lineHeight: 1.35,
      display: 'flex',
      flexDirection: 'column',
      gap: 8 * scale,
    }}
  >
    {(state.trace?.state.length ?? 0) > 0 && <div data-trace-section="variables" style={{ display: 'flex', flexDirection: 'column', gap: 4 * scale }}>
      <div className="trace-title" style={{ fontSize: 20 * scale, fontWeight: 700, color: colors.accent, letterSpacing: 0.4 }}>Variables</div>
      {(state.trace?.state ?? []).map((entry, index) => <div
        key={`${entry.name}-${index}`}
        data-trace-state-row="true"
        {...(entry.changed ? { 'data-changed': 'true' } : {})}
        style={{ display: 'flex', alignItems: 'baseline', gap: 8 * scale, fontWeight: entry.changed ? 700 : 400 }}
      >
        <span data-state-name={entry.name} style={{ color: colors.muted, minWidth: 1.6 * layout.fontSizePx, wordBreak: 'break-all' }}>{entry.name}</span>
        <span data-state-value={entry.value} style={{ color: entry.changed ? colors.accent : colors.fg, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{entry.value}</span>
        {entry.changed && <span data-changed-marker="true" style={{ color: colors.accent }}>←</span>}
      </div>)}
    </div>}
    {state.trace?.output !== undefined && state.trace.output.length > 0 && <div data-trace-section="output" style={{ display: 'flex', flexDirection: 'column', gap: 4 * scale }}>
      <div className="trace-title" style={{ fontSize: 20 * scale, fontWeight: 700, color: colors.accent, letterSpacing: 0.4 }}>Output</div>
      <div data-trace-output="true" style={{ color: colors.fg, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{state.trace.output}</div>
    </div>}
    {state.trace?.callDepth !== undefined && <div data-trace-call-depth={String(state.trace.callDepth)} style={{ color: colors.muted, fontSize: 20 * scale }}>{`depth ${state.trace.callDepth}`}</div>}
  </div> : null;

  const body = tracePanel
    ? (state.portrait
      ? <div style={{ display: 'flex', flexDirection: 'column', gap: state.geometry.gap, flex: 1, minWidth: 0, minHeight: 0 }}>
          {codeWindow}
          {tracePanel}
          {card}
        </div>
      : <div style={{ display: 'flex', flexDirection: 'row', gap: state.geometry.gap, flex: 1, minWidth: 0, minHeight: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: state.geometry.gap, flex: 1, minWidth: 0, minHeight: 0 }}>
            {codeWindow}
            {card}
          </div>
          {tracePanel}
        </div>)
    : <div style={{ display: 'flex', flexDirection: layout.stacked ? 'column' : 'row', gap: state.geometry.gap, flex: 1, minWidth: 0, minHeight: 0 }}>
        {codeWindow}
        {card}
      </div>;

  return <div
    data-code-scene="true"
    {...(state.mode === 'diff' ? { 'data-code-diff': 'true' } : {})}
    style={{
      position: 'relative',
      width: '100%',
      height: '100%',
      overflow: 'hidden',
      boxSizing: 'border-box',
      background: colors.bg,
      color: colors.fg,
      fontFamily: CODE_MONO_FONT,
      display: 'flex',
      flexDirection: 'column',
      gap: state.geometry.gap,
      padding: state.geometry.outer,
    }}
  >
    {state.headerVisible && <div
      data-code-header="true"
      style={{ display: 'flex', alignItems: 'baseline', gap: 12 * scale, width: '100%', maxWidth: layout.maxTextWidthPx, minHeight: state.geometry.header, overflow: 'hidden', fontSize: 21 * scale, color: colors.accent }}
    >
      {state.filename && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{state.filename}</span>}
      {state.language && <span style={{ color: colors.muted, whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: 1 }}>{state.language}</span>}
      {state.title && <span style={{ marginLeft: 'auto', fontSize: 27 * scale, fontWeight: 700, color: colors.fg, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: layout.maxTextWidthPx }}>{state.title}</span>}
    </div>}
    {body}
  </div>;
}

/** Remotion entry point: reads the current frame/video config and delegates to `CodeSceneView`. */
export function CodeScene(props: { scene: Scene; styleId: StyleId; brand?: Storyboard['brand']; captionReservedPx?: number }): React.ReactElement {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  return <CodeSceneView {...props} frame={frame} width={width} height={height} fps={fps} />;
}
