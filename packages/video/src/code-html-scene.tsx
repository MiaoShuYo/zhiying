import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { sanitizeSceneHtml, type Scene, type Storyboard, type StyleId } from '@m2v/schema';
import { resolveCodeDiffColors, resolveCodeTokenColors } from '@m2v/styles';
import { resolveSceneTheme } from './theme';
import {
  CODE_DIM_OPACITY,
  CODE_MONO_FONT_CSS,
  codeTokensFor,
  resolveCodeSceneFrameState,
  type CodeSceneViewProps,
} from './code-scene';

/**
 * HTML-generation-mode dynamic CodeScene (#21, extended in V1.7.0).
 *
 * The scene keeps `type: 'code'` and the exact same `CodeVisual` as the Standard renderer; only the
 * output format differs. `renderCodeHtmlScene` builds a deterministic, hook-free HTML fragment and
 * runs it through `sanitizeSceneHtml`, so the outer React node can safely inject it with
 * `dangerouslySetInnerHTML` — either inside Remotion (`CodeHtmlScene`) or in a static render
 * (`CodeHtmlSceneView`, directly usable with `renderToStaticMarkup`).
 *
 * Both renderers consume the very same `resolveCodeSceneFrameState`, so mode, step, visible/hidden
 * rows, diff rows and trace state can never drift. The dynamic state is expressed with CSS class
 * names only (the sanitizer deliberately drops `data-*` attributes):
 *   - source rows: `code-line` + `active` / `dim` / `hidden` (+ inline `visibility:hidden`)
 *   - diff rows: `diff-line` + `add` / `remove` / `context` + `diff-active`
 *   - trace panel: `trace-panel`, `trace-section`, `trace-title`, `trace-state-row`,
 *     `trace-state-name`, `trace-state-value`, `changed`, `changed-marker`, `trace-output`,
 *     `trace-call-depth`.
 *
 * The static `visual.html` of the scene is *not* used as code content: for a structured code scene
 * it only marks "generate this scene as HTML".
 *
 * Sanitizing is done in independent blocks (each far below the single-call 20000 limit) instead of
 * once over the whole fragment: a long code file legitimately needs more than 20000 characters of
 * markup, and truncating the assembled fragment would drop trailing source lines and leave a broken
 * tag at the end. Every block only contains complete, self-contained pieces (a whole code line, a
 * whole token span, the header or the beat label), so the concatenation is always valid HTML and no
 * source line is ever lost.
 */

export type CodeHtmlSceneViewProps = CodeSceneViewProps & {
  /** Default true; false renders plain text tokens without changing line focus or the viewport. */
  syntaxHighlight?: boolean;
};

/** Target size of one sanitize block; must stay well below the sanitizer's 20000 character cap. */
const SANITIZE_BLOCK_TARGET = 4000;

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Join declarations into a `style="…"` value; callers only pass sanitizer-safe values. */
function styleAttr(declarations: Array<string | false | undefined | null>): string {
  return declarations.filter((declaration): declaration is string => Boolean(declaration)).join(';');
}

/** One sanitizer-safe declaration helper: `property:value` or null when the value is unusable. */
function declaration(property: string, value: string | number | undefined | null): string | null {
  if (value === undefined || value === null || value === '') return null;
  return `${property}:${value}`;
}

/** Token spans of one line as complete pieces (each span is sanitizer-safe on its own). */
function tokenPieces(tokens: Array<{ text: string; type: string }>, tokenColors: Record<string, string>): string[] {
  const pieces: string[] = [];
  for (const token of tokens) {
    const tokenStyle = styleAttr([
      declaration('color', tokenColors[token.type]),
      token.type === 'function' ? declaration('font-weight', 700) : null,
    ]);
    pieces.push(`<span class="tok-${token.type}"${tokenStyle ? ` style="${tokenStyle}"` : ''}>${escapeHtmlText(token.text)}</span>`);
  }
  return pieces;
}

/**
 * Build the inner HTML as an ordered list of complete pieces (element tags and whole elements).
 *
 * Each piece is self-contained: it never ends in the middle of a tag, so blocks of pieces can be
 * sanitized independently without corrupting the final markup.
 */
function buildCodeScenePieces(props: CodeHtmlSceneViewProps): string[] {
  const state = resolveCodeSceneFrameState(props);
  const theme = resolveSceneTheme({ styleId: props.styleId, brand: props.brand }, props.scene);
  const colors = theme.colors;
  const tokenColors = resolveCodeTokenColors(colors) as unknown as Record<string, string>;
  const diffColors = resolveCodeDiffColors(colors);
  const syntaxHighlight = props.syntaxHighlight !== false;
  const sourceTokens = codeTokensFor(state.visual?.code ?? '', state.visual?.language, syntaxHighlight);
  const beforeTokens = state.mode === 'diff'
    ? codeTokensFor(state.visual?.beforeCode ?? '', state.visual?.language, syntaxHighlight)
    : [];
  const { layout, scale } = state;
  const { gap, header: headerHeight, outer } = state.geometry;
  const pieces: string[] = [];
  const table = (tokens: Array<{ text: string; type: string }> | undefined, text: string): string[] =>
    tokenPieces(tokens ?? [{ text, type: 'plain' }], tokenColors);

  pieces.push(`<div class="code-scene${state.mode === 'diff' ? ' code-diff' : ''}" style="${styleAttr([
    declaration('width', '100%'),
    declaration('height', '100%'),
    declaration('overflow', 'hidden'),
    declaration('box-sizing', 'border-box'),
    declaration('background', colors.bg),
    declaration('color', colors.fg),
    declaration('font-family', CODE_MONO_FONT_CSS),
    declaration('display', 'flex'),
    declaration('flex-direction', 'column'),
    declaration('gap', `${gap}px`),
    declaration('padding', `${outer}px`),
  ])}">`);

  if (state.headerVisible) {
    pieces.push(`<div class="code-header" style="${styleAttr([
      declaration('display', 'flex'),
      declaration('align-items', 'baseline'),
      declaration('gap', `${12 * scale}px`),
      declaration('width', '100%'),
      declaration('max-width', `${layout.maxTextWidthPx}px`),
      declaration('min-height', `${headerHeight}px`),
      declaration('overflow', 'hidden'),
      declaration('font-size', `${21 * scale}px`),
      declaration('color', colors.accent),
    ])}">`);
    if (state.filename) {
      pieces.push(`<span class="code-filename" style="${styleAttr([
        declaration('overflow', 'hidden'),
        declaration('text-overflow', 'ellipsis'),
        declaration('white-space', 'nowrap'),
      ])}">${escapeHtmlText(state.filename)}</span>`);
    }
    if (state.language) {
      pieces.push(`<span class="code-language" style="${styleAttr([
        declaration('color', colors.muted),
        declaration('white-space', 'nowrap'),
        declaration('letter-spacing', '1px'),
      ])}">${escapeHtmlText(state.language)}</span>`);
    }
    if (state.title) {
      pieces.push(`<span class="code-title" style="${styleAttr([
        declaration('margin-left', 'auto'),
        declaration('font-size', `${27 * scale}px`),
        declaration('font-weight', 700),
        declaration('color', colors.fg),
        declaration('overflow', 'hidden'),
        declaration('text-overflow', 'ellipsis'),
        declaration('white-space', 'nowrap'),
        declaration('max-width', `${layout.maxTextWidthPx}px`),
      ])}">${escapeHtmlText(state.title)}</span>`);
    }
    pieces.push('</div>');
  }

  const tracePanelLayout = state.mode === 'trace' && state.trace?.panelVisible ? layout.tracePanel : null;

  // ── code window (source rows or diff rows) ───────────────────────────────────
  const windowPieces: string[] = [];
  windowPieces.push(`<div class="code-window" style="${styleAttr([
    layout.stacked ? declaration('flex', '0 0 auto') : declaration('flex', 1),
    layout.stacked ? declaration('width', '100%') : declaration('min-width', 0),
    declaration('height', `${state.visibleLineCount * layout.lineHeightPx}px`),
    declaration('background', colors.card),
    declaration('border', `1px solid ${colors.accent}44`),
    declaration('border-radius', `${14 * scale}px`),
    declaration('overflow', 'hidden'),
    declaration('box-sizing', 'border-box'),
    declaration('font-size', `${layout.fontSizePx}px`),
    declaration('line-height', `${layout.lineHeightPx}px`),
    declaration('color', colors.fg),
    declaration('white-space', 'pre'),
  ])}">`);
  windowPieces.push(`<div class="code-track" style="${styleAttr([declaration('transform', `translateY(${state.translatePx}px)`)])}">`);
  if (state.mode === 'diff') {
    const diffLines = state.diff?.lines ?? [];
    const activeRows = state.diff?.activeRows ?? [];
    diffLines.forEach((line, index) => {
      const active = activeRows.includes(index);
      const kind = line.kind;
      const background = kind === 'add' ? diffColors.add.bg : kind === 'remove' ? diffColors.remove.bg : 'transparent';
      const markerColor = kind === 'add' ? diffColors.add.fg : kind === 'remove' ? diffColors.remove.fg : diffColors.context.fg;
      const lineTokens = kind === 'remove'
        ? beforeTokens[(line.oldLine ?? 1) - 1]?.tokens
        : sourceTokens[(line.newLine ?? 1) - 1]?.tokens;
      windowPieces.push(`<div class="diff-line ${kind} diff-${kind}${active ? ' diff-active' : ''}" style="${styleAttr([
        declaration('height', `${layout.lineHeightPx}px`),
        declaration('opacity', active ? 1 : CODE_DIM_OPACITY),
        declaration('background', background),
      ])}">`);
      windowPieces.push(`<span class="diff-marker" style="${styleAttr([
        declaration('display', 'inline-block'),
        declaration('min-width', `${20 * scale}px`),
        declaration('color', markerColor),
      ])}">${kind === 'add' ? '+' : kind === 'remove' ? '-' : ' '}</span>`);
      windowPieces.push(`<span class="diff-old-line-number" style="${styleAttr([
        declaration('display', 'inline-block'),
        declaration('min-width', `${44 * scale}px`),
        declaration('color', colors.muted),
      ])}">${line.oldLine !== undefined ? line.oldLine : ''}</span>`);
      windowPieces.push(`<span class="diff-new-line-number" style="${styleAttr([
        declaration('display', 'inline-block'),
        declaration('min-width', `${44 * scale}px`),
        declaration('color', colors.muted),
      ])}">${line.newLine !== undefined ? line.newLine : ''}</span>`);
      windowPieces.push(`<span class="diff-content" style="${styleAttr([declaration('white-space', 'pre')])}">`);
      windowPieces.push(...table(lineTokens, line.text));
      windowPieces.push('</span>');
      windowPieces.push('</div>');
    });
  } else {
    const contentStyle = styleAttr([declaration('white-space', 'pre')]);
    for (const row of state.displayRows) {
      const lineTokens = sourceTokens[row.rowNumber - 1]?.tokens;
      const hidden = state.mode === 'build' && !row.revealed;
      const classes = `code-line${row.active ? ' active' : ''}${row.dimmed ? ' dim' : ''}${hidden ? ' hidden' : ''}`;
      windowPieces.push(`<div class="${classes}" style="${styleAttr([
        declaration('height', `${layout.lineHeightPx}px`),
        declaration('opacity', row.dimmed ? CODE_DIM_OPACITY : 1),
        declaration('background', row.active ? `${colors.accent}22` : 'transparent'),
        hidden ? declaration('visibility', 'hidden') : null,
      ])}">`);
      windowPieces.push(`<span class="line-number" style="${styleAttr([
        declaration('min-width', `${44 * scale}px`),
        declaration('color', colors.muted),
      ])}">${row.rowNumber}</span>`);
      windowPieces.push(`<span class="code-content" style="${contentStyle}">`);
      windowPieces.push(...table(lineTokens, row.text));
      windowPieces.push('</span>');
      windowPieces.push('</div>');
    }
  }
  windowPieces.push('</div>');
  windowPieces.push('</div>');

  // ── beat label card (current step label; same visuals as the focus beat card) ─
  const cardPieces: string[] = [];
  if (layout.beatCard) {
    const cardStyle = styleAttr([
      declaration('flex', '0 0 auto'),
      declaration('width', layout.stacked ? '100%' : `${layout.beatCard.widthPx}px`),
      declaration('max-width', '100%'),
      declaration('height', `${layout.beatCard.heightPx}px`),
      declaration('box-sizing', 'border-box'),
      declaration('display', 'flex'),
      declaration('align-items', 'center'),
      declaration('gap', `${10 * scale}px`),
      declaration('padding', `${12 * scale}px ${16 * scale}px`),
      declaration('background', colors.card),
      declaration('border', `1px solid ${colors.accent}66`),
      declaration('border-radius', `${16 * scale}px`),
      declaration('color', colors.fg),
      declaration('font-size', `${24 * scale}px`),
      declaration('font-weight', 700),
      declaration('line-height', '1.3'),
      declaration('overflow', 'hidden'),
    ]);
    cardPieces.push(`<div class="beat-label" style="${cardStyle}">${state.stepLabel ? escapeHtmlText(state.stepLabel) : ''}</div>`);
  }

  // ── trace state panel (landscape: right column, portrait: below the code) ────
  const panelPieces: string[] = [];
  if (tracePanelLayout) {
    panelPieces.push(`<div class="trace-panel" style="${styleAttr([
      declaration('flex', '0 0 auto'),
      declaration('width', tracePanelLayout.placement === 'right' ? `${tracePanelLayout.widthPx}px` : '100%'),
      declaration('max-width', '100%'),
      declaration('height', `${tracePanelLayout.heightPx}px`),
      declaration('box-sizing', 'border-box'),
      declaration('background', colors.card),
      declaration('border', `1px solid ${colors.accent}66`),
      declaration('border-radius', `${14 * scale}px`),
      declaration('padding', `${12 * scale}px ${14 * scale}px`),
      declaration('overflow', 'hidden'),
      declaration('white-space', 'normal'),
      declaration('color', colors.fg),
      declaration('font-size', `${22 * scale}px`),
      declaration('line-height', `${Math.round(1.35 * 22 * scale * 100) / 100}px`),
      declaration('display', 'flex'),
      declaration('flex-direction', 'column'),
      declaration('gap', `${8 * scale}px`),
    ])}">`);
    const traceState = state.trace?.state ?? [];
    if (traceState.length > 0) {
      panelPieces.push(`<div class="trace-section trace-section-variables" style="${styleAttr([
        declaration('display', 'flex'),
        declaration('flex-direction', 'column'),
        declaration('gap', `${4 * scale}px`),
      ])}">`);
      panelPieces.push(`<div class="trace-title" style="${styleAttr([
        declaration('font-size', `${20 * scale}px`),
        declaration('font-weight', 700),
        declaration('color', colors.accent),
        declaration('letter-spacing', '0.4px'),
      ])}">Variables</div>`);
      traceState.forEach((entry, index) => {
        panelPieces.push(`<div class="trace-state-row${entry.changed ? ' changed' : ''}" style="${styleAttr([
          declaration('display', 'flex'),
          declaration('align-items', 'baseline'),
          declaration('gap', `${8 * scale}px`),
          declaration('font-weight', entry.changed ? 700 : 400),
        ])}">`);
        panelPieces.push(`<span class="trace-state-name" style="${styleAttr([
          declaration('color', colors.muted),
          declaration('min-width', `${Math.round(1.6 * layout.fontSizePx)}px`),
        ])}">${escapeHtmlText(entry.name)}</span>`);
        panelPieces.push(`<span class="trace-state-value" style="${styleAttr([
          declaration('color', entry.changed ? colors.accent : colors.fg),
          declaration('white-space', 'pre-wrap'),
        ])}">${escapeHtmlText(entry.value)}</span>`);
        if (entry.changed) panelPieces.push(`<span class="changed-marker" style="${styleAttr([declaration('color', colors.accent)])}">←</span>`);
        panelPieces.push('</div>');
      });
      panelPieces.push('</div>');
    }
    if (state.trace?.output !== undefined && state.trace.output.length > 0) {
      panelPieces.push(`<div class="trace-section trace-section-output" style="${styleAttr([
        declaration('display', 'flex'),
        declaration('flex-direction', 'column'),
        declaration('gap', `${4 * scale}px`),
      ])}">`);
      panelPieces.push(`<div class="trace-title" style="${styleAttr([
        declaration('font-size', `${20 * scale}px`),
        declaration('font-weight', 700),
        declaration('color', colors.accent),
        declaration('letter-spacing', '0.4px'),
      ])}">Output</div>`);
      panelPieces.push(`<div class="trace-output" style="${styleAttr([
        declaration('color', colors.fg),
        declaration('white-space', 'pre-wrap'),
      ])}">${escapeHtmlText(state.trace.output)}</div>`);
      panelPieces.push('</div>');
    }
    if (state.trace?.callDepth !== undefined) {
      panelPieces.push(`<div class="trace-call-depth" style="${styleAttr([
        declaration('color', colors.muted),
        declaration('font-size', `${20 * scale}px`),
      ])}">depth ${state.trace.callDepth}</div>`);
    }
    panelPieces.push('</div>');
  }

  // ── assemble the body (mirrors the Standard flex layout) ────────────────────
  if (tracePanelLayout) {
    pieces.push(`<div class="code-body" style="${styleAttr([
      declaration('display', 'flex'),
      declaration('flex-direction', state.portrait ? 'column' : 'row'),
      declaration('gap', `${gap}px`),
      declaration('flex', 1),
      declaration('min-width', 0),
      declaration('min-height', 0),
    ])}">`);
    if (state.portrait) {
      pieces.push(...windowPieces, ...panelPieces, ...cardPieces);
    } else {
      pieces.push(`<div class="code-main" style="${styleAttr([
        declaration('display', 'flex'),
        declaration('flex-direction', 'column'),
        declaration('gap', `${gap}px`),
        declaration('flex', 1),
        declaration('min-width', 0),
        declaration('min-height', 0),
      ])}">`);
      pieces.push(...windowPieces, ...cardPieces);
      pieces.push('</div>');
      pieces.push(...panelPieces);
    }
    pieces.push('</div>');
  } else {
    pieces.push(`<div class="code-body" style="${styleAttr([
      declaration('display', 'flex'),
      declaration('flex-direction', layout.stacked ? 'column' : 'row'),
      declaration('gap', `${gap}px`),
      declaration('flex', 1),
      declaration('min-width', 0),
      declaration('min-height', 0),
    ])}">`);
    pieces.push(...windowPieces, ...cardPieces);
    pieces.push('</div>');
  }

  pieces.push('</div>');
  return pieces;
}

/**
 * Sanitize the fragment in bounded blocks: concatenate complete pieces until the block target is
 * reached, then sanitize that block. Single pieces above the target (a token span carrying a very
 * long string literal) are still far below the sanitizer limit and are sanitized alone.
 */
function sanitizeInBlocks(pieces: string[]): string {
  const output: string[] = [];
  let buffer: string[] = [];
  let bufferLength = 0;
  const flush = (): void => {
    if (!buffer.length) return;
    output.push(sanitizeSceneHtml(buffer.join('')));
    buffer = [];
    bufferLength = 0;
  };
  for (const piece of pieces) {
    if (piece.length > SANITIZE_BLOCK_TARGET) {
      flush();
      output.push(sanitizeSceneHtml(piece));
      continue;
    }
    if (bufferLength > 0 && bufferLength + piece.length > SANITIZE_BLOCK_TARGET) flush();
    buffer.push(piece);
    bufferLength += piece.length;
  }
  flush();
  return output.join('');
}

/** Returns the inner HTML fragment, whose dynamic blocks are all passed through the sanitizer. */
export function renderCodeHtmlScene(props: CodeHtmlSceneViewProps): string {
  return sanitizeInBlocks(buildCodeScenePieces(props));
}

/** Deterministic, hook-free HTML code scene: directly renderable with `renderToStaticMarkup`. */
export function CodeHtmlSceneView(props: CodeHtmlSceneViewProps): React.ReactElement {
  return <div
    data-code-scene="true"
    data-code-html-scene="true"
    style={{ position: 'relative', width: '100%', height: '100%' }}
    dangerouslySetInnerHTML={{ __html: renderCodeHtmlScene(props) }}
  />;
}

/** Remotion entry point: reads the current frame/video config and delegates to `CodeHtmlSceneView`. */
export function CodeHtmlScene(props: {
  scene: Scene;
  styleId: StyleId;
  brand?: Storyboard['brand'];
  captionReservedPx?: number;
  syntaxHighlight?: boolean;
}): React.ReactElement {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  return <CodeHtmlSceneView {...props} frame={frame} width={width} height={height} fps={fps} />;
}
