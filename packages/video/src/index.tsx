import React, { useCallback, useMemo, useLayoutEffect, useRef, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { AbsoluteFill, Audio, Img, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig, delayRender, continueRender } from 'remotion';
import { SubtitleSchema, SceneSchema, layoutMetrics, timelineFrames, type Scene, type Storyboard, type StyleId, type FrameCard } from '@m2v/schema';
import { styles } from '@m2v/styles';
import { captionDuration, captionAt, resolveCaptionCues } from './captions';

const palettes: Record<StyleId, { bg: string; fg: string; muted: string; accent: string; card: string; secondary: string }> = {
  'minimal-tech': { bg: '#080d19', fg: '#f3f7ff', muted: '#9aaac2', accent: '#50e3c2', card: '#111b2c', secondary: '#182741' },
  'clean-light': { bg: '#f4f7fb', fg: '#192438', muted: '#68758a', accent: '#4169e1', card: '#ffffff', secondary: '#e7eefc' },
  academic: { bg: '#f2ead8', fg: '#2d2923', muted: '#736a5b', accent: '#8a3d2e', card: '#faf6eb', secondary: '#e6dcc6' },
  'social-short': { bg: '#190d35', fg: '#ffffff', muted: '#e3d9ff', accent: '#ffcf4a', card: '#34205d', secondary: '#ef4d9b' },
  whiteboard: { bg: '#fffef9', fg: '#20252c', muted: '#606974', accent: '#2367c8', card: '#ffffff', secondary: '#e8f0fc' },
};

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

function SceneView({ scene, styleId, subtitles, transition = 'none', durationInFrames, onOverflow }: { scene: Scene; styleId: StyleId; subtitles: Storyboard["subtitles"]; transition?: Storyboard["transition"]; durationInFrames?: number; onOverflow?: (sceneId: string, overflowing: boolean) => void }) {
  styleId = scene.sceneStyle ?? styleId;
  const reportOverflow = useCallback((overflowing: boolean) => onOverflow?.(scene.id, overflowing), [onOverflow, scene.id]);
  const layoutSignature = useMemo(() => JSON.stringify([scene, styleId]), [scene, styleId]);
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const scale = height > width ? Math.min(width / 1080, 1.25) : Math.min(width / 1920, 1.25);
  const metrics = layoutMetrics(scene, height > width);
  const base = styles[styleId];
  const bodyBoost = height > width ? 1.15 : 1;
  const style = { ...base, typography: { ...base.typography, bodyScale: base.typography.bodyScale * metrics.density * bodyBoost }, layout: { ...base.layout, padding: base.layout.padding * scale } };
  const subtitle = SubtitleSchema.parse(subtitles ?? {});
  const captionStyle: React.CSSProperties = { position: "absolute", zIndex: 5, left: "5%", right: "5%", ...(subtitle.position === "top" ? { top: "5%" } : subtitle.position === "center" ? { top: "50%", transform: "translateY(-50%)" } : { bottom: "5%" }), boxSizing: "border-box", padding: `${10 * scale}px ${18 * scale}px`, borderRadius: 8 * scale, background: subtitle.preset === "minimal" ? "transparent" : `${subtitle.background}${Math.round(subtitle.backgroundOpacity * 255).toString(16).padStart(2, "0")}`, color: subtitle.color, textShadow: subtitle.preset === "minimal" ? "0 2px 4px #000" : undefined, textAlign: "center", fontSize: subtitle.fontSize * scale, lineHeight: 1.4, fontWeight: subtitle.preset === "highlight" ? 900 : 700, overflowWrap: "anywhere" };
  const imageStyle: React.CSSProperties = { width: "100%", height: "100%", objectFit: scene.image?.fit ?? "contain", objectPosition: `${scene.image?.x ?? 50}% ${scene.image?.y ?? 50}%`, transform: `scale(${scene.image?.zoom ?? 1})`, transformOrigin: `${scene.image?.x ?? 50}% ${scene.image?.y ?? 50}%` };
  const colors = palettes[styleId];
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
  const title = <h1 style={{ fontFamily: style.typography.headingFont, fontSize: 55 * scale * style.typography.titleScale * ((scene.title?.length ?? 0) > 24 ? .8 : 1), lineHeight: 1.08, margin: `0 0 ${24 * scale}px`, color: colors.fg, letterSpacing: styleId === 'social-short' ? -2 * scale : 0, textAlign: centered ? 'center' : 'left' }}>{scene.title ?? scene.type.toUpperCase()}</h1>;
  let content: React.ReactNode;
  switch (scene.type) {
    case 'title': content = <div style={{ textAlign: 'center' }}>{title}<p style={{ color: colors.muted, fontSize: 32 * scale * style.typography.bodyScale }}>{scene.narration}</p></div>; break;
    case 'bullets': content = <div>{title}<ul style={{ color: colors.fg, fontSize: 34 * scale * style.typography.bodyScale, lineHeight: styleId === 'academic' ? 1.45 : 1.65, paddingLeft: centered ? 38 * scale : undefined }}>{(scene.visual.items as string[]).map((x, i) => <li key={i} style={{ padding: `${5 * scale}px 0` }}>{x}</li>)}</ul></div>; break;
    case 'comparison': content = <div>{title}<div style={{ display: 'flex', flexDirection: metrics.stacked ? 'column' : 'row', gap: 24 * scale }}>{(scene.visual.columns as { title?: string; items?: string[] }[]).map((col, i) => <div key={i} style={{ ...box, flex: 1, color: colors.fg }}><h2>{col.title ?? `选项 ${i + 1}`}</h2>{(col.items ?? []).map((x, j) => <p key={j} style={{ fontSize: 25 * scale * style.typography.bodyScale }}>{x}</p>)}</div>)}</div></div>; break;
    case 'chart': { const data = scene.visual.data as { label: string; value: number }[]; const max = Math.max(...data.map(x => x.value), 1); content = <div>{title}<div style={{ display: 'flex', alignItems: 'end', gap: 22, height: 340 }}>{data.map((x, i) => <div key={i} style={{ flex: 1, textAlign: 'center', color: colors.muted }}><div style={{ height: `${Math.max(8, 280 * x.value / max)}px`, background: i % 2 ? colors.secondary : colors.accent, borderRadius: styleId === 'academic' ? 0 : '12px 12px 0 0' }} /><b style={{ color: colors.fg }}>{x.label}</b></div>)}</div></div>; break; }
    case 'code': content = <div>{title}<pre style={{ ...box, whiteSpace: 'pre-wrap', fontSize: 26 * scale * style.typography.bodyScale, color: colors.accent }}>{String(scene.visual.code ?? scene.narration)}</pre></div>; break;
    case 'diagram': { const nodes = (scene.visual.nodes as { id: string; label: string }[] | undefined) ?? []; content = <div>{title}<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, flexWrap: 'wrap' }}>{nodes.map((node, i) => <React.Fragment key={node.id}><div style={{ ...box, color: colors.fg, fontSize: 28 * scale * style.typography.bodyScale }}>{node.label}</div>{i < nodes.length - 1 && <span style={{ color: colors.accent, fontSize: 40 }}>→</span>}</React.Fragment>)}</div></div>; break; }
    case 'timeline': { const items = (scene.visual.items as { date: string; label: string }[] | undefined) ?? []; content = <div>{title}<div style={{ display: 'flex', flexDirection: metrics.stacked ? 'column' : 'row', gap: 12 * scale, alignItems: 'stretch' }}>{items.map((item, i) => <div key={i} style={{ flex: 1, borderTop: `4px solid ${colors.accent}`, padding: 16, color: colors.fg, background: colors.card }}><b style={{ color: colors.accent }}>{item.date}</b><p>{item.label}</p></div>)}</div></div>; break; }
    case 'math': { const formula = katex.renderToString(String(scene.visual.formula ?? ''), { displayMode: true, throwOnError: false, trust: false, output: 'html' }); content = <div>{title}<div style={{ textAlign: 'center', fontSize: 52 * scale, padding: 36, color: colors.accent }} dangerouslySetInnerHTML={{ __html: formula }} /><p style={{ color: colors.fg }}>{String(scene.visual.explanation ?? scene.narration)}</p></div>; break; }
    case 'media': content = <div>{title}<div style={{ height: height * .56, overflow: 'hidden' }}><Img src={staticFile(String(scene.visual.src ?? ''))} style={imageStyle} /></div>    {creditText && <small style={{ display: 'block', textAlign: 'center', marginTop: 12, color: colors.muted, fontSize: 13 * scale }}>{creditText}</small>}</div>; break;
  }
  const bg = styleId === 'minimal-tech' ? `linear-gradient(rgba(80,227,194,.055) 1px, transparent 1px), linear-gradient(90deg, rgba(80,227,194,.055) 1px, transparent 1px), radial-gradient(ellipse at 85% 15%, #173553 0%, ${colors.bg} 56%)` : styleId === 'social-short' ? `radial-gradient(circle at 12% 85%, ${colors.secondary} 0%, transparent 34%), radial-gradient(circle at 88% 15%, #6346bd 0%, ${colors.bg} 50%)` : colors.bg;
  const texture = styleId === 'academic' ? 'repeating-linear-gradient(0deg, transparent, transparent 43px, rgba(90,70,45,.08) 44px)' : styleId === 'clean-light' ? 'radial-gradient(#d8e0ef 1px, transparent 1px)' : 'none';
  return <AbsoluteFill style={{ ...entering, opacity: Number(entering.opacity) * fade, background: bg, backgroundSize: styleId === 'minimal-tech' ? '42px 42px, 42px 42px, cover' : 'cover', color: colors.fg, padding: style.layout.padding, justifyContent: 'center', fontFamily: style.typography.bodyFont }}>
    {texture !== 'none' && <div style={{ position: 'absolute', inset: 0, background: texture, backgroundSize: styleId === 'academic' ? 'auto' : '20px 20px', pointerEvents: 'none' }} />}
    {styleId === 'minimal-tech' && <div style={{ position: 'absolute', top: 44, left: style.layout.padding, color: colors.accent, fontSize: 17, letterSpacing: 4 }}>◈ KNOWLEDGE / {scene.type.toUpperCase()}</div>}
    {styleId === 'clean-light' && <div style={{ position: 'absolute', top: 0, left: 0, width: 22, height: '100%', background: colors.accent }} />}
    {styleId === 'academic' && <div style={{ position: 'absolute', top: 48, left: style.layout.padding, right: style.layout.padding, borderTop: `2px solid ${colors.accent}`, paddingTop: 12, color: colors.muted, font: '16px Georgia, serif' }}>讲义　·　{scene.title ?? '章节摘要'}</div>}
    {styleId === 'social-short' && <div style={{ position: 'absolute', top: 48, right: 70, color: colors.accent, fontSize: 22, fontWeight: 900, letterSpacing: 2 }}>要点速看 ✦</div>}
    <FitContent signature={layoutSignature} onOverflow={onOverflow ? reportOverflow : undefined}><div style={{ ...box, position: 'relative', zIndex: 1, width: '100%', overflowWrap: 'anywhere', boxSizing: 'border-box', textAlign: centered ? 'center' : 'left' }}>{content}</div></FitContent>
    {caption && <div style={captionStyle}>{caption}</div>}
    {scene.audioSrc && <Audio src={staticFile(scene.audioSrc)} />}
  </AbsoluteFill>;
}

function frameCardScene(card: FrameCard, id: string, fallbackTitle: string): Scene {
  return SceneSchema.parse({ id, type: 'title', title: card.title?.trim() || fallbackTitle, narration: card.subtitle ?? '', duration: card.duration });
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
    {introSegment && intro && <Sequence from={introSegment.startFrame} durationInFrames={introSegment.frames}><SceneView scene={frameCardScene(intro, 'intro', storyboard.title)} styleId={storyboard.styleId} subtitles={storyboard.subtitles} transition={storyboard.transition} durationInFrames={introSegment.frames} onOverflow={onOverflow} /></Sequence>}
    {storyboard.scenes.map((scene, index) => { const segment = sceneSegments[index]; return <Sequence key={scene.id} from={segment.startFrame} durationInFrames={segment.frames}><SceneView scene={scene} styleId={storyboard.styleId} subtitles={storyboard.subtitles} transition={storyboard.transition} durationInFrames={segment.frames} onOverflow={onOverflow} /></Sequence>; })}
    {outroSegment && outro && <Sequence from={outroSegment.startFrame} durationInFrames={outroSegment.frames}><SceneView scene={frameCardScene(outro, 'outro', storyboard.title)} styleId={storyboard.styleId} subtitles={storyboard.subtitles} transition={storyboard.transition} durationInFrames={outroSegment.frames} onOverflow={onOverflow} /></Sequence>}
  </AbsoluteFill>;
}

export const getDurationInFrames = (storyboard: Storyboard, fps = 30) => timelineFrames(storyboard, fps).totalFrames;
