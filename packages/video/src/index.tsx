import React, { useCallback, useMemo, useLayoutEffect, useRef, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { AbsoluteFill, Audio, Img, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig, delayRender, continueRender } from 'remotion';
import { brandSceneHtml, sanitizeSceneHtml, SubtitleSchema, layoutMetrics, timelineFrames, codeVisualOf, type Scene, type Storyboard, type StyleId, type FrameCard } from '@m2v/schema';
import { resolveSceneTheme } from './theme';
import { captionDuration, captionAt, resolveCaptionCues } from './captions';
import { rendererScale, CAPTION_EDGE_RATIO, CAPTION_LINE_HEIGHT, CAPTION_PADDING_Y, captionSafeArea } from './safe-area';
import { brandLogoPlacement } from './brand-overlay';
import { CodeScene } from './code-scene';
import { CodeHtmlScene } from './code-html-scene';

/**
 * #206: HTML-mode math scenes carry the formula as escaped LaTeX inside `p.m2v-math-formula` (the
 * class the web app's scene-html-builder writes). The sanitizer cannot keep KaTeX markup, so the
 * paragraph is typeset here, after sanitizing, from the trusted `visual.formula` field with KaTeX's
 * safe settings (`trust: false`, no raw HTML).
 */
function typesetHtmlFormula(scene: { type: string; visual: Record<string, unknown> }, html: string): string {
  if (scene.type !== 'math' || typeof scene.visual.formula !== 'string' || !scene.visual.formula.trim()) return html;
  const formula = katex.renderToString(scene.visual.formula, { displayMode: true, throwOnError: false, trust: false, output: 'html' });
  return html.replace(/(<p class="m2v-math-formula"[^>]*>)[^<]*(<\/p>)/, (_whole, open: string, close: string) => `${open}${formula}${close}`);
}

export * from './code-scene';
export * from './code-html-scene';

function FitContent({ children, signature, onOverflow }: { children: React.ReactNode; signature: string; onOverflow?: (overflowing: boolean) => void }) {
  const outer = useRef<HTMLDivElement>(null), inner = useRef<HTMLDivElement>(null);
  const [factor, setFactor] = useState(1);
  useLayoutEffect(() => {
    const handle = delayRender('计算场景排版'); let stopped = false, continued = false;
    const unblock = () => { if (!continued) { continued = true; continueRender(handle); } };
    const measure = () => { if (stopped || !outer.current || !inner.current) return; const available = outer.current; const content = inner.current; const raw = Math.min(1, available.clientHeight / Math.max(1, content.scrollHeight), available.clientWidth / Math.max(1, content.scrollWidth)); const next = Math.max(.62, raw); setFactor(next); onOverflow?.(raw < .9); };
    void document.fonts.ready.then(() => { measure(); requestAnimationFrame(unblock); });
    const observer = new ResizeObserver(measure); if (inner.current) observer.observe(inner.current);
    return () => { stopped = true; observer.disconnect(); unblock(); };
  }, [signature, onOverflow]);
  return <div ref={outer} style={{ position: 'absolute', inset: '15% 5% 20%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div ref={inner} style={{ width: '100%', flexShrink: 0, transform: `scale(${factor})`, transformOrigin: 'center', overflowWrap: 'anywhere' }}>{children}</div></div>;
}

/**
 * #212: full-frame HTML scenes used to bypass FitContent and were simply clipped to the canvas, so a
 * dense table (30 short rows) lost its last rows without any overflow warning. The markup is now
 * measured like FitContent: it is scaled down to fit the frame (not below 0.5) and the editor's
 * overflow report fires when it needed more than a 10% reduction.
 */
// #213: the saved markup is not rendered with pre-wrap; formatting whitespace between tags stays
// collapsed, and generated layouts carry their own <br> line breaks.
/**
 * #212 (pages): when the markup is still taller than the frame at the 0.5 minimum, it is shown as
 * consecutive pages of one frame height across the scene duration, so every row appears on screen
 * instead of being clipped. The last page is aligned with the end of the content.
 */
function FitFrame({ html, style, signature, onOverflow, frame = 0, durationInFrames = 1 }: { html: string; style: React.CSSProperties; signature: string; onOverflow?: (overflowing: boolean) => void; frame?: number; durationInFrames?: number }) {
  const outer = useRef<HTMLDivElement>(null), inner = useRef<HTMLDivElement>(null);
  const [factor, setFactor] = useState(1);
  const [layout, setLayout] = useState({ pages: 1, viewport: 0, scaledHeight: 0 });
  useLayoutEffect(() => {
    const handle = delayRender('计算 HTML 场景排版'); let stopped = false, continued = false;
    const unblock = () => { if (!continued) { continued = true; continueRender(handle); } };
    const measure = () => {
      if (stopped || !outer.current || !inner.current) return;
      const content = inner.current.firstElementChild as HTMLElement | null;
      const height = Math.max(inner.current.scrollHeight, content?.scrollHeight ?? 0);
      const width = Math.max(inner.current.scrollWidth, content?.scrollWidth ?? 0);
      const viewport = outer.current.clientHeight;
      const raw = Math.min(1, viewport / Math.max(1, height), outer.current.clientWidth / Math.max(1, width));
      const next = Math.max(0.5, raw);
      const scaledHeight = height * next;
      setFactor(next);
      setLayout({ pages: viewport > 0 && scaledHeight > viewport + 1 ? Math.ceil(scaledHeight / viewport) : 1, viewport, scaledHeight });
      onOverflow?.(raw < 0.9);
    };
    void document.fonts.ready.then(() => { measure(); requestAnimationFrame(unblock); });
    const observer = new ResizeObserver(measure); if (inner.current) observer.observe(inner.current);
    return () => { stopped = true; observer.disconnect(); unblock(); };
  }, [signature, onOverflow]);
  const page = layout.pages > 1 ? Math.min(layout.pages - 1, Math.floor(Math.max(0, frame) * layout.pages / Math.max(1, durationInFrames))) : 0;
  const offset = page === 0 ? 0 : Math.min(page * layout.viewport, Math.max(0, layout.scaledHeight - layout.viewport));
  return <div ref={outer} data-html-pages={layout.pages} data-html-page={page} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
    <div ref={inner} style={{ ...style, position: 'absolute', inset: 'auto', top: 0, left: 0, width: `${100 / factor}%`, height: `${100 / factor}%`, transform: `scale(${factor}) translateY(${-offset / factor}px)`, transformOrigin: 'top left' }} dangerouslySetInnerHTML={{ __html: html }} />
  </div>;
}

function SceneView({ scene, styleId, brand, subtitles, transition = 'none', durationInFrames, onOverflow }: { scene: Scene; styleId: StyleId; brand: Storyboard['brand']; subtitles: Storyboard["subtitles"]; transition?: Storyboard["transition"]; durationInFrames?: number; onOverflow?: (sceneId: string, overflowing: boolean) => void }) {
  styleId = scene.sceneStyle ?? styleId;
  const reportOverflow = useCallback((overflowing: boolean) => onOverflow?.(scene.id, overflowing), [onOverflow, scene.id]);
  const layoutSignature = useMemo(() => JSON.stringify([scene, styleId, brand]), [scene, styleId, brand]);
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const scale = rendererScale(width, height);
  const metrics = layoutMetrics(scene, height > width);
  const theme = resolveSceneTheme({ styleId, brand }, scene);
  const bodyBoost = height > width ? 1.15 : 1;
  const style = { ...theme, typography: { ...theme.typography, bodyScale: theme.typography.bodyScale * metrics.density * bodyBoost }, layout: { ...theme.layout, padding: theme.layout.padding * scale } };
  const subtitle = SubtitleSchema.parse(subtitles ?? {});
  const captionStyle: React.CSSProperties = { position: "absolute", zIndex: 5, left: `${CAPTION_EDGE_RATIO * 100}%`, right: `${CAPTION_EDGE_RATIO * 100}%`, ...(subtitle.position === "top" ? { top: `${CAPTION_EDGE_RATIO * 100}%` } : subtitle.position === "center" ? { top: "50%", transform: "translateY(-50%)" } : { bottom: `${CAPTION_EDGE_RATIO * 100}%` }), boxSizing: "border-box", padding: `${CAPTION_PADDING_Y * scale}px ${18 * scale}px`, borderRadius: 8 * scale, background: subtitle.preset === "minimal" ? "transparent" : `${subtitle.background}${Math.round(subtitle.backgroundOpacity * 255).toString(16).padStart(2, "0")}`, color: subtitle.color, textShadow: subtitle.preset === "minimal" ? "0 2px 4px #000" : undefined, textAlign: "center", fontSize: subtitle.fontSize * scale, lineHeight: CAPTION_LINE_HEIGHT, fontWeight: subtitle.preset === "highlight" ? 900 : 700, overflowWrap: "anywhere" };
  const imageStyle: React.CSSProperties = { width: "100%", height: "100%", objectFit: scene.image?.fit ?? "contain", objectPosition: `${scene.image?.x ?? 50}% ${scene.image?.y ?? 50}%`, transform: `scale(${scene.image?.zoom ?? 1})`, transformOrigin: `${scene.image?.x ?? 50}% ${scene.image?.y ?? 50}%` };
  const colors = theme.colors;
  const bg = styleId === 'minimal-tech' ? `linear-gradient(${brand ? `${colors.accent}0E` : 'rgba(80,227,194,.055)'} 1px, transparent 1px), linear-gradient(90deg, ${brand ? `${colors.accent}0E` : 'rgba(80,227,194,.055)'} 1px, transparent 1px), radial-gradient(ellipse at 85% 15%, ${brand ? colors.secondary : '#173553'} 0%, ${colors.bg} 56%)` : styleId === 'social-short' ? `radial-gradient(circle at 12% 85%, ${colors.secondary} 0%, transparent 34%), radial-gradient(circle at 88% 15%, ${brand ? colors.secondary : '#6346bd'} 0%, ${colors.bg} 50%)` : colors.bg;
  const entering = style.motion.entrance === 'kinetic'
    ? { opacity: interpolate(frame, [0, 9], [0, 1], { extrapolateRight: 'clamp' }), transform: `translateY(${interpolate(frame, [0, 12], [80, 0], { extrapolateRight: 'clamp' })}px) scale(${interpolate(frame, [0, 12], [.86, 1], { extrapolateRight: 'clamp' })})` }
    : style.motion.entrance === 'slide'
      ? { opacity: 1, transform: `translateX(${interpolate(frame, [0, 16], [-60, 0], { extrapolateRight: 'clamp' })}px)` }
      : style.motion.entrance === 'scale'
        ? { opacity: interpolate(frame, [0, 12], [0, 1], { extrapolateRight: 'clamp' }), transform: `scale(${interpolate(frame, [0, 12], [.92, 1], { extrapolateRight: 'clamp' })})` }
        : { opacity: interpolate(frame, [0, Math.min(16, fps / 2)], [0, 1], { extrapolateRight: 'clamp' }) };
  const fadeFrames = Math.max(1, Math.round(fps * 0.6));
  const fade = transition === 'fade' && durationInFrames
    ? Math.min(
      interpolate(frame, [0, fadeFrames], [0, 1], { extrapolateRight: 'clamp' }),
      interpolate(frame, [Math.max(0, durationInFrames - fadeFrames), durationInFrames], [1, 0], { extrapolateLeft: 'clamp' }),
    )
    : 1;
  const centered = style.layout.alignment === 'center';
  const htmlVisual = typesetHtmlFormula(scene, sanitizeSceneHtml(String(scene.visual.html ?? '')).replace(/(<div\b[^>]*\bstyle="[^"]*)justify-content\s*:\s*center\b([^"]*")/i, '$1justify-content:flex-start$2'));
  // #189: HTML-mode layouts follow the Brand Snapshot's colours; unbranded output is unchanged.
  const brandedHtml = brand ? brandSceneHtml(htmlVisual, colors) : htmlVisual;
  const mediaSrc = String(scene.visual.src ?? '');
  const credit = [scene.visual['attribution'], scene.visual['license']].map(value => typeof value === 'string' ? value.trim() : '').filter(Boolean).join(' · ');
  const creditUrl = [scene.visual['licenseUrl'], scene.visual['sourceUrl']].find((value): value is string => typeof value === 'string' && /^https?:\/\//i.test(value));
  const creditText = credit && creditUrl ? `${credit} · ${creditUrl}` : credit;
  const isFullBleedSlide = scene.type === 'media' && (scene.visual.fullBleed === true || /(?:^|\/)slide-\d+\.png$/i.test(mediaSrc));
  const captionCues = useMemo(() => resolveCaptionCues(scene, captionDuration(scene), height > width), [scene, height, width]);
  const caption = subtitle.enabled ? captionAt(captionCues, frame / fps) : "";
  if (isFullBleedSlide) {
    return <AbsoluteFill style={{ backgroundColor: '#000', opacity: fade }}>
      <Img src={staticFile(mediaSrc)} style={imageStyle} />
      {caption && <div style={captionStyle}>{caption}</div>}
      {creditText && <small style={{ position: 'absolute', right: 20 * scale, top: 16 * scale, padding: `${5 * scale}px ${8 * scale}px`, background: 'rgba(0,0,0,.6)', color: '#fff', fontSize: 13 * scale }}>{creditText}</small>}
      {scene.audioSrc && <Audio src={staticFile(scene.audioSrc)} />}
    </AbsoluteFill>;
  }
  const box: React.CSSProperties = { borderRadius: style.layout.cardStyle === 'none' ? 0 : style.layout.borderRadius, padding: style.layout.cardStyle === 'none' ? '20px 0' : 32, background: style.layout.cardStyle === 'soft' ? colors.card : 'transparent', border: style.layout.cardStyle === 'soft' ? `1px solid ${colors.accent}55` : 'none', boxShadow: styleId === 'social-short' ? `10px 10px 0 ${colors.secondary}` : 'none' };
  const title = <h1 style={{ fontFamily: theme.fontFamilies.heading, fontSize: 55 * scale * style.typography.titleScale * ((scene.title?.length ?? 0) > 24 ? .8 : 1), lineHeight: 1.08, margin: `0 0 ${24 * scale}px`, color: colors.fg, letterSpacing: styleId === 'social-short' ? -2 * scale : 0, textAlign: centered ? 'center' : 'left' }}>{scene.title ?? scene.type.toUpperCase()}</h1>;
  let content: React.ReactNode;
  // Structured code scenes always use the dynamic renderer; a static `visual.html` on such a scene
  // only means "HTML generation mode" and must not replace the code window with stale markup.
  const structuredCode = scene.type === 'code' && codeVisualOf(scene.visual) !== null;
  const staticHtmlScene = typeof scene.visual.html === 'string' && scene.type !== 'media' && !structuredCode;
  switch (staticHtmlScene ? 'html' : scene.type) {
    case 'title': content = <div style={{ textAlign: 'center' }}>{title}<p style={{ color: colors.muted, fontSize: 32 * scale * style.typography.bodyScale }}>{scene.narration}</p></div>; break;
    case 'text': content = <div>{title}<p style={{ color: colors.fg, fontSize: 34 * scale * style.typography.bodyScale, lineHeight: 1.55, whiteSpace: 'pre-wrap', textAlign: centered ? 'center' : 'left' }}>{String(scene.visual.text ?? scene.narration)}</p></div>; break;
    case 'bullets': { const items = (scene.visual.items as (string | { text: string; children?: string[] })[] | undefined) ?? []; content = <div>{title}<ul style={{ color: colors.fg, fontSize: 34 * scale * style.typography.bodyScale, lineHeight: styleId === 'academic' ? 1.45 : 1.65, paddingLeft: centered ? 38 * scale : undefined }}>{items.map((item, i) => { const text = typeof item === 'string' ? item : item.text; const children = typeof item === 'string' ? [] : item.children ?? []; return <li key={i} style={{ padding: `${5 * scale}px 0` }}>{text}{children.length > 0 && <ul style={{ fontSize: '0.78em', lineHeight: 1.45, paddingLeft: 30 * scale, marginTop: 4 * scale }}>{children.map((child, childIndex) => <li key={childIndex} style={{ padding: `${2 * scale}px 0` }}>{child}</li>)}</ul>}</li>; })}</ul></div>; break; }
    case 'comparison': {
      const schematic = scene.visual.layout === 'diagram';
      const columns = scene.visual.columns as { title?: string; items?: string[] }[];
      const arrowOpacity = interpolate(frame, [0, Math.max(1, fps / 2)], [.2, 1], { extrapolateRight: 'clamp' });
      content = <div>{title}<div style={{ display: 'flex', flexDirection: metrics.stacked ? 'column' : 'row', gap: 24 * scale }}>
        {columns.map((col, i) => <React.Fragment key={i}>
          {i > 0 && schematic && <span aria-hidden style={{ alignSelf: 'center', color: colors.accent, opacity: arrowOpacity, fontSize: 46 * scale }}>{metrics.stacked ? '↕' : '↔'}</span>}
          <div style={{ ...box, ...(schematic ? { border: `2px solid ${i ? colors.secondary : colors.accent}88`, background: colors.card, padding: 22 * scale } : {}), flex: 1, color: colors.fg }}>
            <h2 style={schematic ? { margin: 0, fontSize: 35 * scale } : undefined}>{col.title ?? `选项 ${i + 1}`}</h2>
            {(col.items ?? []).map((item, j) => <p key={j} style={{ fontSize: 25 * scale * style.typography.bodyScale, ...(schematic ? { borderLeft: `3px solid ${colors.accent}`, background: colors.bg, margin: `${12 * scale}px 0 0 ${14 * scale}px`, padding: `${8 * scale}px ${14 * scale}px` } : {}) }}>{item}</p>)}
          </div>
        </React.Fragment>)}
      </div></div>;
      break;
    }
    case 'chart': {
      const rawData: unknown[] = Array.isArray(scene.visual.data) ? scene.visual.data : [];
      const matrix = rawData.length > 0 && rawData.every(Array.isArray) ? rawData as unknown[][] : null;
      const sourceNodes = scene.visual.nodes;
      const rawNodes = Array.isArray(sourceNodes) ? sourceNodes : sourceNodes && typeof sourceNodes === 'object' ? Object.values(sourceNodes) : [];
      const nodes = rawNodes.map((value, index) => {
        if (typeof value === 'string') return { id: `node-${index}`, label: value.trim(), icon: '' };
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const node = value as Record<string, unknown>;
        const data = node.data && typeof node.data === 'object' && !Array.isArray(node.data) ? node.data as Record<string, unknown> : {};
        const label = [node.label, data.label, node.text, data.text, node.title, data.title, node.name, node.content, data.content, node.description, data.description, node.value, data.value].find(item => typeof item === 'string' && item.trim());
        const icon = [node.icon, data.icon, node.emoji, data.emoji].find(item => typeof item === 'string' && item.trim());
        return typeof label === 'string' || typeof icon === 'string'
          ? { id: typeof node.id === 'string' && node.id ? node.id : `node-${index}`, label: typeof label === 'string' ? label.trim() : '', icon: typeof icon === 'string' ? icon.trim() : '' }
          : null;
      }).filter((node): node is { id: string; label: string; icon: string } => Boolean(node && (node.label || node.icon)));
      if (nodes.length) {
        content = <div>{title}<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, flexWrap: 'wrap' }}>{nodes.map((node, index) => <React.Fragment key={`${node.id}-${index}`}><div style={{ ...box, color: colors.fg, fontSize: 28 * scale * style.typography.bodyScale }}>{node.icon && <span style={{ display: 'block', fontSize: 38 * scale, marginBottom: 8 * scale }}>{node.icon}</span>}{node.label}</div>{index < nodes.length - 1 && <span style={{ color: colors.accent, fontSize: 40 }}>→</span>}</React.Fragment>)}</div></div>;
      } else if (matrix) {
        const width = Math.max(1, ...matrix.map(row => row.length));
        const headers = Array.from({ length: width }, (_, index) => String(matrix[0]?.[index] ?? `列 ${index + 1}`));
        const rows = matrix.slice(1).map(row => headers.map((_, index) => String(row[index] ?? '')));
        content = <div>{title}<table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', color: colors.fg, fontSize: 24 * scale * style.typography.bodyScale, lineHeight: 1.35 }}><thead><tr>{headers.map((header, index) => <th key={index} style={{ padding: `${12 * scale}px`, border: `1px solid ${colors.accent}88`, background: `${colors.accent}22`, textAlign: 'left', overflowWrap: 'anywhere' }}>{header}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index} style={{ padding: `${12 * scale}px`, border: `1px solid ${colors.accent}55`, textAlign: 'left', verticalAlign: 'top', overflowWrap: 'anywhere' }}>{cell}</td>)}</tr>)}</tbody></table></div>;
      } else {
        const data = rawData.filter((item): item is { label: string; value: number } => Boolean(item && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, unknown>).label === 'string' && typeof (item as Record<string, unknown>).value === 'number' && Number.isFinite((item as Record<string, unknown>).value)));
        if (data.length) {
          const max = Math.max(...data.map(item => item.value), 1);
          content = <div>{title}<div style={{ display: 'flex', alignItems: 'end', gap: 22, height: 340 }}>{data.map((item, index) => <div key={index} style={{ flex: 1, textAlign: 'center', color: colors.muted }}><div style={{ height: `${Math.max(8, 280 * item.value / max)}px`, background: index % 2 ? colors.secondary : colors.accent, borderRadius: styleId === 'academic' ? 0 : '12px 12px 0 0' }} /><b style={{ color: colors.fg }}>{item.label}</b></div>)}</div></div>;
        } else content = <div>{title}<p style={{ color: colors.fg, fontSize: 30 * scale * style.typography.bodyScale, lineHeight: 1.5 }}>{scene.narration}</p></div>;
      }
      break;
    }
    case 'code': {
      // Structured code scenes render the real source window at a protected font size and are not
      // part of the generic content-fitting pass.
      if (codeVisualOf(scene.visual)) {
        // Reserve the real caption band (live subtitle size/position) so the beat card cannot
        // overlap the subtitles in either aspect ratio. Both rendering modes use the same visual.
        const captionBand = captionSafeArea({ videoHeight: height, fontSize: subtitle.fontSize, scale, lines: 2 }).total;
        // #166: a centred caption would sit across the middle of the code window, so code scenes draw
        // it in the bottom band instead and reserve that band like a bottom caption.
        const codeCaptionBottom = subtitle.position === 'bottom' || subtitle.position === 'center';
        const captionReservedPx = subtitle.enabled && codeCaptionBottom ? captionBand : 0;
        const codeCaptionStyle: React.CSSProperties = subtitle.position === 'center'
          ? { ...captionStyle, top: undefined, transform: undefined, bottom: `${CAPTION_EDGE_RATIO * 100}%` }
          : captionStyle;
        // #166: top subtitles reserve their band at the top (the beat card and header sit below it).
        const captionTopReservedPx = subtitle.enabled && subtitle.position === 'top' ? captionBand : 0;
        const htmlMode = typeof scene.visual.html === 'string';
        return <AbsoluteFill style={{ ...entering, opacity: Number(entering.opacity) * fade, background: bg, backgroundSize: styleId === 'minimal-tech' ? '42px 42px, 42px 42px, cover' : 'cover', overflow: 'hidden' }}>
          {htmlMode
            ? <CodeHtmlScene scene={scene} styleId={styleId} brand={brand} captionReservedPx={captionReservedPx} captionTopReservedPx={captionTopReservedPx} />
            : <CodeScene scene={scene} styleId={styleId} brand={brand} captionReservedPx={captionReservedPx} captionTopReservedPx={captionTopReservedPx} />}
          {caption && <div data-code-caption={subtitle.position} style={codeCaptionStyle}>{caption}</div>}
          {scene.audioSrc && <Audio src={staticFile(scene.audioSrc)} />}
        </AbsoluteFill>;
      }
      // Legacy code scenes (explanation/steps only, no visual.code) keep their original layout.
      content = <div>{title}<div style={{ ...box, color: colors.fg, fontSize: 30 * scale * style.typography.bodyScale, lineHeight: 1.5 }}><p>{String(scene.visual.explanation ?? scene.narration)}</p>{Array.isArray(scene.visual.steps) && <ul>{(scene.visual.steps as unknown[]).filter((step): step is string => typeof step === 'string' && Boolean(step.trim())).slice(0, 5).map((step, index) => <li key={index}>{step}</li>)}</ul>}</div></div>;
      break;
    }
    case 'diagram': {
      const sourceNodes = scene.visual.nodes;
      const rawNodes = Array.isArray(sourceNodes) ? sourceNodes : sourceNodes && typeof sourceNodes === 'object' ? Object.values(sourceNodes) : [];
      const nodes = rawNodes.map((value, index) => {
        if (typeof value === 'string') return { id: `node-${index}`, label: value.trim(), icon: '' };
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const node = value as Record<string, unknown>;
        const data = node.data && typeof node.data === 'object' && !Array.isArray(node.data) ? node.data as Record<string, unknown> : {};
        const label = [node.label, data.label, node.text, data.text, node.title, data.title, node.name, node.content, data.content, node.description, data.description, node.value, data.value].find(item => typeof item === 'string' && item.trim());
        const icon = [node.icon, data.icon, node.emoji, data.emoji].find(item => typeof item === 'string' && item.trim());
        return typeof label === 'string' || typeof icon === 'string'
          ? { id: typeof node.id === 'string' && node.id ? node.id : `node-${index}`, label: typeof label === 'string' ? label.trim() : '', icon: typeof icon === 'string' ? icon.trim() : '' }
          : null;
      }).filter((node): node is { id: string; label: string; icon: string } => Boolean(node && (node.label || node.icon)));
      content = <div>{title}{nodes.length > 0
        ? <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, flexWrap: 'wrap' }}>{nodes.map((node, i) => <React.Fragment key={`${node.id}-${i}`}><div style={{ ...box, color: colors.fg, fontSize: 28 * scale * style.typography.bodyScale }}>{node.icon && <span style={{ display: 'block', fontSize: 38 * scale, marginBottom: 8 * scale }}>{node.icon}</span>}{node.label}</div>{i < nodes.length - 1 && <span style={{ color: colors.accent, fontSize: 40 }}>→</span>}</React.Fragment>)}</div>
        : <p style={{ color: colors.fg, fontSize: 30 * scale * style.typography.bodyScale, lineHeight: 1.5, textAlign: centered ? 'center' : 'left' }}>{nodes[0]?.label || scene.narration}</p>}</div>;
      break;
    }
    case 'timeline': { const items = (scene.visual.items as { date: string; label: string }[] | undefined) ?? []; content = <div>{title}<div style={{ display: 'flex', flexDirection: metrics.stacked ? 'column' : 'row', gap: 12 * scale, alignItems: 'stretch' }}>{items.map((item, i) => <div key={i} style={{ flex: 1, borderTop: `4px solid ${colors.accent}`, padding: 16, color: colors.fg, background: colors.card }}><b style={{ color: colors.accent }}>{item.date}</b><p>{item.label}</p></div>)}</div></div>; break; }
    case 'table': { const headers = scene.visual.headers as string[]; const rows = scene.visual.rows as string[][]; content = <div>{title}<table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', color: colors.fg, fontSize: 24 * scale * style.typography.bodyScale, lineHeight: 1.3 }}><thead><tr>{headers.map((header, i) => <th key={i} style={{ padding: `${12 * scale}px`, border: `1px solid ${colors.accent}88`, background: `${colors.accent}22`, textAlign: 'left', overflowWrap: 'anywhere' }}>{header}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, i) => <td key={i} style={{ padding: `${12 * scale}px`, border: `1px solid ${colors.accent}55`, textAlign: 'left', verticalAlign: 'top', overflowWrap: 'anywhere' }}>{cell}</td>)}</tr>)}</tbody></table></div>; break; }
    case 'math': { const formula = katex.renderToString(String(scene.visual.formula ?? ''), { displayMode: true, throwOnError: false, trust: false, output: 'html' }); content = <div>{title}<div style={{ textAlign: 'center', fontSize: 52 * scale, padding: 36, color: colors.accent }} dangerouslySetInnerHTML={{ __html: formula }} /><p style={{ color: colors.fg }}>{String(scene.visual.explanation ?? scene.narration)}</p></div>; break; }
    case 'media': content = <div>{title}<div style={{ height: height * .56, overflow: 'hidden' }}><Img src={staticFile(String(scene.visual.src ?? ''))} style={imageStyle} /></div>    {creditText && <small style={{ display: 'block', textAlign: 'center', marginTop: 12, color: colors.muted, fontSize: 13 * scale }}>{creditText}</small>}</div>; break;
    case 'html': content = <div style={{ width: '100%', height: height * .7, maxHeight: height * .78, overflow: 'hidden', display: 'flex', flexDirection: 'column', color: colors.fg, fontFamily: theme.fontFamilies.body, fontSize: 30 * scale * style.typography.bodyScale, lineHeight: 1.45 }} dangerouslySetInnerHTML={{ __html: brandedHtml }} />; break;
  }
  if (typeof scene.visual.html === 'string' && scene.type !== 'media') {
    return <AbsoluteFill style={{ ...entering, opacity: Number(entering.opacity) * fade, background: bg, overflow: 'hidden' }}>
      <FitFrame html={brandedHtml} signature={`${scene.id}:${width}x${height}:${brandedHtml.length}`} frame={frame} durationInFrames={durationInFrames ?? 1} onOverflow={onOverflow ? reportOverflow : undefined} style={{ display: 'grid', overflow: 'visible', background: brand ? colors.bg : '#0b1020', ...(brand ? { color: colors.fg, fontFamily: theme.fontFamilies.body } : {}) }} />
      {caption && <div style={captionStyle}>{caption}</div>}
      {scene.audioSrc && <Audio src={staticFile(scene.audioSrc)} />}
    </AbsoluteFill>;
  }
  const texture = styleId === 'academic' ? 'repeating-linear-gradient(0deg, transparent, transparent 43px, rgba(90,70,45,.08) 44px)' : styleId === 'clean-light' ? 'radial-gradient(#d8e0ef 1px, transparent 1px)' : 'none';
  return <AbsoluteFill style={{ ...entering, opacity: Number(entering.opacity) * fade, background: bg, backgroundSize: styleId === 'minimal-tech' ? '42px 42px, 42px 42px, cover' : 'cover', color: colors.fg, padding: style.layout.padding, justifyContent: 'center', fontFamily: theme.fontFamilies.body }}>
    {texture !== 'none' && <div style={{ position: 'absolute', inset: 0, background: texture, backgroundSize: styleId === 'academic' ? 'auto' : '20px 20px', pointerEvents: 'none' }} />}
    {styleId === 'minimal-tech' && <div style={{ position: 'absolute', top: 44, left: style.layout.padding, color: colors.accent, fontSize: 17, letterSpacing: 4 }}>◈ KNOWLEDGE / {scene.type.toUpperCase()}</div>}
    {styleId === 'clean-light' && <div style={{ position: 'absolute', top: 0, left: 0, width: 22, height: '100%', background: colors.accent }} />}
    {styleId === 'academic' && <div style={{ position: 'absolute', top: 48, left: style.layout.padding, right: style.layout.padding, borderTop: `2px solid ${colors.accent}`, paddingTop: 12, color: colors.muted, fontFamily: theme.fontFamilies.heading, fontSize: 16 }}>讲义　·　{scene.title ?? '章节摘要'}</div>}
    {styleId === 'social-short' && <div style={{ position: 'absolute', top: 48, right: 70, color: colors.accent, fontSize: 22, fontWeight: 900, letterSpacing: 2 }}>要点速看 ✦</div>}
    <FitContent signature={layoutSignature} onOverflow={onOverflow ? reportOverflow : undefined}><div style={{ ...box, position: 'relative', zIndex: 1, width: '100%', overflowWrap: 'anywhere', boxSizing: 'border-box', textAlign: centered ? 'center' : 'left' }}>{content}</div></FitContent>
    {caption && <div style={captionStyle}>{caption}</div>}
    {scene.audioSrc && <Audio src={staticFile(scene.audioSrc)} />}
  </AbsoluteFill>;
}

/**
 * Intro/outro cards are internal presentation scenes, not narrated scenes. #290: running them
 * through SceneSchema threw on an empty subtitle (narration must be non-empty) and on a
 * fallback storyboard title over 50 characters, so valid card settings broke preview and MP4.
 */
function frameCardScene(card: FrameCard, id: string, fallbackTitle: string): Scene {
  return { id, type: 'title', title: card.title?.trim() || fallbackTitle, narration: card.subtitle ?? '', duration: card.duration, visual: {} } as Scene;
}

function BrandLogoOverlay({ logo, subtitles }: { logo: NonNullable<Storyboard['brand']>['logo']; subtitles: Storyboard['subtitles'] }) {
  const { width: videoWidth, height: videoHeight } = useVideoConfig();
  const placement = brandLogoPlacement({ logo, subtitles, videoWidth, videoHeight });
  if (!placement || !logo) return null;
  const horizontal = placement.edge === 'left' ? { left: placement.edgeOffset } : { right: placement.edgeOffset };
  const vertical = placement.verticalEdge === 'top' ? { top: placement.verticalOffset } : { bottom: placement.verticalOffset };
  // #182: the Logo is decorative. Passing onError keeps a missing or unreadable file from
  // failing the whole render; the render route also drops a Logo whose file is gone.
  return <Img src={staticFile(logo.src)} onError={() => { console.warn(`[brand-logo] 无法加载 Logo：${logo.src}`); }} style={{ position: 'absolute', zIndex: placement.zIndex, ...horizontal, ...vertical, width: placement.width, height: 'auto', opacity: placement.opacity, objectFit: 'contain', pointerEvents: 'none' }} />;
}

export function ExplainerVideo({ storyboard, onOverflow }: { storyboard: Storyboard; onOverflow?: (sceneId: string, overflowing: boolean) => void }) {
  const { fps } = useVideoConfig();
  const { segments } = timelineFrames(storyboard, fps);
  const music = storyboard.bgmSrc;
  const totalFrames = getDurationInFrames(storyboard, fps);
  const fadeInFrames = Math.round((storyboard.bgmFadeIn ?? 1) * fps);
  const fadeOutFrames = Math.round((storyboard.bgmFadeOut ?? 1) * fps);
  const baseVolume = storyboard.bgmVolume ?? 0.12;
  const volume = (frame: number) => Math.min(baseVolume, fadeInFrames ? baseVolume * frame / fadeInFrames : baseVolume, fadeOutFrames ? baseVolume * Math.max(0, totalFrames - frame) / fadeOutFrames : baseVolume);
  const introSegment = segments.find(segment => segment.kind === 'intro');
  const outroSegment = segments.find(segment => segment.kind === 'outro');
  const sceneSegments = segments.filter(segment => segment.kind === 'scene');
  const intro = storyboard.intro?.enabled ? storyboard.intro : null;
  const outro = storyboard.outro?.enabled ? storyboard.outro : null;
  return <AbsoluteFill style={{ backgroundColor: '#000' }}>
    {music && <Audio src={staticFile(music)} volume={volume} loop loopVolumeCurveBehavior="extend" />}
    {introSegment && intro && <Sequence from={introSegment.startFrame} durationInFrames={introSegment.frames}><SceneView scene={frameCardScene(intro, 'intro', storyboard.title)} styleId={storyboard.styleId} brand={storyboard.brand} subtitles={storyboard.subtitles} transition={storyboard.transition} durationInFrames={introSegment.frames} onOverflow={onOverflow} /></Sequence>}
    {storyboard.scenes.map((scene, index) => { const segment = sceneSegments[index]; return <Sequence key={scene.id} from={segment.startFrame} durationInFrames={segment.frames}><SceneView scene={scene} styleId={storyboard.styleId} brand={storyboard.brand} subtitles={storyboard.subtitles} transition={storyboard.transition} durationInFrames={segment.frames} onOverflow={onOverflow} /></Sequence>; })}
    {outroSegment && outro && <Sequence from={outroSegment.startFrame} durationInFrames={outroSegment.frames}><SceneView scene={frameCardScene(outro, 'outro', storyboard.title)} styleId={storyboard.styleId} brand={storyboard.brand} subtitles={storyboard.subtitles} transition={storyboard.transition} durationInFrames={outroSegment.frames} onOverflow={onOverflow} /></Sequence>}
    <BrandLogoOverlay logo={storyboard.brand?.logo} subtitles={storyboard.subtitles} />
  </AbsoluteFill>;
}

export const getDurationInFrames = (storyboard: Storyboard, fps = 30) => timelineFrames(storyboard, fps).totalFrames;
