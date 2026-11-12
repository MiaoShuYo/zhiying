import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import {
  codeLines,
  codeVisualOf,
  plainCodeTokens,
  resolveCodeBeatTimeline,
  resolveCodeScrollKeyframes,
  resolveCodeVisibleLineCount,
  tokenizeCode,
  type CodeBeat,
  type CodeBeatFrame,
  type CodeLineTokens,
  type CodeScrollKeyframe,
  type CodeVisual,
  type Scene,
  type Storyboard,
  type StyleId,
} from '@m2v/schema';
import { resolveCodeTokenColors } from '@m2v/styles';
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

export type CodeSceneLayout = {
  stacked: boolean;
  codeArea: { widthPx: number; heightPx: number };
  beatCard: { placement: 'right' | 'bottom-right' | 'below'; widthPx: number; heightPx: number; topPx: number } | null;
  fontSizePx: number;
  lineHeightPx: number;
  visibleLineCount: number;
  maxTextWidthPx: number;
};

function safeDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Portrait/landscape specific code layout.
 *
 * Landscape keeps the beat card in a right-hand column capped at 32% so the code area never drops
 * below 68% of the frame; portrait stacks the header, code window and beat card so the code keeps
 * the full frame width. The card always stops above the caption safe area.
 */
export function resolveCodeSceneLayout(input: {
  width: number;
  height: number;
  hasBeats: boolean;
  hasBeatCard: boolean;
  captionReservedPx?: number;
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
  const codeWidthPx = showCard && !portrait ? width - cardWidthPx : width;
  const codeHeightPx = portrait
    ? Math.max(1, availableHeight - (showCard ? cardHeightPx + gap : 0))
    : Math.max(1, availableHeight);
  const visibleLineCount = resolveCodeVisibleLineCount({
    heightPx: codeHeightPx,
    fontSizePx,
    lineHeightRatio: CODE_LINE_HEIGHT_RATIO,
    portrait,
  });
  const maxTextWidthPx = Math.max(0, codeWidthPx - outer * 2);
  let beatCard: CodeSceneLayout['beatCard'] = null;
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
  return { stacked: portrait, codeArea: { widthPx: codeWidthPx, heightPx: codeHeightPx }, beatCard, fontSizePx, lineHeightPx, visibleLineCount, maxTextWidthPx };
}

/**
 * Token data shared by both code renderers.
 *
 * Syntax highlighting defaults to on; when it is disabled, when the language is unknown or when the
 * tokenizer degrades, the renderer uses plain-text tokens. Line focus, the viewport window and the
 * line numbers never depend on this choice, so highlighting can never change scene timing.
 */
export function codeLineTokensFor(visual: CodeVisual | null, syntaxHighlight = true): CodeLineTokens[] {
  if (!visual) return [];
  if (syntaxHighlight) {
    try {
      const tokenized = tokenizeCode(visual.code, visual.language);
      if (tokenized.length === codeLines(visual.code).length) return tokenized;
    } catch {
      // Highlighting must never break a code scene: fall through to plain tokens.
    }
  }
  return plainCodeTokens(visual.code);
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
 * structure, so the active beat, the visible line window, the scroll offset and the caption-safe
 * card placement can never drift between the two rendering modes.
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
  const hasBeatCard = hasBeats && beats.some(beat => Boolean(beat.label));
  // Reserve the caption band so the beat label never covers the subtitles. The live subtitle
  // settings win; the estimate only keeps the standalone view safe without them.
  const captionReservedPx = Number.isFinite(input.captionReservedPx) && (input.captionReservedPx as number) >= 0
    ? (input.captionReservedPx as number)
    : Math.round(height * CAPTION_EDGE_RATIO) + Math.round(2 * 30 * scale * CAPTION_LINE_HEIGHT) + Math.round(20 * scale);
  const layout = resolveCodeSceneLayout({ width, height, hasBeats, hasBeatCard, captionReservedPx });
  const fps = Number.isFinite(input.fps) && (input.fps as number) > 0 ? (input.fps as number) : 30;
  const timeline: CodeBeatFrame[] = resolveCodeBeatTimeline(input.scene as unknown as Record<string, unknown>, fps);
  const keyframes = resolveCodeScrollKeyframes({ beats: timeline, totalLines, visibleLineCount: layout.visibleLineCount });
  const startLine = scrolledStartLine(keyframes, frame, totalLines);
  const translatePx = (1 - startLine) * layout.lineHeightPx;
  const currentBeat = timeline.find(beat => frame >= beat.startFrame && frame < beat.endFrame)
    ?? (timeline.length ? (frame < timeline[0].startFrame ? timeline[0] : timeline[timeline.length - 1]) : undefined);
  const activeLines = [...(currentBeat?.lines ?? [])];
  const visibleLineCount = Math.min(layout.visibleLineCount, totalLines);
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

/** Deterministic (hook-free) code scene view, directly renderable with `renderToStaticMarkup`. */
export function CodeSceneView(props: CodeSceneViewProps): React.ReactElement {
  const { scene, styleId, brand } = props;
  const state = resolveCodeSceneFrameState(props);
  const { layout, scale } = state;
  const theme = resolveSceneTheme({ styleId, brand }, scene);
  const colors = theme.colors;
  const tokenColors = resolveCodeTokenColors(colors);
  const tokenLines = codeLineTokensFor(state.visual, props.syntaxHighlight !== false);
  const { sourceLines, activeLines, currentBeat } = state;
  const hasBeats = state.hasBeats;
  const activeSet = new Set(activeLines);
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
  return <div
    data-code-scene="true"
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
    <div style={{ display: 'flex', flexDirection: layout.stacked ? 'column' : 'row', gap: state.geometry.gap, flex: 1, minWidth: 0, minHeight: 0 }}>
      <div style={{
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
          {sourceLines.map((line, index) => {
            const lineNumber = index + 1;
            const active = hasBeats && activeSet.has(lineNumber);
            const dimmed = hasBeats && !active;
            // Syntax tokens are rendered as individually escaped spans: source text is never
            // injected as raw HTML, so a line like `</span><script>` cannot break the layout.
            const lineTokens = tokenLines[index]?.tokens ?? [{ text: line, type: 'plain' as const }];
            return <div
              key={lineNumber}
              data-line-number={lineNumber}
              {...(active ? { 'data-active': 'true' } : dimmed ? { 'data-dimmed': 'true' } : {})}
              style={{ height: layout.lineHeightPx, opacity: dimmed ? CODE_DIM_OPACITY : 1, background: active ? `${colors.accent}22` : 'transparent' }}
            >
              <span style={{ minWidth: 44 * scale, color: colors.muted }}>{lineNumber}</span>
              <span style={{ whiteSpace: 'pre' }}>
                {lineTokens.map((token, tokenIndex) => (
                  <span
                    key={tokenIndex}
                    className={`tok-${token.type}`}
                    style={{ color: tokenColors[token.type], ...(token.type === 'function' ? { fontWeight: 700 } : {}) }}
                  >{token.text}</span>
                ))}
              </span>
            </div>;
          })}
        </div>
      </div>
      {layout.beatCard && (currentBeat?.label
        ? <div data-beat-label="true" style={cardStyle}>{currentBeat.label}</div>
        : <div aria-hidden="true" style={cardStyle} />)}
    </div>
  </div>;
}

/** Remotion entry point: reads the current frame/video config and delegates to `CodeSceneView`. */
export function CodeScene(props: { scene: Scene; styleId: StyleId; brand?: Storyboard['brand']; captionReservedPx?: number }): React.ReactElement {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  return <CodeSceneView {...props} frame={frame} width={width} height={height} fps={fps} />;
}
