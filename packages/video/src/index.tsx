import React, { useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { AbsoluteFill, Audio, Img, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Scene, Storyboard, StyleId } from '@m2v/schema';
import { styles } from '@m2v/styles';
import { buildCaptionCues, captionAt } from './captions';

const palettes: Record<StyleId, { bg: string; fg: string; muted: string; accent: string; card: string; secondary: string }> = {
  'minimal-tech': { bg: '#080d19', fg: '#f3f7ff', muted: '#9aaac2', accent: '#50e3c2', card: '#111b2c', secondary: '#182741' },
  'clean-light': { bg: '#f4f7fb', fg: '#192438', muted: '#68758a', accent: '#4169e1', card: '#ffffff', secondary: '#e7eefc' },
  academic: { bg: '#f2ead8', fg: '#2d2923', muted: '#736a5b', accent: '#8a3d2e', card: '#faf6eb', secondary: '#e6dcc6' },
  'social-short': { bg: '#190d35', fg: '#ffffff', muted: '#e3d9ff', accent: '#ffcf4a', card: '#34205d', secondary: '#ef4d9b' },
  whiteboard: { bg: '#fffef9', fg: '#20252c', muted: '#606974', accent: '#2367c8', card: '#ffffff', secondary: '#e8f0fc' },
};

function SceneView({ scene, styleId }: { scene: Scene; styleId: StyleId }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const scale = height > width ? Math.min(width / 1080, 1.25) : Math.min(width / 1920, 1.25);
  const style = styles[styleId];
  const colors = palettes[styleId];
  const entering = style.motion.entrance === 'kinetic'
    ? { opacity: interpolate(frame, [0, 9], [0, 1], { extrapolateRight: 'clamp' }), transform: `translateY(${interpolate(frame, [0, 12], [80, 0], { extrapolateRight: 'clamp' })}px) scale(${interpolate(frame, [0, 12], [.86, 1], { extrapolateRight: 'clamp' })})` }
    : style.motion.entrance === 'slide'
      ? { opacity: 1, transform: `translateX(${interpolate(frame, [0, 16], [-60, 0], { extrapolateRight: 'clamp' })}px)` }
      : style.motion.entrance === 'scale'
        ? { opacity: interpolate(frame, [0, 12], [0, 1], { extrapolateRight: 'clamp' }), transform: `scale(${interpolate(frame, [0, 12], [.92, 1], { extrapolateRight: 'clamp' })})` }
        : { opacity: interpolate(frame, [0, Math.min(16, fps / 2)], [0, 1], { extrapolateRight: 'clamp' }) };
  const centered = style.layout.alignment === 'center';
  const mediaSrc = String(scene.visual.src ?? '');
  const isFullBleedSlide = scene.type === 'media' && (scene.visual.fullBleed === true || /(?:^|\/)slide-\d+\.png$/i.test(mediaSrc));
  const attributionText = `${String(scene.visual.attribution ?? '')}，${String(scene.visual.license ?? '')}`;
  const narrationWithoutAttribution = scene.type === 'media' && attributionText !== '，' && scene.narration.startsWith(attributionText) ? scene.narration.slice(attributionText.length).replace(/^[，,。\s]+/, '') : scene.narration;
  const captionNarration = narrationWithoutAttribution.trim() === '请添加图片讲解。' ? '' : narrationWithoutAttribution;
  const captionCues = useMemo(() => buildCaptionCues(captionNarration, scene.wordTimings, Math.max(3, scene.duration ?? 6), height > width), [captionNarration, scene.wordTimings, scene.duration, height, width]);
  const caption = captionAt(captionCues, frame / fps);
  if (isFullBleedSlide) {
    return <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <Img src={staticFile(mediaSrc)} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      {caption && <div style={{ position: 'absolute', left: '5%', right: '5%', bottom: 36 * scale, boxSizing: 'border-box', padding: `${10 * scale}px ${18 * scale}px`, borderRadius: 8 * scale, background: 'rgba(0,0,0,.62)', color: '#fff', textAlign: 'center', fontSize: 26 * scale, lineHeight: 1.25, fontWeight: 700 }}>{caption}</div>}
      {typeof scene.visual.attribution === 'string' && <small style={{ position: 'absolute', right: 20 * scale, top: 16 * scale, padding: `${5 * scale}px ${8 * scale}px`, background: 'rgba(0,0,0,.6)', color: '#fff', fontSize: 13 * scale }}>{scene.visual.attribution} · {String(scene.visual.license ?? '')}</small>}
      {scene.audioSrc && <Audio src={staticFile(scene.audioSrc)} />}
    </AbsoluteFill>;
  }
  const box: React.CSSProperties = { borderRadius: style.layout.cardStyle === 'none' ? 0 : style.layout.borderRadius, padding: style.layout.cardStyle === 'none' ? '20px 0' : 32, background: style.layout.cardStyle === 'soft' ? colors.card : 'transparent', border: style.layout.cardStyle === 'soft' ? `1px solid ${colors.accent}55` : 'none', boxShadow: styleId === 'social-short' ? `10px 10px 0 ${colors.secondary}` : 'none' };
  const title = <h1 style={{ fontFamily: style.typography.headingFont, fontSize: 55 * scale * style.typography.titleScale, lineHeight: 1.08, margin: `0 0 ${24 * scale}px`, color: colors.fg, letterSpacing: styleId === 'social-short' ? -2 * scale : 0, textAlign: centered ? 'center' : 'left' }}>{scene.title ?? scene.type.toUpperCase()}</h1>;
  let content: React.ReactNode;
  switch (scene.type) {
    case 'title': content = <div style={{ textAlign: 'center' }}>{title}<p style={{ color: colors.muted, fontSize: 32 * scale * style.typography.bodyScale }}>{scene.narration}</p></div>; break;
    case 'bullets': content = <div>{title}<ul style={{ color: colors.fg, fontSize: 34 * scale * style.typography.bodyScale, lineHeight: styleId === 'academic' ? 1.45 : 1.65, paddingLeft: centered ? 38 * scale : undefined }}>{(scene.visual.items as string[]).map((x, i) => <li key={i} style={{ padding: `${5 * scale}px 0` }}>{x}</li>)}</ul></div>; break;
    case 'comparison': content = <div>{title}<div style={{ display: 'flex', gap: 24 }}>{(scene.visual.columns as { title?: string; items?: string[] }[]).map((col, i) => <div key={i} style={{ ...box, flex: 1, color: colors.fg }}><h2>{col.title ?? `选项 ${i + 1}`}</h2>{(col.items ?? []).map((x, j) => <p key={j} style={{ fontSize: 25 }}>{x}</p>)}</div>)}</div></div>; break;
    case 'chart': { const data = scene.visual.data as { label: string; value: number }[]; const max = Math.max(...data.map(x => x.value), 1); content = <div>{title}<div style={{ display: 'flex', alignItems: 'end', gap: 22, height: 340 }}>{data.map((x, i) => <div key={i} style={{ flex: 1, textAlign: 'center', color: colors.muted }}><div style={{ height: `${Math.max(8, 280 * x.value / max)}px`, background: i % 2 ? colors.secondary : colors.accent, borderRadius: styleId === 'academic' ? 0 : '12px 12px 0 0' }} /><b style={{ color: colors.fg }}>{x.label}</b></div>)}</div></div>; break; }
    case 'code': content = <div>{title}<pre style={{ ...box, whiteSpace: 'pre-wrap', fontSize: 26 * scale, color: colors.accent }}>{String(scene.visual.code ?? scene.narration)}</pre></div>; break;
    case 'diagram': { const nodes = (scene.visual.nodes as { id: string; label: string }[] | undefined) ?? []; content = <div>{title}<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, flexWrap: 'wrap' }}>{nodes.map((node, i) => <React.Fragment key={node.id}><div style={{ ...box, color: colors.fg, fontSize: 28 }}>{node.label}</div>{i < nodes.length - 1 && <span style={{ color: colors.accent, fontSize: 40 }}>→</span>}</React.Fragment>)}</div></div>; break; }
    case 'timeline': { const items = (scene.visual.items as { date: string; label: string }[] | undefined) ?? []; content = <div>{title}<div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>{items.map((item, i) => <div key={i} style={{ flex: 1, borderTop: `4px solid ${colors.accent}`, padding: 16, color: colors.fg, background: colors.card }}><b style={{ color: colors.accent }}>{item.date}</b><p>{item.label}</p></div>)}</div></div>; break; }
    case 'math': { const formula = katex.renderToString(String(scene.visual.formula ?? ''), { displayMode: true, throwOnError: false, trust: false, output: 'html' }); content = <div>{title}<div style={{ textAlign: 'center', fontSize: 52 * scale, padding: 36, color: colors.accent }} dangerouslySetInnerHTML={{ __html: formula }} /><p style={{ color: colors.fg }}>{String(scene.visual.explanation ?? scene.narration)}</p></div>; break; }
    case 'media': content = <div>{title}<Img src={staticFile(String(scene.visual.src ?? ''))} style={{ maxWidth: '100%', maxHeight: '65vh', objectFit: 'contain', display: 'block', margin: '0 auto' }} />{typeof scene.visual.attribution === 'string' && <small style={{ display: 'block', textAlign: 'center', marginTop: 12, color: colors.muted, fontSize: 13 * scale }}>{scene.visual.attribution} · {String(scene.visual.license ?? '')}</small>}</div>; break;
  }
  const bg = styleId === 'minimal-tech' ? `linear-gradient(rgba(80,227,194,.055) 1px, transparent 1px), linear-gradient(90deg, rgba(80,227,194,.055) 1px, transparent 1px), radial-gradient(ellipse at 85% 15%, #173553 0%, ${colors.bg} 56%)` : styleId === 'social-short' ? `radial-gradient(circle at 12% 85%, ${colors.secondary} 0%, transparent 34%), radial-gradient(circle at 88% 15%, #6346bd 0%, ${colors.bg} 50%)` : colors.bg;
  const texture = styleId === 'academic' ? 'repeating-linear-gradient(0deg, transparent, transparent 43px, rgba(90,70,45,.08) 44px)' : styleId === 'clean-light' ? 'radial-gradient(#d8e0ef 1px, transparent 1px)' : 'none';
  return <AbsoluteFill style={{ ...entering, background: bg, backgroundSize: styleId === 'minimal-tech' ? '42px 42px, 42px 42px, cover' : 'cover', color: colors.fg, padding: style.layout.padding, justifyContent: 'center', fontFamily: style.typography.bodyFont }}>
    {texture !== 'none' && <div style={{ position: 'absolute', inset: 0, background: texture, backgroundSize: styleId === 'academic' ? 'auto' : '20px 20px', pointerEvents: 'none' }} />}
    {styleId === 'minimal-tech' && <div style={{ position: 'absolute', top: 44, left: style.layout.padding, color: colors.accent, fontSize: 17, letterSpacing: 4 }}>◈ KNOWLEDGE / {scene.type.toUpperCase()}</div>}
    {styleId === 'clean-light' && <div style={{ position: 'absolute', top: 0, left: 0, width: 22, height: '100%', background: colors.accent }} />}
    {styleId === 'academic' && <div style={{ position: 'absolute', top: 48, left: style.layout.padding, right: style.layout.padding, borderTop: `2px solid ${colors.accent}`, paddingTop: 12, color: colors.muted, font: '16px Georgia, serif' }}>讲义　·　{scene.title ?? '章节摘要'}</div>}
    {styleId === 'social-short' && <div style={{ position: 'absolute', top: 48, right: 70, color: colors.accent, fontSize: 22, fontWeight: 900, letterSpacing: 2 }}>要点速看 ✦</div>}
    <div style={{ ...box, position: 'relative', zIndex: 1, width: '100%', boxSizing: 'border-box', textAlign: centered ? 'center' : 'left' }}>{content}</div>
    {caption && <div style={{ position: 'absolute', zIndex: 2, bottom: 32 * scale, left: '5%', right: '5%', boxSizing: 'border-box', padding: `${10 * scale}px ${18 * scale}px`, borderRadius: 8 * scale, background: 'rgba(0,0,0,.72)', color: '#fff', textAlign: 'center', fontSize: 30 * scale, lineHeight: 1.4, fontWeight: 700 }}>{caption}</div>}
    {scene.audioSrc && <Audio src={staticFile(scene.audioSrc)} />}
  </AbsoluteFill>;
}

export function ExplainerVideo({ storyboard }: { storyboard: Storyboard }) {
  const { fps } = useVideoConfig();
  let cursor = 0;
  const music = storyboard.bgmSrc;
  const totalFrames = getDurationInFrames(storyboard, fps);
  const fadeInFrames = Math.round((storyboard.bgmFadeIn ?? 1) * fps);
  const fadeOutFrames = Math.round((storyboard.bgmFadeOut ?? 1) * fps);
  const baseVolume = storyboard.bgmVolume ?? 0.12;
  const volume = (frame: number) => Math.min(baseVolume, fadeInFrames ? baseVolume * frame / fadeInFrames : baseVolume, fadeOutFrames ? baseVolume * Math.max(0, totalFrames - frame) / fadeOutFrames : baseVolume);
  return <AbsoluteFill>{music && <Audio src={staticFile(music)} volume={volume} loop loopVolumeCurveBehavior="extend" />}{storyboard.scenes.map(scene => { const duration = Math.max(90, Math.round((scene.duration ?? 6) * fps)); const from = cursor; cursor += duration; return <Sequence key={scene.id} from={from} durationInFrames={duration}><SceneView scene={scene} styleId={storyboard.styleId} /></Sequence>; })}</AbsoluteFill>;
}

export const getDurationInFrames = (storyboard: Storyboard, fps = 30) => storyboard.scenes.reduce((sum, scene) => sum + Math.max(90, Math.round((scene.duration ?? 6) * fps)), 0);
